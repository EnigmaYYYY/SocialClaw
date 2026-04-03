# -*- coding: utf-8 -*-

CONVERSATION_PROFILE_PART3_EXTRACTION_PROMPT = """
你是长期画像增强器。请基于最新对话和已有画像，为指定用户补充稳定画像信息。

要求：
1. 只抽取长期稳定、可复用的信息，不要重复复述整段对话。
2. 只保留有明确证据支持的字段；没有证据就省略。
3. 不要输出 90 维人格表，也不要扩展无关字段。
4. 列表字段统一使用：
   `{"value": "字段值", "evidences": ["conversation_id 或 event_id"]}`
5. 标量字段只允许：
   - occupation
   - relationship
6. 列表字段只允许：
   - personality
   - interests
   - way_of_decision_making
   - life_habit_preference
   - communication_style
   - catchphrase
   - user_to_friend_catchphrase
   - user_to_friend_chat_style_preference
   - motivation_system
   - fear_system
   - value_system
   - humor_use

输入：
- target_user_id: {user_id}
- target_user_name: {user_name}
- conversation_text: {conversation}
- owner_user_id: {owner_user_id}
- existing_profile: {existing_profile}

请输出一个 JSON 代码块：
```json
{
  "user_profiles": [
    {
      "user_id": "USER_ID",
      "user_name": "USER_NAME",
      "output_reasoning": "1到3句说明本次补充了什么、为什么",
      "occupation": "职业或身份",
      "relationship": "与owner的关系",
      "personality": [],
      "interests": [],
      "way_of_decision_making": [],
      "life_habit_preference": [],
      "communication_style": [],
      "catchphrase": [],
      "user_to_friend_catchphrase": [],
      "user_to_friend_chat_style_preference": [],
      "motivation_system": [],
      "fear_system": [],
      "value_system": [],
      "humor_use": []
    }
  ]
}
```

补充规则：
- 若已有画像里已有稳定信息，只有在新对话提供了更强证据时才修正。
- `communication_style` 更偏抽取“对方怎么说话”，不要写成抽象人格结论。
- `catchphrase` 只保留明显高频或很有代表性的表达。
- `relationship` 只写一个最贴切的角色关系。
- `output_reasoning` 用简体中文，简短即可。
"""
