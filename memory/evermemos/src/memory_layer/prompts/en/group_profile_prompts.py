"""Group Profile Extraction prompts for EverMemOS."""

# ======================================
# PARALLEL EXTRACTION PROMPTS
# ======================================

CONTENT_ANALYSIS_PROMPT = """
You are a group content analysis expert specializing in analyzing group conversations to extract discussion topics, group summary, and subject positioning.

**IMPORTANT LANGUAGE REQUIREMENT:**
- Extract content (summary, subject, topic names/summaries) in the SAME LANGUAGE as the conversation
- Keep enum values (topic status) in English as specified
- If conversation is in Chinese, use Chinese for content; if English, use English for content

**IMPORTANT EVIDENCE EXTRACTION:**
- Each conversation segment is prefixed with "=== MEMCELL_ID: xxxx ===" to identify the memcell
- When providing evidences, use ONLY the exact memcell IDs from these markers
- DO NOT use timestamps as memcell IDs
- Only reference memcell IDs that appear in the conversation input

Your task is to analyze group conversation transcripts and extract:
1. **Recent Topics** (0-{max_topics} topics based on actual content, quality over quantity)
2. **Group Summary** (one sentence overview)
3. **Group Subject** (long-term positioning)

<principles>
- **Evidence-Based**: Only extract information explicitly mentioned or clearly implied
- **Quality Over Quantity**: Better to have fewer accurate insights than many inaccurate ones
- **Conservative Extraction**: When uncertain, output "not_found" rather than guessing
- **Temporal Awareness**: Focus on recent activity patterns for topics
- **Batch Processing**: This is offline analysis, not real-time updates
- **Incremental Updates**: When existing profile provided, update/preserve existing information intelligently
</principles>

<input>
- **conversation_transcript**: {conversation}
- **group_id**: {group_id}
- **group_name**: {group_name}
- **existing_group_profile**: {existing_profile}
- **conversation_timespan**: {timespan}
</input>

<output_format>
You MUST output a single JSON object with the following structure:

**Note**: The "topics" array can contain 0-{max_topics} items. Empty array [] is acceptable if no substantial topics are found.

```json
{{
  "topics": [
    {{
      "name": "short_phrase_topic_name",
      "summary": "one sentence about what the group is discussing on this topic (max 3 sentences)",
      "status": "exploring|disagreement|consensus|implemented",
      "update_type": "new|update",
      "old_topic_id": "topic_abc12345",
      "evidences": ["memcell_id_1", "memcell_id_3"],
      "confidence": "strong|weak"
    }}
  ],
  "summary": "one sentence focusing on current stage based on current and previous topics",
  "subject": "long_term_group_positioning_or_not_found"
}}
```
</output_format>

<extraction_rules>
### Topics (0-{max_topics})
- **Selection**: Choose the most SUBSTANTIAL and MEANINGFUL discussion threads
- **Minimum Requirements**: Each topic must involve at least 5 messages OR 3+ participants on the same thread
- **Granularity Requirement**: Topics should represent significant group themes, not one-off requests or trivial coordination
- **DO NOT generate topic IDs**: The system will generate IDs after extraction
- **Name**: Short phrase (2-4 words) that captures the essence
- **Summary**: One sentence describing the discussion (maximum 3 sentences)
- **Incremental Update Logic**:
  - **If existing_group_profile is empty**: Set all topics as "new" (update_type="new", old_topic_id=null)
  - **If existing_group_profile has topics**: Compare with existing topics and decide update/new
- **Status Assessment**:
  - **"exploring"**: Initial discussion, gathering information
  - **"disagreement"**: Multiple viewpoints, debate ongoing
  - **"consensus"**: Agreement reached, decision made
  - **"implemented"**: Executed/completed, results mentioned
- **Evidence & Confidence**:
  - **"evidences"**: List of memcell IDs supporting the topic
  - **"confidence"**: "strong" for clear multi-signal evidence; "weak" otherwise

**Topic Quality Guidelines (Include):**
- **Life & Interests**: food, travel, entertainment, daily planning
- **Learning & Growth**: study plans, skills, courses, reading
- **Emotions & Relationships**: support, communication, conflict resolution
- **Shared Experiences**: event recap, shared goals, long-term plans
- **Knowledge Sharing**: advice, tips, recommendations
- **Planning & Collaboration**: activity planning, role splitting (non-trivial)

**Topic Exclusion Guidelines (Exclude):**
- **Greetings/Small Talk**: short acknowledgements, emojis
- **Pure Politeness**: thanks/ok-only replies
- **System Notifications**: bot alerts, status updates
- **Trivial Coordination**: "I'm late", "send the link"
- **Group Management**: add/remove members, permissions
- **Tool Operations**: unrelated technical instructions

**Selection Priority**: Prefer multi-participant, multi-turn, substantive content that matters to the group.

### Summary
- **Source**: Based on topics
- **Format**: One sentence describing current group focus
- **Language**: SAME language as the conversation
- **Templates**:
  - Chinese: "目前主要关注..."
  - English: "Currently focusing on..."

### Subject
- **Priority Sources**:
  1. Explicit group descriptions
  2. Consistent patterns across conversations
  3. Group name analysis
  4. "not_found" if insufficient evidence
- **Stability**: Should remain relatively stable across extractions
- **Examples**: "travel buddies", "study circle", "daily life support group"
</extraction_rules>

<update_logic>
1. **New Extraction**: If no existing_group_profile provided, extract fresh from conversation
2. **Incremental Update**: If existing profile exists:
   - **Topics**: Compare new topics with existing ones
   - **Summary**: Regenerate based on old + new
   - **Subject**: Keep existing unless strong contradictory evidence
</update_logic>

## Language Requirements
- **Content Language**: Extract topics, summary, and subject in the SAME language as the conversation
- **Enum Values**: Keep enum values in ENGLISH

Now analyze the provided conversation and return only the JSON object.
"""

