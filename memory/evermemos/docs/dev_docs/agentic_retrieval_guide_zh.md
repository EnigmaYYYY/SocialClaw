# Agentic 检索使用指南

## 概述

Agentic 检索是一种 LLM 引导的多轮检索方法，通过智能判断和查询优化，显著提升复杂查询的检索质量。

## 核心特性

✅ **智能判断**：LLM 自动判断检索结果是否充分  
✅ **多轮检索**：不充分时自动进行第二轮检索  
✅ **多查询策略**：生成 2-3 个互补查询，提升召回率  
✅ **自动降级**：失败时回退到 Lightweight 检索  
✅ **完整元数据**：返回详细的检索过程信息  

## 快速开始

### 1. 在对话界面使用

运行 `chat_with_memory.py` 时选择检索模式：

```bash
uv run python src/bootstrap.py demo/chat_with_memory.py
```

选择第 4 个选项：`Agentic 检索 - LLM 引导的多轮检索（实验性）`

### 2. 在代码中使用

```python
from agentic_layer.memory_manager import MemoryManager
from memory_layer.llm.llm_provider import LLMProvider
from agentic_layer.agentic_utils import AgenticConfig

# 初始化 LLM Provider
llm = LLMProvider(
    provider_type="openai",
    model="gpt-4",
    api_key="your_api_key",
    base_url="https://api.openai.com/v1",
    temperature=0.0,
)

# 初始化 Memory Manager
memory_manager = MemoryManager()

# 执行 Agentic 检索
result = await memory_manager.retrieve_agentic(
    query="用户喜欢吃什么？",
    group_id="美食爱好者群",
    llm_provider=llm,
    top_k=20,
)

# 查看结果
print(f"检索到 {result['count']} 条记忆")
print(f"是否充分: {result['metadata']['is_sufficient']}")

if result['metadata']['is_multi_round']:
    print(f"改进查询: {result['metadata']['refined_queries']}")
```

## 高级配置

### 自定义 Agentic 配置

```python
from agentic_layer.agentic_utils import AgenticConfig

# 创建自定义配置
config = AgenticConfig(
    # Round 1 配置
    round1_emb_top_n=50,        # Embedding 候选数
    round1_bm25_top_n=50,       # BM25 候选数
    round1_top_n=20,            # RRF 融合后返回数
    round1_rerank_top_n=5,      # Rerank 后用于 LLM 判断
    
    # LLM 配置
    llm_temperature=0.0,        # 判断用低温度
    llm_max_tokens=500,
    
    # Round 2 配置
    enable_multi_query=True,    # 是否启用多查询
    num_queries=3,              # 期望生成查询数量
    round2_per_query_top_n=50,  # 每个查询召回数
    
    # 融合配置
    combined_total=40,          # 合并后总数
    final_top_n=20,             # 最终返回数
    
    # Rerank 配置
    use_reranker=True,
    reranker_instruction="根据查询与记忆的相关性进行排序",
)

# 使用自定义配置
result = await memory_manager.retrieve_agentic(
    query="用户喜欢吃什么？",
    group_id="美食爱好者群",
    llm_provider=llm,
    agentic_config=config,
)
```

## 返回格式

```python
{
    "memories": [
        {
            "event_id": "...",
            "user_id": "...",
            "group_id": "...",
            "timestamp": "2024-01-15T10:30:00",
            "episode": "用户说他最喜欢吃川菜，尤其是麻婆豆腐",
            "summary": "用户的菜系偏好",
            "subject": "饮食习惯",
            "score": 0.95
        },
        # ... 更多记忆
    ],
    "count": 20,
    "metadata": {
        # 基本信息
        "retrieval_mode": "agentic",
        "is_multi_round": True,  # 是否进行了多轮检索
        
        # Round 1 统计
        "round1_count": 20,
        "round1_reranked_count": 5,
        "round1_latency_ms": 800,
        
        # LLM 判断
        "is_sufficient": False,
        "reasoning": "缺少用户的具体菜系偏好和口味信息",
        "missing_info": ["菜系偏好", "口味习惯", "忌口信息"],
        
        # Round 2 统计（仅在多轮时存在）
        "refined_queries": [
            "用户最喜欢的菜系是什么？",
            "用户喜欢什么口味？",
            "用户有什么饮食禁忌？"
        ],
        "query_strategy": "将原查询分解为多个具体子问题",
        "num_queries": 3,
        "round2_count": 40,
        "round2_latency_ms": 600,
        "multi_query_total_docs": 120,
        
        # 最终统计
        "final_count": 20,
        "total_latency_ms": 3500
    }
}
```

## 工作流程

```
用户查询
  ↓
Round 1: Hybrid Search (Embedding + BM25 + RRF)
  ↓
RRF 融合 → Top 20
  ↓
Rerank → Top 5
  ↓
LLM 判断充分性
  ↓
├─ 充分 → 返回 Round 1 的 Top 20 ✅
│
└─ 不充分 → LLM 生成多查询（2-3个）
              ↓
          Round 2: 并行检索所有查询
              ↓
          多查询 RRF 融合
              ↓
          去重 + 合并到 40 个
              ↓
          Rerank → Top 20 ✅
```

## 性能指标

| 指标 | 单轮（充分） | 多轮（不充分） |
|------|-------------|---------------|
| 延迟 | 2-5 秒 | 5-10 秒 |
| LLM 调用 | 1 次 | 2 次 |
| Token 消耗 | ~500 | ~1500 |
| API 费用 | ~$0.001 | ~$0.003 |

*基于 GPT-4 的估算值*

## 适用场景

