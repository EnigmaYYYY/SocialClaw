"""
Reply Generator

回复生成器，负责运行 Planner + Responder 流水线。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple
import json

from api_specs.unified_types import (
    UnifiedProfile,
    ProfileField,
    UnifiedMessage,
    ReplySuggestionRequest,
    ReplySuggestionResponse,
)
from core.observation.logger import get_logger

logger = get_logger(__name__)


def _format_profile_for_prompt(profile: Optional[UnifiedProfile], role: str = "user") -> str:
    """
    将 Profile 格式化为 Prompt 文本，只提取非空字段的 value，不含 evidences。

    Args:
        profile: 用户画像
        role: 角色（"user" 或 "contact"）

    Returns:
        格式化后的画像文本
    """
    if not profile:
        return f"{role}: 无画像信息"

    lines = []

    # 基础信息
    if profile.display_name:
        lines.append(f"名字: {profile.display_name}")

    # 置信度标注辅助函数
    def _confidence_tag(field: ProfileField) -> str:
        level = getattr(field, 'evidence_level', None) or ''
        return "确定" if level == "L1" else "推测"

    # 单值字段
    def add_single_field(label: str, field: Optional[ProfileField]):
        if field and field.value:
            lines.append(f"{label}: {field.value}({_confidence_tag(field)})")

    add_single_field("性别", profile.gender)
    add_single_field("年龄", profile.age)
    add_single_field("学历", profile.education_level)
    add_single_field("熟悉程度", profile.intimacy_level)

    # 列表字段（带置信度标注）
    def add_list_field(label: str, fields: List[ProfileField]):
        if fields:
            formatted = [f"{f.value}({_confidence_tag(f)})" for f in fields if f.value]
            if formatted:
                lines.append(f"{label}: {', '.join(values)}")

    add_list_field("人格特质", profile.traits)
    add_list_field("性格特征", profile.personality)
    add_list_field("职业", profile.occupation)
    add_list_field("关系", profile.relationship)
    add_list_field("兴趣爱好", profile.interests)
    add_list_field("决策风格", profile.way_of_decision_making)
    add_list_field("生活偏好", profile.life_habit_preference)
    add_list_field("沟通风格", profile.communication_style)
    add_list_field("口头禅", profile.catchphrase)
    add_list_field("对朋友口头禅", profile.user_to_friend_catchphrase)
    add_list_field("对朋友回复风格", profile.user_to_friend_chat_style)
    add_list_field("核心动机", profile.motivation_system)
    add_list_field("核心恐惧", profile.fear_system)
    add_list_field("价值观", profile.value_system)
    add_list_field("幽默风格", profile.humor_use)

    # 社交属性
    sa = profile.social_attributes
    if sa.current_status:
        lines.append(f"当前状态: {sa.current_status}")
    if sa.intimacy_level:
        lines.append(f"亲密度: {sa.intimacy_level.value}")

    if not lines:
        return f"{role}: 无画像信息"

    return "\n".join(f"- {line}" for line in lines)


class ReplyGenerator:
    """
    回复生成器

    负责：
    1. 构建 Planner prompt
    2. 调用 LLM 进行策略规划
    3. 构建 Responder prompt
    4. 调用 LLM 生成回复
    5. 执行 Guardrail 检查
    """

    def __init__(self, llm_provider: Any = None):
        """
        初始化回复生成器

        Args:
            llm_provider: LLM 提供者
        """
        self.llm_provider = llm_provider

    async def generate_reply(
        self,
        request: ReplySuggestionRequest,
        user_profile: UnifiedProfile,
        contact_profile: Optional[UnifiedProfile],
        recent_messages: List[UnifiedMessage],
        episodes: Optional[List[Dict[str, Any]]] = None,
        foresights: Optional[List[Dict[str, Any]]] = None,
        visual_context: Optional[str] = None,
    ) -> ReplySuggestionResponse:
        """
        生成回复建议

        Args:
            request: 回复请求
            user_profile: 用户画像
            contact_profile: 联系人画像
            recent_messages: 最近消息
            episodes: 当前会话的情景记忆摘要
            foresights: 当前会话的前瞻洞察
            visual_context: VLM 场景描述文本

        Returns:
            ReplySuggestionResponse
        """
        try:
            # Step 1: 运行 Planner
            planner_result = await self._run_planner(
                request=request,
                user_profile=user_profile,
                contact_profile=contact_profile,
                recent_messages=recent_messages,
                episodes=episodes or [],
                foresights=foresights or [],
                visual_context=visual_context,
            )

            if not planner_result.get("should_reply", True):
                return ReplySuggestionResponse(
                    should_reply=False,
                    planner_decision=planner_result
                )

            # Step 2: 运行 Responder
            reply_text = await self._run_responder(
                request=request,
                user_profile=user_profile,
                contact_profile=contact_profile,
                recent_messages=recent_messages,
                planner_result=planner_result
            )

            # Step 3: Guardrail 检查
            risk_check = self._check_guardrails(
                reply_text=reply_text,
                user_profile=user_profile,
                contact_profile=contact_profile,
                recent_messages=recent_messages,
                manual_intent=request.manual_intent
            )

            # Step 4: 如果有风险，尝试重写
            if not risk_check.get("passed", True):
                reply_text = await self._handle_risks(
                    reply_text=reply_text,
                    risk_check=risk_check,
                    user_profile=user_profile,
                    planner_result=planner_result
                )

            # Step 5: 构建证据
            evidence = self._build_evidence(
                user_profile=user_profile,
                contact_profile=contact_profile,
                planner_result=planner_result
            )

            return ReplySuggestionResponse(
                should_reply=True,
                reply_text=reply_text,
                planner_decision=planner_result,
                evidence=evidence,
                risk_check=risk_check
            )

        except Exception as e:
            logger.error(f"Failed to generate reply: {e}")
            return ReplySuggestionResponse(
                should_reply=False,
                risk_check={"passed": False, "error": str(e)}
            )

    async def _run_planner(
        self,
        request: ReplySuggestionRequest,
        user_profile: UnifiedProfile,
        contact_profile: Optional[UnifiedProfile],
        recent_messages: List[UnifiedMessage],
        episodes: Optional[List[Dict[str, Any]]] = None,
        foresights: Optional[List[Dict[str, Any]]] = None,
        visual_context: Optional[str] = None,
    ) -> Dict[str, Any]:
        """运行 Planner 生成策略"""
        prompt = self._build_planner_prompt(
            request=request,
            user_profile=user_profile,
            contact_profile=contact_profile,
            recent_messages=recent_messages,
            episodes=episodes or [],
            foresights=foresights or [],
            visual_context=visual_context,
        )

        logger.info("🐳🐳🐳 Planner Prompt:\n%s", prompt)
        if self.llm_provider:
            try:
                response = await self.llm_provider.generate(prompt)
                logger.info("🐳🐳🐳 Planner Response:\n%s", response)
                return self._parse_planner_response(response)
            except Exception as e:
                logger.error(f"Planner LLM call failed: {e}")

        logger.warning("🐳🐳🐳 No LLM provider, using default strategy")
        # 默认策略
        return {
            "should_reply": True,
            "intent": "respond",
            "tone": "friendly",
            "question_policy": "default_statement"
        }

    def _build_planner_prompt(
        self,
        request: ReplySuggestionRequest,
        user_profile: UnifiedProfile,
        contact_profile: Optional[UnifiedProfile],
        recent_messages: List[UnifiedMessage],
        episodes: Optional[List[Dict[str, Any]]] = None,
        foresights: Optional[List[Dict[str, Any]]] = None,
        visual_context: Optional[str] = None,
    ) -> str:
        """构建 Planner prompt"""
        incoming_msg = request.incoming_message.content if request.incoming_message else ""

        # 格式化双方画像（所有非空字段，含置信度标注）
        user_profile_text = _format_profile_for_prompt(user_profile, "用户")
        contact_profile_text = _format_profile_for_prompt(contact_profile, "对方")

        # 格式化最近对话
        recent_msg_text = self._format_recent_messages(recent_messages)

        # 格式化情景记忆
        episodes_text = ""
        if episodes:
            episode_lines = [f"- [{ep.get('time','')[:10]}] {ep.get('subject','')}: {ep.get('summary','')}" for ep in episodes[:5]]
            episodes_text = "\n".join(episode_lines)
        else:
            episodes_text = "无相关情景记忆"

        # 格式化前瞻洞察
        foresights_text = ""
        if foresights:
            foresight_lines = [f"- [{fs.get('time','')[:10]}] {fs.get('content','')}" for fs in foresights[:3]]
            foresights_text = "\n".join(foresight_lines)
        else:
            foresights_text = "无前瞻洞察"

        # 格式化视觉上下文
        visual_section = ""
        if visual_context:
            visual_section = f"""
