# EverMemOS End-to-End Memory Guide (SocialClaw)

## 0. Positioning and Boundaries

This document is an end-to-end technical guide for the EverMemOS memory system inside SocialClaw.

It covers:

- Input and trigger paths
- Memory construction
- Multi-layer extraction and persistence
- Retrieval and ranking
- Model/dependency integration
- Frontend backfill and retry behavior
- Production troubleshooting

It does not cover step-by-step UI operations. For product operations, see:

- [memory-operations-guide.md](./memory-operations-guide.md)

---

## 1. System Overview and Call Sequence

### Input

- Source A: realtime suggestion flow from `social_copilot/frontend`
- Source B: historical backfill (Profile Admin)
- Core entrypoint: `POST /api/v1/copilot/process-chat`

### Processing

High-level sequence:

`visual_monitor/frontend -> /api/v1/copilot/process-chat -> chat_workflow.process_chat -> _sync_long_term_memory -> MemoryManager.memorize -> mem_memorize -> retrieval/reply`

Concurrency:

- `process_chat` runs memory sync and profile update gating in parallel
- reply generation is decoupled and timeout-protected

### Output

- Main flow fields: `success/is_new_friend/profile_updated/contact_profile`
- Optional field: `reply_suggestion`

### Storage/Index

- Conversation cache: Redis/ConversationData
- Structured memories: MongoDB
- Search indexes: Elasticsearch (keyword) + Milvus (vector)

### Failure Fallback

- memory sync timeout does not block request completion
- reply timeout can return empty suggestion
- profile extraction can fall back to stub profile

---

## 2. Memory Construction Main Path (process-chat -> memorize)

### Input

Key fields in `POST /api/v1/copilot/process-chat`:

- `owner_user_id`
- `session_key`
- `display_name`
- `messages`
- `incoming_message` (optional)
- `force_profile_update` (optional)
- `force_memory_backfill` (optional)
- `allow_memory_replay` (optional)
- `is_historical_import` (optional)

### Processing

Core order:

1. `routes.py` normalizes UnifiedMessage fields.
2. `chat_workflow._prepare_new_message_batch` deduplicates by `message_id` and merges incoming message.
3. `_sync_long_term_memory` builds `MemorizeRequest`.
4. `MemoryManager.memorize` forwards to `biz_layer.mem_memorize.memorize`.
5. Boundary detection, MemCell generation, and downstream extraction are executed.

### Output

- Process result object from `process-chat`
- Whether this round produced extracted memories (depends on boundary state machine)

### Storage/Index

- ConversationData (message accumulation)
- ConversationStatus (pending boundary state)
- MemCell and downstream memories (MongoDB)

### Failure Fallback

- No new messages after dedupe: skip heavy re-processing
- Replay not allowed (`force_memory_backfill=true` and `allow_memory_replay=false`): warning + normal path

---

## 3. MemCell Boundary State Machine

### Input

From `MemorizeRequest`:

- `history_raw_data_list`
- `new_raw_data_list`
- `group_id/conversation_id`
- `skip_pending_boundary`

### Processing

Key behavior:

1. `preprocess_conv_request` loads historical cache and appends new messages.
2. `extract_memcell(...)` decides boundary.
3. Pending mechanism:
   - First boundary hit becomes pending and returns `0`.
   - Next batch confirms and materializes the MemCell.
4. Historical import (`skip_pending_boundary=true`) can bypass pending.
5. Duplicate boundary hash is used to skip duplicate MemCell writes.

### Output

- `0` when boundary is not confirmed yet
- `>0` when memory extraction and persistence proceed

### Storage/Index

- ConversationStatus: `pending_boundary/pending_boundary_count/pending_boundary_hash`
- ConversationData: remaining messages not yet cut into MemCell

### Failure Fallback

- No boundary: continue accumulation
- Boundary confirmation errors are logged without crashing the whole API flow

---

## 4. Multi-Layer Extraction and Persistence (MemCell -> Episode/Foresight/EventLog/Profile)

### Input

- Confirmed MemCell
- Scene, participants, owner context

### Processing

Extraction order:

1. Extract Episode (group-level + personal-level).
2. Backfill MemCell `episode/subject`.
3. Trigger clustering.
4. Trigger profile extraction after clustering.
5. Extract Foresight and EventLog from Episode context.

### Output

- EpisodeMemory
- Foresight
- EventLog
- UnifiedProfile (self/contact)

### Storage/Index

- MongoDB: source-of-truth memory documents
- Elasticsearch: keyword retrieval index
- Milvus: vector retrieval index

