# Social Copilot 接入 EverMemOS 设计文档

> 本文档整合了两版设计思路，标注共识点、差异点和待确认决策。
> 详细版本见 `D:\SC\social_copilot_integration.md`。

---

## 一、整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    Social Copilot Frontend                       │
│  (聊天界面 / 建议回复面板 / 意图输入 / 人设卡片展示)              │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTP API
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Copilot Orchestrator                          │
│  (上下文组装 / Planner-Responder 调度 / Guardrail / 回退)        │
│                                                                 │
│  核心职责:                                                       │
│  1. 屏蔽 EverMemOS 底层复杂对象结构                              │
│  2. 组装 LLM 推理所需的完整上下文                                │
│  3. 执行回复生成流水线 (Planner → Responder → Guardrail)         │
│  4. 管理会话状态与缓存                                           │
└──────────┬──────────────────────────────────────┬───────────────┘
           │                                      │
           ▼                                      ▼
┌──────────────────────┐              ┌──────────────────────────┐
│      EverMemOS       │              │      LLM Service         │
│  (记忆 / 画像 / 检索) │              │  (Planner / Responder)   │
│                      │              │                          │
│  - Profile 查询      │              │  - Claude / 其他 LLM      │
│  - Memory 检索       │              │  - Prompt 管理            │
│  - MemCell 写入      │              │  - 响应解析               │
│  - Episode/EventLog  │              │                          │
└──────────┬───────────┘              └──────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    存储层                                        │
│  MongoDB (权威存储) / Redis (缓存/状态) / ES (文本检索) / Milvus │
└─────────────────────────────────────────────────────────────────┘
```

---

## 二、核心 API 设计

### 2.1 写入记忆 (异步)

**用途**: 新消息到达时，增量写入 EverMemOS 做记忆抽取。

**请求**:
```http
POST /api/v1/copilot/memorize
Content-Type: application/json
```

**请求体**:
```json
{
  "conversation_id": "conv_abc123",
  "scene": "private",
  "owner_user_id": "user_owner_001",
  "target_user_id": "user_friend_002",
  "messages": [
    {
      "message_id": "msg_001",
      "sender_id": "user_friend_002",
      "sender_name": "张三",
      "content": "晚上出来吃饭吗？",
      "timestamp": 1710000000,
      "type": "text"
    },
    {
      "message_id": "msg_002",
      "sender_id": "user_owner_001",
      "sender_name": "我",
      "content": "今晚可能不行",
      "timestamp": 1710000100,
      "type": "text"
    }
  ],
  "options": {
    "trigger_profile_extraction": true,
    "trigger_episode_extraction": true
  }
}
```

**响应**:
```json
{
  "success": true,
  "job_id": "job_xyz789",
  "message": "记忆写入任务已提交"
}
```

**说明**:
- 此接口应**异步处理**，不阻塞前端
- 返回 job_id 可用于后续查询处理状态
- EverMemOS 内部会触发 MemCell 切分、Profile/Episode 抽取等流程

---

### 2.2 获取建议回复 (核心接口)

**用途**: 前端请求"应该怎么回复"。

**请求**:
```http
POST /api/v1/copilot/reply-suggestion
Content-Type: application/json
```

**请求体**:
```json
{
  "conversation_id": "conv_abc123",
  "scene": "private",
  "owner_user_id": "user_owner_001",
  "target_user_id": "user_friend_002",
  "incoming_message": {
    "message_id": "msg_003",
    "sender_id": "user_friend_002",
    "sender_name": "张三",
    "content": "那明天呢？",
    "timestamp": 1710000200
  },
  "manual_intent": "想答应，但不要表现太积极",
  "history_window": 20,
  "options": {
    "include_explanation": true,
    "max_reply_length": 50,
    "allow_question": false
  }
}
```

**响应**:
```json
{
  "success": true,
  "data": {
    "should_reply": true,
    "reply_text": "明天可以",
    "alternatives": [
      {
        "reply_text": "明天行啊",
        "style": "更随意"
      },
      {
        "reply_text": "明天应该有空",
        "style": "更保留"
      }
    ],
    "planner_decision": {
      "intent": "同意邀约",
      "tone": "轻松但不热情",
      "question_policy": "no_question",
      "reasoning": "用户手动意图为'不要表现太积极'，因此选择简短确认"
    },
    "evidence": {
      "self_profile_used": true,
      "friend_profile_used": true,
      "memory_hits": [
        "你平时答应邀约时比较简短",
        "和对方关系较熟"
      ],
      "persona_anchors": {
        "catchphrases": ["嗯", "行", "可以"],
        "style_tags": ["简短", "不爱追问"]
      }
    },
    "risk_check": {
      "passed": true,
      "flags": [],
      "rewrites_applied": []
    }
  }
}
```

**响应字段说明**:

| 字段 | 说明 |
|------|------|
| `should_reply` | 是否建议回复 |
| `reply_text` | 主推荐回复 |
| `alternatives` | 备选回复 |
| `planner_decision` | Planner 的策略决策摘要 |
| `evidence` | 决策依据（供前端展示"为什么这样回"）|
| `risk_check` | 风险检测结果 |

---

### 2.3 获取会话上下文

**用途**: 前端展示"人设卡片"或调试。

**请求**:
```http
GET /api/v1/copilot/conversations/{conversation_id}/context
```

**查询参数**:
```
owner_user_id=user_owner_001
target_user_id=user_friend_002
```

**响应**:
```json
{
  "success": true,
  "data": {
    "conversation_id": "conv_abc123",
    "scene": "private",
    "self_profile": {
      "display_name": "我",
      "traits": ["内敛", "不爱主动"],
      "catchphrases": ["嗯", "行", "可以"],
      "style_summary": "回复偏简短，不喜欢追问"
    },
    "friend_profile": {
      "display_name": "张三",
      "relationship": "熟人",
      "traits": ["健谈", "喜欢约人"],
      "interaction_pattern": "经常主动发起邀约"
    },
    "recent_episodes": [
      {
        "summary": "他约你吃饭，你拒绝了",
        "timestamp": 1710000000
      }
    ],
    "pending_foresights": [
      {
        "content": "明天可能要确认具体时间",
        "priority": "medium"
      }
    ]
  }
}
```

---

### 2.4 批量生成建议回复

**用途**: 一次请求生成多个候选回复，供用户选择。

**请求**:
```http
POST /api/v1/copilot/reply-suggestions/batch
Content-Type: application/json
```

**请求体**:
```json
{
  "conversation_id": "conv_abc123",
  "scene": "private",
  "owner_user_id": "user_owner_001",
  "target_user_id": "user_friend_002",
  "incoming_message": {
    "message_id": "msg_003",
    "content": "那明天呢？"
  },
  "manual_intent": "想答应，但不要表现太积极",
  "count": 3,
  "styles": ["简短", "带表情", "带追问"]
}
```

**响应**:
```json
{
  "success": true,
  "data": {
    "suggestions": [
      {
        "reply_text": "明天可以",
        "style": "简短",
        "confidence": 0.85
      },
      {
        "reply_text": "明天行啊 😊",
        "style": "带表情",
        "confidence": 0.72
      },
      {
        "reply_text": "明天应该行，几点？",
        "style": "带追问",
        "confidence": 0.68,
        "risk_note": "包含追问，可能偏离用户意图"
      }
    ]
  }
}
```

---

### 2.5 反馈与学习

**用途**: 用户选择/修改/拒绝建议回复后，记录反馈用于优化。

**请求**:
```http
POST /api/v1/copilot/feedback
Content-Type: application/json
```

**请求体**:
```json
{
  "conversation_id": "conv_abc123",
  "suggestion_id": "sugg_001",
  "action": "accepted",
  "modified_text": null,
  "user_comment": "这个回复挺像我的风格"
}
```

**action 枚举**:
- `accepted`: 直接采纳
- `modified`: 采纳但修改过
- `rejected`: 拒绝
- `regenerate`: 请求重新生成

---

## 三、Copilot Orchestrator 内部流程

### 3.1 Reply Suggestion 生成流水线

```
┌─────────────────────────────────────────────────────────────────┐
│                    Orchestrator 内部流程                         │
└─────────────────────────────────────────────────────────────────┘

