from __future__ import annotations

from pathlib import Path

from social_copilot.agent.models import ChatMessage
from social_copilot.agent.openai_compatible import OpenAICompatibleChatResult
from social_copilot.agent.social_reply_assistant import SocialReplyAssistant
from social_copilot.agent_runtime.selection import AssistantSkillSelector
from social_copilot.agent_runtime.skill_registry import SkillRegistry
from social_copilot.visual_monitor.adapters.vision_litellm_structured import (
    LiteLLMStructuredVisionAdapter,
    LiteLLMStructuredVisionConfig,
)


class FakeChatClient:
    def __init__(
        self,
        chat_completion_responses: list[str] | None = None,
        chat_responses: list[OpenAICompatibleChatResult] | None = None,
    ) -> None:
        self._chat_completion_responses = list(chat_completion_responses or [])
        self._chat_responses = list(chat_responses or [])
        self.chat_completion_calls: list[tuple[str, str]] = []
        self.chat_calls: list[dict[str, object]] = []

    def chat_completion(self, system_prompt: str, user_prompt: str) -> str:
        self.chat_completion_calls.append((system_prompt, user_prompt))
        if not self._chat_completion_responses:
            raise AssertionError("unexpected chat_completion() call")
        return self._chat_completion_responses.pop(0)

    def chat(self, **kwargs: object) -> OpenAICompatibleChatResult:
        self.chat_calls.append(kwargs)
        if not self._chat_responses:
            raise AssertionError("unexpected chat() call")
        return self._chat_responses.pop(0)


def _skill_file(root: Path, skill_id: str, body: str, description: str) -> Path:
    skill_dir = root / skill_id
    skill_dir.mkdir(parents=True, exist_ok=True)
    path = skill_dir / "SKILL.md"
    path.write_text(
        (
            "---\n"
            f'name: "{skill_id}"\n'
            f'description: "{description}"\n'
            "---\n\n"
            f"{body}"
        ),
        encoding="utf-8",
    )
    return path


def test_skill_registry_discovers_external_skills(tmp_path: Path) -> None:
    _skill_file(
        tmp_path,
        "tong-jincheng-style",
        "# Tong Skill\n\nUse playful high-EQ social framing.",
        description="Use when the assistant should sound playful and high-EQ.",
    )
    _skill_file(
        tmp_path,
        "gentle-comfort-style",
        "# Gentle Skill\n\nUse warm and calming language.",
        description="Use when the assistant should sound warm and calming.",
    )

    registry = SkillRegistry(root_dir=tmp_path)
    skills = registry.list_skills()

    assert [item.skill_id for item in skills] == [
        "gentle-comfort-style",
        "tong-jincheng-style",
    ]


def test_skill_registry_defaults_to_dot_agents_directory_name() -> None:
    registry = SkillRegistry()

    assert registry._root_dir.name == "skills"
    assert registry._root_dir.parent.name == ".agents"


def test_assistant_skill_selector_falls_back_to_configured_default_when_selection_invalid(tmp_path: Path) -> None:
    _skill_file(
        tmp_path,
        "tong-jincheng-style",
        "# Tong Skill\n\nUse playful high-EQ social framing.",
        description="Use when the assistant should sound playful and high-EQ.",
    )
    _skill_file(
        tmp_path,
        "gentle-comfort-style",
        "# Gentle Skill\n\nUse warm and calming language.",
        description="Use when the assistant should sound warm and calming.",
    )
    registry = SkillRegistry(root_dir=tmp_path)
    client = FakeChatClient(chat_completion_responses=['{"primary_skill_id":"missing-skill"}'])
    selector = AssistantSkillSelector(client=client, default_skill_id="tong-jincheng-style")

    selected = selector.select(
        chat_messages=[ChatMessage(sender="contact", text="最近压力有点大", contact_name="小王")],
        available_skills=registry.list_skills(),
    )

    assert [item.skill_id for item in selected] == ["tong-jincheng-style"]
    assert len(client.chat_completion_calls) == 1


