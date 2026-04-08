# EverMemOS 全链路记忆 Guide（SocialClaw）

## 0. 文档定位与边界

本文是 SocialClaw 中 EverMemOS 记忆系统的全链路技术说明，面向开发与排障同学。

覆盖范围：

- 输入与触发
- 记忆构建
- 多层抽取与存储
- 检索与排序
- 模型与依赖接入
- 前端回填与重试
- 运维排障

不覆盖 UI 逐步操作（导入按钮、界面点击等），这些请参考：

- [memory-operations-guide.md](./memory-operations-guide.md)

---

## 1. 系统全景与调用时序

### 输入

- 来源 A：`social_copilot/frontend` 实时轮询/建议触发
- 来源 B：历史回填任务（Profile Admin）
- 核心入口：`POST /api/v1/copilot/process-chat`

### 处理

主时序（简化）：

`visual_monitor/frontend -> /api/v1/copilot/process-chat -> chat_workflow.process_chat -> _sync_long_term_memory -> MemoryManager.memorize -> mem_memorize -> retrieval/reply`

并发点：

- `process_chat` 内记忆同步和 profile 判定并行
- reply 生成与记忆同步解耦，具备超时保护

### 输出

- 主流程结果：`success/is_new_friend/profile_updated/contact_profile`
- 可选结果：`reply_suggestion`

### 存储/索引

- 会话缓存：Redis/ConversationData
- 结构化记忆：Mongo
- 检索索引：ES（keyword）+ Milvus（vector）

### 失败回退

- memory sync 超时不阻塞主流程
- reply suggestion 超时可返回空建议
- profile 无法提取时可回退到 stub profile

---

## 2. 记忆构建主链路（process-chat -> memorize）

### 输入

`POST /api/v1/copilot/process-chat` 关键字段：

- `owner_user_id`
- `session_key`
- `display_name`
- `messages`
- `incoming_message`（可选）
- `force_profile_update`（可选）
- `force_memory_backfill`（可选）
- `allow_memory_replay`（可选）
- `is_historical_import`（可选）

### 处理

核心顺序：

1. `routes.py` 规范化 UnifiedMessage 字段。
2. `chat_workflow._prepare_new_message_batch` 去重（按 message_id）并合并 incoming message。
3. `_sync_long_term_memory` 组装 `MemorizeRequest`。
4. `MemoryManager.memorize` 转入 `biz_layer.mem_memorize.memorize`。
5. 完成边界判定、MemCell 生成、后续抽取。

### 输出

- 业务侧：本轮 process-chat 结果对象
- 记忆侧：本轮是否产出有效 memory（取决于边界状态机）

### 存储/索引

- ConversationData（历史积累）
- ConversationStatus（pending boundary 等状态）
- MemCell 和后续记忆对象（Mongo）

### 失败回退

- 去重后无新消息：跳过后续重计算
- replay 未授权（`force_memory_backfill=true` 但 `allow_memory_replay=false`）：仅告警并按常规路径执行

---

## 3. MemCell 边界与状态机

### 输入

`MemorizeRequest` 中的：

- `history_raw_data_list`
- `new_raw_data_list`
- `group_id/conversation_id`
- `skip_pending_boundary`

### 处理

关键机制：

1. `preprocess_conv_request` 读取会话历史，拼接新消息。
2. `extract_memcell(...)` 判断是否达到边界。
3. pending boundary 机制：
   - 第一次命中边界先设 pending，返回 0，等待下一批确认。
   - 下一批确认后才真正固化 MemCell。
4. 历史导入（`skip_pending_boundary=true`）可跳过 pending。
5. 通过 boundary hash 检测并跳过重复 MemCell。

### 输出

- 可能输出 `0`（未确认边界）
- 或输出 >0（有记忆抽取并保存）

### 存储/索引

- ConversationStatus：`pending_boundary/pending_boundary_count/pending_boundary_hash`
- ConversationData：未切入 MemCell 的剩余消息

### 失败回退

- 无边界：继续积累，不中断链路
- 边界确认阶段异常：记录日志，避免系统崩溃

---

## 4. 多层记忆抽取与落库（MemCell -> Episode/Foresight/EventLog/Profile）

### 输入

- 已确认的 MemCell
- 会话 scene、participants、owner_user_id

### 处理

抽取顺序：

1. 先抽 Episode（群级 + 个人级）。
2. 回填 MemCell 的 `episode/subject`。
3. 触发 clustering。
4. clustering 后触发 profile extraction（写 unified profile）。
5. 基于 Episode 继续抽 Foresight 和 EventLog。

### 输出

- EpisodeMemory
- Foresight
- EventLog
- UnifiedProfile（self/contact）

### 存储/索引

- Mongo：原始文档主存储
- ES：keyword 检索索引
- Milvus：vector 检索索引

职责划分：

- Mongo 负责“真相数据”
- ES 负责“倒排召回”
- Milvus 负责“语义召回”

### 失败回退

