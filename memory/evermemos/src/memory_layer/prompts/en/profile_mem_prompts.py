CONVERSATION_PROFILE_EXTRACTION_PROMPT = """
You are a personal profile extraction expert for social conversations.

<input>
- conversation_transcript: {conversation}
- owner_user_id: {owner_user_id}
- participants: {participants}
- participants_current_profiles: {participants_profile}
- participants_base_memory: {participants_baseMemory}
</input>

<output_format>
```json
{
  "user_profiles": [
    {
      "user_id": "",
      "user_name": "",
      "output_reasoning": "",
      "gender": {"value": "", "evidence_level": "L1", "evidences": [{"event_id": "", "reasoning": ""}]},
      "occupation": [{"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "relationship": [{"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "personality": [{"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "way_of_decision_making": [{"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "interests": [{"value": "", "evidence_level": "L1", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "life_habit_preference": [{"value": "", "evidence_level": "L1", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "communication_style": [{"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "motivation_system": [{"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "fear_system": [{"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "value_system": [{"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "humor_use": [{"value": "", "evidence_level": "L1", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "catchphrase": [{"value": "", "evidence_level": "L1", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "user_to_friend_catchphrase": [{"value": "", "evidence_level": "L1", "evidences": [{"event_id": "", "reasoning": ""}]}],
      "user_to_friend_chat_style_preference": [{"value": "", "evidence_level": "L2", "evidences": [{"event_id": "", "reasoning": ""}]}]
    }
  ]
}
```
</output_format>

Rules:
- Generate profiles ONLY for user_id values listed in participants; do not create users outside the list.
- You MUST include a profile for owner_user_id, and its user_id must equal owner_user_id.
- Output order MUST match the participants list, and each user_id must exactly match the corresponding participants entry.
- Only include information explicitly stated in the conversation.
- Use event_id values from the transcript as evidences; do not invent IDs.
- Each evidence MUST include a reasoning field explaining the inference from the conversation.
- evidence_level: L1 (explicit statement) or L2 (strong implication).
"""
