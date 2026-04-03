"""
Copilot Orchestrator

回复编排层的主控制器，负责：
1. 从 EverMemOS 获取画像和历史记忆
2. 调用 ReplyGenerator 生成回复
3. 返回建议回复
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from api_specs.unified_types import (
    UnifiedProfile,
    UnifiedMessage,
    ReplySuggestionRequest,
    ReplySuggestionResponse,
    MemorizeRequest,
)
from copilot_orchestrator.converters import SocialCopilotConverter, EverMemOSConverter
from copilot_orchestrator.reply_generator import ReplyGenerator
from core.observation.logger import get_logger
from core.di import get_bean

logger = get_logger(__name__)


class CopilotOrchestrator:
    """
    Copilot 编排器

    核心职责：
    1. 屏蔽 EverMemOS 底层复杂对象结构
    2. 组装 LLM 推理所需的完整上下文
    3. 执行回复生成流水线 (Planner → Responder → Guardrail)
    4. 返回建议回复
    """

    def __init__(self):
        """初始化编排器"""
        self._profile_repo = None
        self._conversation_repo = None
        self._conversation_message_repo = None
        self._memcell_repo = None
        self._episodic_memory_repo = None
        self._foresight_repo = None
        self._reply_generator = None

    async def _get_profile_repo(self):
        """延迟获取 profile repository"""
        if self._profile_repo is None:
            from infra_layer.adapters.out.persistence.repository.unified_profile_repository import UnifiedProfileRepository
            self._profile_repo = get_bean("unified_profile_repository") or UnifiedProfileRepository()
        return self._profile_repo

    async def _get_conversation_repo(self):
        """延迟获取 conversation repository"""
        if self._conversation_repo is None:
            try:
                self._conversation_repo = get_bean("conversation_data_repo")
            except Exception:
                self._conversation_repo = None
        return self._conversation_repo

    async def _get_memcell_repo(self):
        """å¯¤æƒ°ç¹œé‘¾å³°å½‡ memcell repository"""
        if self._memcell_repo is None:
            try:
                self._memcell_repo = get_bean("memcell_raw_repository")
            except Exception:
                self._memcell_repo = None
        return self._memcell_repo

    async def _get_conversation_message_repo(self):
        """Get permanent conversation message repository"""
        if self._conversation_message_repo is None:
            try:
                self._conversation_message_repo = get_bean("conversation_message_repository")
            except Exception:
                self._conversation_message_repo = None
        return self._conversation_message_repo

    async def _get_reply_generator(self):
        """延迟获取回复生成器"""
        if self._reply_generator is None:
            try:
                llm_provider = get_bean("llm_provider")
            except Exception:
                llm_provider = None
            self._reply_generator = ReplyGenerator(llm_provider)
        return self._reply_generator

    async def _get_episodic_memory_repo(self):
        """延迟获取 episodic memory repository"""
        if self._episodic_memory_repo is None:
            try:
                from infra_layer.adapters.out.persistence.repository.episodic_memory_raw_repository import EpisodicMemoryRawRepository
                self._episodic_memory_repo = get_bean("episodic_memory_raw_repository") or EpisodicMemoryRawRepository()
            except Exception as e:
                logger.warning(f"Failed to get episodic memory repo: {e}")
                self._episodic_memory_repo = None
        return self._episodic_memory_repo

    async def _get_foresight_repo(self):
        """延迟获取 foresight record repository"""
        if self._foresight_repo is None:
            try:
                from infra_layer.adapters.out.persistence.repository.foresight_record_repository import ForesightRecordRawRepository
                self._foresight_repo = get_bean("foresight_record_raw_repository") or ForesightRecordRawRepository()
            except Exception as e:
                logger.warning(f"Failed to get foresight repo: {e}")
                self._foresight_repo = None
        return self._foresight_repo

    # ==================== 核心方法 ====================

    async def get_reply_suggestion(
        self,
        request: ReplySuggestionRequest
    ) -> ReplySuggestionResponse:
        """
        获取回复建议

        Args:
            request: 回复请求

        Returns:
            ReplySuggestionResponse
        """
        try:
            # Step 1: 获取用户画像
            profile_repo = await self._get_profile_repo()
            user_profile = await profile_repo.get_user_profile(request.owner_user_id)

            if not user_profile:
                # 创建默认用户画像
                user_profile = UnifiedProfile.create_user_profile(
                    owner_user_id=request.owner_user_id
                )
                await profile_repo.save_profile(user_profile)

            # Step 2: 获取联系人画像
            contact_profile = None
            if request.target_user_id:
                contact_profile = await profile_repo.get_by_owner_and_target(
                    owner_user_id=request.owner_user_id,
                    target_user_id=request.target_user_id
                )

            # Step 3: 获取历史消息
            recent_messages = await self._get_recent_messages(
                conversation_id=request.conversation_id,
                limit=request.history_window
            )

            # Step 4: 获取情景记忆和前瞻洞察
            episodes = await self._get_recent_episodes(
                conversation_id=request.conversation_id,
                owner_user_id=request.owner_user_id,
                limit=5
            )
            foresights = await self._get_active_foresights(
                conversation_id=request.conversation_id,
                owner_user_id=request.owner_user_id,
                limit=3
            )

            # Step 5: 生成回复
            reply_generator = await self._get_reply_generator()
            response = await reply_generator.generate_reply(
                request=request,
                user_profile=user_profile,
                contact_profile=contact_profile,
                recent_messages=recent_messages,
                episodes=episodes,
                foresights=foresights
            )

            return response

        except Exception as e:
            logger.error(f"Failed to get reply suggestion: {e}")
            return ReplySuggestionResponse(
                should_reply=False,
                risk_check={"passed": False, "error": str(e)}
            )

    async def get_context(
        self,
        conversation_id: str,
        owner_user_id: str,
        target_user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        获取会话上下文

        Args:
            conversation_id: 会话ID
            owner_user_id: 用户ID
            target_user_id: 目标用户ID

        Returns:
            上下文字典
        """
        try:
            profile_repo = await self._get_profile_repo()

            # 获取用户画像
            user_profile = await profile_repo.get_user_profile(owner_user_id)

            # 获取联系人画像
            contact_profile = None
            if target_user_id:
                contact_profile = await profile_repo.get_by_owner_and_target(
                    owner_user_id=owner_user_id,
                    target_user_id=target_user_id
                )

            # 获取最近消息
            recent_messages = await self._get_recent_messages(
                conversation_id=conversation_id,
                limit=20
            )

            # 转换为 Social Copilot 格式
            context = {
                "conversation_id": conversation_id,
                "self_profile": SocialCopilotConverter.to_sc_user_profile(user_profile) if user_profile else None,
                "friend_profile": SocialCopilotConverter.to_sc_contact_profile(contact_profile) if contact_profile else None,
                "recent_messages": [m.to_dict() for m in recent_messages],
                "persona_anchors": {
                    "catchphrases": user_profile.communication_style.frequent_phrases if user_profile else [],
                    "style_tags": [user_profile.communication_style.tone_style] if user_profile else []
                }
            }

            return context

        except Exception as e:
            logger.error(f"Failed to get context: {e}")
            return {"error": str(e)}

    async def memorize_messages(
        self,
        request: MemorizeRequest
    ) -> Dict[str, Any]:
        """
        写入消息到记忆系统

        Args:
            request: 记忆写入请求

        Returns:
            结果字典
        """
        try:
            conversation_repo = await self._get_conversation_repo()

            if conversation_repo:
                # 转换为 EverMemOS 格式
                raw_data_list = []
                for msg in request.messages:
                    raw_data_list.append({
                        "data_id": msg.message_id,
                        "content": msg.to_dict()
                    })

                # 调用 EverMemOS 记忆链路
                # TODO: 集成完整的记忆抽取流程
                logger.info(f"Memorized {len(request.messages)} messages for conversation {request.conversation_id}")

            return {
                "success": True,
                "message_count": len(request.messages)
            }

        except Exception as e:
            logger.error(f"Failed to memorize messages: {e}")
            return {"success": False, "error": str(e)}

    # ==================== 内部方法 ====================

    async def _get_recent_episodes(
        self,
        conversation_id: str,
        owner_user_id: str,
        limit: int = 5
    ) -> List[Dict[str, Any]]:
        """获取当前会话最近的情景记忆摘要"""
        episodes_data = []
        try:
            repo = await self._get_episodic_memory_repo()
            if repo and conversation_id:
                episodes = await repo.get_by_conversation_id(
                    conversation_id=conversation_id,
                    limit=limit,
                    sort_desc=True,
                    user_id=owner_user_id
                )
                for ep in episodes:
                    subject = getattr(ep, 'subject', None) or getattr(ep, 'topic', None) or ''
                    summary = getattr(ep, 'summary', None) or ''
                    created_at = getattr(ep, 'created_at', None)
                    time_str = created_at.isoformat() if hasattr(created_at, 'isoformat') else str(created_at)
                    if subject or summary:
                        episodes_data.append({
                            "subject": subject,
                            "summary": summary,
                            "time": time_str
                        })
        except Exception as e:
            logger.warning(f"Failed to get recent episodes: {e}")
        return episodes_data

    async def _get_active_foresights(
        self,
        conversation_id: str,
        owner_user_id: str,
        limit: int = 3
    ) -> List[Dict[str, Any]]:
        """获取当前会话有效的前瞻洞察"""
        foresights_data = []
        try:
            repo = await self._get_foresight_repo()
            if repo and conversation_id:
                from datetime import datetime
                now = datetime.now()
                foresights = await repo.get_by_conversation_id(
                    conversation_id=conversation_id,
                    limit=limit,
                    user_id=owner_user_id
                )
                for f in foresights:
                    content = getattr(f, 'content', None) or getattr(f, 'foresight_text', None) or ''
                    end_time = getattr(f, 'end_time', None)
                    created_at = getattr(f, 'created_at', None)
                    time_str = created_at.isoformat() if hasattr(created_at, 'isoformat') else str(created_at)
                    if content and (not end_time or end_time > now):
                        foresights_data.append({
                            "content": content,
                            "time": time_str
                        })
                foresights_data = foresights_data[:limit]
        except Exception as e:
            logger.warning(f"Failed to get active foresights: {e}")
        return foresights_data

    async def _get_recent_messages(
        self,
        conversation_id: str,
        limit: int = 20
    ) -> List[UnifiedMessage]:
        """获取最近消息"""
        messages: List[UnifiedMessage] = []

        try:
            conversation_repo = await self._get_conversation_repo()

            if conversation_repo:
                # 从 EverMemOS 获取历史
                raw_data_list = await conversation_repo.get_conversation_data(
                    group_id=conversation_id,  # 兼容旧接口
                    limit=limit
                )

                for raw_data in raw_data_list:
                    content = raw_data.content or {}
                    msg = UnifiedMessage.from_dict(content)
                    messages.append(msg)

            if messages:
                return self._finalize_recent_messages(messages, limit)

            conversation_message_repo = await self._get_conversation_message_repo()
            if conversation_message_repo:
                messages = await conversation_message_repo.get_recent_messages(
                    conversation_id=conversation_id,
                    limit=limit,
                )

            if messages:
                return self._finalize_recent_messages(messages, limit)

            messages = await self._get_recent_messages_from_memcells(
                conversation_id=conversation_id,
                limit=limit,
            )

        except Exception as e:
            logger.warning(f"Failed to get recent messages: {e}")

        return self._finalize_recent_messages(messages, limit)

    # ==================== 画像管理 ====================

    async def _get_recent_messages_from_memcells(
        self,
        conversation_id: str,
        limit: int = 20,
    ) -> List[UnifiedMessage]:
        """Fallback to memcells when conversation cache is empty."""
        messages: List[UnifiedMessage] = []

        try:
            memcell_repo = await self._get_memcell_repo()
            if not memcell_repo:
                return messages

            memcells = await memcell_repo.find_by_group_id(
                group_id=conversation_id,
                limit=max(limit, 50),
                sort_desc=True,
            )

            for memcell in memcells:
                if hasattr(memcell, "model_dump"):
                    payload = memcell.model_dump()
                elif hasattr(memcell, "dict"):
                    payload = memcell.dict()
                else:
                    payload = dict(memcell)

                messages.extend(
                    EverMemOSConverter.convert_memcell_to_messages(
                        payload,
                        conversation_id=conversation_id,
                        owner_user_id=(payload.get("user_id") or ""),
                    )
                )

        except Exception as e:
            logger.warning(f"Failed to get recent messages from memcells: {e}")

        return messages

    def _finalize_recent_messages(
        self,
        messages: List[UnifiedMessage],
        limit: int,
    ) -> List[UnifiedMessage]:
        """Deduplicate and keep recent messages in chronological order."""
        if not messages:
            return []

        unique_by_id: Dict[str, UnifiedMessage] = {}
        for message in messages:
            message_id = (
                message.message_id
                or f"{message.conversation_id}:{message.timestamp}:{message.sender_id}:{message.content}"
            )
            unique_by_id[message_id] = message

        ordered = sorted(
            unique_by_id.values(),
            key=lambda item: ((item.timestamp or ""), (item.message_id or "")),
        )

        if limit > 0:
            ordered = ordered[-limit:]

        return ordered

    async def create_or_update_user_profile(
        self,
        owner_user_id: str,
        profile_data: Dict[str, Any]
    ) -> UnifiedProfile:
        """
        创建或更新用户画像

        Args:
            owner_user_id: 用户ID
            profile_data: 画像数据

        Returns:
            UnifiedProfile
        """
        profile_repo = await self._get_profile_repo()

        # 检查是否存在
        existing = await profile_repo.get_user_profile(owner_user_id)

        if existing:
            # 更新
            if profile_data.get("traits"):
                existing.traits = profile_data["traits"]
            if profile_data.get("interests"):
                existing.interests = profile_data["interests"]
            if profile_data.get("communication_style"):
                existing.communication_style = SocialCopilotConverter.convert_user_profile(
                    {"communication_habits": profile_data["communication_style"]},
                    owner_user_id
                ).communication_style

            await profile_repo.save_profile(existing)
            return existing
        else:
            # 创建
            profile = UnifiedProfile.create_user_profile(
                owner_user_id=owner_user_id
            )
            if profile_data.get("traits"):
                profile.traits = profile_data["traits"]
            if profile_data.get("interests"):
                profile.interests = profile_data["interests"]

            await profile_repo.save_profile(profile)
            return profile

    async def create_or_update_contact_profile(
        self,
        owner_user_id: str,
        session_key: str,
        display_name: str,
        profile_data: Dict[str, Any]
    ) -> UnifiedProfile:
        """
        创建或更新联系人画像

        Args:
            owner_user_id: 用户ID
            session_key: 会话标识
            display_name: 显示名称
            profile_data: 画像数据

        Returns:
            UnifiedProfile
        """
        profile_repo = await self._get_profile_repo()

        # 创建或获取
        profile = UnifiedProfile.create_contact_profile(
            owner_user_id=owner_user_id,
            session_key=session_key,
            display_name=display_name
        )

        # 更新数据
        if profile_data.get("traits"):
            profile.traits = profile_data["traits"]
        if profile_data.get("interests"):
            profile.interests = profile_data["interests"]
        if profile_data.get("role"):
            profile.social_attributes.role = profile_data["role"]
        if profile_data.get("intimacy_level"):
            from api_specs.unified_types import normalize_intimacy_level

            profile.social_attributes.intimacy_level = normalize_intimacy_level(
                profile_data["intimacy_level"]
            )

        await profile_repo.upsert_by_owner_target(profile)
        return profile


# 单例
_copilot_orchestrator = None


def get_copilot_orchestrator() -> CopilotOrchestrator:
    """获取 CopilotOrchestrator 单例"""
    global _copilot_orchestrator
    if _copilot_orchestrator is None:
        _copilot_orchestrator = CopilotOrchestrator()
    return _copilot_orchestrator