## 场景视觉信息
对方当前场景：{visual_context}
"""

        prompt = f"""你是一个社交回复策略规划专家。请分析以下对话并给出回复策略。

## 用户画像
{user_profile_text}

## 对方画像
{contact_profile_text}

## 最近对话
{recent_msg_text}

## 情景记忆（关于这个对话的记录）
{episodes_text}

## 前瞻洞察（关于对方的推测）
{foresights_text}
{visual_section}
## 最新消息
{incoming_msg}

## 用户意图
{request.manual_intent or '无特别意图'}

请以 JSON 格式返回策略：
{{"should_reply": bool, "intent": str, "tone": str, "question_policy": str, "reasoning": str}}
"""
        return prompt

    def _format_recent_messages(self, messages: List[UnifiedMessage], limit: int = 10) -> str:
        """格式化最近对话消息"""
        if not messages:
            return "无历史消息"
        from api_specs.unified_types import SenderType
        recent = messages[-limit:]
        lines = []
        for msg in recent:
            sender = "用户" if getattr(msg, 'sender_type', None) == SenderType.USER else "对方"
            content = msg.content[:50] + "..." if len(msg.content or "") > 50 else (msg.content or "")
            lines.append(f"[{sender}]: {content}")
        return "\n".join(lines)

    def _parse_planner_response(self, response: str) -> Dict[str, Any]:
        """解析 Planner 响应"""
        try:
            # 尝试提取 JSON
            import re
            json_match = re.search(r'\{[\s\S]*\}', response)
            if json_match:
                return json.loads(json_match.group())
        except Exception:
            pass

        return {
            "should_reply": True,
            "intent": "respond",
            "tone": "friendly",
            "question_policy": "default_statement"
        }

    async def _run_responder(
        self,
        request: ReplySuggestionRequest,
        user_profile: UnifiedProfile,
        contact_profile: Optional[UnifiedProfile],
        recent_messages: List[UnifiedMessage],
        planner_result: Dict[str, Any]
    ) -> str:
        """运行 Responder 生成回复"""
        prompt = self._build_responder_prompt(
            request=request,
            user_profile=user_profile,
            contact_profile=contact_profile,
            planner_result=planner_result,
            recent_messages=recent_messages
        )

        logger.info("🐳🐳🐳 Responder Prompt:\n%s", prompt)
        if self.llm_provider:
            try:
                response = await self.llm_provider.generate(prompt)
                logger.info("🐳🐳🐳 Responder Response:\n%s", response)
                return self._parse_responder_response(response)
            except Exception as e:
                logger.error(f"Responder LLM call failed: {e}")

        logger.warning("🐳🐳🐳 No LLM provider, using default reply")
        # 默认回复
        return "好的"

    def _build_responder_prompt(
        self,
        request: ReplySuggestionRequest,
        user_profile: UnifiedProfile,
        contact_profile: Optional[UnifiedProfile],
        planner_result: Dict[str, Any],
        recent_messages: Optional[List[UnifiedMessage]] = None
    ) -> str:
        """构建 Responder prompt"""
        incoming_msg = request.incoming_message.content if request.incoming_message else ""

        # 格式化双方画像（所有非空字段，含置信度标注）
        user_profile_text = _format_profile_for_prompt(user_profile, "用户")
        contact_profile_text = _format_profile_for_prompt(contact_profile, "对方")

        # 格式化最近对话
        recent_msg_text = self._format_recent_messages(recent_messages) if recent_messages else "无历史消息"

        prompt = f"""你是一个社交回复助手。请根据以下信息生成一条简短的回复。

