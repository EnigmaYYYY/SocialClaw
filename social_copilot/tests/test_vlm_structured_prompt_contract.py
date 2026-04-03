from social_copilot.visual_monitor.adapters.vision_litellm_structured import (
    DEFAULT_WECHAT_INCREMENTAL_PROMPT,
    DEFAULT_WECHAT_STRUCTURED_PROMPT,
)


def test_snapshot_prompt_requests_draft_contract_fields() -> None:
    assert "schema_version" in DEFAULT_WECHAT_STRUCTURED_PROMPT
    assert "window_time_context" in DEFAULT_WECHAT_STRUCTURED_PROMPT
    assert "time_anchor" in DEFAULT_WECHAT_STRUCTURED_PROMPT
    assert "non_text_signature_parts" in DEFAULT_WECHAT_STRUCTURED_PROMPT
    assert "完整的微信窗口截图" in DEFAULT_WECHAT_STRUCTURED_PROMPT
    assert "不要提取左侧会话列表里的预览文本" in DEFAULT_WECHAT_STRUCTURED_PROMPT
    assert "不要编造时间" in DEFAULT_WECHAT_STRUCTURED_PROMPT
    assert "左侧白气泡" in DEFAULT_WECHAT_STRUCTURED_PROMPT
    assert "误判成 user" in DEFAULT_WECHAT_STRUCTURED_PROMPT


def test_incremental_prompt_requests_draft_contract_fields() -> None:
    assert "schema_version" in DEFAULT_WECHAT_INCREMENTAL_PROMPT
    assert "window_time_context" in DEFAULT_WECHAT_INCREMENTAL_PROMPT
    assert "time_anchor" in DEFAULT_WECHAT_INCREMENTAL_PROMPT
    assert "non_text_signature_parts" in DEFAULT_WECHAT_INCREMENTAL_PROMPT
    assert "older（上一帧）与 newer（当前帧）" in DEFAULT_WECHAT_INCREMENTAL_PROMPT
    assert "不要提取左侧会话列表里的预览文本" in DEFAULT_WECHAT_INCREMENTAL_PROMPT
    assert "expected_conversation_title" not in DEFAULT_WECHAT_INCREMENTAL_PROMPT
    assert "不要编造时间" in DEFAULT_WECHAT_INCREMENTAL_PROMPT
