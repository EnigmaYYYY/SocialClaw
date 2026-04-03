from social_copilot.visual_monitor.core.vlm_structured_parser import (
    parse_vlm_structured_content,
    parse_vlm_structured_payload,
)


def test_parse_vlm_structured_content_from_plain_json() -> None:
    content = """
    {
      "conversation_title": "三个臭皮匠(3)",
      "messages": [
        {"sender": "contact", "contact_name": "张三", "text": "晚上吃什么", "confidence": 0.93},
        {"sender": "user", "contact_name": null, "text": "火锅吧", "confidence": 0.95}
      ]
    }
    """
    messages, ok, title = parse_vlm_structured_content(content)
    assert ok is True
    assert title == "三个臭皮匠(3)"
    assert len(messages) == 2
    assert messages[0].sender == "contact"
    assert messages[1].sender == "user"


def test_parse_vlm_structured_content_from_fenced_json() -> None:
    content = """
    ```json
    {"messages":[{"sender":"unknown","text":"无法判断"}]}
    ```
    """
    messages, ok, title = parse_vlm_structured_content(content)
    assert ok is True
    assert title is None
    assert len(messages) == 1
    assert messages[0].sender == "unknown"


def test_parse_vlm_structured_content_returns_false_on_non_json() -> None:
    messages, ok, title = parse_vlm_structured_content("这不是 JSON")
    assert ok is False
    assert messages == []
    assert title is None


def test_parse_vlm_structured_payload_from_draft_contract_json() -> None:
    content = """
    {
      "schema_version": "draft-1",
      "app_name": "WeChat",
      "capture_time": "2026-03-28T16:11:23+08:00",
      "conversation": {
        "display_title": "上海辛巴宠物医院-客服专员",
        "title_confidence": 0.97,
        "title_source": "main_header"
      },
      "window_time_context": {
        "visible_time_markers": [
          {"value": "15:33", "source": "chat_separator", "position_hint": "main_chat"}
        ],
        "selected_session_time_hint": {
          "value": "15:53",
          "source": "sidebar_selected_session"
        }
      },
      "messages": [
        {
          "sender": "contact",
          "contact_name": "上海辛巴宠物医院-客服专员",
          "text": "正常下周五、周六记得过来拆线哈",
          "content_type": "text",
          "quoted_message": {
            "text": "收到，拆线前要注意什么吗",
            "sender_name": "我"
          },
          "confidence": 0.94,
          "time_anchor": {
            "value": "15:51",
            "source": "exact_separator",
            "confidence": 0.95
          }
        },
        {
          "sender": "contact",
          "contact_name": "上海辛巴宠物医院-客服专员",
          "text": "",
          "content_type": "sticker",
          "non_text_description": "一个拿喇叭的企鹅表情包",
          "non_text_signature_parts": ["penguin", "megaphone"],
          "confidence": 0.87
        }
      ],
      "extraction_meta": {
        "mode": "snapshot"
      }
    }
    """
    payload = parse_vlm_structured_payload(content)
    assert payload is not None
    assert payload.schema_version == "draft-1"
    assert payload.conversation.display_title == "上海辛巴宠物医院-客服专员"
    assert payload.window_time_context is not None
    assert payload.window_time_context.selected_session_time_hint is not None
    assert len(payload.messages) == 2
    assert payload.messages[0].time_anchor is not None
    assert payload.messages[0].time_anchor.value == "15:51"
    assert payload.messages[0].quoted_message is not None
    assert payload.messages[0].quoted_message.text == "收到，拆线前要注意什么吗"
    assert payload.messages[1].non_text_signature_parts == ["penguin", "megaphone"]


def test_parse_vlm_structured_content_uses_conversation_display_title_from_draft_contract() -> None:
    content = """
    {
      "schema_version": "draft-1",
      "conversation": {
        "display_title": "面试小组",
        "title_source": "main_header"
      },
      "messages": [
        {"sender": "user", "contact_name": null, "text": "收到", "confidence": 0.9}
      ]
    }
    """
    messages, ok, title = parse_vlm_structured_content(content)
    assert ok is True
    assert title == "面试小组"
    assert len(messages) == 1


def test_parse_vlm_structured_payload_accepts_null_selected_session_time_hint_value() -> None:
    content = """
    {
      "schema_version": "draft-1",
      "app_name": "WeChat",
      "capture_time": null,
      "conversation": {
        "display_title": "姜添翼（同济）",
        "title_confidence": 1.0,
        "title_source": "main_header"
      },
      "window_time_context": {
        "visible_time_markers": [],
        "selected_session_time_hint": {
          "value": null,
          "source": "other"
        }
      },
      "messages": [
        {
          "sender": "contact",
          "contact_name": "姜添翼（同济）",
          "text": "6666",
          "content_type": "text",
          "non_text_description": null,
          "non_text_signature_parts": ["text"],
          "quoted_message": {
            "text": "",
            "sender_name": null
          },
          "time_anchor": {
            "value": null,
            "source": "unknown",
            "confidence": 0.0
          },
          "confidence": 0.99
        }
      ],
      "extraction_meta": {
        "mode": "snapshot"
      }
    }
    """
    payload = parse_vlm_structured_payload(content)
    messages, ok, title = parse_vlm_structured_content(content)

    assert payload is not None
    assert payload.window_time_context is not None
    assert payload.window_time_context.selected_session_time_hint is not None
    assert payload.window_time_context.selected_session_time_hint.value is None
    assert payload.window_time_context.selected_session_time_hint.source == "other"
    assert ok is True
    assert title == "姜添翼（同济）"
    assert len(messages) == 1
