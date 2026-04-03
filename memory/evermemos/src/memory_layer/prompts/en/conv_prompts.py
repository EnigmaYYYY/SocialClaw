# Prompts for LLM-based conversation processing
CONV_BOUNDARY_DETECTION_PROMPT = """
You are an episodic boundary detector.
Goal: split chat streams into coherent MemCells.
Core policy: **merge by default, split cautiously; allow in-batch split points (not batch-only split).**

Conversation history:
{conversation_history}

Time gap info:
{time_gap_info}

New messages (numbered from 1):
```
{new_messages}
```
New message count: {new_messages_count}

Decision rules:
1. `should_end=true` only when a clear new-topic start appears:
- new content is semantically independent from the current thread; or
- previous thread is closed and a new independent task/event starts; or
- time gap is **>24h** and semantic continuity is weak.

2. `should_wait=true` when evidence is insufficient:
- placeholder-only messages (image/file/no intent),
- ultra-short acknowledgements ("ok", "got it", etc.),
- system/non-conversational notifications.

3. `split_index` (critical):
- meaningful only when `should_end=true`;
- number of new messages that still belong to the old episode;
- range: `0..{new_messages_count}`;
- if first new message already starts a new topic => `split_index=0`;
- if all new messages still belong to old topic => `should_end=false` and `split_index={new_messages_count}`.

4. Constraints:
- `should_end` and `should_wait` must be mutually exclusive.
- Do not split only because of greetings/farewells.
- Preserve causal/task continuity.

Return exactly one JSON object:
```json
{{
  "reasoning": "One concise sentence on topic continuity + time signal",
  "should_end": true,
  "should_wait": false,
  "confidence": 0.0,
  "topic_summary": "Only when should_end=true: summarize the ending old episode; otherwise empty",
  "split_index": 0
}}
```
"""

CONV_SUMMARY_PROMPT = """
You are an episodic memory summary expert. You need to summarize the following conversation.
"""