### ✅ 适合使用 Agentic 检索

1. **复杂查询**：需要多个角度的信息
   - ❌ "用户喜欢吃什么？"（太宽泛）
   - ✅ "用户最喜欢的川菜是什么，以及口味偏好？"

2. **信息分散**：相关记忆分布在不同时间点

3. **高质量要求**：对召回率和精度要求高的场景

### ❌ 不适合使用 Agentic 检索

1. **简单查询**：可以直接回答的问题
   - "今天是星期几？"
   - "用户的名字是什么？"

2. **对延迟敏感**：要求 < 1 秒响应的场景

3. **成本敏感**：无法承担 LLM API 费用

## 降级策略

Agentic 检索在以下情况会自动降级到 Lightweight 检索：

1. ❌ LLM API 调用失败
2. ❌ 超时（默认 60 秒）
3. ❌ 未提供 `llm_provider`
4. ❌ 候选记忆为空

降级时会在元数据中标记：

```python
{
    "metadata": {
        "retrieval_mode": "agentic_fallback",
        "fallback_reason": "LLM API timeout"
    }
}
```

## 成本优化

### 1. 调整 LLM 模型

```python
# 使用更便宜的模型
llm = LLMProvider(
    provider_type="openai",
    model="gpt-4o-mini",  # 更便宜
    # model="gpt-4",      # 更准确但更贵
)
```

### 2. 禁用多查询

```python
config = AgenticConfig(
    enable_multi_query=False,  # 只生成 1 个查询（降低成本）
)
```

### 3. 禁用 Reranker

```python
config = AgenticConfig(
    use_reranker=False,  # 不使用 Reranker（降低延迟和成本）
)
```

## 故障排查

### 问题：LLM API 调用失败

**原因**：
- API Key 错误
- 网络问题
- API 限流

**解决**：
1. 检查 `.env` 文件中的 API Key
2. 确认网络连接
3. 查看日志中的详细错误信息

### 问题：延迟过高（> 10 秒）

**原因**：
- LLM 响应慢
- 候选记忆过多
- Reranker 超时

**解决**：
1. 减少 `time_range_days`（减少候选数）
2. 禁用 Reranker
3. 使用更快的 LLM 模型

### 问题：检索质量不佳

**原因**：
- LLM 判断不准确
- 查询生成不合理
- Prompt 不适配

**解决**：
1. 使用更强的 LLM 模型（如 GPT-4）
2. 调整 Prompt 模板（在 `agentic_utils.py`）
3. 增加 `round1_rerank_top_n`（给 LLM 更多样本）

## 与其他检索模式对比

| 特性 | Lightweight | Agentic |
|------|------------|---------|
| 延迟 | 0.5-2s | 5-10s |
| LLM 调用 | ❌ 无 | ✅ 1-2次 |
| 多轮检索 | ❌ 否 | ✅ 是 |
| 召回率 | 中 | 高 |
| 精度 | 中 | 高 |
| 成本 | 低 | 中 |
| 适用场景 | 简单查询 | 复杂查询 |

## 最佳实践

1. ✅ **优先使用 Lightweight**：对于简单查询，Lightweight 足够好
2. ✅ **复杂查询用 Agentic**：只在需要时使用
3. ✅ **监控成本**：记录 LLM Token 消耗
4. ✅ **日志分析**：定期查看 LLM 判断是否合理
5. ✅ **A/B 测试**：对比不同模式的效果

## 示例：完整对话流程

```python
import asyncio
from agentic_layer.memory_manager import MemoryManager
from memory_layer.llm.llm_provider import LLMProvider

async def main():
    # 初始化
    llm = LLMProvider("openai", model="gpt-4", api_key="...")
    memory_manager = MemoryManager()
    
    # 用户查询
    query = "用户喜欢吃什么？有什么忌口吗？"
    
    # 执行检索
    result = await memory_manager.retrieve_agentic(
        query=query,
        group_id="美食爱好者群",
        llm_provider=llm,
    )
    
    # 展示结果
    print(f"\n{'='*60}")
    print(f"查询: {query}")
    print(f"{'='*60}\n")
    
    print(f"检索模式: {result['metadata']['retrieval_mode']}")
    print(f"检索到 {result['count']} 条记忆")
    print(f"总延迟: {result['metadata']['total_latency_ms']:.0f}ms\n")
    
    # LLM 判断
    print(f"LLM 判断: {'✅ 充分' if result['metadata']['is_sufficient'] else '❌ 不充分'}")
    print(f"理由: {result['metadata']['reasoning']}\n")
    
    # 多轮信息
    if result['metadata']['is_multi_round']:
        print(f"📝 进入 Round 2")
        print(f"生成查询:")
        for i, q in enumerate(result['metadata']['refined_queries'], 1):
            print(f"  {i}. {q}")
        print()
    
    # 展示记忆
    print(f"Top 5 记忆:")
    for i, mem in enumerate(result['memories'][:5], 1):
        print(f"\n[{i}] {mem['timestamp'][:10]}")
        print(f"    {mem['episode'][:100]}...")
        print(f"    分数: {mem['score']:.3f}")

if __name__ == "__main__":
    asyncio.run(main())
```

## 更多资源

- 📖 [Memory Manager API 文档](../docs/api_docs/memory_api.md)
- 🔬 [检索评估](../../evaluation/locomo_evaluation/README.md)
- 💡 [最佳实践](../docs/dev_docs/getting_started.md)

---

**注意事项**：
- Agentic 检索是实验性功能，可能在未来版本中调整
- 使用前请确保理解 LLM API 的成本和限制
- 建议在生产环境中先进行充分测试