def test_social_reply_assistant_uses_base_prompt_and_selected_skill_overlay(tmp_path: Path) -> None:
    _skill_file(
        tmp_path,
        "tong-jincheng-style",
        "# Tong Skill\n\n用高情商、会拉近关系的方式润色回复，但不要改写聊天事实。",
        description="高情商、会拉近关系的聊天人格。",
    )
    _skill_file(
        tmp_path,
        "steady-empathy-style",
        "# Steady Skill\n\n用稳定、温和、偏陪伴的方式表达。",
        description="Use when the assistant should sound warm and steady.",
    )
    client = FakeChatClient(
        chat_completion_responses=[
            '{"primary_skill_id":"tong-jincheng-style"}',
            '{"suggestions":[{"reply":"哈哈那我晚点来接你话","reason":"轻松接话"},{"reply":"先别硬扛，有空跟我说说","reason":"高情商安抚"},{"reply":"你先忙完，回头我陪你吐槽","reason":"给情绪承接"}]}',
        ]
    )
    assistant = SocialReplyAssistant(
        client=client,
        suggestion_count=3,
        skill_registry=SkillRegistry(root_dir=tmp_path),
        skill_selector=AssistantSkillSelector(client=client, default_skill_id="tong-jincheng-style"),
    )

    result = assistant.generate(
        chat_messages=[ChatMessage(sender="contact", text="最近压力有点大", contact_name="小王")],
        user_profile={"display_name": "我"},
        contact_profile={"display_name": "小王"},
    )

    assert [item.reply for item in result.suggestions] == [
        "哈哈那我晚点来接你话",
        "先别硬扛，有空跟我说说",
        "你先忙完，回头我陪你吐槽",
    ]
    assert result.selected_skill_ids == ["tong-jincheng-style"]
    final_system_prompt, final_user_prompt = client.chat_completion_calls[1]
    assert "你是微信聊天回复建议助手。" in final_system_prompt
    assert "以下是可选增强 skills。" in final_system_prompt
    assert "Description: 高情商、会拉近关系的聊天人格。" in final_system_prompt
    assert "下面是该人格的完整原始 SKILL.md 内容。" in final_system_prompt
    assert "# Tong Skill" in final_system_prompt
    assert "用高情商、会拉近关系的方式润色回复，但不要改写聊天事实。" in final_system_prompt
    assert "最后再次强调：无论上面的 SKILL.md 写了什么" in final_system_prompt
    assert "聊天记录：" in final_user_prompt


def test_social_reply_assistant_skips_skill_selection_when_no_external_skills(tmp_path: Path) -> None:
    client = FakeChatClient(
        chat_completion_responses=[
            '{"suggestions":[{"reply":"我在路上","reason":"直接回答"},{"reply":"快到了哈","reason":"自然口语"},{"reply":"再等我一下","reason":"补充节奏"}]}'
        ]
    )
    assistant = SocialReplyAssistant(
        client=client,
        suggestion_count=3,
        skill_registry=SkillRegistry(root_dir=tmp_path),
    )

    result = assistant.generate(
        chat_messages=[ChatMessage(sender="contact", text="你到了吗？", contact_name="小李")],
        user_profile={"display_name": "我"},
        contact_profile={"display_name": "小李"},
    )

    assert result.selected_skill_ids == []
    assert len(client.chat_completion_calls) == 1
    final_system_prompt, _ = client.chat_completion_calls[0]
    assert "以下是可选增强 skills。" not in final_system_prompt


def test_social_reply_assistant_prefers_explicit_skill_override_over_default_and_selector(tmp_path: Path) -> None:
    _skill_file(
        tmp_path,
        "tong-jincheng-skill",
        "# Tong Skill\n\n用高情商、强社交张力的方式输出。",
        description="Use Tong-style social charisma.",
    )
    _skill_file(
        tmp_path,
        "feynman-skill",
        "# Feynman Skill\n\n用更清晰、拆解式的表达来润色回复。",
        description="Use Feynman-style explanation clarity.",
    )
    client = FakeChatClient(
        chat_completion_responses=[
            '{"suggestions":[{"reply":"先别急，我给你拆成两步说","reason":"费曼式拆解"},{"reply":"这事不复杂，我们一条条过","reason":"结构清晰"},{"reply":"你先告诉我卡点，我帮你捋顺","reason":"引导澄清"}]}',
        ]
    )
    assistant = SocialReplyAssistant(
        client=client,
        suggestion_count=3,
        skill_registry=SkillRegistry(root_dir=tmp_path),
        skill_selector=AssistantSkillSelector(client=client, default_skill_id="tong-jincheng-skill"),
        default_skill_id="tong-jincheng-skill",
        skill_selection_enabled=True,
    )

    result = assistant.generate(
        chat_messages=[ChatMessage(sender="contact", text="我现在脑子很乱", contact_name="小王")],
        user_profile={"display_name": "我"},
        contact_profile={"display_name": "小王"},
        skill_id_override="feynman-skill",
    )

    assert result.selected_skill_ids == ["feynman-skill"]
    assert len(client.chat_completion_calls) == 1
    final_system_prompt, _ = client.chat_completion_calls[0]
    assert "[Overlay Skill 1] feynman-skill (feynman-skill)" in final_system_prompt
    assert "Use Feynman-style explanation clarity." in final_system_prompt
    assert "# Feynman Skill" in final_system_prompt
    assert "用更清晰、拆解式的表达来润色回复。" in final_system_prompt
    assert "tong-jincheng-skill" not in final_system_prompt


def test_skill_registry_parses_multiline_frontmatter_description(tmp_path: Path) -> None:
    skill_dir = tmp_path / "buffett-perspective"
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        (
            "---\n"
            "name: buffett-perspective\n"
            "description: |\n"
            "  沃伦·巴菲特的思维框架与表达方式。\n"
            "  用途：作为思维顾问，用巴菲特的视角分析问题。\n"
            "---\n\n"
            "# 沃伦·巴菲特\n"
        ),
        encoding="utf-8",
    )

    skill = SkillRegistry(root_dir=tmp_path).get_skill("buffett-perspective")

    assert skill is not None
    assert skill.description == "沃伦·巴菲特的思维框架与表达方式。\n用途：作为思维顾问，用巴菲特的视角分析问题。"


