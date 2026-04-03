"""
Simple Boundary Detection Base Class for EverMemOS

This module provides a simple and extensible base class for detecting
boundaries in various types of content (conversations, emails, notes, etc.).
"""

from typing import Dict, Any, Optional, List, Tuple
from datetime import datetime
from dataclasses import dataclass
import uuid
import json, re
import asyncio
import os
from common_utils.logging_utils import summarize_text, dump_llm_artifacts
from core.di.utils import get_bean, get_bean_by_type
from core.component.llm.tokenizer.tokenizer_factory import TokenizerFactory
from common_utils.datetime_utils import (
    from_iso_format as dt_from_iso_format,
)
from memory_layer.llm.llm_provider import LLMProvider
from api_specs.memory_types import RawDataType

from memory_layer.prompts import get_prompt_by
from memory_layer.memcell_extractor.base_memcell_extractor import (
    MemCellExtractor,
    RawData,
    MemCell,
    StatusResult,
    MemCellExtractRequest,
)
from core.observation.logger import get_logger

logger = get_logger(__name__)


@dataclass
class BoundaryDetectionResult:
    """Boundary detection result."""

    should_end: bool
    should_wait: bool
    reasoning: str
    confidence: float
    topic_summary: Optional[str] = None
    split_index: Optional[int] = None


@dataclass
class ConversationMemCellExtractRequest(MemCellExtractRequest):
    pass


