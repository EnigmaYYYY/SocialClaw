from __future__ import annotations

from social_copilot.agent.models import ChatMessage, ChatQuotedMessage
from social_copilot.agent.prompting import build_social_reply_prompts


def test_social_reply_prompts_stay_compact_without_profiles() -> None:
    system_prompt, user_prompt = build_social_reply_prompts(
        chat_messages=[
            ChatMessage(sender="contact", text="在吗", contact_name="小王", timestamp=None),
            ChatMessage(sender="user", text="在，怎么了", contact_name=None, timestamp=None),
        ],
        suggestion_count=3,
        max_messages=24,
        user_profile=None,
        contact_profile=None,
    )

    assert "User profile:\n- None" not in user_prompt
    assert "Contact profile:\n- None" not in user_prompt
    assert "用户历史回复风格总结" not in user_prompt
    assert len(system_prompt) <= 240
    assert len(user_prompt) <= 180


def test_social_reply_prompts_include_profiles_only_when_present() -> None:
    system_prompt, user_prompt = build_social_reply_prompts(
        chat_messages=[
            ChatMessage(sender="contact", text="周末一起吃饭吗", contact_name="小王", timestamp=None),
            ChatMessage(sender="user", text="可以啊，你想吃什么", contact_name=None, timestamp=None),
        ],
        suggestion_count=3,
        max_messages=24,
        user_profile={"display_name": "Me", "traits": [{"value": "回复直接"}]},
        contact_profile={"display_name": "小王", "traits": [{"value": "说话随意"}]},
    )

    assert "用户画像" in user_prompt
    assert "对方画像" in user_prompt
    assert '"suggestions"' in system_prompt


def test_social_reply_prompts_preserve_quoted_message_context() -> None:
    _, user_prompt = build_social_reply_prompts(
        chat_messages=[
            ChatMessage(
                sender="contact",
                text="快快关注 助力每一个梦想好吧😎",
                contact_name="宝宝💗",
                timestamp=None,
                quoted_message=ChatQuotedMessage(
                    sender_name="赵梓涵",
                    text="刷到叶老师的小红书了",
                ),
            ),
        ],
        suggestion_count=3,
        max_messages=24,
        user_profile=None,
        contact_profile=None,
    )

    assert "引用[赵梓涵]: 刷到叶老师的小红书了" in user_prompt


def test_social_reply_prompts_explicitly_frame_suggestions_as_user_drafts() -> None:
    system_prompt, user_prompt = build_social_reply_prompts(
        chat_messages=[
            ChatMessage(sender="contact", text="到哪啦", contact_name="宝宝💗", timestamp=None),
            ChatMessage(sender="user", text="约了三点半的顺风车去嘉定", contact_name=None, timestamp=None),
        ],
        suggestion_count=3,
        max_messages=24,
        user_profile={"display_name": "我", "traits": [{"value": "说话自然"}]},
        contact_profile={"display_name": "宝宝💗", "traits": [{"value": "关系亲密"}]},
    )

    assert "你是在替用户本人起草下一条可直接发送的微信消息" in system_prompt
    assert "用户画像代表要模仿的我方说话方式" in system_prompt
    assert "当前任务：替用户本人继续这段对话" in user_prompt
    assert "最后一条消息来自用户本人" in user_prompt
    assert "默认产出用户下一条还能继续发出的自然跟进" in user_prompt


def test_social_reply_prompts_mark_contact_as_the_other_party() -> None:
    _, user_prompt = build_social_reply_prompts(
        chat_messages=[
            ChatMessage(sender="user", text="周末你方便吗", contact_name=None, timestamp=None),
            ChatMessage(sender="contact", text="可以呀", contact_name="小王", timestamp=None),
        ],
        suggestion_count=3,
        max_messages=24,
        user_profile={"display_name": "我"},
        contact_profile={"display_name": "小王"},
    )

    assert "对方画像代表聊天对象，不是建议模仿对象" in user_prompt
    assert "最后一条消息来自对方" in user_prompt
