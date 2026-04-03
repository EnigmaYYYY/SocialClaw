import pytest
from types import SimpleNamespace

import copilot_orchestrator.routes as copilot_routes
from api_specs.unified_types import (
    SenderType,
    UnifiedMessage,
    generate_conversation_id,
    generate_target_user_id,
)
from copilot_orchestrator.chat_workflow import ChatWorkflowService
from api_specs.memory_types import RawDataType


class _CaptureWorkflowService:
    def __init__(self) -> None:
        self.request = None

    async def process_chat(self, request):
        self.request = request
        return SimpleNamespace(
            success=True,
            reply_suggestion=None,
            is_new_friend=False,
            profile_updated=False,
            user_profile_updated=False,
            contact_profile=None,
            error=None,
            to_dict=lambda: {
                "success": True,
                "reply_suggestion": None,
                "is_new_friend": False,
                "profile_updated": False,
                "user_profile_updated": False,
                "contact_profile": None,
                "error": None,
            }
        )


class _CaptureProfileManager:
    def __init__(self) -> None:
        self.kwargs = None

    async def extract_profiles(self, **kwargs):
        self.kwargs = kwargs
        return []


@pytest.mark.asyncio
async def test_process_chat_simple_builds_sender_type_enum_instances(monkeypatch):
    workflow = _CaptureWorkflowService()
    monkeypatch.setattr(copilot_routes, "get_chat_workflow_service", lambda: workflow)

    await copilot_routes.process_chat_simple(
        {
            "owner_user_id": "owner_1",
            "friend_name": "Alice",
            "messages": ["hello", "hi"],
            "last_message": "ping",
        }
    )

    assert workflow.request is not None
    assert all(isinstance(msg.sender_type, SenderType) for msg in workflow.request.messages)
    assert isinstance(workflow.request.incoming_message.sender_type, SenderType)


@pytest.mark.asyncio
async def test_process_chat_accepts_aligned_social_copilot_message_shape(monkeypatch):
    workflow = _CaptureWorkflowService()
    monkeypatch.setattr(copilot_routes, "get_chat_workflow_service", lambda: workflow)

    session_key = "微信::Alice"
    owner_user_id = "owner_1"

    await copilot_routes.process_chat(
        {
            "owner_user_id": owner_user_id,
            "session_key": session_key,
            "display_name": "Alice",
            "messages": [
                {
                    "message_id": "m_001",
                    "conversation_id": generate_conversation_id(session_key),
                    "sender_id": generate_target_user_id(session_key, owner_user_id),
                    "sender_name": "Alice",
                    "sender_type": "contact",
                    "content": "hello",
                    "content_type": "text",
                    "timestamp": "2026-03-12T10:00:00+08:00",
                    "reply_to": None,
                    "metadata": {
                        "frame_id": "f_001",
                    },
                },
                {
                    "message_id": "m_002",
                    "conversation_id": generate_conversation_id(session_key),
                    "sender_id": owner_user_id,
                    "sender_name": owner_user_id,
                    "sender_type": "user",
                    "content": "hi",
                    "content_type": "text",
                    "timestamp": "2026-03-12T10:01:00+08:00",
                    "reply_to": None,
                    "metadata": {
                        "frame_id": "f_001",
                    },
                },
            ],
            "incoming_message": {
                "message_id": "m_001",
                "conversation_id": generate_conversation_id(session_key),
                "sender_id": generate_target_user_id(session_key, owner_user_id),
                "sender_name": "Alice",
                "sender_type": "contact",
                "content": "hello",
                "content_type": "text",
                "timestamp": "2026-03-12T10:00:00+08:00",
                "reply_to": None,
                "metadata": {
                    "frame_id": "f_001",
                },
            },
        }
    )

    assert workflow.request is not None
    assert [msg.content for msg in workflow.request.messages] == ["hello", "hi"]
    assert workflow.request.messages[0].sender_type == SenderType.CONTACT
    assert workflow.request.messages[0].sender_name == "Alice"
    assert workflow.request.messages[0].conversation_id == generate_conversation_id(session_key)
    assert workflow.request.messages[1].sender_type == SenderType.USER
    assert workflow.request.messages[1].sender_name == owner_user_id
    assert workflow.request.incoming_message.message_id == "m_001"
    assert workflow.request.incoming_message.metadata["frame_id"] == "f_001"


