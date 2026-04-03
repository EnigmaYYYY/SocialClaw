"""Memory Enhanced Chat Demo (Profile-aware)

Usage:
    uv run python src/bootstrap.py demo/chat_demo.py
"""

import asyncio
from pathlib import Path

from dotenv import load_dotenv
from demo.chat.orchestrator_profiles import ChatOrchestratorProfiles

load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parents[1]


async def main():
    """Main Entry - Start Chat Application (Profile-aware)"""
    orchestrator = ChatOrchestratorProfiles(PROJECT_ROOT)
    await orchestrator.run()


if __name__ == "__main__":
    asyncio.run(main())
