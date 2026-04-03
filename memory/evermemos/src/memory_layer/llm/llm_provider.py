import os
import asyncio
from memory_layer.llm.openai_provider import OpenAIProvider


class LLMProvider:
    def __init__(self, provider_type: str, **kwargs):
        self.provider_type = provider_type
        if provider_type == "openai":
            self.provider = OpenAIProvider(**kwargs)
        else:
            raise ValueError(
                f"Unsupported provider type: {provider_type}. Supported types: 'openai'"
            )
        # TODO: add other providers

    async def generate(
        self,
        prompt: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
        extra_body: dict | None = None,
        response_format: dict | None = None,
    ) -> str:
        async with _LLM_SEMAPHORE:
            return await self.provider.generate(
                prompt, temperature, max_tokens, extra_body, response_format
            )


# ── 全局 LLM 并发控制 ──
# 防止 process_chat 中 asyncio.gather 同时发起过多 LLM 请求触发 rate limit (429)
# 默认 5 并发，可通过 LLM_MAX_CONCURRENT 环境变量调整
_LLM_SEMAPHORE = asyncio.Semaphore(int(os.getenv("LLM_MAX_CONCURRENT", "5")))
