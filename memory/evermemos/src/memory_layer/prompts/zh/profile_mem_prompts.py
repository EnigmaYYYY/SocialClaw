# -*- coding: utf-8 -*-
# 通用用户画像抽取提示词（通用场景）
CONVERSATION_PROFILE_EXTRACTION_PROMPT = """
你是社交对话的用户画像抽取专家。

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
      "gender": "",
      "occupation": "",
      "relationship": "",
      "personality": [{"value": "", "evidences": ["conversation_id"]}],
      "way_of_decision_making": [{"value": "", "evidences": ["conversation_id"]}],
      "interests": [{"value": "", "evidences": ["conversation_id"]}],
      "life_habit_preference": [{"value": "", "evidences": ["conversation_id"]}],
      "communication_style": [{"value": "", "evidences": ["conversation_id"]}],
      "motivation_system": [{"value": "", "level": "", "evidences": ["conversation_id"]}],
      "fear_system": [{"value": "", "level": "", "evidences": ["conversation_id"]}],
      "value_system": [{"value": "", "level": "", "evidences": ["conversation_id"]}],
      "humor_use": [{"value": "", "level": "", "evidences": ["conversation_id"]}],
      "catchphrase": [{"value": "", "evidences": ["conversation_id"]}],
      "user_to_friend_catchphrase": [{"value": "", "evidences": ["conversation_id"]}],
      "user_to_friend_chat_style_preference": [{"value": "", "evidences": ["conversation_id"]}]
    }
  ]
}
```
</output_format>

<rules>
- 只为 participants 列表中的 user_id 生成画像；不要生成列表外用户。
- 必须包含 owner_user_id 对应的自我画像；其 user_id 必须等于 owner_user_id。
- 输出顺序必须与 participants 列表一致，并且每个 user_id 必须与对应 participants 的 user_id 完全一致。
- evidences 必须来自对话中出现的 conversation_id，不得编造。
- occupation / gender / relationship 仅在明确提及时填写。
- user_to_friend_* 从对话中 owner 的消息抽取；若 user_id == owner_user_id 则留空。
- 只输出对话中可支持的信息。
</rules>
"""