1. 接收请求
   └── 解析 conversation_id, owner_user_id, target_user_id, manual_intent

2. 拉取上下文
   ├── 从 EverMemOS 获取:
   │   ├── self_profile (用户自我画像)
   │   ├── friend_profile (对方画像)
   │   ├── group_profile (如果是群聊)
   │   ├── persona_anchors (口头禅/风格锚点)
   │   └── relevant_memories (相关历史记忆)
   └── 从消息存储获取:
       └── recent_history (最近 N 条消息)

3. 推断回复意愿 (如未手动指定)
   └── 根据历史互动模式 + 当前消息类型

4. 构造 Planner Prompt
   ├── 注入画像信息
   ├── 注入历史上下文
   ├── 注入 persona anchors
   ├── 注入相关记忆
   └── 注入手动意图 (如有)

5. 调用 Planner (LLM)
   └── 返回策略 JSON:
       ├── should_reply: bool
       ├── intent: string
       ├── tone: string
       ├── question_policy: enum
       └── key_points: string[]

6. 决策分支
   ├── if not should_reply:
   │   └── 返回 { should_reply: false }
   └── if should_reply:
       └── 继续

7. 构造 Responder Prompt
   ├── 注入 Planner 决策
   ├── 注入画像/风格约束
   ├── 注入手动意图 (如有)
   └── 注入硬约束 (禁止 AI 味/禁止编造/长度限制)