BEHAVIOR_ANALYSIS_PROMPT = """
You are a group behavior analysis expert specializing in identifying roles based on conversation behaviors.

**IMPORTANT EVIDENCE EXTRACTION:**
- Each conversation segment is prefixed with "=== MEMCELL_ID: xxxx ==="
- Use ONLY those memcell IDs as evidences
- DO NOT use timestamps as memcell IDs

Your task is to extract:
**Role Mapping** (7 key roles based on behavioral patterns)

<principles>
- **Evidence-Based**: Only assign roles with clear evidence
- **Quality Over Quantity**: Prefer empty roles over wrong assignments
- **Conservative Assignment**: When uncertain, leave empty
- **Minimum Evidence**: Require at least 2 clear examples
</principles>

<input>
- **conversation_transcript**: {conversation}
- **group_id**: {group_id}
- **group_name**: {group_name}
- **existing_group_profile**: {existing_profile}
{speaker_info}
</input>

<output_format>
```json
{{
  "roles": {{
    "decision_maker": [
      {{
        "speaker": "speaker_id1",
        "evidences": ["memcell_id_2"],
        "confidence": "strong|weak"
      }}
    ],
    "opinion_leader": [
      {{
        "speaker": "speaker_id2",
        "evidences": ["memcell_id_4", "memcell_id_5"],
        "confidence": "strong|weak"
      }}
    ],
    "topic_initiator": [...],
    "execution_promoter": [...],
    "core_contributor": [...],
    "coordinator": [...],
    "info_summarizer": [...]
  }}
}}
```
</output_format>

<extraction_rules>
### Roles (7 Key Roles)
- **decision_maker**: makes final calls
- **opinion_leader**: influences others' views
- **topic_initiator**: starts new threads
- **execution_promoter**: pushes action/follow-up
- **core_contributor**: provides knowledge/resources
- **coordinator**: aligns people and resolves friction
- **info_summarizer**: summarizes decisions and discussions

**Assignment Rules**:
- One person can have multiple roles
- Max 3 people per role
- Use ONLY provided speaker_ids
- If insufficient evidence, leave empty
- Preserve historical roles unless contradicted
- Add new roles only with new evidence
- Provide memcell evidences and confidence
</extraction_rules>

<conversation_examples>
**Topic Initiation**: "I want to discuss weekend plans"
**Decision Making**: "Let's go with this option"
**Opinion Leadership**: "As I mentioned before..." and others follow
**Execution Focus**: "Let's set a time and move on"
**Knowledge Contribution**: detailed explanations or helpful resources
**Coordination**: "Let's align on this plan"
**Summarization**: "To recap, we decided..."
</conversation_examples>

Now analyze and return only the JSON object.
"""

AGGREGATION_PROMPT = """
You are a group profile aggregation expert. Your task is to analyze multiple daily group profiles and conversation data to create a consolidated group profile.

**IMPORTANT EVIDENCE EXTRACTION:**
- Each conversation segment is prefixed with [MEMCELL_ID: xxxx]
- Use those memcell IDs in evidences

You are aggregating group profiles from {aggregation_level} data ({start_date} to {end_date}).

Daily Profiles Summary:
{daily_context}

Conversation Data:
{conversation}

Output a single JSON object:
{{
  "topics": [
    {{
      "name": "topic_name",
      "summary": "topic summary",
      "status": "exploring|disagreement|consensus|implemented",
      "update_type": "new|update",
      "old_topic_id": "topic_id",
      "evidences": ["memcell_id1", "memcell_id2"],
      "confidence": "strong|weak"
    }}
  ],
  "summary": "consolidated group summary",
  "subject": "group subject or not_found",
  "roles": {{
    "decision_maker": [
      {{
        "speaker": "speaker_id",
        "evidences": ["memcell_id"],
        "confidence": "strong|weak"
      }}
    ]
  }}
}}

Focus on consistent patterns and evidence-based consolidation.
"""