class ConvMemCellExtractor(MemCellExtractor):
    """
    Conversation MemCell Extractor - Responsible only for boundary detection and creating basic MemCell

    Responsibilities:
    1. Boundary detection (determine whether current MemCell should end)
    2. Create basic MemCell (including basic fields such as original_data, summary, timestamp, etc.)

    Not included:
    - Episode extraction (handled by EpisodeMemoryExtractor)
    - Foresight extraction (handled by ForesightExtractor)
    - EventLog extraction (handled by EventLogExtractor)
    - Embedding computation (handled by MemoryManager)

    Language support:
    - Controlled by MEMORY_LANGUAGE env var: 'zh' (Chinese) or 'en' (English), default 'en'
    """

    # Default limits for force splitting
    DEFAULT_HARD_TOKEN_LIMIT = 8192
    DEFAULT_HARD_MESSAGE_LIMIT = 50

    @classmethod
    def _get_tokenizer(cls):
        """Get the shared tokenizer from tokenizer factory (with caching)."""
        tokenizer_factory: TokenizerFactory = get_bean_by_type(TokenizerFactory)
        return tokenizer_factory.get_tokenizer_from_tiktoken("o200k_base")

    def __init__(
        self,
        llm_provider=LLMProvider,
        boundary_detection_prompt: Optional[str] = None,
        use_eval_prompts: bool = False,
        hard_token_limit: Optional[int] = None,
        hard_message_limit: Optional[int] = None,
    ):
        super().__init__(RawDataType.CONVERSATION, llm_provider)
        self.llm_provider = llm_provider

        # Force split limits
        self.hard_token_limit = hard_token_limit or self.DEFAULT_HARD_TOKEN_LIMIT
        self.hard_message_limit = hard_message_limit or self.DEFAULT_HARD_MESSAGE_LIMIT

        # Use custom prompt or get default via PromptManager
        self.conv_boundary_detection_prompt = (
            boundary_detection_prompt or get_prompt_by("CONV_BOUNDARY_DETECTION_PROMPT")
        )

    def shutdown(self) -> None:
        """Cleanup resources."""
        pass

    def _count_tokens(self, messages: List[Dict[str, Any]]) -> int:
        """
        Count total tokens in message list using tiktoken.

        Includes speaker_name in token count since it's included when passed to LLM.

        Args:
            messages: List of message dictionaries

        Returns:
            Total token count
        """
        tokenizer = self._get_tokenizer()
        total = 0
        for msg in messages:
            if isinstance(msg, dict):
                speaker = msg.get('speaker_name', '')
                content = msg.get('content', '')
                # Format matches what's sent to LLM: "speaker: content"
                text = f"{speaker}: {content}" if speaker else content
            else:
                text = str(msg)
            total += len(tokenizer.encode(text))
        return total

    def _extract_participant_ids(
        self, chat_raw_data_list: List[Dict[str, Any]]
    ) -> List[str]:
        """
        Extract all participant IDs from chat_raw_data_list

        Retrieve from the content dictionary of each element:
        1. speaker_id (speaker ID)
        2. All _id in referList (@mentioned user IDs)

        Args:
            chat_raw_data_list: List of raw chat data

        Returns:
            List[str]: List of deduplicated participant IDs
        """
        participant_ids = set()

        for raw_data in chat_raw_data_list:

            # Extract speaker_id
            if 'speaker_id' in raw_data and raw_data['speaker_id']:
                participant_ids.add(raw_data['speaker_id'])

            # Extract all IDs from referList
            if 'referList' in raw_data and raw_data['referList']:
                for refer_item in raw_data['referList']:
                    # refer_item may be a dictionary format containing _id field
                    if isinstance(refer_item, dict):
                        # Handle MongoDB ObjectId format _id
                        if '_id' in refer_item:
                            refer_id = refer_item['_id']
                            # If it's an ObjectId object, convert to string
                            if hasattr(refer_id, '__str__'):
                                participant_ids.add(str(refer_id))
                            else:
                                participant_ids.add(refer_id)
                        # Also check regular id field
                        elif 'id' in refer_item:
                            participant_ids.add(refer_item['id'])
                    # If refer_item is directly an ID string
                    elif isinstance(refer_item, str):
                        participant_ids.add(refer_item)

        return list(participant_ids)

    def _format_conversation_dicts(
        self, messages: list[dict[str, str]], include_timestamps: bool = False
    ) -> str:
        """Format conversation from message dictionaries into plain text."""
        lines = []
        for i, msg in enumerate(messages):
            content = msg.get("content", "")
            speaker_name = msg.get("speaker_name", "")
            timestamp = msg.get("timestamp", "")

            if content:
                if include_timestamps and timestamp:
                    try:
                        # Handle different types of timestamp
                        if isinstance(timestamp, datetime):
                            # If it's a datetime object, format directly
                            time_str = timestamp.strftime("%Y-%m-%d %H:%M:%S")
                            lines.append(f"[{time_str}] {speaker_name}: {content}")
                        elif isinstance(timestamp, str):
                            # If it's a string, parse and then format
                            dt = datetime.fromisoformat(
                                timestamp.replace("Z", "+00:00")
                            )
                            time_str = dt.strftime("%Y-%m-%d %H:%M:%S")
                            lines.append(f"[{time_str}] {speaker_name}: {content}")
                        else:
                            # Other types, do not include timestamp
                            lines.append(f"{speaker_name}: {content}")
                    except (ValueError, AttributeError, TypeError):
                        # Fallback if timestamp parsing fails
                        lines.append(f"{speaker_name}: {content}")
                else:
                    lines.append(f"{speaker_name}: {content}")
            else:
                print(msg)
                print(
                    f"[ConversationEpisodeBuilder] Warning: message {i} has no content"
                )
        return "\n".join(lines)

    def _save_boundary_artifacts(
        self, prompt: str, response: Optional[str], attempt: int
    ) -> None:
        """Save boundary detection prompt/response for inspection."""
        try:
            base_dir = os.path.join("logs")
            prompt_dir = os.path.join(base_dir, "boundary_prompts")
            response_dir = os.path.join(base_dir, "boundary_responses")
            os.makedirs(prompt_dir, exist_ok=True)
            os.makedirs(response_dir, exist_ok=True)

            ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S_%f")
            suffix = f"{ts}_attempt_{attempt}_{uuid.uuid4().hex[:8]}"
            prompt_path = os.path.join(
                prompt_dir, f"boundary_prompt_{suffix}.txt"
            )
            response_path = os.path.join(
                response_dir, f"boundary_response_{suffix}.txt"
            )

            with open(prompt_path, "w", encoding="utf-8") as f:
                f.write(prompt or "")
            with open(response_path, "w", encoding="utf-8") as f:
                f.write(response or "")
        except Exception as e:
            logger.warning(
                "[ConversationEpisodeBuilder] Failed to save boundary artifacts: %s",
                e,
            )

    def _calculate_time_gap(
        self,
        conversation_history: list[dict[str, str]],
        new_messages: list[dict[str, str]],
    ):
        if not conversation_history or not new_messages:
            return "No time gap information available"

        try:
            # Get the last message from history and first new message
            last_history_msg = conversation_history[-1]
            first_new_msg = new_messages[0]

            last_timestamp_str = last_history_msg.get("timestamp", "")
            first_timestamp_str = first_new_msg.get("timestamp", "")

            if not last_timestamp_str or not first_timestamp_str:
                return "No timestamp information available"

            # Parse timestamps - handle different types of timestamp
            try:
                if isinstance(last_timestamp_str, datetime):
                    last_time = last_timestamp_str
                elif isinstance(last_timestamp_str, str):
                    last_time = datetime.fromisoformat(
                        last_timestamp_str.replace("Z", "+00:00")
                    )
                else:
                    return "Invalid timestamp format for last message"

                if isinstance(first_timestamp_str, datetime):
                    first_time = first_timestamp_str
                elif isinstance(first_timestamp_str, str):
                    first_time = datetime.fromisoformat(
                        first_timestamp_str.replace("Z", "+00:00")
                    )
                else:
                    return "Invalid timestamp format for first message"
            except (ValueError, TypeError):
                return "Failed to parse timestamps"

            # Calculate time difference
            time_diff = first_time - last_time
            total_seconds = time_diff.total_seconds()

            if total_seconds < 0:
                return "Time gap: Messages appear to be out of order"
            elif total_seconds < 60:  # Less than 1 minute
                return f"Time gap: {int(total_seconds)} seconds (immediate response)"
            elif total_seconds < 3600:  # Less than 1 hour
                minutes = int(total_seconds // 60)
                return f"Time gap: {minutes} minutes (recent conversation)"
            elif total_seconds < 86400:  # Less than 1 day
                hours = int(total_seconds // 3600)
                return f"Time gap: {hours} hours (same day, but significant pause)"
            else:  # More than 1 day
                days = int(total_seconds // 86400)
                return f"Time gap: {days} days (long gap, likely new conversation)"

        except (ValueError, KeyError, AttributeError) as e:
            return f"Time gap calculation error: {str(e)}"

    def _get_message_time(self, msg: Dict[str, Any]) -> Optional[datetime]:
        """Extract datetime from a message dict if possible."""
        if not isinstance(msg, dict):
            return None
        ts_value = msg.get("timestamp") or msg.get("createTime") or msg.get(
            "create_time"
        )
        try:
            if isinstance(ts_value, datetime):
                return ts_value
            if isinstance(ts_value, str) and ts_value:
                return datetime.fromisoformat(ts_value.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            return None
        return None

    def _find_split_index_by_time_gap(
        self, new_messages: List[Dict[str, Any]]
    ) -> Optional[int]:
        """Find split point within new messages based on large time gap."""
        if len(new_messages) < 2:
            return None
        best_idx = None
        best_gap = 0.0
        for i in range(1, len(new_messages)):
            t1 = self._get_message_time(new_messages[i - 1])
            t2 = self._get_message_time(new_messages[i])
            if not t1 or not t2:
                continue
            gap = (t2 - t1).total_seconds()
            if gap > best_gap:
                best_gap = gap
                best_idx = i
        # Heuristic: consider a "large gap" as >= 24 hours
        if best_idx is not None and best_gap >= 24 * 3600:
            return best_idx
        return None

    async def _find_split_index_with_llm(
        self,
        conversation_history: List[Dict[str, Any]],
        new_messages: List[Dict[str, Any]],
        smart_mask_flag: bool,
    ) -> int:
        """Binary search split point inside the batch using boundary detection."""
        if len(new_messages) < 2:
            return 0

        left, right = 0, len(new_messages) - 1
        earliest_true: Optional[int] = None
        max_iters = min(5, len(new_messages))

        for _ in range(max_iters):
            mid = (left + right) // 2
            history_part = conversation_history + new_messages[:mid]
            new_part = new_messages[mid:]
            if not new_part:
                break

            if smart_mask_flag and len(history_part) > 0:
                history_for_detect = history_part[:-1]
            else:
                history_for_detect = history_part

            result = await self._detect_boundary(
                conversation_history=history_for_detect,
                new_messages=new_part,
            )

            if result.should_end:
                earliest_true = mid
                right = mid - 1
            else:
                left = mid + 1

            if left > right:
                break

        return earliest_true if earliest_true is not None else 0

    async def _find_split_index(
        self,
        conversation_history: List[Dict[str, Any]],
        new_messages: List[Dict[str, Any]],
        smart_mask_flag: bool,
    ) -> int:
        """Find split point within new messages."""
        time_gap_idx = self._find_split_index_by_time_gap(new_messages)
        if time_gap_idx is not None:
            return time_gap_idx
        return await self._find_split_index_with_llm(
            conversation_history, new_messages, smart_mask_flag
        )

    async def _detect_boundary(
        self,
        conversation_history: list[dict[str, str]],
        new_messages: list[dict[str, str]],
    ) -> BoundaryDetectionResult:
        if not conversation_history:
            return BoundaryDetectionResult(
                should_end=False,
                should_wait=False,
                reasoning="First messages in conversation",
                confidence=1.0,
                topic_summary="",
            )
        history_text = self._format_conversation_dicts(
            conversation_history, include_timestamps=True
        )
        # Number new messages so the LLM can return a split index reliably.
        new_lines = []
        for i, msg in enumerate(new_messages):
            content = msg.get("content", "") if isinstance(msg, dict) else str(msg)
            speaker_name = msg.get("speaker_name", "") if isinstance(msg, dict) else ""
            timestamp = msg.get("timestamp", "") if isinstance(msg, dict) else ""
            prefix = f"[{i+1}]"
            if timestamp:
                try:
                    if isinstance(timestamp, datetime):
                        time_str = timestamp.strftime("%Y-%m-%d %H:%M:%S")
                    elif isinstance(timestamp, str):
                        dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                        time_str = dt.strftime("%Y-%m-%d %H:%M:%S")
                    else:
                        time_str = ""
                except (ValueError, AttributeError, TypeError):
                    time_str = ""
                if time_str:
                    new_lines.append(
                        f"{prefix} [{time_str}] {speaker_name}: {content}"
                    )
                else:
                    new_lines.append(f"{prefix} {speaker_name}: {content}")
            else:
                new_lines.append(f"{prefix} {speaker_name}: {content}")
        new_text = "\n".join(new_lines)
        time_gap_info = self._calculate_time_gap(conversation_history, new_messages)

        print(
            f"[ConversationEpisodeBuilder] Detect boundary – history tokens: {len(history_text)} new tokens: {len(new_text)} time gap: {time_gap_info}"
        )

        prompt = self.conv_boundary_detection_prompt.format(
            conversation_history=history_text,
            new_messages=new_text,
            time_gap_info=time_gap_info,
            new_messages_count=len(new_messages),
        )
        for i in range(5):
            resp = None
            try:
                resp = await self.llm_provider.generate(prompt)
                self._save_boundary_artifacts(prompt, resp, i + 1)
                print(
                    f"[ConversationEpisodeBuilder] Boundary response length: {len(resp)} chars"
                )

                # Parse JSON response from LLM boundary detection
                json_match = re.search(r"\{[^{}]*\}", resp, re.DOTALL)
                if json_match:
                    data = json.loads(json_match.group())
                    split_index = data.get("split_index")
                    if isinstance(split_index, (int, float)):
                        split_index = int(split_index)
                    elif isinstance(split_index, str):
                        try:
                            split_index = int(split_index.strip())
                        except ValueError:
                            split_index = None
                    else:
                        split_index = None
                    return BoundaryDetectionResult(
                        should_end=data.get("should_end", False),
                        should_wait=data.get("should_wait", True),
                        reasoning=data.get("reasoning", "No reason provided"),
                        confidence=data.get("confidence", 1.0),
                        topic_summary=data.get("topic_summary", ""),
                        split_index=split_index,
                    )
                else:
                    # JSON parsing failed, retry
                    logger.warning(
                        f"[ConversationEpisodeBuilder] Failed to parse JSON from LLM response (attempt {i+1}/5), response: {resp[:200]}..."
                    )
                    logger.warning(
                        "[ConversationEpisodeBuilder] Parse failure details: "
                        "prompt_len=%s response_len=%s response_preview=%s",
                        len(prompt),
                        len(resp) if resp else 0,
                        summarize_text(resp, 800),
                    )
                    artifact_path = dump_llm_artifacts(
                        "boundary_detection",
                        prompt=prompt,
                        response=resp,
                        meta={"attempt": i + 1},
                    )
                    if artifact_path:
                        logger.error(
                            "[ConversationEpisodeBuilder] Saved LLM failure artifact: %s",
                            artifact_path,
                        )
                    continue
            except Exception as e:
                logger.warning(
                    f"[ConversationEpisodeBuilder] Boundary detection error (attempt {i+1}/5): {e}"
                )
                logger.warning(
                    "[ConversationEpisodeBuilder] Error context: prompt_len=%s prompt_preview=%s",
                    len(prompt),
                    summarize_text(prompt, 800),
                )
                if resp:
                    logger.warning(
                        "[ConversationEpisodeBuilder] Error context: response_len=%s response_preview=%s",
                        len(resp),
                        summarize_text(resp, 800),
                    )
                self._save_boundary_artifacts(prompt, resp, i + 1)
                artifact_path = dump_llm_artifacts(
                    "boundary_detection_error",
                    prompt=prompt,
                    response=resp,
                    meta={"attempt": i + 1, "error": str(e)},
                )
                if artifact_path:
                    logger.error(
                        "[ConversationEpisodeBuilder] Saved LLM failure artifact: %s",
                        artifact_path,
                    )
                continue

        # All retries exhausted, return default result
        logger.error(
            f"[ConversationEpisodeBuilder] All 5 retries exhausted for boundary detection, returning default (should_end=False)"
        )
        return BoundaryDetectionResult(
            should_end=False,
            should_wait=True,
            reasoning="All retries exhausted - failed to parse LLM response",
            confidence=0.0,
            topic_summary="",
        )

    async def extract_memcell(
        self, request: ConversationMemCellExtractRequest
    ) -> tuple[Optional[MemCell], Optional[StatusResult]]:
        """
        Extract basic MemCell (only contains raw data and basic fields)

        The returned MemCell only includes:
        - event_id: event ID
        - user_id_list: list of user IDs
        - original_data: raw message data
        - timestamp: timestamp
        - summary: summary
        - group_id: group ID
        - participants: participant list
        - type: data type

        Not included (to be filled by other extractors later):
        - episode: filled by EpisodeMemoryExtractor
        - foresights: filled by ForesightExtractor
        - event_log: filled by EventLogExtractor
        - extend['embedding']: filled by MemoryManager
        """
        history_message_dict_list = []
        for raw_data in request.history_raw_data_list:
            processed_data = self._data_process(raw_data)
            if processed_data is not None:  # Filter out unsupported message types
                history_message_dict_list.append(processed_data)

        # Check if the last new_raw_data is None
        if (
            request.new_raw_data_list
            and self._data_process(request.new_raw_data_list[-1]) is None
        ):
            logger.warning(
                f"[ConvMemCellExtractor] The last new_raw_data is None, skipping processing"
            )
            status_control_result = StatusResult(should_wait=True)
            return (None, status_control_result)

        new_message_dict_list = []
        for new_raw_data in request.new_raw_data_list:
            processed_data = self._data_process(new_raw_data)
            if processed_data is not None:  # Filter out unsupported message types
                new_message_dict_list.append(processed_data)

        # Check if there are valid messages to process
        if not new_message_dict_list:
            logger.warning(
                f"[ConvMemCellExtractor] No valid new messages to process (possibly all filtered out)"
            )
            status_control_result = StatusResult(should_wait=True)
            return (None, status_control_result)

        # === Force split check (token limit or message limit) ===
        # Calculate tokens for history + new messages combined
        accumulated_tokens = self._count_tokens(history_message_dict_list)
        new_tokens = self._count_tokens(new_message_dict_list)
        total_tokens = accumulated_tokens + new_tokens
        total_messages = len(history_message_dict_list) + len(new_message_dict_list)

        # Check if force split is needed (before calling LLM)
        needs_force_split = (
            total_tokens >= self.hard_token_limit
            or total_messages >= self.hard_message_limit
        )

        # Check if we should force split all messages (for historical imports)
        force_split_all = getattr(request, "force_split_all", False)
        logger.info(
            f"[ConvMemCellExtractor] Boundary check: total_messages={total_messages}, "
            f"history_len={len(history_message_dict_list)}, new_len={len(new_message_dict_list)}, "
            f"force_split_all={force_split_all}"
        )

        if needs_force_split and len(history_message_dict_list) >= 2:
            # Force split: create MemCell from history, new message starts next accumulation
            logger.debug(
                f"[ConvMemCellExtractor] Force split triggered: "
                f"tokens={total_tokens}/{self.hard_token_limit}, "
                f"messages={total_messages}/{self.hard_message_limit}"
            )

            # Parse timestamp from last history message
            ts_value = history_message_dict_list[-1].get("timestamp")
            timestamp = dt_from_iso_format(ts_value)
            participants = self._extract_participant_ids(history_message_dict_list)

            memcell = MemCell(
                user_id_list=request.user_id_list,
                original_data=history_message_dict_list,
                timestamp=timestamp,
                summary="",  # Empty summary for force split, will be filled by episode extractor
                group_id=request.group_id,
                participants=participants,
                type=self.raw_data_type,
            )

            logger.debug(
                f"✅ Force split MemCell created: event_id={memcell.event_id}, "
                f"messages={len(history_message_dict_list)}, tokens={accumulated_tokens}"
            )

            return (memcell, StatusResult(should_wait=False))

        elif needs_force_split and force_split_all and len(new_message_dict_list) >= 2:
            # Force split all: create MemCell from all messages (for historical imports with no history)
            logger.debug(
                f"[ConvMemCellExtractor] Force split ALL triggered (historical import): "
                f"tokens={total_tokens}/{self.hard_token_limit}, "
                f"messages={total_messages}/{self.hard_message_limit}"
            )

            # Use all messages (history + new)
            all_messages = history_message_dict_list + new_message_dict_list
            ts_value = all_messages[-1].get("timestamp")
            timestamp = dt_from_iso_format(ts_value)
            participants = self._extract_participant_ids(all_messages)

            memcell = MemCell(
                user_id_list=request.user_id_list,
                original_data=all_messages,
                timestamp=timestamp,
                summary="",
                group_id=request.group_id,
                participants=participants,
                type=self.raw_data_type,
            )

            logger.debug(
                f"✅ Force split ALL MemCell created: event_id={memcell.event_id}, "
                f"messages={len(all_messages)}, tokens={total_tokens}"
            )

            return (memcell, StatusResult(should_wait=False))

        elif needs_force_split:
            # Needs split but not enough messages (single long message case)
            # Don't split, just log warning and continue normal flow
            logger.debug(
                f"[ConvMemCellExtractor] Exceeds limits but only {len(history_message_dict_list)} history messages, "
                f"not splitting single message. tokens={total_tokens}, messages={total_messages}"
            )

        # === Normal LLM-based boundary detection ===
        if request.smart_mask_flag:
            boundary_detection_result = await self._detect_boundary(
                conversation_history=history_message_dict_list[:-1],
                new_messages=new_message_dict_list,
            )
        else:
            boundary_detection_result = await self._detect_boundary(
                conversation_history=history_message_dict_list,
                new_messages=new_message_dict_list,
            )
        should_end = boundary_detection_result.should_end
        should_wait = boundary_detection_result.should_wait
        reason = boundary_detection_result.reasoning

        status_control_result = StatusResult(should_wait=should_wait)

        if should_end:
            split_index = boundary_detection_result.split_index
            # If LLM returns 0 but we have multiple new messages, fall back to
            # internal split search to avoid "no split" when a boundary exists.
            if split_index is None or (
                split_index == 0 and len(new_message_dict_list) > 1
            ):
                split_index = await self._find_split_index(
                    history_message_dict_list,
                    new_message_dict_list,
                    request.smart_mask_flag,
                )
            split_index = max(0, min(split_index, len(new_message_dict_list)))
            history_message_dict_list = (
                history_message_dict_list + new_message_dict_list[:split_index]
            )
            # Parse timestamp
            ts_value = history_message_dict_list[-1].get("timestamp")
            timestamp = dt_from_iso_format(ts_value)
            participants = self._extract_participant_ids(history_message_dict_list)

            # Generate summary (prioritize topic summary from boundary detection)
            fallback_text = ""
            if new_message_dict_list:
                last_msg = new_message_dict_list[-1]
                if isinstance(last_msg, dict):
                    fallback_text = last_msg.get("content") or ""
                elif isinstance(last_msg, str):
                    fallback_text = last_msg
            summary_text = boundary_detection_result.topic_summary or (
                fallback_text.strip()[:200] if fallback_text else "Conversation segment"
            )
            summary_text = boundary_detection_result.topic_summary or (
                fallback_text.strip()[:200] if fallback_text else "Conversation segment"
            )

            # Create basic MemCell (without episode, foresight, event_log, embedding)
            memcell = MemCell(
                user_id_list=request.user_id_list,
                original_data=history_message_dict_list,
                timestamp=timestamp,
                summary=summary_text,
                group_id=request.group_id,
                participants=participants,
                type=self.raw_data_type,
            )

            logger.debug(
                f"✅ Successfully created basic MemCell: event_id={memcell.event_id}, "
                f"participants={len(participants)}, messages={len(history_message_dict_list)}"
            )

            return (memcell, status_control_result)
        elif should_wait:
            logger.debug(f"⏳ Waiting for more messages: {reason}")
        return (None, status_control_result)

    def _data_process(self, raw_data: RawData) -> Dict[str, Any]:
        """Process raw data, including message type filtering and preprocessing"""
        content = (
            raw_data.content.copy()
            if isinstance(raw_data.content, dict)
            else raw_data.content
        )

        # Get message type
        msg_type = content.get('msgType') if isinstance(content, dict) else None

        # Define supported message types and corresponding placeholders
        SUPPORTED_MSG_TYPES = {
            1: None,  # TEXT - keep original text
            2: "[Image]",  # PICTURE
            3: "[Video]",  # VIDEO
            4: "[Audio]",  # AUDIO
            5: "[File]",  # FILE - keep original text (text and file in same message)
            6: "[File]",  # FILES
        }

        if isinstance(content, dict) and msg_type is not None:
            # Check if it's a supported message type
            if msg_type not in SUPPORTED_MSG_TYPES:
                # Unsupported message type, skip directly (returning None will be handled at upper level)
                logger.warning(
                    f"[ConvMemCellExtractor] Skipping unsupported message type: {msg_type}"
                )
                return None

            # Preprocess non-text messages
            placeholder = SUPPORTED_MSG_TYPES[msg_type]
            if placeholder is not None:
                # Replace message content with placeholder
                content = content.copy()
                content['content'] = placeholder
                logger.debug(
                    f"[ConvMemCellExtractor] Message type {msg_type} converted to placeholder: {placeholder}"
                )

        return content
