# EverMemOS 配置指南

本指南详细介绍了 `env.template` 文件中的各项配置。在部署 EverMemOS 之前，请根据本指南将 `env.template` 复制为 `.env` 并填入您的实际配置信息。

> **⚠️ 安全提示**：
> `.env` 文件包含敏感信息（如 API 密钥、数据库密码），请务必将其加入 `.gitignore`，**切勿**提交到版本控制系统。

---

## 1. LLM 配置 (LLM Configuration)

用于记忆提取、Agentic 检索和问答生成的 LLM 服务配置。

| 变量名 | 必填 | 说明 | 示例值 |
|--------|------|------|--------|
| `LLM_PROVIDER` | 是 | LLM 提供商，通常设为 `openai` 以兼容 OpenAI SDK 格式 | `openai` |
| `LLM_MODEL` | 是 | 使用的模型名称。**Evaluation** 建议使用 `gpt-4o-mini`，**Demo** 可使用 `x-ai/grok-4-fast` 等高性价比模型 | `gpt-4o-mini` |
| `LLM_BASE_URL` | 是 | API 基础地址，支持 OpenRouter、DeepSeek 等兼容接口 | `https://openrouter.ai/api/v1` |
| `LLM_API_KEY` | 是 | 您的 API 密钥 | `sk-or-v1-xxxx` |
| `LLM_TEMPERATURE` | 否 | 生成温度，建议保持较低值以获得稳定输出 | `0.3` |
| `LLM_MAX_TOKENS` | 否 | 最大生成 Token 数 | `32768` |

---

## 2. 向量化服务配置 (Vectorize Service Configuration)

用于将文本转换为向量（Embedding），支持 DeepInfra 和 vLLM。

| 变量名 | 必填 | 说明 | 示例值 |
|--------|------|------|--------|
| `VECTORIZE_PROVIDER` | 是 | 提供商选项：`deepinfra`, `vllm` | `deepinfra` |
| `VECTORIZE_API_KEY` | 是* | API 密钥（DeepInfra 必填，vLLM 可选） | `xxxxx` |
| `VECTORIZE_BASE_URL` | 是 | 服务地址 | `https://api.deepinfra.com/v1/openai` |
| `VECTORIZE_MODEL` | 是 | 模型名称，需与服务端一致 | `Qwen/Qwen3-Embedding-4B` |
| `VECTORIZE_DIMENSIONS` | 否 | 向量维度。若 vLLM 不支持此参数请设为 `0`，否则保持模型维度（如 `1024`） | `1024` |

**高级设置**：
- `VECTORIZE_TIMEOUT`: 请求超时时间（秒）
- `VECTORIZE_MAX_RETRIES`: 最大重试次数
- `VECTORIZE_BATCH_SIZE`: 批处理大小
- `VECTORIZE_MAX_CONCURRENT`: 最大并发请求数
- `VECTORIZE_ENCODING_FORMAT`: 编码格式，通常为 `float`

---

## 3. 重排序服务配置 (Rerank Service Configuration)

用于对检索结果进行精细排序，提升相关性。

| 变量名 | 必填 | 说明 | 示例值 |
|--------|------|------|--------|
| `RERANK_PROVIDER` | 是 | 提供商选项：`deepinfra`, `vllm` | `deepinfra` |
| `RERANK_API_KEY` | 是* | API 密钥 | `xxxxx` |
| `RERANK_BASE_URL` | 是 | 服务地址 | `https://api.deepinfra.com/v1/inference` |
| `RERANK_MODEL` | 是 | 模型名称 | `Qwen/Qwen3-Reranker-4B` |

**高级设置**：
- `RERANK_TIMEOUT`: 超时时间
- `RERANK_BATCH_SIZE`: 批处理大小
- `RERANK_MAX_CONCURRENT`: 最大并发数

---

## 4. 数据库配置 (Database Configuration)

EverMemOS 依赖多种数据库服务，通常通过 Docker Compose 启动。

### Redis
用于缓存和分布式锁。
- `REDIS_HOST`: 主机地址 (默认 `localhost`)
- `REDIS_PORT`: 端口 (默认 `6379`)
- `REDIS_DB`: 数据库索引 (默认 `8`)

### MongoDB
主数据库，存储记忆单元、画像和对话记录。
- `MONGODB_HOST`: 主机地址 (默认 `localhost`)
- `MONGODB_PORT`: 端口 (默认 `27017`)
- `MONGODB_USERNAME`: 用户名 (默认 `admin`)
- `MONGODB_PASSWORD`: 密码 (默认 `memsys123`)
- `MONGODB_DATABASE`: 数据库名 (默认 `memsys`)

### Elasticsearch
用于关键词检索 (BM25)。
- `ES_HOSTS`: 服务地址 (默认 `http://localhost:19200`)
- `SELF_ES_INDEX_NS`: 索引命名空间 (默认 `memsys`)

### Milvus
向量数据库，用于语义检索。
- `MILVUS_HOST`: 主机地址 (默认 `localhost`)
- `MILVUS_PORT`: 端口 (默认 `19530`)
- `SELF_MILVUS_COLLECTION_NS`: 集合命名空间 (默认 `memsys`)

---

## 5. 其他配置 (Others)

### API Server
- `API_BASE_URL`: V1 API 的基础 URL，用于客户端连接 (默认 `http://localhost:8001`)

### 环境与日志
- `LOG_LEVEL`: 日志级别 (`INFO`, `DEBUG`, `WARNING`, `ERROR`)
- `ENV`: 环境标识 (`dev`, `prod`)
- `MEMORY_LANGUAGE`: 系统主要语言 (`zh`, `en`)

---

## 配置示例

### 1. 使用 DeepInfra (推荐)

```bash
VECTORIZE_PROVIDER=deepinfra
VECTORIZE_API_KEY=your_key_here
VECTORIZE_BASE_URL=https://api.deepinfra.com/v1/openai
VECTORIZE_MODEL=Qwen/Qwen3-Embedding-4B

RERANK_PROVIDER=deepinfra
RERANK_API_KEY=your_key_here
RERANK_BASE_URL=https://api.deepinfra.com/v1/inference
RERANK_MODEL=Qwen/Qwen3-Reranker-4B
```

### 2. 使用本地 vLLM

```bash
VECTORIZE_PROVIDER=vllm
VECTORIZE_API_KEY=none
VECTORIZE_BASE_URL=http://localhost:8000/v1
VECTORIZE_MODEL=Qwen3-Embedding-4B
VECTORIZE_DIMENSIONS=0  # vLLM 有时需禁用此参数

RERANK_PROVIDER=vllm
RERANK_API_KEY=none
RERANK_BASE_URL=http://localhost:12000/score
RERANK_MODEL=Qwen3-Reranker-4B
```

> **ℹ️ vLLM 部署提示**：
> - **Embedding 模型**（支持 v0.4.0+）：
>   ```bash
>   vllm serve Qwen/Qwen3-Embedding-4B --task embed --trust-remote-code
>   ```
> - **Reward/Reranker 模型**（相关支持请参考 [vLLM PR #19260](https://github.com/vllm-project/vllm/pull/19260)）：
>   ```bash
>   vllm serve Qwen/Qwen3-Reranker-4B --task reward --trust-remote-code
>   ```
>   注意：对于 Reranker 模型，请使用 `--task reward` 参数启动。



