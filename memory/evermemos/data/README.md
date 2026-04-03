# Data - Sample Conversation Data

[English](README.md) | [简体中文](README_zh.md)

This directory contains sample conversation data files used for testing and demonstration purposes.

## 📂 Contents

### Bilingual Sample Data

All sample data files are now available in both **English** and **Chinese** versions:

- **`assistant_chat_en.json`** / **`assistant_chat_zh.json`** - Sample private one-on-one conversation data
  - One-on-one conversation format (human-human or human-AI)
  - Used for testing memory extraction from private interactions
  - Available in English and Chinese

- **`group_chat_en.json`** / **`group_chat_zh.json`** - Sample group conversation data
  - Multi-user group chat format
  - Follows [GroupChatFormat](../data_format/group_chat/group_chat_format.md) specification
  - Used for testing memory extraction from group discussions
  - Available in English and Chinese

**Note:** The `conversation_meta` field in the data is provided solely to help users understand the conversation context and participant roles. It is not used during memory extraction and inference generation.

## 📋 Data Format

### GroupChatFormat Specification

All conversation data files follow the standardized [GroupChatFormat](../data_format/group_chat/group_chat_format.md) format:

```json
{
  "version": "1.0.0",
  "conversation_meta": {
    "scene": "group",
    "scene_desc": {},
    "group_id": "group_001",
    "name": "Project Discussion Group",
    "user_details": {
      "user_101": {
        "full_name": "Alice",
        "role": "Product Manager"
      }
    }
  },
  "conversation_list": [
    {
      "message_id": "msg_001",
      "create_time": "2025-02-01T10:00:00+00:00",
      "sender": "user_101",
      "content": "Good morning everyone"
    }
  ]
}
```

### Scenario Types

EverMemOS supports two core conversation scenarios:

- **🤖 Private Scenario** (`scene: "private"`)
  - One-on-one conversation (human-human or human-AI)
  - `scene_desc` is optional and can store extra context (e.g. owner_user_id, bot_ids)
  - Example: `assistant_chat_en.json`, `assistant_chat_zh.json`

- **👥 Group Scenario** (`scene: "group"`)
  - Multi-person group chat
  - General social chat format
  - `scene_desc` is typically an empty object
  - Example: `group_chat_en.json`, `group_chat_zh.json`

## 📖 Data Scenarios

### Group Chat Scenario (group_chat.json)

**Background:** Friends planning trips and daily updates

**Topics:**
- Trip planning and itinerary
- Daily life updates and recommendations

**Characters:**
- **Alex** - Friend
- **Betty** - Friend
- **Chen** - Friend
- **Dylan** - Friend
- **Emily** - Friend

💡 Explore more details using EverMemOS!

### Private Scenario (assistant_chat.json)

**Background:** One-on-one private chat

**Conversation Topics:**
- Daily life updates
- Preferences and habits
- Personal plans and reminders

💡 Use EverMemOS to explore our personal conversation data and gain deep insights into how the memory system works!

## 🎯 Usage

### For Demo Scripts

These data files are used by the demo scripts:

```bash
# Extract memories from the sample data
uv run python src/bootstrap.py demo/extract_memory.py
```

The extraction script automatically reads and processes all JSON files in this directory.

### For Batch Memory Storage

You can use these files with the batch storage script:

```bash
# Validate format (English version)
uv run python src/bootstrap.py src/run_memorize.py \
  --input data/group_chat_en.json \
  --validate-only

# Validate format (Chinese version)
uv run python src/bootstrap.py src/run_memorize.py \
  --input data/group_chat_zh.json \
  --validate-only

# Store to memory system (English version)
uv run python src/bootstrap.py src/run_memorize.py \
  --input data/group_chat_en.json \
  --api-url http://localhost:8001/api/v1/memories

# Store to memory system (Chinese version)
uv run python src/bootstrap.py src/run_memorize.py \
  --input data/group_chat_zh.json \
  --api-url http://localhost:8001/api/v1/memories
```

## 📝 Adding Your Own Data

To add your own conversation data:

1. **Create a JSON file** following the GroupChatFormat specification
2. **Place it in this directory** (`data/`)
3. **Run validation** to ensure format compliance:
   ```bash
   uv run python src/bootstrap.py src/run_memorize.py \
     --input data/your_data.json \
     --validate-only
   ```
4. **Extract memories** using the demo or batch scripts

## 🔍 Data Privacy

**Important**: The sample data in this directory is for demonstration purposes only and contains fictional conversations. When using EverMemOS with real data:

- Ensure you have proper consent to process conversation data
- Follow data privacy regulations (GDPR, CCPA, etc.)
- Anonymize sensitive information before processing
- Secure storage of extracted memories

## 🔗 Related Documentation

- [GroupChatFormat Specification](../data_format/group_chat/group_chat_format.md)
- [Batch Memorization Usage](../docs/dev_docs/run_memorize_usage.md)
- [Demo Scripts Guide](../demo/README.md)
- [API Documentation](../docs/api_docs/memory_api.md)

## 📊 Sample Data Statistics

| File | Messages | Users | Groups | Language | Purpose |
|------|----------|-------|--------|----------|---------|
| `assistant_chat_en.json` | 56 | 2 | 1 | English | Private chat demo |
| `assistant_chat_zh.json` | 56 | 2 | 1 | Chinese | Private chat demo |
| `group_chat_en.json` | 508 | 5 | 1 | English | Group chat demo |
| `group_chat_zh.json` | 508 | 5 | 1 | Chinese | Group chat demo |

## 💡 Need Help?

- Check the [GroupChatFormat documentation](../data_format/group_chat/group_chat_format.md)
- Review the [Batch Memorization Usage Guide](../docs/dev_docs/run_memorize_usage.md)
- Open an issue on GitHub

---

**Ready to extract memories! 🧠📊**