- 某一层抽取失败不应导致整个 API 崩溃
- 索引写入失败时至少保留 Mongo 主存，便于后续修复重建

---

## 5. 检索全链路与方法对比（search -> dispatch）

### 输入

`GET /api/v1/memories/search` 关键参数：

- `user_id`
- `conversation_id` 或 `group_id`
- `query`
- `retrieve_method=keyword|vector|hybrid|rrf|agentic`
- `memory_types`
- `top_k`
- `start_time/end_time`
- `radius`

### 处理

1. `memory_controller.search_memories` 读取 query/body 参数。
2. `convert_dict_to_retrieve_mem_request` 标准化。
3. `MemoryManager.retrieve_mem` 按 `retrieve_method` 分发。
4. 聚合返回：按 group 组织 memories/scores/original_data。

方法对比：

- `keyword`：ES BM25，快，精确词匹配强。
- `vector`：query embedding + Milvus，语义召回强。
- `hybrid`：keyword + vector 合并后 rerank。
- `rrf`：keyword + vector 走 RRF 融合，不依赖 rerank。
- `agentic`：Round1 hybrid -> 充分性判断 -> 多查询并行 -> 融合/重排。

### 输出

统一响应核心字段：

- `memories`（按 group）
- `scores`
- `importance_scores`
- `original_data`
- `total_count`
- `metadata/query_metadata`

### 存储/索引

检索主要读：

- ES（keyword）
- Milvus（vector）
- Mongo（补齐 memcell 证据和 group profile 信息）

### 失败回退

- 子路径失败时返回空结构或降级结果，不直接抛致命错误
- rerank 失败可回退到原始排序

---

## 6. 模型与依赖接入（LLM/Vectorize/Rerank/ES/Milvus）

### 输入

依赖项：

- LLM（抽取、agentic判断、回复）
- Vectorize（embedding）
- Rerank（重排）
- ES（倒排）
- Milvus（向量库）

### 处理

能力耦合关系：

- `keyword` 只需要 ES
- `vector` 需要 Vectorize + Milvus
- `hybrid` 需要 ES + Vectorize + Milvus，建议加 Rerank
- `rrf` 需要 ES + Vectorize + Milvus，不依赖 Rerank
- `agentic` 需要 LLM + Vectorize +（建议 Rerank）

关键配置（`.env.example`）：

- `LLM_*`
- `VECTORIZE_*`
- `RERANK_*`
- `ES_*`
- `MILVUS_*`

维度约束：

- `VECTORIZE_DIMENSIONS` 必须与模型输出维度一致，否则会触发向量写入/查询异常。

### 输出

- 配置正确时：检索与排序能力完整生效
- 配置缺失时：能力降级（如仅 keyword 有效、排序质量下降）

### 存储/索引

- Vectorize 直接影响 Milvus 写入与 vector 查询
- Rerank 影响 hybrid/agentic 的结果排序质量（不改变原始存储）

### 失败回退

- Vectorize 不可用：vector路径退化或不可用
- Rerank 不可用：hybrid/agentic 回退原排序
- LLM 不可用：agentic/抽取链路能力受限

---

## 7. 前端触发与历史回填

### 输入

来源：

- 实时同步：`realtime-suggestion-adapter` 在建议前调用 process-chat
- 历史回填：`ipc-handlers` 按 session/chunk 批量调用 process-chat

### 处理

实时路径：

- 通常不传 `incoming_message`，避免重复触发后端 reply 生成
- 同步完成后更新 session backfill progress

回填路径：

- chunk 化发送
- 支持 retry
- 超时时自动缩小 chunk（degrade）

关键参数语义：

- `force_memory_backfill`：请求回放模式
- `allow_memory_replay`：允许清缓存重放（高风险）
- `is_historical_import`：历史导入语义，常用于跳过 pending

### 输出

- 回填结果统计：processed/skipped/failed/updatedProfiles
- 分 session 进度落盘

### 存储/索引

- 设置与进度：前端 settings/sessionBackfillProgress
- 记忆数据：由后端按标准链路落 Mongo/ES/Milvus

### 失败回退

- chunk 失败重试
- 超时降级 chunk 大小
- 失败 session 单独记录，不阻塞全部任务

---

## 8. 排障与缺漏检查清单

### 输入

典型症状：

- process-chat 成功但不产出 MemCell
- 有记忆但搜不到
- 有结果但排序差
- 回填慢/超时

### 处理

最短诊断路径：

1. 先看入口参数是否完整（user_id/conversation_id/query/method）。
2. 再看状态机（pending、去重、skip_pending）。
3. 再看依赖可用性（ES/Milvus/Vectorize/Rerank/LLM）。
4. 最后看索引是否存在与是否写入成功。

缺漏项检查：

- 只配 LLM，没配 `VECTORIZE_*` / `RERANK_*`
- Milvus 起了但无向量写入
- `memory_types` 默认只查 episodic，导致误判“搜不到”
- `top_k` 默认值认知错误（DTO 默认 40，converter 入口默认 10）
- `force_memory_backfill` 未配 `allow_memory_replay`