8. 调用 Responder (LLM)
   └── 返回候选回复文本

9. Guardrail 检查
   ├── 检查是否 AI 味/客服腔
   ├── 检查是否包含新事实/虚假承诺
   ├── 检查是否违反手动意图
   ├── 检查是否重复
   ├── 检查是否离题
   └── 检查是否过长

10. 风险处理
    ├── if 有风险:
    │   ├── 尝试 grounded_casual_rewrite
    │   └── 如仍不行 → fallback_human_reply
    └── if 无风险:
        └── 保留原回复

11. 构造响应
    └── 返回 reply_text + evidence + risk_check

12. 异步记录反馈数据
    └── 用于后续优化
```

---

## 四、EverMemOS 查询接口封装

Copilot Orchestrator 需要调用 EverMemOS 以下能力：

### 4.1 获取用户画像

```python
# 伪代码
async def get_profiles(
    conversation_id: str,
    owner_user_id: str,
    target_user_id: str
) -> Dict[str, Any]:
    """
    返回:
    - self_profile: 用户自己的画像
    - friend_profile: 对方画像
    - group_profile: 群画像 (如适用)
    """
    pass
```

### 4.2 获取风格锚点

```python
async def get_persona_anchors(
    owner_user_id: str
) -> Dict[str, Any]:
    """
    返回:
    - catchphrases: 口头禅列表
    - style_tags: 风格标签
    - reply_patterns: 常见回复模式
    """
    pass
```

### 4.3 检索相关记忆

```python
async def retrieve_relevant_memories(
    conversation_id: str,
    owner_user_id: str,
    target_user_id: str,
    incoming_message: str,
    top_k: int = 5
) -> List[Dict[str, Any]]:
    """
    基于 incoming_message 检索相关的:
    - Episode
    - EventLog
    - Foresight
    - 历史相似对话
    """
    pass
```

### 4.4 写入新消息

```python
async def memorize_messages(
    conversation_id: str,
    messages: List[Dict[str, Any]],
    options: Dict[str, Any]
) -> str:
    """
    写入新消息，触发记忆抽取
    返回 job_id
    """
    pass
```

---

## 五、前端集成指南

### 5.1 消息到达时的调用顺序

```javascript
// 1. 收到新消息时，异步写入记忆
async function onNewMessage(message) {
  // 先显示消息
  displayMessage(message);

  // 异步写入 EverMemOS
  fetch('/api/v1/copilot/memorize', {
    method: 'POST',
    body: JSON.stringify({
      conversation_id: currentConversationId,
      messages: [message]
    })
  });
}

