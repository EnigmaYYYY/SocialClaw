"""
Chat Workflow Service

处理前端与 Social Copilot 集成的完整工作流：
1. 新好友检测 → 基于聊天记录生成画像 → 更新用户自画像
2. 已有好友新消息 → 判断是否更新画像 → 给出回复建议
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from dataclasses import dataclass, field

from api_specs.dtos.memory_command import RawData, MemorizeRequest
from api_specs.memory_types import RawDataType
from api_specs.unified_types import (
    UnifiedProfile,
    UnifiedMessage,
    UnifiedFact,
    ProfileType,
    SocialAttributes,
    CommunicationStyle,
    IntimacyLevel,
    MessageLength,
    ReplySuggestionRequest,
    ReplySuggestionResponse,
    generate_profile_id,
    generate_target_user_id,
    generate_conversation_id,
)
from agentic_layer.memory_manager import MemoryManager
from copilot_orchestrator.converters import EverMemOSConverter, SocialCopilotConverter
from copilot_orchestrator.reply_generator import ReplyGenerator
from common_utils.datetime_utils import from_iso_format
from core.observation.logger import get_logger
from core.di import get_bean

logger = get_logger(__name__)


@dataclass
class ChatProcessResult:
    """聊天处理结果"""

    success: bool = True
    is_new_friend: bool = False
    profile_updated: bool = False
    user_profile_updated: bool = False
    contact_profile: Optional[UnifiedProfile] = None
    reply_suggestion: Optional[ReplySuggestionResponse] = None
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "success": self.success,
            "is_new_friend": self.is_new_friend,
            "profile_updated": self.profile_updated,
            "user_profile_updated": self.user_profile_updated,
            "contact_profile": self.contact_profile.to_dict() if self.contact_profile else None,
            "reply_suggestion": self.reply_suggestion.to_dict() if self.reply_suggestion else None,
            "error": self.error,
        }


@dataclass
class ChatProcessRequest:
    """聊天处理请求"""

    owner_user_id: str
    session_key: str  # 会话标识，如 "微信::张三"
    display_name: str  # 联系人显示名称
    messages: List[UnifiedMessage]  # 聊天记录
    incoming_message: Optional[UnifiedMessage] = None  # 最新收到的消息
    manual_intent: Optional[str] = None  # 手动意图
    force_profile_update: bool = False  # 是否强制更新画像
    force_memory_backfill: bool = False  # 是否回放未处理的历史聊天
    is_historical_import: bool = False  # 是否为历史导入模式（绕过pending_boundary）
    visual_context: Optional[str] = None  # VLM 场景描述文本（来自视觉检测）


class ChatWorkflowService:
    """
    聊天工作流服务

    核心职责：
    1. 检测新好友 vs 已有好友
    2. 新好友：基于聊天记录生成画像
    3. 已有好友：判断是否需要更新画像
    4. 返回回复建议
    """

    # 触发画像更新的消息阈值
    PROFILE_UPDATE_MESSAGE_THRESHOLD = 10
    PROFILE_UPDATE_MEMCELL_DELTA_THRESHOLD = 1
    # 触发画像更新的时间间隔（天）
    PROFILE_UPDATE_TIME_THRESHOLD_DAYS = 7
    FALLBACK_PHRASE_MAX_COUNT = 5
    # 超时保护
    MEMORY_SYNC_TIMEOUT_SECONDS = 60
    REPLY_SUGGESTION_TIMEOUT_SECONDS = 30

    def __init__(self):
        self._profile_repo = None
        self._conversation_repo = None
        self._conversation_message_repo = None
        self._memcell_repo = None
        self._memory_manager = None
        self._reply_generator = None
        self._profile_manager = None
        self._llm_provider = None
        self._episodic_memory_repo = None
        self._foresight_repo = None

    def _profile_trace_file(self) -> Path:
        log_dir = Path(__file__).resolve().parents[2] / "logs" / "profile_updates"
        log_dir.mkdir(parents=True, exist_ok=True)
        return log_dir / f"{datetime.now():%Y%m%d}.log"

    def _log_profile_trace(self, event: str, **payload: Any) -> None:
        record = {
            "ts": datetime.now().isoformat(),
            "event": event,
            **payload,
        }
        try:
            with self._profile_trace_file().open("a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
        except Exception as exc:
            logger.warning("Failed to write profile trace log: %s", exc)

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
        if self._memcell_repo is None:
            try:
                self._memcell_repo = get_bean("memcell_raw_repository")
            except Exception:
                self._memcell_repo = None
        return self._memcell_repo

    async def _get_conversation_message_repo(self):
        if self._conversation_message_repo is None:
            try:
                self._conversation_message_repo = get_bean("conversation_message_repository")
            except Exception:
                self._conversation_message_repo = None
        return self._conversation_message_repo

    async def _get_memory_manager(self):
        if self._memory_manager is None:
            try:
                self._memory_manager = get_bean("memory_manager")
            except Exception:
                self._memory_manager = None
            if self._memory_manager is None:
                self._memory_manager = MemoryManager()
        return self._memory_manager

    async def _get_llm_provider(self):
        """延迟获取 LLM provider"""
        if self._llm_provider is None:
            try:
                # 尝试从 DI 容器获取
                self._llm_provider = get_bean("llm_provider")
            except Exception:
                pass
            # 如果 DI 容器没有，直接创建
            if self._llm_provider is None:
                import os
                from memory_layer.llm.llm_provider import LLMProvider
                try:
                    self._llm_provider = LLMProvider(
                        provider_type=os.getenv("LLM_PROVIDER", "openai"),
                        model=os.getenv("LLM_MODEL", "gpt-4"),
                        base_url=os.getenv("LLM_BASE_URL"),
                        api_key=os.getenv("LLM_API_KEY"),
                        temperature=float(os.getenv("LLM_TEMPERATURE", "0.3")),
                        max_tokens=int(os.getenv("LLM_MAX_TOKENS", "16384")),
                    )
                    logger.info("Created LLMProvider directly: %s", os.getenv("LLM_MODEL", "gpt-4"))
                except Exception as e:
                    logger.warning("Failed to create LLMProvider: %s", e)
                    self._llm_provider = None
        return self._llm_provider

    async def _get_reply_generator(self):
        """延迟获取回复生成器"""
        if self._reply_generator is None:
            llm_provider = await self._get_llm_provider()
            self._reply_generator = ReplyGenerator(llm_provider)
        return self._reply_generator

    async def _get_profile_manager(self):
        """延迟获取画像管理器"""
        if self._profile_manager is None:
            try:
                from memory_layer.profile_manager import ProfileManager
                from memory_layer.profile_manager.config import ProfileManagerConfig, ScenarioType
                llm_provider = await self._get_llm_provider()
                if llm_provider is None:
                    logger.warning("LLM provider unavailable, skip ProfileManager initialization")
                    self._profile_manager = None
                    return None
                config = ProfileManagerConfig(scenario=ScenarioType.PRIVATE)
                self._profile_manager = ProfileManager(llm_provider=llm_provider, config=config)
            except Exception as e:
                logger.warning(f"Failed to get ProfileManager: {e}")
                self._profile_manager = None
        return self._profile_manager

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

    async def _get_recent_episodes(
        self,
        conversation_id: str,
        owner_user_id: str,
        limit: int = 5,
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
                    user_id=owner_user_id,
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
                            "time": time_str,
                        })
        except Exception as e:
            logger.warning(f"Failed to get recent episodes: {e}")
        return episodes_data

    async def _get_active_foresights(
        self,
        conversation_id: str,
        owner_user_id: str,
        limit: int = 3,
    ) -> List[Dict[str, Any]]:
        """获取当前会话有效的前瞻洞察"""
        foresights_data = []
        try:
            repo = await self._get_foresight_repo()
            if repo and conversation_id:
                from datetime import datetime as dt
                now = dt.now()
                foresights = await repo.get_by_conversation_id(
                    conversation_id=conversation_id,
                    limit=limit,
                    user_id=owner_user_id,
                )
                for f in foresights:
                    content = getattr(f, 'content', None) or getattr(f, 'foresight_text', None) or ''
                    end_time = getattr(f, 'end_time', None)
                    created_at = getattr(f, 'created_at', None)
                    time_str = created_at.isoformat() if hasattr(created_at, 'isoformat') else str(created_at)
                    if content and (not end_time or end_time > now):
                        foresights_data.append({
                            "content": content,
                            "time": time_str,
                        })
                foresights_data = foresights_data[:limit]
        except Exception as e:
            logger.warning(f"Failed to get active foresights: {e}")
        return foresights_data

    # ==================== 核心工作流 ====================

    async def process_chat(
        self,
        request: ChatProcessRequest
    ) -> ChatProcessResult:
        """
        处理聊天的完整工作流

        Args:
            request: 聊天处理请求

        Returns:
            ChatProcessResult: 处理结果
        """
        try:
            self._log_profile_trace(
                "process_chat_start",
                owner_user_id=request.owner_user_id,
                session_key=request.session_key,
                display_name=request.display_name,
                message_count=len(request.messages),
                force_profile_update=request.force_profile_update,
                force_memory_backfill=request.force_memory_backfill,
            )
            profile_repo = await self._get_profile_repo()
            conversation_id, messages_to_process, force_memory_replay = await self._prepare_new_message_batch(
                request
            )

            # ── 并行化：memory sync 与 profile 检测同时进行 ──
            sync_task = asyncio.create_task(
                self._sync_long_term_memory(
                    request=request,
                    conversation_id=conversation_id,
                    new_messages=messages_to_process,
                    force_memory_replay=force_memory_replay,
                )
            )

            # Step 1 (并行): 检测是新好友还是已有好友
            target_user_id = generate_target_user_id(request.session_key, request.owner_user_id)
            existing_contact = await profile_repo.get_by_owner_and_target(
                owner_user_id=request.owner_user_id,
                target_user_id=target_user_id
            )

            is_new_friend = existing_contact is None
            self._log_profile_trace(
                "contact_lookup",
                owner_user_id=request.owner_user_id,
                conversation_id=conversation_id,
                target_user_id=target_user_id,
                is_new_friend=is_new_friend,
                existing_profile_id=getattr(existing_contact, "profile_id", None),
            )

            # Step 2 (并行): 处理画像 — 与 memory sync 同时进行
            contact_profile = existing_contact
            profile_updated = False
            user_profile_updated = False

            if is_new_friend or request.force_profile_update:
                contact_profile, profile_updated = await self._extract_and_save_contact_profile(
                    owner_user_id=request.owner_user_id,
                    session_key=request.session_key,
                    display_name=request.display_name,
                    messages=request.messages,
                    existing_profile=existing_contact
                )
                user_profile_updated = await self._update_user_self_profile(
                    owner_user_id=request.owner_user_id,
                    messages=request.messages,
                    contact_display_name=request.display_name
                )

            elif request.force_memory_backfill or request.is_historical_import:
                profile_updated = False
            else:
                should_update = await self._should_update_profile(
                    profile=existing_contact,
                    new_messages=request.messages,
                    session_key=request.session_key
                )
                self._log_profile_trace(
                    "profile_update_gate",
                    owner_user_id=request.owner_user_id,
                    conversation_id=conversation_id,
                    target_user_id=target_user_id,
                    should_update=should_update,
                    new_message_count=len(request.messages),
                )

                if should_update:
                    contact_profile, profile_updated = await self._extract_and_save_contact_profile(
                        owner_user_id=request.owner_user_id,
                        session_key=request.session_key,
                        display_name=request.display_name,
                        messages=request.messages,
                        existing_profile=existing_contact
                    )

            # ── 等待 memory sync 完成（带超时保护）──
            try:
                memory_synced = await asyncio.wait_for(
                    asyncio.shield(sync_task),
                    timeout=self.MEMORY_SYNC_TIMEOUT_SECONDS,
                )
            except asyncio.TimeoutError:
                logger.warning(
                    "[process_chat] Memory sync timed out (%ds), continuing without sync: conversation=%s",
                    self.MEMORY_SYNC_TIMEOUT_SECONDS,
                    conversation_id,
                )
                memory_synced = False
            except Exception as exc:
                logger.warning("[process_chat] Memory sync failed: %s", exc)
                memory_synced = False

            await self._persist_conversation_messages(
                request=request,
                conversation_id=conversation_id,
                messages_to_persist=messages_to_process,
                skip_redis=memory_synced,
            )

            # Step 3: 生成回复建议（带超时保护）
            reply_suggestion = None
            if request.incoming_message and not (request.force_memory_backfill or request.is_historical_import):
                try:
                    reply_suggestion = await asyncio.wait_for(
                        self._generate_reply_suggestion(
                            request=request,
                            contact_profile=contact_profile
                        ),
                        timeout=self.REPLY_SUGGESTION_TIMEOUT_SECONDS,
                    )
                except asyncio.TimeoutError:
                    logger.warning(
                        "[process_chat] Reply suggestion timed out (%ds): conversation=%s",
                        self.REPLY_SUGGESTION_TIMEOUT_SECONDS,
                        conversation_id,
                    )
                    reply_suggestion = None

            return ChatProcessResult(
                success=True,
                is_new_friend=is_new_friend,
                profile_updated=profile_updated,
                user_profile_updated=user_profile_updated,
                contact_profile=contact_profile,
                reply_suggestion=reply_suggestion
            )

        except Exception as e:
            # R1: 清理孤立协程 — 如果 sync_task 还在运行，取消它
            if 'sync_task' in locals() and not sync_task.done():
                sync_task.cancel()
                logger.info("[process_chat] Cancelled orphan sync_task after exception")
            self._log_profile_trace(
                "process_chat_error",
                owner_user_id=request.owner_user_id,
                session_key=request.session_key,
                error=str(e),
            )
            logger.error(f"Failed to process chat: {e}")
            return ChatProcessResult(
                success=False,
                error=str(e)
            )

    async def _persist_conversation_messages(
        self,
        request: ChatProcessRequest,
        conversation_id: str,
        messages_to_persist: List[UnifiedMessage],
        skip_redis: bool = False,
    ) -> bool:
        """Persist current conversation messages into EverMemOS conversation storage."""
        conversation_repo = await self._get_conversation_repo()
        conversation_message_repo = await self._get_conversation_message_repo()
        if (not conversation_repo or skip_redis) and not conversation_message_repo:
            return False

        if not conversation_id:
            return False

        if not messages_to_persist:
            return False

        redis_saved = False
        if conversation_repo and not skip_redis:
            raw_data_list = self._build_raw_data_list(
                request=request,
                conversation_id=conversation_id,
                messages=messages_to_persist,
            )
            try:
                redis_saved = await conversation_repo.save_conversation_data(
                    raw_data_list=raw_data_list,
                    group_id=conversation_id,
                )
            except Exception as exc:
                logger.warning(
                    "Failed to persist conversation messages into Redis for %s: %s",
                    conversation_id,
                    exc,
                )

        mongo_saved = 0
        if conversation_message_repo:
            try:
                mongo_saved = await conversation_message_repo.save_messages(
                    owner_user_id=request.owner_user_id,
                    messages=messages_to_persist,
                )
            except Exception as exc:
                logger.warning(
                    "Failed to persist conversation messages into Mongo for %s: %s",
                    conversation_id,
                    exc,
                )

        return bool(redis_saved or mongo_saved > 0)

    async def _prepare_new_message_batch(
        self,
        request: ChatProcessRequest,
    ) -> Tuple[str, List[UnifiedMessage], bool]:
        conversation_repo = await self._get_conversation_repo()
        conversation_id = self._resolve_conversation_id(
            messages=request.messages,
            session_key=request.session_key,
        )
        candidate_messages = self._collect_candidate_messages(request)
        if not conversation_id or not candidate_messages:
            return conversation_id, candidate_messages, False

        should_force_replay = False
        if request.force_memory_backfill:
            current_memcell_count = await self._get_session_memcell_count(request.session_key)
            should_force_replay = (current_memcell_count or 0) <= 0
            if should_force_replay:
                return conversation_id, candidate_messages, True

        if not conversation_repo:
            return conversation_id, candidate_messages, False

        existing_message_ids: set[str] = set()
        try:
            existing_raw_data = await conversation_repo.get_conversation_data(
                group_id=conversation_id,
                limit=1000,
            )
            for raw_data in existing_raw_data:
                if raw_data.data_id:
                    existing_message_ids.add(str(raw_data.data_id))
                content = raw_data.content or {}
                message_id = content.get("message_id")
                if message_id:
                    existing_message_ids.add(str(message_id))
        except Exception as exc:
            logger.warning(
                "Failed to inspect existing conversation cache for %s: %s",
                conversation_id,
                exc,
            )
            return conversation_id, candidate_messages, False

        new_messages = []
        for message in candidate_messages:
            if self._ensure_message_id(message) in existing_message_ids:
                continue
            new_messages.append(message)
        return conversation_id, new_messages, False

    def _collect_candidate_messages(
        self,
        request: ChatProcessRequest,
    ) -> List[UnifiedMessage]:
        messages = list(request.messages)
        if request.incoming_message is not None:
            incoming_id = self._ensure_message_id(request.incoming_message)
            if not any(self._ensure_message_id(message) == incoming_id for message in messages):
                messages.append(request.incoming_message)
        return messages

    def _build_raw_data_list(
        self,
        request: ChatProcessRequest,
        conversation_id: str,
        messages: List[UnifiedMessage],
    ) -> List[RawData]:
        raw_data_list: List[RawData] = []
        for message in messages:
            raw_data_list.append(
                RawData(
                    data_id=self._ensure_message_id(message),
                    data_type="conversation",
                    content=message.to_dict(),
                    metadata={
                        "conversation_id": conversation_id,
                        "owner_user_id": request.owner_user_id,
                        "session_key": request.session_key,
                        "display_name": request.display_name,
                    },
                )
            )
        return raw_data_list

    async def _sync_long_term_memory(
        self,
        request: ChatProcessRequest,
        conversation_id: str,
        new_messages: List[UnifiedMessage],
        force_memory_replay: bool = False,
    ) -> bool:
        if not conversation_id or not new_messages:
            return False

        memory_manager = await self._get_memory_manager()
        if not memory_manager:
            return False

        target_user_id = generate_target_user_id(
            request.session_key,
            request.owner_user_id,
        )
        participants = [request.owner_user_id]
        if target_user_id and target_user_id not in participants:
            participants.append(target_user_id)

        try:
            conversation_repo = await self._get_conversation_repo()
            if force_memory_replay and conversation_repo:
                try:
                    await conversation_repo.delete_conversation_data(conversation_id)
                except Exception as exc:
                    logger.warning(
                        "Failed to reset conversation cache before backfill for %s: %s",
                        conversation_id,
                        exc,
                    )
            memorize_request = MemorizeRequest(
                history_raw_data_list=[],
                new_raw_data_list=[
                    RawData(
                        data_id=self._ensure_message_id(message),
                        data_type="conversation",
                        content=self._convert_message_to_memorize_content(
                            request=request,
                            conversation_id=conversation_id,
                            message=message,
                            participants=participants,
                        ),
                        metadata={
                            "conversation_id": conversation_id,
                            "owner_user_id": request.owner_user_id,
                            "session_key": request.session_key,
                            "display_name": request.display_name,
                        },
                    )
                    for message in new_messages
                ],
                raw_data_type=RawDataType.CONVERSATION,
                user_id_list=participants,
                conversation_id=conversation_id,
                group_id=conversation_id,
                group_name=request.display_name,
                current_time=self._extract_latest_message_time(new_messages),
                force_profile_extraction=request.force_profile_update,
                owner_user_id=request.owner_user_id,
                skip_pending_boundary=request.is_historical_import,
            )
            self._log_profile_trace(
                "memorize_request",
                owner_user_id=request.owner_user_id,
                conversation_id=conversation_id,
                skip_pending_boundary=request.force_memory_backfill,
                message_count=len(new_messages),
            )
            await memory_manager.memorize(memorize_request)
            return True
        except Exception as exc:
            logger.warning(
                "Failed to sync long-term memory for %s: %s",
                conversation_id,
                exc,
            )
            return False

    def _convert_message_to_memorize_content(
        self,
        request: ChatProcessRequest,
        conversation_id: str,
        message: UnifiedMessage,
        participants: List[str],
    ) -> Dict[str, Any]:
        sender_type_value = getattr(message.sender_type, "value", message.sender_type)
        if sender_type_value == "user":
            speaker_id = request.owner_user_id
        elif sender_type_value == "contact":
            speaker_id = generate_target_user_id(
                request.session_key,
                request.owner_user_id,
            )
        else:
            speaker_id = message.sender_id or "unknown"

        msg_type = self._map_content_type_to_msg_type(message.content_type)
        return {
            "message_id": self._ensure_message_id(message),
            "speaker_id": speaker_id,
            "speaker_name": message.sender_name or speaker_id,
            "sender_id": message.sender_id,
            "sender_name": message.sender_name,
            "sender_type": sender_type_value,
            "content": message.content,
            "timestamp": self._normalize_message_timestamp(message.timestamp),
            "conversation_id": conversation_id,
            "groupName": request.display_name,
            "group_id": conversation_id,
            "userIdList": participants,
            "referList": [],
            "msgType": msg_type,
            "reply_to": message.reply_to,
            "metadata": dict(message.metadata or {}),
        }

    def _map_content_type_to_msg_type(self, content_type: str) -> int:
        normalized = (content_type or "text").strip().lower()
        mapping = {
            "text": 1,
            "emoji": 1,
            "mixed": 1,
            "unknown": 1,
            "image": 2,
            "sticker": 2,
            "video": 3,
            "audio": 4,
            "file": 5,
        }
        return mapping.get(normalized, 1)

    def _normalize_message_timestamp(self, timestamp: Optional[str]) -> str:
        if timestamp:
            return timestamp
        return datetime.now().isoformat()

    def _extract_latest_message_time(
        self,
        messages: List[UnifiedMessage],
    ) -> datetime:
        for message in reversed(messages):
            if not message.timestamp:
                continue
            try:
                return from_iso_format(message.timestamp)
            except Exception:
                continue
        return datetime.now()

    async def _extract_and_save_contact_profile(
        self,
        owner_user_id: str,
        session_key: str,
        display_name: str,
        messages: List[UnifiedMessage],
        existing_profile: Optional[UnifiedProfile]
    ) -> Tuple[UnifiedProfile, bool]:
        """
        获取联系人画像（Phase 2 改造）

        不再独立提取 profile，而是依赖 memorize 管线（mem_memorize.py）
        通过 memcell → clustering → profile extraction → unified_profiles 写入。
        本方法仅从 unified_profiles 读取结果。

        Returns:
            (UnifiedProfile, bool): (画像, 是否有更新)
        """
        profile_repo = await self._get_profile_repo()
        conversation_id = self._resolve_conversation_id(messages, session_key)
        target_user_id = generate_target_user_id(session_key, owner_user_id)

        # The memorize pipeline (_sync_long_term_memory) has already run before
        # this method is called. It triggers clustering → profile extraction →
        # unified_profiles write (Phase 1). Re-read the profile to pick up updates.
        updated_profile = await profile_repo.get_by_owner_and_target(
            owner_user_id=owner_user_id,
            target_user_id=target_user_id,
        )

        if updated_profile:
            # Check if the profile was actually updated since the existing one
            was_updated = (
                existing_profile is None
                or getattr(updated_profile.metadata, "last_updated", None)
                != getattr(existing_profile.metadata, "last_updated", None)
            )

            if was_updated:
                # Ensure display_name is populated
                if not updated_profile.display_name or updated_profile.display_name == "unknown":
                    updated_profile.display_name = display_name
                if not updated_profile.conversation_id:
                    updated_profile.conversation_id = conversation_id

                self._log_profile_trace(
                    "profile_update_success",
                    mode="memcell_pipeline",
                    owner_user_id=owner_user_id,
                    conversation_id=conversation_id,
                    target_user_id=updated_profile.target_user_id,
                    profile_id=updated_profile.profile_id,
                    display_name=updated_profile.display_name,
                    traits=updated_profile.traits,
                    interests=updated_profile.interests,
                    occupation=updated_profile.occupation,
                    fact_count=len(updated_profile.facts),
                    source_memcell_count=getattr(updated_profile.metadata, "source_memcell_count", 0),
                )
                return updated_profile, True

            # Profile exists but wasn't updated this cycle
            return updated_profile, False

        # No profile in unified store yet (new friend, memcell threshold not met).
        # Create a stub profile so downstream consumers have something to work with.
        if existing_profile:
            self._log_profile_trace(
                "profile_stub_reuse",
                mode="memcell_pipeline",
                owner_user_id=owner_user_id,
                conversation_id=conversation_id,
                target_user_id=target_user_id,
            )
            return existing_profile, False

        stub = UnifiedProfile.create_contact_profile(
            owner_user_id=owner_user_id,
            session_key=session_key,
            display_name=display_name,
        )
        stub.conversation_id = conversation_id
        await profile_repo.upsert_by_owner_target(stub)

        self._log_profile_trace(
            "profile_stub_created",
            mode="memcell_pipeline",
            owner_user_id=owner_user_id,
            conversation_id=conversation_id,
            target_user_id=stub.target_user_id,
            profile_id=stub.profile_id,
            display_name=display_name,
        )
        return stub, True

    async def _update_user_self_profile(
        self,
        owner_user_id: str,
        messages: List[UnifiedMessage],
        contact_display_name: str
    ) -> bool:
        """
        更新用户自画像

        分析用户与该联系人的对话风格
        """
        profile_repo = await self._get_profile_repo()

        # 获取用户自画像
        user_profile = await profile_repo.get_user_profile(owner_user_id)

        if not user_profile:
            user_profile = UnifiedProfile.create_user_profile(owner_user_id)

        # 分析用户自己的消息
        user_messages = [m for m in messages if m.sender_id == owner_user_id or m.sender_type == "user"]

        if user_messages:
            # 计算平均消息长度
            avg_len = sum(len(m.content) for m in user_messages) / len(user_messages) if user_messages else 0
            if avg_len < 10:
                msg_length_label = "消息简短"
            elif avg_len < 50:
                msg_length_label = "消息中等长度"
            else:
                msg_length_label = "消息较长"

            # 更新 communication_style 列表（添加消息长度偏好）
            from api_specs.unified_types import ProfileField
            existing_styles = {f.value for f in user_profile.communication_style if f.value}
            if msg_length_label not in existing_styles:
                user_profile.communication_style.append(
                    ProfileField(value=msg_length_label, evidence_level="L2", evidences=[])
                )

            # 提取口头禅
            from collections import Counter
            all_words = []
            for msg in user_messages:
                words = [w for w in msg.content if len(w) >= 2]
                all_words.extend(words)

            if all_words:
                word_freq = Counter(all_words)
                existing_phrases = {f.value for f in user_profile.catchphrase if f.value}
                for w, _ in word_freq.most_common(5):
                    if w not in existing_phrases:
                        user_profile.catchphrase.append(
                            ProfileField(value=w, evidence_level="L1", evidences=[])
                        )

        fallback_phrases = self._extract_fallback_phrases(user_messages)
        if fallback_phrases:
            existing_phrases = {f.value for f in user_profile.catchphrase if f.value}
            for phrase in fallback_phrases:
                if phrase not in existing_phrases:
                    user_profile.catchphrase.append(
                        ProfileField(value=phrase, evidence_level="L1", evidences=[])
                    )

        user_profile.metadata.last_updated = datetime.now().isoformat()
        await profile_repo.save_profile(user_profile)
        return True

    async def _should_update_profile(
        self,
        profile: UnifiedProfile,
        new_messages: List[UnifiedMessage],
        session_key: str
    ) -> bool:
        """
        判断是否需要更新画像

        条件：
        1. 新消息数量超过阈值
        2. 距离上次更新超过一定时间
        3. 检测到重要信息变化
        """
        if not profile:
            return True

        # 检查消息数量
        if len(new_messages) >= self.PROFILE_UPDATE_MESSAGE_THRESHOLD:
            return True

        # 检查时间
        current_memcell_count = await self._get_session_memcell_count(session_key)
        profile_memcell_count = (
            profile.metadata.source_memcell_count
            if profile.metadata and profile.metadata.source_memcell_count is not None
            else 0
        )
        if (
            current_memcell_count is not None
            and current_memcell_count - profile_memcell_count
            >= self.PROFILE_UPDATE_MEMCELL_DELTA_THRESHOLD
        ):
            return True

        if profile.metadata and profile.metadata.last_updated:
            try:
                last_updated_dt = from_iso_format(profile.metadata.last_updated)
                days_since_update = (datetime.now(last_updated_dt.tzinfo) - last_updated_dt).days
                if days_since_update >= self.PROFILE_UPDATE_TIME_THRESHOLD_DAYS:
                    return True
            except Exception:
                logger.warning(
                    "Failed to parse profile last_updated for %s: %s",
                    getattr(profile, "profile_id", None),
                    profile.metadata.last_updated,
                )

        return False

    async def _get_session_memcell_count(self, session_key: str) -> Optional[int]:
        memcell_repo = await self._get_memcell_repo()
        if not memcell_repo:
            return None

        try:
            group_ids = []
            if session_key:
                group_ids.append(session_key)
                conversation_id = generate_conversation_id(session_key)
                if conversation_id not in group_ids:
                    group_ids.append(conversation_id)

            total = 0
            seen_event_ids = set()
            for group_id in group_ids:
                memcells = await memcell_repo.find_by_group_id(group_id)
                for memcell in memcells:
                    event_id = getattr(memcell, "event_id", None) or id(memcell)
                    if event_id in seen_event_ids:
                        continue
                    seen_event_ids.add(event_id)
                    total += 1
            return total
        except Exception as e:
            logger.warning("Failed to load memcells for session %s: %s", session_key, e)
            return None

    def _resolve_conversation_id(self, messages: List[UnifiedMessage], session_key: str) -> str:
        for message in messages:
            if message.conversation_id:
                return message.conversation_id
        return generate_conversation_id(session_key) if session_key else ""

    def _ensure_message_id(self, message: UnifiedMessage) -> str:
        if message.message_id:
            return message.message_id
        fallback = f"{message.sender_id}|{message.timestamp}|{message.content}|{message.content_type}"
        message.message_id = f"msg_{hashlib.sha256(fallback.encode('utf-8')).hexdigest()[:16]}"
        return message.message_id

    def _build_conversation_text(self, messages: List[UnifiedMessage]) -> str:
        """构建对话文本用于画像抽取"""
        lines = []
        for msg in messages:
            sender = msg.sender_name or msg.sender_id or "Unknown"
            lines.append(f"[{sender}]: {msg.content}")
        return "\n".join(lines)

    def _extract_fallback_phrases(self, messages: List[UnifiedMessage]) -> List[str]:
        from collections import Counter

        phrase_counter: Counter[str] = Counter()
        for msg in messages:
            content = (msg.content or "").strip()
            if not content:
                continue

            cjk_chunks = re.findall(r"[\u4e00-\u9fff]{2,12}", content)
            ascii_chunks = re.findall(r"[A-Za-z][A-Za-z0-9'_-]{1,31}", content)
            emoji_chunks = re.findall(r"[\U00010000-\U0010ffff]", content)

            for chunk in cjk_chunks + ascii_chunks + emoji_chunks:
                normalized = chunk.strip()
                if not normalized:
                    continue
                if normalized in {"哈哈", "嘿嘿", "嗯嗯", "好的"}:
                    continue
                phrase_counter[normalized] += 1

        return [
            phrase
            for phrase, _ in phrase_counter.most_common(self.FALLBACK_PHRASE_MAX_COUNT)
        ]

    async def _generate_reply_suggestion(
        self,
        request: ChatProcessRequest,
        contact_profile: Optional[UnifiedProfile]
    ) -> ReplySuggestionResponse:
        """生成回复建议"""
        logger.info("🐳🐳🐳 _generate_reply_suggestion called, incoming_message: %s",
                    request.incoming_message.content if request.incoming_message else "None")
        profile_repo = await self._get_profile_repo()

        # 获取用户画像
        user_profile = await profile_repo.get_user_profile(request.owner_user_id)
        if not user_profile:
            user_profile = UnifiedProfile.create_user_profile(request.owner_user_id)

        # 构建回复请求
        conversation_id = self._resolve_conversation_id(request.messages, request.session_key)
        reply_request = ReplySuggestionRequest(
            conversation_id=conversation_id,
            owner_user_id=request.owner_user_id,
            target_user_id=generate_target_user_id(request.session_key, request.owner_user_id),
            incoming_message=request.incoming_message,
            manual_intent=request.manual_intent,
            history_window=20
        )

        # 获取情景记忆和前瞻洞察
        episodes = await self._get_recent_episodes(
            conversation_id=conversation_id,
            owner_user_id=request.owner_user_id,
            limit=5
        )
        foresights = await self._get_active_foresights(
            conversation_id=conversation_id,
            owner_user_id=request.owner_user_id,
            limit=3
        )
        logger.info(
            "🐳 episodes=%d, foresights=%d for conversation=%s",
            len(episodes), len(foresights), conversation_id,
        )

        # 生成回复
        reply_generator = await self._get_reply_generator()
        logger.info("🐳🐳🐳 reply_generator.llm_provider: %s", reply_generator.llm_provider)
        response = await reply_generator.generate_reply(
            request=reply_request,
            user_profile=user_profile,
            contact_profile=contact_profile,
            recent_messages=request.messages[-20:],  # 最近20条消息
            episodes=episodes,
            foresights=foresights,
            visual_context=getattr(request, 'visual_context', None),
        )

        return response


# 单例
_chat_workflow_service = None


def get_chat_workflow_service() -> ChatWorkflowService:
    """获取 ChatWorkflowService 单例"""
    global _chat_workflow_service
    if _chat_workflow_service is None:
        _chat_workflow_service = ChatWorkflowService()
    return _chat_workflow_service