## 回复策略
- 意图: {planner_result.get('intent', 'respond')}
- 语气: {planner_result.get('tone', 'friendly')}
- 问题策略: {planner_result.get('question_policy', 'default_statement')}

## 用户画像
{user_profile_text}

## 对方画像
{contact_profile_text}

## 最近对话
{recent_msg_text}

## 对方消息
{incoming_msg}

## 用户意图
{request.manual_intent or '无特别意图'}

## 要求
1. 模仿用户风格，使用口头禅
2. 简短自然，不要 AI 味
3. 不要编造事实
4. 直接返回回复内容，不要解释
"""
        return prompt

    def _parse_responder_response(self, response: str) -> str:
        """解析 Responder 响应"""
        # 清理响应
        text = response.strip()
        # 移除可能的引号
        if text.startswith('"') and text.endswith('"'):
            text = text[1:-1]
        return text

    def _check_guardrails(
        self,
        reply_text: str,
        user_profile: UnifiedProfile,
        contact_profile: Optional[UnifiedProfile],
        recent_messages: List[UnifiedMessage],
        manual_intent: Optional[str]
    ) -> Dict[str, Any]:
        """检查 Guardrail"""
        flags = []

        # 检查 AI 味
        ai_patterns = ["我很乐意", "作为AI", "希望这能帮到你", "有什么我可以帮你的"]
        for pattern in ai_patterns:
            if pattern in reply_text:
                flags.append({"type": "ai_flavor", "pattern": pattern})

        # 检查长度
        if len(reply_text) > 100:
            flags.append({"type": "too_long", "length": len(reply_text)})

        # 检查问题过多
        question_count = reply_text.count("？") + reply_text.count("?")
        if question_count > 1:
            flags.append({"type": "too_many_questions", "count": question_count})

        return {
            "passed": len(flags) == 0,
            "flags": flags
        }

    async def _handle_risks(
        self,
        reply_text: str,
        risk_check: Dict[str, Any],
        user_profile: UnifiedProfile,
        planner_result: Dict[str, Any]
    ) -> str:
        """处理风险"""
        # 简化版：如果有风险，尝试简化回复
        flags = risk_check.get("flags", [])

        for flag in flags:
            if flag.get("type") == "ai_flavor":
                # 移除 AI 味的内容
                reply_text = reply_text.replace(flag.get("pattern", ""), "")
            elif flag.get("type") == "too_long":
                # 截断
                reply_text = reply_text[:50]
            elif flag.get("type") == "too_many_questions":
                # 只保留第一个问题
                parts = reply_text.split("？", 1)
                reply_text = parts[0] if parts else reply_text

        return reply_text.strip()

    def _build_evidence(
        self,
        user_profile: UnifiedProfile,
        contact_profile: Optional[UnifiedProfile],
        planner_result: Dict[str, Any]
    ) -> Dict[str, Any]:
        """构建证据"""
        evidence = {
            "user_profile_used": True,
            "contact_profile_used": contact_profile is not None,
            "memory_hits": []
        }

        # 从用户画像中提取关键信息作为证据
        def add_field_values(fields: List[ProfileField], limit: int = 3):
            for f in fields[:limit]:
                if f.value:
                    evidence["memory_hits"].append(f.value)

        add_field_values(user_profile.traits)
        add_field_values(user_profile.interests)
        add_field_values(user_profile.catchphrase)

        if contact_profile:
            add_field_values(contact_profile.traits)
            add_field_values(contact_profile.interests)
            add_field_values(contact_profile.relationship)

        return evidence