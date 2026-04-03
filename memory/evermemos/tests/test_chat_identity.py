from api_specs.unified_types import SenderType, UnifiedMessage, generate_target_user_id

from chat_identity import resolve_chat_identity


def test_resolve_chat_identity_keeps_one_to_one_sessions_as_single_target():
    session_key = "微信::Alice"
    owner_user_id = "owner_1"

    identity = resolve_chat_identity(
        [
            UnifiedMessage(
                message_id="m1",
                conversation_id="conv_1",
                sender_id="contact_1",
                sender_name="Alice",
                sender_type=SenderType.CONTACT,
                content="hello",
                timestamp="2026-03-12T10:00:00+08:00",
            ),
            UnifiedMessage(
                message_id="m2",
                conversation_id="conv_1",
                sender_id=owner_user_id,
                sender_name=owner_user_id,
                sender_type=SenderType.USER,
                content="hi",
                timestamp="2026-03-12T10:01:00+08:00",
            ),
        ],
        owner_user_id=owner_user_id,
        session_key=session_key,
    )

    assert identity.is_group_chat is False
    assert identity.primary_target_user_id == generate_target_user_id(
        session_key, owner_user_id
    )
    assert identity.contact_targets[0].target_user_id == generate_target_user_id(
        session_key, owner_user_id
    )
    assert identity.contact_targets[0].display_name == "Alice"


def test_resolve_chat_identity_splits_group_chat_by_speaker():
    identity = resolve_chat_identity(
        [
            UnifiedMessage(
                message_id="m1",
                conversation_id="conv_1",
                sender_id="speaker_a",
                sender_name="Alice",
                sender_type=SenderType.CONTACT,
                content="hello",
                timestamp="2026-03-12T10:00:00+08:00",
            ),
            UnifiedMessage(
                message_id="m2",
                conversation_id="conv_1",
                sender_id="speaker_b",
                sender_name="Bob",
                sender_type=SenderType.CONTACT,
                content="hi",
                timestamp="2026-03-12T10:01:00+08:00",
            ),
            UnifiedMessage(
                message_id="m3",
                conversation_id="conv_1",
                sender_id="owner_1",
                sender_name="owner_1",
                sender_type=SenderType.USER,
                content="got it",
                timestamp="2026-03-12T10:02:00+08:00",
            ),
        ],
        owner_user_id="owner_1",
        session_key="微信群聊::project",
    )

    assert identity.is_group_chat is True
    assert [item.target_user_id for item in identity.contact_targets] == [
        "speaker_a",
        "speaker_b",
    ]
    assert [item.display_name for item in identity.contact_targets] == ["Alice", "Bob"]
    assert identity.primary_target_user_id == "speaker_a"