Role split:

- MongoDB = truth store
- ES = lexical recall
- Milvus = semantic recall

### Failure Fallback

- Single-layer extraction failures should not crash the API request
- If index writing fails, MongoDB source data should remain available for later repair/reindex

---

## 5. Retrieval End-to-End and Method Comparison (search -> dispatch)

### Input

Key params in `GET /api/v1/memories/search`:

- `user_id`
- `conversation_id` or `group_id`
- `query`
- `retrieve_method=keyword|vector|hybrid|rrf|agentic`
- `memory_types`
- `top_k`
- `start_time/end_time`
- `radius`

### Processing

1. `memory_controller.search_memories` reads query/body params.
2. `convert_dict_to_retrieve_mem_request` normalizes input.
3. `MemoryManager.retrieve_mem` dispatches by `retrieve_method`.
4. Response is grouped by `group_id`, with scores and original evidence.

Method summary:

- `keyword`: ES BM25, fast, strong exact-token matching
- `vector`: query embedding + Milvus, strong semantic recall
- `hybrid`: keyword + vector merge, then rerank
- `rrf`: keyword + vector with RRF fusion, no rerank dependency
- `agentic`: hybrid round-1 -> sufficiency check -> multi-query -> fusion/rerank

### Output

Unified response fields:

- `memories` (grouped)
- `scores`
- `importance_scores`
- `original_data`
- `total_count`
- `metadata/query_metadata`

### Storage/Index

Retrieval mostly reads from:

- ES (keyword)
- Milvus (vector)
- MongoDB (memcell evidence and group-level metadata augmentation)

### Failure Fallback

- Branch failures return empty/degraded results instead of fatal errors
- rerank failures can fall back to original ranking

---

## 6. Model and Dependency Integration (LLM/Vectorize/Rerank/ES/Milvus)

### Input

Dependencies:

- LLM (extraction, agentic judgment, reply generation)
- Vectorize service (embedding)
- Rerank service
- Elasticsearch
- Milvus

### Processing

Capability coupling:

- `keyword` needs ES only
- `vector` needs Vectorize + Milvus
- `hybrid` needs ES + Vectorize + Milvus (+ rerank recommended)
- `rrf` needs ES + Vectorize + Milvus (no rerank required)
- `agentic` needs LLM + Vectorize (+ rerank recommended)

Critical env groups (from `.env.example`):

- `LLM_*`
- `VECTORIZE_*`
- `RERANK_*`
- `ES_*`
- `MILVUS_*`

Dimension constraint:

- `VECTORIZE_DIMENSIONS` must match the actual embedding model output dimension.

### Output

- Correct config -> full retrieval/ranking capabilities
- Missing config -> expected degradation (for example: keyword-only availability, weaker ranking)

### Storage/Index

- Vectorize directly affects Milvus writes and vector retrieval
- Rerank affects ordering quality in hybrid/agentic (not source storage)

### Failure Fallback

- Vectorize unavailable: vector-based paths degrade/fail
- Rerank unavailable: hybrid/agentic can use non-reranked order
- LLM unavailable: agentic and extraction capabilities are reduced

---

## 7. Frontend Triggering and Historical Backfill

### Input

Sources:

- Realtime sync from `realtime-suggestion-adapter`
- Session/chunk backfill from `ipc-handlers`

### Processing

Realtime path:

- Usually does not pass `incoming_message` to avoid duplicated backend reply generation
- Updates session backfill progress after successful sync

Backfill path:

- Chunked request batches
- Retry enabled
- Timeout-driven chunk-size degradation

Key flag semantics:

- `force_memory_backfill`: request replay mode
- `allow_memory_replay`: allow cache reset + replay (high risk)
- `is_historical_import`: historical-import semantics, often bypassing pending boundary

### Output

- Backfill summary: processed/skipped/failed/updatedProfiles
- Per-session progress updates

### Storage/Index

- Frontend settings/progress persisted in app settings
- Memory data still follows backend standard write/index pipeline

### Failure Fallback

- Per-chunk retry
- Chunk-size degrade on timeout
- Failed sessions are isolated and recorded

---

## 8. Troubleshooting and Gap Checklist

### Input

Common symptoms:

- process-chat succeeds but no MemCell is produced
- memories exist but search misses
- results exist but ranking quality is poor
- backfill is slow or times out frequently

### Processing

Shortest diagnosis path:

1. Verify request params (`user_id/conversation_id/query/retrieve_method`).
2. Verify state-machine status (pending/dedupe/skip_pending).
3. Verify dependency health (ES/Milvus/Vectorize/Rerank/LLM).
4. Verify index/document existence and freshness.

Gap checklist:

- LLM configured but `VECTORIZE_*` / `RERANK_*` missing
- Milvus is up but no vectors are actually written
- `memory_types` left implicit and unintentionally limited to episodic
- `top_k` default misunderstanding (DTO default 40 vs converter-entry default 10)
- `force_memory_backfill` used without `allow_memory_replay`

### Output

- Issues can be localized to one layer: input/state-machine/dependency/index

### Storage/Index

Check points:

- ConversationStatus
- MemCell
- Episode/Foresight/EventLog
- ES indexes
- Milvus collections

### Failure Fallback

- Prefer graceful degradation first, then targeted repair

---

## 9. Public API and Key Type Quick Reference

Public APIs:

1. `POST /api/v1/copilot/process-chat`
2. `GET /api/v1/memories/search`
3. `GET /api/v1/copilot/conversations/{conversation_id}/context`
4. `GET /api/v1/copilot/episodes|memcells|foresights`

Key type: `RetrieveMemRequest`

- `retrieve_method`
- `top_k`
- `memory_types`
- `start_time`
- `end_time`
- `radius`

Default difference to call out explicitly:

- DTO default `top_k`: 40
- Converter entry default `top_k`: 10

---

## 10. Examples (Minimal Reproducible)

### 10.1 Construction example: realtime process-chat

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
        "content":"Let us finalize the requirement this week.",
        "timestamp":"2026-04-08T10:00:00+08:00",
        "content_type":"text"
      }
    ]
  }'
```

### 10.2 Construction example: historical backfill process-chat

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
    "messages":[ ...historical batch... ]
  }'
```

### 10.3 Retrieval examples: all methods

```bash
# keyword
curl "http://127.0.0.1:1995/api/v1/memories/search?user_id=u_self&conversation_id=wechat::alice&query=What is she recently pushing forward&retrieve_method=keyword&memory_types=episodic_memory&top_k=10"

# vector
curl "http://127.0.0.1:1995/api/v1/memories/search?user_id=u_self&conversation_id=wechat::alice&query=What is she recently pushing forward&retrieve_method=vector&memory_types=episodic_memory&top_k=10"

# hybrid
curl "http://127.0.0.1:1995/api/v1/memories/search?user_id=u_self&conversation_id=wechat::alice&query=What is she recently pushing forward&retrieve_method=hybrid&memory_types=episodic_memory,foresight&top_k=10"

# rrf
curl "http://127.0.0.1:1995/api/v1/memories/search?user_id=u_self&conversation_id=wechat::alice&query=What is she recently pushing forward&retrieve_method=rrf&memory_types=episodic_memory,foresight&top_k=10"

# agentic
curl "http://127.0.0.1:1995/api/v1/memories/search?user_id=u_self&conversation_id=wechat::alice&query=Infer the next most likely action from context&retrieve_method=agentic&memory_types=episodic_memory,foresight,event_log&top_k=10"
```

### 10.4 End-to-end validation example (write -> retrieve -> ranking check)

1. Send 1-2 `process-chat` batches to write data.
2. Run `keyword` retrieval and verify at least one hit.
3. Switch to `vector/hybrid` and compare recall changes.
4. Compare `hybrid` ordering with and without rerank availability.

---

## 11. Executable Acceptance Checklist

1. System still works in keyword-only mode.
2. After enabling vectorize, `vector/hybrid` recall improvement is observable.
3. After enabling rerank, `hybrid/agentic` top-rank quality change is observable.
4. When rerank is unavailable, degraded fallback path is still functional.
5. A new engineer can use this guide to diagnose:
   - why MemCell is not produced
   - why retrieval misses existing memory
6. Every core section contains:
   - Input
   - Processing
   - Output
   - Storage/Index
   - Failure Fallback

---

## 12. Code Anchors (Suggested Reading Order)

- `memory/evermemos/src/copilot_orchestrator/chat_workflow.py`
- `memory/evermemos/src/biz_layer/mem_memorize.py`
- `memory/evermemos/src/agentic_layer/memory_manager.py`
- `memory/evermemos/src/agentic_layer/vectorize_service.py`
- `memory/evermemos/src/agentic_layer/rerank_service.py`
- `memory/evermemos/src/infra_layer/adapters/input/api/memory/memory_controller.py`
- `memory/evermemos/src/api_specs/request_converter.py`

