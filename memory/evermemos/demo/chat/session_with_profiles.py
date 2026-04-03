"""Conversation Session with Profiles

Extends ChatSession to inject self/friend profiles into the prompt.
"""

import json
from typing import Any, Dict, List, Optional

from demo.chat.session import ChatSession
from common_utils.datetime_utils import to_iso_format
from demo.ui import I18nTexts
from demo.config import ScenarioType

from infra_layer.adapters.out.persistence.document.memory.conversation_meta import (
    ConversationMeta,
)
from infra_layer.adapters.out.persistence.document.memory.user_profile import UserProfile
from infra_layer.adapters.out.persistence.document.memory.user_self_profile import (
    UserSelfProfile,
)


class ChatSessionWithProfiles(ChatSession):
    """ChatSession that injects self/friend profiles into the prompt."""

    def __init__(
        self,
        group_id: str,
        config,
        llm_config,
        scenario_type: ScenarioType,
        retrieval_mode: str,
        data_source: str,
        texts: I18nTexts,
    ):
        super().__init__(
            group_id=group_id,
            config=config,
            llm_config=llm_config,
            scenario_type=scenario_type,
            retrieval_mode=retrieval_mode,
            data_source=data_source,
            texts=texts,
        )
        self._last_profile_context: Optional[Dict[str, Any]] = None

    async def _fetch_profile_context(self) -> Dict[str, Any]:
        """Fetch owner and friend profiles for the current group."""
        meta = await ConversationMeta.find_one(
            ConversationMeta.group_id == self.group_id
        )

        owner_user_id = None
        if meta and isinstance(meta.scene_desc, dict):
            owner_user_id = meta.scene_desc.get("owner_user_id")

        user_ids = list(meta.user_details.keys()) if meta and meta.user_details else []
        other_user_ids = (
            [uid for uid in user_ids if uid != owner_user_id]
            if owner_user_id
            else []
        )
        other_user_id = other_user_ids[0] if other_user_ids else None

        self_profile = None
        if owner_user_id:
            self_doc = await UserSelfProfile.find_one(
                UserSelfProfile.user_id == owner_user_id
            )
            if self_doc:
                self_profile = self_doc.profile_data

        friend_profile = None
        if other_user_id:
            friend_doc = await UserProfile.find_one(
                UserProfile.user_id == other_user_id,
                UserProfile.group_id == self.group_id,
            )
            if friend_doc:
                friend_profile = friend_doc.profile_data

        return {
            "owner_user_id": owner_user_id,
            "other_user_id": other_user_id,
            "self_profile": self_profile,
            "friend_profile": friend_profile,
        }

    def _format_profiles_for_prompt(self, ctx: Dict[str, Any]) -> Optional[str]:
        """Format profiles for prompt injection."""
        if not ctx:
            return None

        owner_user_id = ctx.get("owner_user_id")
        other_user_id = ctx.get("other_user_id")
        self_profile = ctx.get("self_profile")
        friend_profile = ctx.get("friend_profile")

        if not (self_profile or friend_profile):
            return None

        parts: List[str] = ["Profiles (use as background context, do not quote verbatim):"]

        if self_profile:
            parts.append(
                "Self Profile (user_id=%s): %s"
                % (
                    owner_user_id or "",
                    json.dumps(self_profile, ensure_ascii=False),
                )
            )

        if friend_profile:
            parts.append(
                "Friend Profile (user_id=%s): %s"
                % (
                    other_user_id or "",
                    json.dumps(friend_profile, ensure_ascii=False),
                )
            )

        return "\n".join(parts)

    def _additional_prompt_adjustments(self) -> Optional[str]:
        """Hook for additional prompt adjustments (override if needed)."""
        return None

    def build_prompt(
        self, user_query: str, memories: List[Dict[str, Any]]
    ) -> List[Dict[str, str]]:
        messages: List[Dict[str, str]] = []

        # System Message
        lang_key = "zh" if self.texts.language == "zh" else "en"
        system_content = self.texts.get(f"prompt_system_role_{lang_key}")
        messages.append({"role": "system", "content": system_content})

        # Profiles (self + friend)
        profile_context = self._format_profiles_for_prompt(self._last_profile_context)
        if profile_context:
            messages.append({"role": "system", "content": profile_context})

        # Additional adjustments
        extra = self._additional_prompt_adjustments()
        if extra:
            messages.append({"role": "system", "content": extra})

        # Retrieved Memories
        if memories:
            memory_lines = []
            for i, mem in enumerate(memories, start=1):
                raw_timestamp = mem.get("timestamp", "")
                iso_timestamp = to_iso_format(raw_timestamp)
                timestamp = iso_timestamp[:10] if iso_timestamp else ""
                subject = mem.get("subject", "")
                summary = mem.get("summary", "")
                episode = mem.get("episode", "")

                parts = [
                    f"[{i}] {self.texts.get('prompt_memory_date', date=timestamp)}"
                ]
                if subject:
                    parts.append(
                        self.texts.get("prompt_memory_subject", subject=subject)
                    )
                if summary:
                    parts.append(
                        self.texts.get("prompt_memory_content", content=summary)
                    )
                if episode:
                    parts.append(
                        self.texts.get("prompt_memory_episode", episode=episode)
                    )

                memory_lines.append(" | ".join(parts))

            memory_content = self.texts.get("prompt_memories_prefix") + "\n".join(
                memory_lines
            )
            messages.append({"role": "system", "content": memory_content})

        # Conversation History
        for user_q, assistant_a in self.conversation_history[
            -self.config.conversation_history_size :
        ]:
            messages.append({"role": "user", "content": user_q})
            messages.append({"role": "assistant", "content": assistant_a})

        # Current Question
        messages.append({"role": "user", "content": user_query})

        return messages

    async def chat(self, user_input: str) -> str:
        """Chat with profile-aware prompt."""
        from .ui import ChatUI

        # Refresh profiles per turn
        self._last_profile_context = await self._fetch_profile_context()

        # Retrieve Memories
        memories = await self.retrieve_memories(user_input)

        # Show Retrieval Results
        if self.config.show_retrieved_memories and memories:
            ChatUI.print_retrieved_memories(
                memories[:5],
                texts=self.texts,
                retrieval_metadata=self.last_retrieval_metadata,
            )

        # Build Prompt
        messages = self.build_prompt(user_input, memories)

        # Show Generation Progress
        ChatUI.print_generating_indicator(self.texts)

        # Call LLM
        try:
            if hasattr(self.llm_provider, 'provider') and hasattr(
                self.llm_provider.provider, 'chat_with_messages'
            ):
                raw_response = await self.llm_provider.provider.chat_with_messages(
                    messages
                )
            else:
                prompt_parts = []
                for msg in messages:
                    role = msg["role"]
                    content = msg["content"]
                    if role == "system":
                        prompt_parts.append(f"System: {content}")
                    elif role == "user":
                        prompt_parts.append(f"User: {content}")
                    elif role == "assistant":
                        prompt_parts.append(f"Assistant: {content}")

                prompt = "\n\n".join(prompt_parts)
                raw_response = await self.llm_provider.generate(prompt)

            raw_response = raw_response.strip()

            # Clear Generation Progress
            ChatUI.print_generation_complete(self.texts)

            assistant_response = raw_response

        except Exception as e:
            ChatUI.clear_progress_indicator()
            error_msg = f"[{self.texts.get('error_label')}] {self.texts.get('chat_llm_error', error=str(e))}"
            print(f"\n{error_msg}")
            import traceback

            traceback.print_exc()
            return error_msg

        # Update Conversation History
        self.conversation_history.append((user_input, assistant_response))

        if len(self.conversation_history) > self.config.conversation_history_size:
            self.conversation_history = self.conversation_history[
                -self.config.conversation_history_size :
            ]

        return assistant_response