// 2. 用户点击"生成建议回复"
async function generateReplySuggestion(incomingMessage, manualIntent) {
  const response = await fetch('/api/v1/copilot/reply-suggestion', {
    method: 'POST',
    body: JSON.stringify({
      conversation_id: currentConversationId,
      owner_user_id: currentUserId,
      target_user_id: friendId,
      incoming_message: incomingMessage,
      manual_intent: manualIntent  // 可选
    })
  });

  const data = await response.json();

  if (data.data.should_reply) {
    showSuggestion(data.data.reply_text, data.data.evidence);
  } else {
    showNoReplyNeeded();
  }
}

// 3. 用户选择/修改后，记录反馈
async function submitFeedback(suggestionId, action, modifiedText) {
  await fetch('/api/v1/copilot/feedback', {
    method: 'POST',
    body: JSON.stringify({
      suggestion_id: suggestionId,
      action: action,
      modified_text: modifiedText
    })
  });
}
```

### 5.2 UI 组件建议

```
┌─────────────────────────────────────────────────────┐
│  聊天界面                                           │
├─────────────────────────────────────────────────────┤
│  [消息列表]                                         │
│                                                     │
│  张三: 那明天呢？                                   │
│                                                     │
├─────────────────────────────────────────────────────┤
│  [建议回复面板]                                     │
│  ┌───────────────────────────────────────────────┐ │
│  │ 建议回复: "明天可以"                          │ │
│  │                                               │ │
│  │ 风格: 简短、轻松                              │ │
│  │ 依据: 你平时答应邀约时比较简短                 │ │
│  │                                               │ │
│  │ [采纳] [重新生成] [修改后发送]                │ │
│  └───────────────────────────────────────────────┘ │
│                                                     │
│  手动意图: [想答应，但不要表现太积极         ]      │
│                                                     │
├─────────────────────────────────────────────────────┤
│  [输入框]                                           │
└─────────────────────────────────────────────────────┘
```

---

## 六、错误处理与降级

### 6.1 错误码设计

| 错误码 | 说明 | 前端处理建议 |
|--------|------|--------------|
| `PROFILE_NOT_FOUND` | 用户画像不存在 | 引导用户多聊几句后再试 |
| `MEMORY_SERVICE_UNAVAILABLE` | EverMemOS 服务不可用 | 降级到无记忆的简单回复 |
| `LLM_TIMEOUT` | LLM 响应超时 | 显示"生成中，请稍后重试" |
| `RATE_LIMIT_EXCEEDED` | 请求频率超限 | 提示用户稍后再试 |

### 6.2 降级策略

```python
async def get_reply_suggestion(request):
    try:
        # 尝试完整流程
        return await full_pipeline(request)
    except MemoryServiceError:
        # 降级: 不使用记忆，只基于当前对话
        return await fallback_without_memory(request)
    except LLMError:
        # 降级: 返回预设的安全回复
        return await fallback_canned_reply(request)
```

---

## 七、下一步落地建议

### Phase 1: 最小可用 (1-2 周)

1. 实现 `/api/v1/copilot/reply-suggestion` 核心接口
2. 复用现有 demo 中的 dual-agent 逻辑
3. 只实现 self_profile + recent_history 上下文
4. 前端简单展示建议回复

### Phase 2: 完整上下文 (2-3 周)

1. 接入 friend_profile / group_profile
2. 接入 persona_anchors
3. 实现 memory retrieval
4. 前端展示"为什么这样回"

### Phase 3: 反馈闭环 (1-2 周)

1. 实现反馈接口
2. 收集用户选择数据
3. 用于后续 prompt / 策略优化

---

## 八、关键问题与决策点

| 问题 | 选项 | 建议 |
|------|------|------|
| 记忆写入是同步还是异步？ | 同步/异步 | **异步**，不阻塞用户 |
| Profile 每次都查还是缓存？ | 实时查/缓存 | **短时缓存**，5-10 分钟 |
| 手动意图是必填还是可选？ | 必填/可选 | **可选**，但高优先级 |
| 回复长度由谁控制？ | 前端/后端/LLM | **后端控制**，配置化 |
| 多候选回复如何排序？ | confidence/style | **按风格多样性** |

---

## 九、文档更新记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2024-XX-XX | v0.1 | 初始草案 |

---

**下一步**: 确认 API 设计后，可以开始实现 Orchestrator 层的骨架代码。