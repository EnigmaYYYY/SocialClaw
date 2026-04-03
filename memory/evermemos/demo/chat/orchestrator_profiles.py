"""Chat Orchestrator (Profile-aware)

Reuses the chat_with_memory flow, but injects self/friend profiles into prompt.
"""

from pathlib import Path
from typing import Optional

from demo.chat.orchestrator import ChatOrchestrator
from demo.chat.session_with_profiles import ChatSessionWithProfiles
from demo.config import ChatModeConfig, LLMConfig
from demo.ui import I18nTexts


class ChatOrchestratorProfiles(ChatOrchestrator):
    """Chat Orchestrator with profile-aware session."""

    async def create_session(
        self,
        group_id: str,
        scenario_type: str,
        retrieval_mode: str,
        texts: I18nTexts,
    ) -> Optional[ChatSessionWithProfiles]:
        chat_config = ChatModeConfig()
        llm_config = LLMConfig()

        session = ChatSessionWithProfiles(
            group_id=group_id,
            config=chat_config,
            llm_config=llm_config,
            scenario_type=scenario_type,
            retrieval_mode=retrieval_mode,
            data_source="episodic_memory",
            texts=texts,
        )

        if not await session.initialize():
            return None

        return session
