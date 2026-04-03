# Data - 示例对话数据

[English](README.md) | [简体中文](README_zh.md)

本目录包含用于测试和演示的示例对话数据文件。

## 📂 内容

### 双语示例数据

所有示例数据文件现已提供**英文**和**中文**两个版本：

- **`assistant_chat_en.json`** / **`assistant_chat_zh.json`** - 私聊对话示例数据
  - 一对一对话格式（人-人或人-机）
  - 用于测试私聊记忆提取
  - 提供英文和中文版本

- **`group_chat_en.json`** / **`group_chat_zh.json`** - 群组对话示例数据
  - 多用户群聊格式
  - 遵循 [GroupChatFormat](../data_format/group_chat/group_chat_format.md) 规范
  - 用于测试群组讨论的记忆提取
  - 提供英文和中文版本

**说明：** 数据中的 `conversation_meta` 字段仅用于帮助用户理解对话内容和参与者角色，不会在记忆提取和推理生成过程中使用。

## 📋 数据格式

### GroupChatFormat 规范

所有对话数据文件都遵循标准化的 [GroupChatFormat](../data_format/group_chat/group_chat_format.md) 格式：

```json
{
  "version": "1.0.0",
  "conversation_meta": {
    "scene": "group",
    "scene_desc": {},
    "group_id": "group_001",
    "name": "项目讨论组",
    "user_details": {
      "user_101": {
        "full_name": "Alice",
        "role": "产品经理"
      }
    }
  },
  "conversation_list": [
    {
      "message_id": "msg_001",
      "create_time": "2025-02-01T10:00:00+00:00",
      "sender": "user_101",
      "content": "大家早上好"
    }
  ]
}
```

### 场景类型

EverMemOS 支持两种核心对话场景：

- **🤖 Private 场景** (`scene: "private"`)
  - 一对一对话（人-人或人-机）
  - `scene_desc` 可选，用于补充上下文（如 owner_user_id、bot_ids）
  - 示例：`assistant_chat_en.json`, `assistant_chat_zh.json`

- **👥 Group 场景** (`scene: "group"`)
  - 多人群聊
  - `scene_desc` 通常为空对象
  - 示例：`group_chat_en.json`, `group_chat_zh.json`

## 📖 数据场景

### ???? (group_chat.json)

**Background:** Friends chatting about trips and daily life

**Topics:**
- Trip planning
- Daily updates and recommendations

**Characters:**
- **Alex** - Friend
- **Betty** - Friend
- **Chen** - Friend
- **Dylan** - Friend
- **Emily** - Friend

### 私聊场景 (assistant_chat.json)

**场景背景：** 一对一私聊对话

**对话主题：**
- 日常交流与更新
- 偏好与习惯
- 个人计划与提醒

💡 推荐使用 EverMemOS 探索我们构建的个人对话数据，深入了解记忆系统的工作原理！

## 🔗 相关文档

- [GroupChatFormat 规范](../data_format/group_chat/group_chat_format.md)
- [批量记忆化使用说明](../docs/dev_docs/run_memorize_usage.md)
- [演示脚本指南](../demo/README_zh.md)
- [API 文档](../docs/api_docs/memory_api.md)

## 📊 示例数据统计

| 文件 | 消息数 | 用户数 | 群组数 | 语言 | 用途 |
|------|--------|--------|--------|------|------|
| `assistant_chat_en.json` | 56 | 2 | 1 | 英文 | 私聊对话演示 |
| `assistant_chat_zh.json` | 56 | 2 | 1 | 中文 | 私聊对话演示 |
| `group_chat_en.json` | 508 | 5 | 1 | 英文 | 群聊演示 |
| `group_chat_zh.json` | 508 | 5 | 1 | 中文 | 群聊演示 |

## 💡 需要帮助？

- 查看 [GroupChatFormat 文档](../data_format/group_chat/group_chat_format.md)
- 查阅 [批量记忆化使用指南](../docs/dev_docs/run_memorize_usage.md)
- 在 GitHub 上提交问题

---

**准备好提取记忆了！🧠📊**