@pytest.mark.asyncio
async def test_process_chat_keeps_legacy_message_shape_compatible(monkeypatch):
    workflow = _CaptureWorkflowService()
    monkeypatch.setattr(copilot_routes, "get_chat_workflow_service", lambda: workflow)

    session_key = "微信::Alice"

    await copilot_routes.process_chat(
        {
            "owner_user_id": "owner_1",
            "session_key": session_key,
            "display_name": "Alice",
            "messages": [
                {
                    "message_id": "legacy_1",
                    "content": "hello",
                    "sender_id": "contact_1",
                    "sender_name": "Alice",
                    "timestamp": "2026-03-12T10:00:00+08:00",
                    "role": "assistant",
                }
            ],
            "incoming_message": {
                "message_id": "legacy_1",
                "content": "hello",
                "sender_id": "contact_1",
                "sender_name": "Alice",
                "timestamp": "2026-03-12T10:00:00+08:00",
                "role": "assistant",
            },
        }
    )

    assert workflow.request is not None
    assert workflow.request.messages[0].sender_type == SenderType.CONTACT
    assert workflow.request.messages[0].conversation_id == generate_conversation_id(session_key)
    assert workflow.request.incoming_message.sender_type == SenderType.CONTACT


@pytest.mark.asyncio
async def test_extract_profile_via_evermemos_uses_profile_memory_message_schema(monkeypatch):
    service = ChatWorkflowService()
    profile_manager = _CaptureProfileManager()

    async def _fake_get_profile_manager():
        return profile_manager

    monkeypatch.setattr(service, "_get_profile_manager", _fake_get_profile_manager)

    messages = [
        UnifiedMessage(
            message_id="msg_1",
            conversation_id="conv_1",
            sender_id="contact_1",
            sender_name="Alice",
            sender_type=SenderType.CONTACT,
            content="hello",
            timestamp="2026-03-12T10:00:00+08:00",
        )
    ]

    await service._extract_profile_via_evermemos(
        owner_user_id="owner_1",
        session_key="wechat::alice",
        display_name="Alice",
        messages=messages,
        existing_profile=None,
    )

    assert profile_manager.kwargs is not None
    memcell = profile_manager.kwargs["memcells"][0]
    first_row = memcell.original_data[0]

    assert first_row["speaker_id"] == "contact_1"
    assert first_row["speaker_name"] == "Alice"
    assert first_row["content"] == "hello"
    assert first_row["role"] == "contact"


@pytest.mark.asyncio
async def test_extract_profile_via_evermemos_targets_contact_id_not_display_name(monkeypatch):
    service = ChatWorkflowService()
    profile_manager = _CaptureProfileManager()

    async def _fake_get_profile_manager():
        return profile_manager

    monkeypatch.setattr(service, "_get_profile_manager", _fake_get_profile_manager)

    session_key = "wechat::alice"
    owner_user_id = "owner_1"
    expected_target_user_id = generate_target_user_id(session_key, owner_user_id)

    messages = [
        UnifiedMessage(
            message_id="msg_1",
            conversation_id="conv_1",
            sender_id=expected_target_user_id,
            sender_name="Alice",
            sender_type=SenderType.CONTACT,
            content="hello",
            timestamp="2026-03-12T10:00:00+08:00",
        )
    ]

    await service._extract_profile_via_evermemos(
        owner_user_id=owner_user_id,
        session_key=session_key,
        display_name="Alice",
        messages=messages,
        existing_profile=None,
    )

    assert profile_manager.kwargs is not None
    memcell = profile_manager.kwargs["memcells"][0]

    assert memcell.user_id_list == [expected_target_user_id]
    assert memcell.participants == [owner_user_id, expected_target_user_id]
    assert profile_manager.kwargs["user_id_list"] == [expected_target_user_id]


@pytest.mark.asyncio
async def test_extract_profile_via_evermemos_uses_memcell_dataclass_contract(monkeypatch):
    service = ChatWorkflowService()
    profile_manager = _CaptureProfileManager()

    async def _fake_get_profile_manager():
        return profile_manager

    monkeypatch.setattr(service, "_get_profile_manager", _fake_get_profile_manager)

    messages = [
        UnifiedMessage(
            message_id="msg_1",
            conversation_id="conv_1",
            sender_id="contact_1",
            sender_name="Alice",
            sender_type=SenderType.CONTACT,
            content="hello",
            timestamp="2026-03-12T10:00:00+08:00",
        )
    ]

    await service._extract_profile_via_evermemos(
        owner_user_id="owner_1",
        session_key="wechat::alice",
        display_name="Alice",
        messages=messages,
        existing_profile=None,
    )

    memcell = profile_manager.kwargs["memcells"][0]
    assert memcell.event_id == "conv_owner_1_wechat::alice"
    assert memcell.group_id == "wechat::alice"
    assert memcell.group_name == "Alice"
    assert memcell.type == RawDataType.CONVERSATION
