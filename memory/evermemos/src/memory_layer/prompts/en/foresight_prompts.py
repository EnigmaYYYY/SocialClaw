"""
Foresight Association Prediction Prompt Templates

Used to generate foresight associations based on MemCell and EpisodeMemory content.
"""

GROUP_FORESIGHT_GENERATION_PROMPT = """
You are a foresight extractor for group/private chat events.
Infer likely near-future changes from the given event content.

Rules:
1. One-hop inference only: every foresight must be directly supported by explicit input facts.
2. Output 3-7 items; if evidence is weak, keep items conservative and concise.
3. Each `content` must be specific, testable, and not a source summary.
4. No advice words like "should/need to"; use probabilistic wording (may/likely/tend to).
5. `evidence` must come from source facts, <=30 words, no fabrication.
6. Time fields are required:
   - `start_time`: YYYY-MM-DD
   - `end_time`: YYYY-MM-DD or null (only for truly long-term cases)
   - `duration_days`: consistent with start/end; null only when `end_time` is null
7. `parent_episode_id` must copy the input event id.

Output only a JSON array:
[
  {
    "content": "A likely future change",
    "evidence": "Direct source evidence",
    "start_time": "YYYY-MM-DD",
    "end_time": "YYYY-MM-DD or null",
    "duration_days": 7,
    "parent_episode_id": "EVENT_ID"
  }
]
"""

FORESIGHT_GENERATION_PROMPT = """
You are a personal foresight extractor.
Infer likely near-future personal changes from the given episode.

Rules:
1. One-hop inference only: every foresight must be grounded in explicit input facts.
2. Output 3-7 items; if evidence is weak, keep items conservative and concise.
3. Focus on personal behavior/plan/emotion trends; avoid generic statements.
4. No advice words like "should/need to"; use probabilistic wording (may/likely/tend to).
5. `evidence` must come from source facts, <=30 words, no fabrication.
6. Time fields are required:
   - `start_time`: YYYY-MM-DD
   - `end_time`: YYYY-MM-DD or null (only for truly long-term cases)
   - `duration_days`: consistent with start/end; null only when `end_time` is null
7. `parent_episode_id` must copy the input event id.

Output only a JSON array:
[
  {
    "content": "A likely personal future change",
    "evidence": "Direct source evidence",
    "start_time": "YYYY-MM-DD",
    "end_time": "YYYY-MM-DD or null",
    "duration_days": 7,
    "parent_episode_id": "EVENT_ID"
  }
]
"""


def get_group_foresight_generation_prompt(
    memcell_summary: str, memcell_episode: str, user_ids: list = None
) -> str:
    """Generate prompt for group foresight association prediction."""
    user_ids_info = ""
    if user_ids:
        user_ids_info = f"\nUser IDs:\n{', '.join(user_ids)}\n"

    return f"""{GROUP_FORESIGHT_GENERATION_PROMPT}

Input:
- MemCell summary:
{memcell_summary}

- MemCell episode:
{memcell_episode}{user_ids_info}
Generate 3-7 high-quality foresight items in JSON array format.
"""


def get_foresight_generation_prompt(
    episode_memory: str, episode_content: str, user_id: str = None
) -> str:
    """Generate prompt for personal foresight association prediction."""
    user_id_info = ""
    if user_id:
        user_id_info = f"\nUser ID:\n{user_id}\n"

    return f"""{FORESIGHT_GENERATION_PROMPT}

Input:
- Episode summary:
{episode_memory}

- Episode content:
{episode_content}{user_id_info}
Generate 3-7 high-quality foresight items in JSON array format.
"""
