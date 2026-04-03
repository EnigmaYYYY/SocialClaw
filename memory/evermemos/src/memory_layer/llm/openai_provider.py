"""
OpenAI LLM provider implementation using OpenRouter.

This provider uses OpenRouter API to access OpenAI models.
"""

from math import log
import os
import time
import json
import urllib.request
import urllib.parse
import urllib.error
import aiohttp
from typing import Optional
import asyncio
import random
from json import JSONDecodeError

from memory_layer.llm.protocol import LLMProvider, LLMError
from core.observation.logger import get_logger

logger = get_logger(__name__)


class OpenAIProvider(LLMProvider):
    """
    OpenAI LLM provider using OpenRouter API.

    This provider uses OpenRouter to access OpenAI models with environment variable configuration.
    """

    def __init__(
        self,
        model: str = "gpt-4.1-mini",
        api_key: str | None = None,
        base_url: str | None = None,
        temperature: float = 0.3,
        max_tokens: int | None = 100 * 1024,
        enable_stats: bool = False,  # New: optional statistics feature, disabled by default
        **kwargs,
    ):
        """
        Initialize OpenAI provider.

        Args:
            model: Model name (e.g., "gpt-4o-mini", "gpt-4o")
            api_key: OpenRouter API key (defaults to OPENROUTER_API_KEY env var)
            base_url: OpenRouter base URL (defaults to OpenRouter endpoint)
            temperature: Sampling temperature
            max_tokens: Maximum tokens to generate
            enable_stats: Enable usage statistics accumulation (default: False)
            **kwargs: Additional arguments (ignored for now)
        """
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.enable_stats = enable_stats  # New

        # Use OpenRouter API key and base URL
        self.api_key = api_key or os.getenv("OPENROUTER_API_KEY")
        self.base_url = base_url or "https://openrouter.ai/api/v1"

        # New: optional per-call statistics (disabled by default, does not affect existing usage)
        if self.enable_stats:
            self.current_call_stats = None  # Store statistics for current call

    async def generate(
        self,
        prompt: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
        extra_body: dict | None = None,
        response_format: dict | None = None,
    ) -> str:
        """
        Generate a response for the given prompt.

        Args:
            prompt: Input prompt
            temperature: Override temperature for this request
            max_tokens: Override max tokens for this request

        Returns:
            Generated response text

        Raises:
            LLMError: If generation fails
        """
        # Use time.perf_counter() for more precise time measurement
        start_time = time.perf_counter()
        # Prepare request data
        if os.getenv("LLM_OPENROUTER_PROVIDER", "default") != "default":
            provider_str = os.getenv('LLM_OPENROUTER_PROVIDER')
            provider_list = [p.strip() for p in provider_str.split(',')]
            openrouter_provider = {"order": provider_list, "allow_fallbacks": False}
        else:
            openrouter_provider = None
        # Prepare request data
        data = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": temperature if temperature is not None else self.temperature,
            "provider": openrouter_provider,
            "response_format": response_format,
        }
        extra_body_payload = {}
        if extra_body:
            extra_body_payload.update(extra_body)

        extra_body_env = os.getenv("LLM_EXTRA_BODY")
        if extra_body_env:
            try:
                extra_body_payload.update(json.loads(extra_body_env))
            except json.JSONDecodeError:
                logger.warning(
                    "Invalid LLM_EXTRA_BODY JSON, ignoring: %s", extra_body_env
                )

        thinking_budget_env = os.getenv("LLM_THINKING_BUDGET")
        if thinking_budget_env not in (None, ""):
            try:
                extra_body_payload.setdefault(
                    "thinking_budget", int(thinking_budget_env)
                )
            except ValueError:
                logger.warning(
                    "Invalid LLM_THINKING_BUDGET value, ignoring: %s",
                    thinking_budget_env,
                )

        disable_thinking_env = os.getenv("LLM_DISABLE_THINKING", "")
        if disable_thinking_env.lower() in ("1", "true", "yes", "on"):
            extra_body_payload.setdefault("enable_thinking", False)
            extra_body_payload.setdefault("thinking_budget", 0)

        if extra_body_payload:
            data.update(extra_body_payload)
        # print(data)
        # print(data["extra_body"])
        # Add max_tokens if specified
        if max_tokens is not None:
            data["max_tokens"] = max_tokens
        elif self.max_tokens is not None:
            data["max_tokens"] = self.max_tokens

        # Use asynchronous aiohttp instead of synchronous urllib
        headers = {
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {self.api_key}',
        }
        max_retries = 5
        for retry_num in range(max_retries):
            try:
                timeout = aiohttp.ClientTimeout(total=600)
                async with aiohttp.ClientSession(timeout=timeout) as session:
                    async with session.post(
                        f"{self.base_url}/chat/completions", json=data, headers=headers
                    ) as response:
                        chunks = []
                        async for chunk in response.content.iter_any():
                            chunks.append(chunk)
                        raw_text = b"".join(chunks).decode("utf-8", errors="replace").strip()
                        content_type = response.headers.get("Content-Type", "")

                        if not raw_text:
                            logger.error(
                                f"[OpenAI-{self.model}] Empty response body: status={response.status}, content_type={content_type}"
                            )
                            raise LLMError(
                                f"Empty response body (status={response.status}, content_type={content_type})"
                            )

                        try:
                            response_data = json.loads(raw_text)
                        except JSONDecodeError as decode_error:
                            snippet = raw_text[:500].replace("\n", "\\n")
                            logger.error(
                                f"[OpenAI-{self.model}] Invalid JSON response: status={response.status}, content_type={content_type}, body_snippet={snippet}"
                            )
                            raise LLMError(
                                f"Invalid JSON response (status={response.status}, content_type={content_type}): {decode_error}"
                            )
                        # print(response_data)
                        # Handle error responses
                        if response.status != 200:
                            error_msg = f"HTTP {response.status}"
                            if isinstance(response_data, dict):
                                error_msg = response_data.get('error', {}).get(
                                    'message', error_msg
                                )
                            logger.error(
                                f"❌ [OpenAI-{self.model}] HTTP error {response.status}:"
                            )
                            logger.error(f"   💬 Error message: {error_msg}")
                            # Debug: 429 Too Many Requests breakpoint debugging
                            if response.status == 429:
                                logger.warning(
                                    f"429 Too Many Requests, waiting for 10 seconds"
                                )
                                await asyncio.sleep(random.randint(5, 20))

                            raise LLMError(f"HTTP Error {response.status}: {error_msg}")

                        # Use time.perf_counter() for more precise time measurement
                        end_time = time.perf_counter()

                        # Extract finish_reason
                        finish_reason = response_data.get('choices', [{}])[0].get(
                            'finish_reason', ''
                        )
                        if finish_reason == 'stop':
                            logger.debug(
                                f"[OpenAI-{self.model}] Finish reason: {finish_reason}"
                            )
                        else:
                            logger.warning(
                                f"[OpenAI-{self.model}] Finish reason: {finish_reason}"
                            )

                        # Extract token usage information
                        usage = response_data.get('usage', {})
                        prompt_tokens = usage.get('prompt_tokens', 0)
                        completion_tokens = usage.get('completion_tokens', 0)
                        total_tokens = usage.get('total_tokens', 0)

                        # Print detailed usage information

                        logger.debug(f"[OpenAI-{self.model}] API call completed:")
                        logger.debug(
                            f"[OpenAI-{self.model}] Duration: {end_time - start_time:.2f}s"
                        )
                        # If the duration is too long
                        if end_time - start_time > 30:
                            logger.warning(
                                f"[OpenAI-{self.model}] Duration too long: {end_time - start_time:.2f}s"
                            )
                        logger.debug(
                            f"[OpenAI-{self.model}] Prompt Tokens: {prompt_tokens:,}"
                        )
                        logger.debug(
                            f"[OpenAI-{self.model}] Completion Tokens: {completion_tokens:,}"
                        )
                        logger.debug(
                            f"[OpenAI-{self.model}] Total Tokens: {total_tokens:,}"
                        )

                        # New: record statistics for current call (if statistics enabled)
                        if self.enable_stats:
                            self.current_call_stats = {
                                'prompt_tokens': prompt_tokens,
                                'completion_tokens': completion_tokens,
                                'total_tokens': total_tokens,
                                'duration': end_time - start_time,
                                'timestamp': time.time(),
                            }

                        if not isinstance(response_data, dict):
                            raise LLMError(
                                f"Unexpected response payload type: {type(response_data).__name__}"
                            )
                        choices = response_data.get("choices")
                        if not isinstance(choices, list) or not choices:
                            raise LLMError("Response missing choices")
                        message = choices[0].get("message", {}) if isinstance(choices[0], dict) else {}
                        content = message.get("content") if isinstance(message, dict) else None
                        if not isinstance(content, str):
                            raise LLMError("Response missing assistant content")

                        return content

            except aiohttp.ClientError as e:
                error_time = time.perf_counter()
                logger.error("aiohttp.ClientError: %s", e)
                # logger.error(f"❌ [OpenAI-{self.model}] Request failed:")
                logger.error(f"   ⏱️  Duration: {error_time - start_time:.2f}s")
                logger.error(f"   💬 Error message: {str(e)}")
                logger.error(f"retry_num: {retry_num}")
                # raise LLMError(f"Request failed: {str(e)}")
                if retry_num == max_retries - 1:
                    raise LLMError(f"Request failed: {str(e)}")
            except Exception as e:
                error_time = time.perf_counter()
                logger.error("Exception: %s", e)
                logger.error(f"   ⏱️  Duration: {error_time - start_time:.2f}s")
                logger.error(f"   💬 Error message: {str(e)}")
                logger.error(f"retry_num: {retry_num}")
                if retry_num == max_retries - 1:
                    raise LLMError(f"Request failed: {str(e)}")

    async def test_connection(self) -> bool:
        """
        Test the connection to the OpenRouter API.

        Returns:
            True if connection successful, False otherwise
        """
        try:
            logger.info(f"🔗 [OpenAI-{self.model}] Testing API connection...")
            # Try a simple generation to test connection
            test_response = await self.generate("Hello", temperature=0.1)
            success = len(test_response) > 0
            if success:
                logger.info(f"✅ [OpenAI-{self.model}] API connection test succeeded")
            else:
                logger.error(
                    f"❌ [OpenAI-{self.model}] API connection test failed: Empty response"
                )
            return success
        except Exception as e:
            logger.error(f"❌ [OpenAI-{self.model}] API connection test failed: {e}")
            return False

    def get_current_call_stats(self) -> Optional[dict]:
        if self.enable_stats:
            return self.current_call_stats
        return None

    def __repr__(self) -> str:
        """String representation of the provider."""
        return f"OpenAIProvider(model={self.model}, base_url={self.base_url})"