### 输出

- 问题可定位到具体层：输入层/状态机层/依赖层/索引层

### 存储/索引

- 检查目标对象：ConversationStatus、MemCell、Episode/Foresight/EventLog、ES index、Milvus collection

### 失败回退

- 依赖层局部失败时先走降级路径，保障基本可用性，再做修复

---

## 9. 公开接口与关键类型速查

公开接口：

1. `POST /api/v1/copilot/process-chat`
2. `GET /api/v1/memories/search`
3. `GET /api/v1/copilot/conversations/{conversation_id}/context`
4. `GET /api/v1/copilot/episodes|memcells|foresights`

关键类型：`RetrieveMemRequest`

- `retrieve_method`
- `top_k`
- `memory_types`
- `start_time`
- `end_time`
- `radius`

默认值差异（需显式写清）：

- DTO 中 `top_k` 默认是 40
- 入口 converter 中默认 `top_k` 是 10

---

## 10. 示例补全（最小可复现）

### 10.1 构建示例：普通实时 process-chat

```bash
curl -X POST http://127.0.0.1:1995/api/v1/copilot/process-chat \
  -H "Content-Type: application/json" \
  -d '{
    "owner_user_id":"u_self",
    "session_key":"wechat::alice",
    "display_name":"Alice",
    "messages":[
      {
        "message_id":"m1",
        "conversation_id":"wechat::alice",
        "sender_id":"alice",
        "sender_name":"Alice",
        "sender_type":"contact",
        "content":"这周把需求定稿吧",
        "timestamp":"2026-04-08T10:00:00+08:00",
        "content_type":"text"
      }
    ]
  }'
```

### 10.2 构建示例：历史回填 process-chat

```bash
curl -X POST http://127.0.0.1:1995/api/v1/copilot/process-chat \
  -H "Content-Type: application/json" \
  -d '{
    "owner_user_id":"u_self",
    "session_key":"wechat::alice",
    "display_name":"Alice",
    "force_memory_backfill":true,
    "allow_memory_replay":true,
    "is_historical_import":true,
    "messages":[ ...历史消息批次... ]
  }'
```

### 10.3 检索示例：五种 retrieve_method

```bash
# keyword
curl "http://127.0.0.1:1995/api/v1/memories/search?user_id=u_self&conversation_id=wechat::alice&query=她最近在推进什么&retrieve_method=keyword&memory_types=episodic_memory&top_k=10"

# vector
curl "http://127.0.0.1:1995/api/v1/memories/search?user_id=u_self&conversation_id=wechat::alice&query=她最近在推进什么&retrieve_method=vector&memory_types=episodic_memory&top_k=10"

# hybrid
curl "http://127.0.0.1:1995/api/v1/memories/search?user_id=u_self&conversation_id=wechat::alice&query=她最近在推进什么&retrieve_method=hybrid&memory_types=episodic_memory,foresight&top_k=10"

# rrf
curl "http://127.0.0.1:1995/api/v1/memories/search?user_id=u_self&conversation_id=wechat::alice&query=她最近在推进什么&retrieve_method=rrf&memory_types=episodic_memory,foresight&top_k=10"

# agentic
curl "http://127.0.0.1:1995/api/v1/memories/search?user_id=u_self&conversation_id=wechat::alice&query=结合上下文推断她下一步最可能做什么&retrieve_method=agentic&memory_types=episodic_memory,foresight,event_log&top_k=10"
```

### 10.4 端到端验证示例（写入 -> 检索 -> 排序观察）

1. 先发 1~2 批 `process-chat` 写入数据。  
2. 用 `keyword` 验证至少有命中。  
3. 切到 `vector/hybrid` 比较召回变化。  
4. 观察 `hybrid` 在启用/关闭 rerank 时前排差异。  

---

## 11. 可执行验收清单

1. 仅 keyword 可用时，系统仍可检索并返回结果。  
2. 启用 vectorize 后，`vector/hybrid` 召回提升可观察。  
3. 启用 rerank 后，`hybrid/agentic` 前排质量变化可观察。  
4. rerank 不可用时，存在可验证的降级路径。  
5. 新人可用本指南定位“为什么没生成 MemCell/为什么搜不到”。  
6. 每个核心章节均包含：输入 -> 处理 -> 输出 -> 存储/索引 -> 失败回退。  

---

## 12. 代码锚点（阅读顺序建议）

- `memory/evermemos/src/copilot_orchestrator/chat_workflow.py`
- `memory/evermemos/src/biz_layer/mem_memorize.py`
- `memory/evermemos/src/agentic_layer/memory_manager.py`
- `memory/evermemos/src/agentic_layer/vectorize_service.py`
- `memory/evermemos/src/agentic_layer/rerank_service.py`
- `memory/evermemos/src/infra_layer/adapters/input/api/memory/memory_controller.py`
- `memory/evermemos/src/api_specs/request_converter.py`