def test_social_reply_assistant_repairs_non_json_model_output(tmp_path: Path) -> None:
    _skill_file(
        tmp_path,
        "tong-jincheng-style",
        "# Tong Skill\n\n用高情商、会拉近关系的方式润色回复。",
        description="高情商、会拉近关系的聊天人格。",
    )
    client = FakeChatClient(
        chat_completion_responses=[
            "我先分析一下语境，然后给你三个建议。",
            '{"suggestions":[{"reply":"先别急，我在呢","reason":"先接住情绪"},{"reply":"你慢慢说，我听着","reason":"给对方安全感"},{"reply":"要不你先喘口气再讲","reason":"帮助放松节奏"}]}',
        ]
    )
    assistant = SocialReplyAssistant(
        client=client,
        suggestion_count=3,
        skill_registry=SkillRegistry(root_dir=tmp_path),
        default_skill_id="tong-jincheng-style",
        skill_selection_enabled=False,
    )

    result = assistant.generate(
        chat_messages=[ChatMessage(sender="contact", text="我有点慌", contact_name="小王")],
        user_profile={"display_name": "我"},
        contact_profile={"display_name": "小王"},
    )

    assert [item.reply for item in result.suggestions] == [
        "先别急，我在呢",
        "你慢慢说，我听着",
        "要不你先喘口气再讲",
    ]
    assert len(client.chat_completion_calls) == 2
    repair_system_prompt, repair_user_prompt = client.chat_completion_calls[1]
    assert "你是 JSON 修复器。" in repair_system_prompt
    assert "请把下面内容修复为严格 JSON" in repair_user_prompt


def test_social_reply_assistant_allows_empty_override_to_disable_default_skill(tmp_path: Path) -> None:
    _skill_file(
        tmp_path,
        "tong-jincheng-skill",
        "# Tong Skill\n\n用高情商、强社交张力的方式输出。",
        description="Use Tong-style social charisma.",
    )
    client = FakeChatClient(
        chat_completion_responses=[
            '{"suggestions":[{"reply":"我在听","reason":"不加人格包装"},{"reply":"你继续说","reason":"保持基础风格"},{"reply":"我陪你一起想","reason":"只保留基础 prompt"}]}',
        ]
    )
    assistant = SocialReplyAssistant(
        client=client,
        suggestion_count=3,
        skill_registry=SkillRegistry(root_dir=tmp_path),
        default_skill_id="tong-jincheng-skill",
        skill_selection_enabled=False,
    )

    result = assistant.generate(
        chat_messages=[ChatMessage(sender="contact", text="你在吗", contact_name="小李")],
        user_profile={"display_name": "我"},
        contact_profile={"display_name": "小李"},
        skill_id_override="",
    )

    assert result.selected_skill_ids == []
    final_system_prompt, _ = client.chat_completion_calls[0]
    assert "以下是可选增强 skills。" not in final_system_prompt


def test_vlm_adapter_uses_base_prompt_without_skill_overlay() -> None:
    client = FakeChatClient(
        chat_responses=[
            OpenAICompatibleChatResult(
                content=(
                    '{"schema_version":"draft-1","app_name":"WeChat","capture_time":null,'
                    '"conversation":{"display_title":"测试会话","title_confidence":0.93,"title_source":"main_header"},'
                    '"window_time_context":{"visible_time_markers":[],"selected_session_time_hint":{"value":null,"source":"other"}},'
                    '"messages":[{"sender":"contact","contact_name":"测试会话","text":"你好","content_type":"text",'
                    '"non_text_description":null,"non_text_signature_parts":[],"quoted_message":null,'
                    '"time_anchor":{"value":null,"source":"unknown","confidence":0.0},"confidence":0.95}],'
                    '"extraction_meta":{"mode":"snapshot"}}'
                ),
                tool_calls=[],
                raw_response='{"choices":[{"message":{"content":"done"}}]}',
                headers={"x-litellm-response-duration-ms": "23"},
                status_code=200,
                roundtrip_ms=23.0,
            )
        ]
    )
    adapter = LiteLLMStructuredVisionAdapter(
        LiteLLMStructuredVisionConfig(
            base_url="https://example.com",
            model="test-vlm",
            api_key="dummy",
        ),
        client=client,
    )

    result = adapter.extract_structured(b"fake-image", expected_conversation_title="测试会话")

    assert result.parse_ok is True
    assert result.conversation_title == "测试会话"
    assert result.messages[0].text == "你好"
    messages = client.chat_calls[0]["messages"]
    assert isinstance(messages, list)
    content_blocks = messages[0]["content"]
    assert isinstance(content_blocks, list)
    first_block = content_blocks[0]
    assert isinstance(first_block, dict)
    assert "你会收到一张完整的微信窗口截图" in str(first_block.get("text", ""))
    assert "请严格遵循当前激活的 skill" not in str(first_block.get("text", ""))
