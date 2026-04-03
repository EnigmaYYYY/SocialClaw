# API 使用指南

本文档详细介绍如何使用 MemSys 的 API 接口来存储和检索记忆数据。

## 📋 目录

- [API 概览](#api-概览)
- [存储记忆接口](#存储记忆接口)
  - [V1 Memory API](#v3-agentic-api)
  - [V1 Memory API](#v1-memory-api)
  - [接口选择建议](#接口选择建议)
- [群聊数据格式](#群聊数据格式)
- [使用脚本存储记忆](#使用脚本存储记忆)
- [API 调用示例](#api-调用示例)

## 🔍 API 概览

MemSys 提供两套标准化的 API 接口用于存储记忆：

### 可用接口

| API 类型 | 接口地址 | 功能 | 推荐场景 |
|---------|---------|------|---------|
| **V1 Memory API** | `/api/v1/memories` | 存储记忆 + 智能检索 | 需要检索功能的完整应用场景 |


### 接口对比

| 特性 | V1 Memory API | V1 Memory API |
|-----|---------------|--------------|
| 存储单条消息 | ✅ 支持 | ✅ 支持 |
| 消息格式 | 简单直接的单条消息格式 | 简单直接的单条消息格式 |
| 智能检索 | ✅ 支持（轻量级 + Agentic） | ❌ 不支持 |
| 会话元数据管理 | ✅ 支持 | ✅ 支持（含 PATCH 更新） |
| 适用场景 | 完整的记忆系统（存储+检索） | 纯记忆存储系统 |

**重要提示**：两个接口的存储格式完全相同，可以根据您的需求选择使用。如果您需要检索功能，建议使用 V1 Memory API 以获得完整的功能支持。

---

## 🚀 存储记忆接口

### V1 Memory API

推荐用于需要完整功能（存储 + 检索）的场景。

#### 接口地址

```
POST /api/v1/memories
```

#### 特性

- ✅ 简单直接的单条消息格式
- ✅ 支持轻量级检索（RRF 融合）
- ✅ 支持 Agentic 智能检索（LLM 辅助）
- ✅ 支持会话元数据管理

详细文档请参考：[Memory API 文档](../api_docs/memory_api.md)

---

### V1 Memory API

推荐用于仅需存储功能的简单场景。

#### 接口地址

```
POST /api/v1/memories
```

#### 特性

- ✅ 简单直接的单条消息格式
- ✅ 专注于记忆存储
- ✅ 支持会话元数据管理（含 PATCH 部分更新）

详细文档请参考：[Memory API 文档](../api_docs/memory_api.md)

---

### 接口选择建议

**使用 V1 Memory API (`/api/v1/memories`)** 如果：
- ✅ 您需要使用智能检索功能
- ✅ 您需要构建完整的记忆系统（存储 + 检索）
- ✅ 您希望使用轻量级或 Agentic 检索模式

**使用 V1 Memory API (`/api/v1/memories`)** 如果：
- ✅ 您只需要存储记忆，不需要检索
- ✅ 您有自己的检索方案
- ✅ 您希望使用更简洁的专用存储接口

**注意**：两个接口的数据格式完全相同，底层存储机制也相同，主要区别在于 V1 API 提供了额外的检索功能。

---

## 📝 Memorize API 接口详情

### 请求格式（两个接口通用）

两个接口使用相同的简单直接的单条消息格式：

```json
{
  "message_id": "msg_001",
  "create_time": "2025-02-01T10:00:00+00:00",
  "sender": "user_103",
  "sender_name": "Chen",
  "content": "消息内容",
  "refer_list": [],
  "group_id": "group_001",
  "group_name": "项目讨论组"
}
```

### 字段说明

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `message_id` | string | 是 | 消息唯一标识符 |
| `create_time` | string | 是 | 消息创建时间（ISO 8601 格式） |
| `sender` | string | 是 | 发送者 ID |
| `sender_name` | string | 否 | 发送者名称（便于阅读） |
| `content` | string | 是 | 消息内容 |
| `refer_list` | array | 否 | 引用的消息列表 |
| `group_id` | string | 否 | 群组 ID |
| `group_name` | string | 否 | 群组名称 |

### 响应格式

```json
{
  "code": 0,
  "message": "success",
  "result": {
    "count": 2,
    "saved_memories": [
      {
        "memory_id": "mem_001",
        "type": "episode",
        "content": "提取的记忆内容"
      }
    ]
  }
}
```

### 调用示例

#### cURL

```bash
curl -X POST http://localhost:1995/api/v1/memories \
  -H "Content-Type: application/json" \
  -d '{
    "message_id": "msg_001",
    "create_time": "2025-02-01T10:00:00+00:00",
    "sender": "user_103",
    "sender_name": "Chen",
    "content": "我们需要在本周完成产品设计",
    "group_id": "group_001",
    "group_name": "项目讨论组"
  }'
```

#### Python

```python
import httpx
import asyncio

async def store_memory():
    async with httpx.AsyncClient() as client:
        response = await client.post(
            "http://localhost:1995/api/v1/memories",
            json={
                "message_id": "msg_001",
                "create_time": "2025-02-01T10:00:00+00:00",
                "sender": "user_103",
                "sender_name": "Chen",
                "content": "我们需要在本周完成产品设计",
                "group_id": "group_001",
                "group_name": "项目讨论组"
            }
        )
        print(response.json())

asyncio.run(store_memory())
```

#### JavaScript


**使用 V1 Memory API：**

```javascript
fetch('http://localhost:1995/api/v1/memories', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    message_id: 'msg_001',
    create_time: '2025-02-01T10:00:00+00:00',
    sender: 'user_103',
    sender_name: 'Chen',
    content: '我们需要在本周完成产品设计',
    group_id: 'group_001',
    group_name: '项目讨论组'
  })
})
.then(response => response.json())
.then(data => console.log(data));
```

## 📁 群聊数据格式

MemSys 定义了标准化的群聊数据格式 `GroupChatFormat`，用于存储和交换群聊对话数据。

### 格式概览

```json
{
  "version": "1.0.0",
  "conversation_meta": {
    "group_id": "group_friends_001",
    "name": "Weekend Friends Chat",
    "default_timezone": "+00:00",
    "user_details": {
      "user_101": {
        "full_name": "Alex",
        "role": "friend"
      }
    }
  },
  "conversation_list": [
    {
      "message_id": "msg_001",
      "create_time": "2025-02-01T10:00:00+00:00",
      "sender": "user_101",
      "sender_name": "Alex",
      "type": "text",
      "content": "Good morning everyone",
      "refer_list": []
    }
  ]
}
```

### 核心特性

1. **分离的元信息和消息列表**
   - `conversation_meta`: 群聊元信息
   - `conversation_list`: 消息列表

2. **集中的用户详细信息**
   - 所有用户信息存储在 `user_details` 中
   - 消息中只需引用用户 ID

3. **时区感知的时间戳**
   - 使用 ISO 8601 格式
   - 支持时区信息

4. **灵活的消息引用**
   - 支持字符串引用（仅 message_id）
   - 支持对象引用（包含完整消息信息）

### 详细文档

完整的格式说明请参考：[群聊格式规范](../../data_format/group_chat/group_chat_format.md)

## 🔧 使用脚本存储记忆

MemSys 提供了 `run_memorize.py` 脚本，可以批量将群聊数据存储到系统中。该脚本支持两个 API 接口。

### 脚本位置

```
src/run_memorize.py
```

### 基本用法

使用 Bootstrap 脚本运行 V1 API：



**使用 V1 Memory API（仅存储）：**

```bash
uv run python src/bootstrap.py src/run_memorize.py \
  --input data/group_chat.json \
  --api-url http://localhost:1995/api/v1/memories
```

### 命令行参数

| 参数 | 必需 | 说明 |
|------|------|------|
| `--input` | 是 | 输入的群聊 JSON 文件路径（GroupChatFormat 格式） |
| `--api-url` | 否* | memorize API 地址（*除非使用 --validate-only） |
| `--validate-only` | 否 | 仅验证输入文件格式，不执行存储 |

### 使用示例

#### 1. 存储记忆

**使用 V1 Memory API：**

```bash
# 基本用法
uv run python src/bootstrap.py src/run_memorize.py \
  --input data/group_chat.json \
  --api-url http://localhost:1995/api/v1/memories

# 使用相对路径
uv run python src/bootstrap.py src/run_memorize.py \
  --input ../my_data/chat_history.json \
  --api-url http://localhost:1995/api/v1/memories
```

#### 2. 验证文件格式

在存储前验证文件格式是否正确：

```bash
uv run python src/bootstrap.py src/run_memorize.py \
  --input data/group_chat.json \
  --validate-only
```

### 脚本工作流程

1. **验证输入文件**
   - 检查 JSON 格式是否正确
   - 验证是否符合 GroupChatFormat 规范
   - 输出数据统计信息

2. **逐条处理消息**
   - 从群聊文件中读取每条消息
   - 逐条调用 API 存储
   - 显示处理进度和结果

3. **输出处理结果**
   - 成功处理的消息数量
   - 保存的记忆数量
   - 失败的消息（如有）

### 输出示例

```
🚀 群聊记忆存储脚本
======================================================================
📄 输入文件: /path/to/data/group_chat.json
🔍 验证模式: 否
🌐 API地址: http://localhost:1995/api/v1/memories
======================================================================

======================================================================
验证输入文件格式
======================================================================
正在读取文件: /path/to/data/group_chat.json
正在验证 GroupChatFormat 格式...
✓ 格式验证通过！

=== 数据统计 ===
格式版本: 1.0.0
群聊名称: 项目讨论组
群聊ID: group_001
用户数量: 5
消息数量: 20
时间范围: 2025-02-01T10:00:00+00:00 ~ 2025-02-01T18:30:00+00:00

======================================================================
开始逐条调用 memorize API
======================================================================
群组名称: 项目讨论组
群组ID: group_001
消息数量: 20
API地址: http://localhost:1995/api/v1/memories

--- 处理第 1/20 条消息 ---
  ✓ 成功保存 2 条记忆

--- 处理第 2/20 条消息 ---
  ✓ 成功保存 1 条记忆

...

======================================================================
处理完成
======================================================================
✓ 成功处理: 20/20 条消息
✓ 共保存: 35 条记忆
```

## 📝 API 调用示例

### 完整的工作流程

#### 1. 准备数据文件

创建符合 GroupChatFormat 的 JSON 文件：

```json
{
  "version": "1.0.0",
  "conversation_meta": {
    "group_id": "group_friends_001",
    "name": "Weekend Friends Chat",
    "default_timezone": "+00:00",
    "user_details": {
      "alice": {
        "full_name": "Alice Wang",
        "role": "friend"
      },
      "bob": {
        "full_name": "Bob Chen",
        "role": "friend"
      }
    }
  },
  "conversation_list": [
    {
      "message_id": "msg_20250201_001",
      "create_time": "2025-02-01T09:00:00+00:00",
      "sender": "alice",
      "sender_name": "Alice Wang",
      "type": "text",
      "content": "Good morning! Let's discuss weekend plans",
      "refer_list": []
    },
    {
      "message_id": "msg_20250201_002",
      "create_time": "2025-02-01T09:02:00+00:00",
      "sender": "bob",
      "sender_name": "Bob Chen",
      "type": "text",
      "content": "Sure, any suggestions?",
      "refer_list": ["msg_20250201_001"]
    }
  ]
}
```

保存为 `my_chat_data.json`。

#### 2. 验证文件格式

```bash
uv run python src/bootstrap.py src/run_memorize.py \
  --input my_chat_data.json \
  --validate-only
```

#### 3. 启动服务

确保 MemSys 服务正在运行：

```bash
uv run python src/run.py
```

服务启动后，访问 http://localhost:1995/docs 验证 API 文档可访问。

#### 4. 存储记忆



**选择 B：使用 V1 Memory API**

```bash
uv run python src/bootstrap.py src/run_memorize.py \
  --input my_chat_data.json \
  --api-url http://localhost:1995/api/v1/memories
```

#### 5. 验证存储结果

如果使用 V1 Memory API，可以通过检索接口查询已存储的记忆（具体查询 API 请参考 [Memory API 文档](../api_docs/memory_api.md)）。

### 错误处理

#### 格式验证失败

```
✗ 格式验证失败！
请确保输入文件符合 GroupChatFormat 规范
```

**解决方案**：
- 检查 JSON 格式是否正确
- 参考 [群聊格式规范](../../data_format/group_chat/group_chat_format.md)
- 确保必需字段都已填写

#### API 调用失败

```
✗ API调用失败: 500
响应内容: {"error": "Internal server error"}
```

**解决方案**：
- 检查服务是否正常运行
- 查看服务日志排查问题
- 确认 API 地址是否正确

#### 连接超时

```
✗ 处理失败: ReadTimeout
```

**解决方案**：
- 检查网络连接
- 确认服务地址和端口正确
- 检查防火墙设置

## 🔗 相关文档

### API 文档

- [Memory API 文档](../api_docs/memory_api.md) - V1 API 完整文档（存储 + 检索）
- [Memory API 文档](../api_docs/memory_api.md) - V1 Memory API 完整文档（专注存储）

### 其他文档

- [群聊格式规范](../../data_format/group_chat/group_chat_format.md) - GroupChatFormat 详细说明
- [快速开始指南](getting_started.md) - 环境搭建和服务启动
- [Agentic 检索指南](agentic_retrieval_guide.md) - 智能检索功能详解

## 💡 最佳实践

1. **数据准备**
   - 使用标准的 GroupChatFormat 格式
   - 确保时间戳包含时区信息
   - 为用户提供完整的详细信息

2. **批量处理**
   - 对于大量消息，使用脚本逐条处理
   - 添加适当的延迟避免服务器压力
   - 监控处理进度和错误

3. **错误恢复**
   - 记录处理失败的消息
   - 支持断点续传
   - 定期验证存储结果

4. **性能优化**
   - 合理设置并发数量
   - 使用批量接口（如适用）
   - 监控 API 响应时间

---

如有问题，请参考 [常见问题](getting_started.md#常见问题) 或提交 Issue。


