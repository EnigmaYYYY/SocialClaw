from pathlib import Path
import sys

from api_specs.unified_types import SenderType, generate_conversation_id, generate_target_user_id

SRC_DIR = Path(__file__).resolve().parents[1] / "src" / "copilot_orchestrator"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from converters import SocialCopilotConverter  # noqa: E402


def test_convert_chat_record_preserves_contact_sender_id():
    session_key = "微信群聊::project"
    owner_user_id = "owner_1"
    conversation_id = generate_conversation_id(session_key)

    message = SocialCopilotConverter.convert_chat_record(
        {
            "message_id": "m_001",
            "conversation_id": conversation_id,
            "sender": "contact",
            "sender_id": "speaker_a",
            "sender_name": "Alice",
            "text": "hello",
            "timestamp": "2026-03-12T10:00:00+08:00",
        },
        conversation_id=conversation_id,
        owner_user_id=owner_user_id,
        session_key=session_key,
    )

    assert message.sender_type == SenderType.CONTACT
    assert message.sender_id == "speaker_a"
    assert message.sender_name == "Alice"


def test_convert_chat_record_falls_back_to_generated_target_when_sender_id_missing():
    session_key = "微信群聊::project"
    owner_user_id = "owner_1"
    conversation_id = generate_conversation_id(session_key)
    expected_target_user_id = generate_target_user_id(session_key, owner_user_id)

    message = SocialCopilotConverter.convert_chat_record(
        {
            "message_id": "m_001",
            "conversation_id": conversation_id,
            "sender": "contact",
            "sender_name": "Alice",
            "text": "hello",
            "timestamp": "2026-03-12T10:00:00+08:00",
        },
        conversation_id=conversation_id,
        owner_user_id=owner_user_id,
        session_key=session_key,
    )

    assert message.sender_type == SenderType.CONTACT
    assert message.sender_id == expected_target_user_id
    assert message.sender_name == "Alice"
