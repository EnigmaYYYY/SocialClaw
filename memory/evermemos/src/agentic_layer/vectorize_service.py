"""
Vectorize Service
Vectorization service

This module provides methods to call DeepInfra or vLLM API for getting text embeddings.
"""

from __future__ import annotations

import os
import asyncio
import logging
from abc import ABC, abstractmethod
from enum import Enum
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass
import numpy as np
from openai import AsyncOpenAI, BadRequestError
import httpx

from common_utils.logging_utils import dump_embedding_context

from core.di.utils import get_bean
from core.di.decorators import service
from memory_layer.constants import VECTORIZE_DIMENSIONS

logger = logging.getLogger(__name__)


class VectorizeProvider(str, Enum):
    """Vectorization service provider enum"""

    DEEPINFRA = "deepinfra"
    VLLM = "vllm"
    OLLAMA = "ollama"


@dataclass
@service(name="vectorize_config", primary=True)
class VectorizeConfig:
    """Vectorize API configuration class"""

    provider: VectorizeProvider = VectorizeProvider.DEEPINFRA
    api_key: str = ""
    base_url: str = ""
    model: str = ""
    timeout: int = 30
    max_retries: int = 3
    batch_size: int = 10
    max_concurrent_requests: int = 5
    encoding_format: str = "float"
    dimensions: int = 1024
    disabled: bool = False

    def __post_init__(self):
        """Load configuration values from environment variables after initialization"""
        # Handle provider
        env_provider = os.getenv("VECTORIZE_PROVIDER")
        if env_provider:
            provider_str = env_provider.lower()
            try:
                self.provider = VectorizeProvider(provider_str)
            except ValueError:
                logger.error(
                    f"Invalid provider '{provider_str}', expected one of {[p.value for p in VectorizeProvider]}"
                )
                raise ValueError(
                    f"Invalid provider '{provider_str}', expected one of {[p.value for p in VectorizeProvider]}"
                )

        if not self.api_key:
            self.api_key = os.getenv("VECTORIZE_API_KEY") or os.getenv(
                "VECTORIZE_API_KEY", ""
            )
            if self.provider == VectorizeProvider.VLLM and not self.api_key:
                self.api_key = "EMPTY"

        if not self.base_url:
            default_url = "https://api.deepinfra.com/v1/openai"
            if self.provider == VectorizeProvider.VLLM:
                default_url = "http://localhost:8000/v1"  # Standard vLLM port
            elif self.provider == VectorizeProvider.OLLAMA:
                default_url = "http://127.0.0.1:11434"

            self.base_url = os.getenv("VECTORIZE_BASE_URL", default_url)

        if not self.model:
            self.model = os.getenv("VECTORIZE_MODEL", "Qwen/Qwen3-Embedding-4B")

        if self.timeout == 30:
            self.timeout = int(os.getenv("VECTORIZE_TIMEOUT", "30"))
        if self.max_retries == 3:
            self.max_retries = int(os.getenv("VECTORIZE_MAX_RETRIES", "3"))
        if self.batch_size == 10:
            self.batch_size = int(
                os.getenv("VECTORIZE_BATCH_SIZE")
                or os.getenv("VECTORIZE_BATCH_SIZE", "10")
            )
        if self.max_concurrent_requests == 5:
            self.max_concurrent_requests = int(
                os.getenv("VECTORIZE_MAX_CONCURRENT", "5")
            )
        if self.encoding_format == "float":
            self.encoding_format = os.getenv("VECTORIZE_ENCODING_FORMAT", "float")
        if self.dimensions == 1024:
            self.dimensions = VECTORIZE_DIMENSIONS
        if not self.disabled:
            self.disabled = os.getenv("VECTORIZE_DISABLED", "0") in ("1", "true", "True")


class VectorizeError(Exception):
    """Vectorize API error exception class"""

    pass


@dataclass
class UsageInfo:
    """Token usage information"""

    prompt_tokens: int
    total_tokens: int

    @classmethod
    def from_openai_usage(cls, usage) -> "UsageInfo":
        """Create UsageInfo object from OpenAI usage object"""
        return cls(prompt_tokens=usage.prompt_tokens, total_tokens=usage.total_tokens)


class VectorizeServiceInterface(ABC):
    """Vectorization service interface"""

    @abstractmethod
    async def get_embedding(
        self, text: str, instruction: Optional[str] = None
    ) -> np.ndarray:
        pass

    @abstractmethod
    async def get_embedding_with_usage(
        self, text: str, instruction: Optional[str] = None
    ) -> Tuple[np.ndarray, Optional[UsageInfo]]:
        pass

    @abstractmethod
    async def get_embeddings(
        self, texts: List[str], instruction: Optional[str] = None
    ) -> List[np.ndarray]:
        pass

    @abstractmethod
    async def get_embeddings_batch(
        self, text_batches: List[List[str]], instruction: Optional[str] = None
    ) -> List[List[np.ndarray]]:
        pass

    @abstractmethod
    def get_model_name(self) -> str:
        """
        Get the current model name

        Returns:
            str: Model name
        """
        pass


@service(name="vectorize_service", primary=True)
class VectorizeService(VectorizeServiceInterface):
    """
    Generic vectorization service class (supports DeepInfra, vLLM and other OpenAI-compatible interfaces)
    """

    def __init__(self, config: Optional[VectorizeConfig] = None):
        if config is None:
            try:
                from core.di import get_bean

                config = get_bean("vectorize_config")
                logger.info("Vectorize config source: DI bean 'vectorize_config'")
            except Exception:
                config = self._load_config_from_env()
                logger.info("Vectorize config source: env")

        # Normalize configuration
        base_url = config.base_url or ""
        if base_url and not (
            base_url.startswith("http://") or base_url.startswith("https://")
        ):
            # Default based on provider, or default to https
            base_url = f"https://{base_url}"

        config.base_url = base_url

        self.config = config
        self.client: Optional[AsyncOpenAI] = None
        self._semaphore = asyncio.Semaphore(config.max_concurrent_requests)

        logger.info(
            f"Initialized Vectorize Service | provider={config.provider.value} | model={config.model} | base_url={config.base_url}"
        )
        if self.config.disabled:
            logger.warning("Vectorize Service is disabled by VECTORIZE_DISABLED=1")

    def _disabled_vector(self) -> np.ndarray:
        dim = self.config.dimensions or VECTORIZE_DIMENSIONS
        return np.zeros(int(dim), dtype=np.float32)

    def _load_config_from_env(self) -> VectorizeConfig:
        """Load configuration from environment variables"""
        return VectorizeConfig()

    async def __aenter__(self):
        await self._ensure_client()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.close()

    async def _ensure_client(self):
        if self.client is None:
            self.client = AsyncOpenAI(
                api_key=self.config.api_key,
                base_url=self.config.base_url,
                timeout=self.config.timeout,
            )

    async def close(self):
        if self.client:
            await self.client.close()
            self.client = None

    def _normalize_embedding_vector(self, emb: np.ndarray) -> np.ndarray:
        """Apply dimension truncation and re-normalization."""
        if (
            self.config.dimensions
            and self.config.dimensions > 0
            and len(emb) > self.config.dimensions
        ):
            emb = emb[: self.config.dimensions]
            norm = np.linalg.norm(emb)
            if norm > 0:
                emb = emb / norm
        return emb

    async def _make_request_ollama(
        self, texts: List[str], instruction: Optional[str] = None, is_query: bool = False
    ) -> List[np.ndarray]:
        """Call Ollama native /api/embeddings endpoint."""
        if not self.config.model:
            raise VectorizeError("Embedding model is not configured.")

        if is_query:
            default_instruction = (
                "Given a search query, retrieve relevant passages that answer the query"
            )
            final_instruction = (
                instruction if instruction is not None else default_instruction
            )
            formatted_texts = [
                f"Instruct: {final_instruction}\nQuery: {text}" for text in texts
            ]
        else:
            formatted_texts = texts

        url = self.config.base_url.rstrip("/") + "/api/embeddings"

        embeddings: List[np.ndarray] = []
        async with self._semaphore:
            async with httpx.AsyncClient(timeout=self.config.timeout) as client:
                for text in formatted_texts:
                    payload = {"model": self.config.model, "prompt": text}
                    last_err: Optional[Exception] = None
                    for attempt in range(self.config.max_retries):
                        try:
                            resp = await client.post(url, json=payload)
                            if resp.status_code != 200:
                                raise VectorizeError(
                                    f"Ollama API request failed: {resp.status_code} {resp.text}"
                                )
                            data = resp.json()
                            if "embedding" not in data:
                                raise VectorizeError(
                                    f"Invalid Ollama response: {data}"
                                )
                            emb = np.array(data["embedding"], dtype=np.float32)
                            emb = self._normalize_embedding_vector(emb)
                            embeddings.append(emb)
                            last_err = None
                            break
                        except Exception as e:
                            last_err = e
                            logger.error(
                                "Ollama embedding error (attempt %s/%s): %s",
                                attempt + 1,
                                self.config.max_retries,
                                e,
                            )
                            if attempt < self.config.max_retries - 1:
                                await asyncio.sleep(2**attempt)
                    if last_err is not None:
                        dump_embedding_context(
                            "ollama_embed_failed",
                            prompt=text,
                            meta={
                                "model": self.config.model,
                                "base_url": self.config.base_url,
                                "is_query": is_query,
                                "instruction": instruction,
                                "retries": self.config.max_retries,
                                "error": str(last_err),
                            },
                        )
                        raise VectorizeError(f"Ollama API request failed: {last_err}")

        return embeddings

    async def _make_request(
        self,
        texts: List[str],
        instruction: Optional[str] = None,
        is_query: bool = False,
    ):
        await self._ensure_client()
        if not self.config.model:
            raise VectorizeError("Embedding model is not configured.")

        # If is_query=True, wrap text with instruction format
        if is_query:
            default_instruction = (
                "Given a search query, retrieve relevant passages that answer the query"
            )
            final_instruction = (
                instruction if instruction is not None else default_instruction
            )
            formatted_texts = [
                f"Instruct: {final_instruction}\nQuery: {text}" for text in texts
            ]
        else:
            formatted_texts = texts

        async with self._semaphore:
            for attempt in range(self.config.max_retries):
                try:
                    request_kwargs = {
                        "model": self.config.model,
                        "input": formatted_texts,
                        "encoding_format": self.config.encoding_format,
                    }

                    # Only add dimensions parameter if provider is NOT vllm
                    # vLLM typically doesn't support 'dimensions' param in OpenAI API compatibility layer yet
                    # We handle vLLM via client-side truncation in _parse_embeddings_response
                    if self.config.dimensions and self.config.dimensions > 0:
                        if self.config.provider != VectorizeProvider.VLLM:
                            request_kwargs["dimensions"] = self.config.dimensions

                    response = await self.client.embeddings.create(**request_kwargs)
                    return response

                except Exception as e:
                    logger.error(f"Vectorize API error (attempt {attempt + 1}): {e}")
                    if attempt < self.config.max_retries - 1:
                        await asyncio.sleep(2**attempt)
                        continue
                    else:
                        raise VectorizeError(f"API request failed: {e}")

    async def get_embedding(
        self, text: str, instruction: Optional[str] = None, is_query: bool = False
    ) -> np.ndarray:
        if self.config.disabled:
            return self._disabled_vector()
        if self.config.provider == VectorizeProvider.OLLAMA:
            embeddings = await self._make_request_ollama([text], instruction, is_query)
            if not embeddings:
                raise VectorizeError("Invalid Ollama response: missing embedding")
            return embeddings[0]

        response = await self._make_request([text], instruction, is_query)
        if not response.data:
            raise VectorizeError("Invalid API response: missing data")
        return np.array(self._parse_embeddings_response(response)[0], dtype=np.float32)

    async def get_embedding_with_usage(
        self, text: str, instruction: Optional[str] = None, is_query: bool = False
    ) -> Tuple[np.ndarray, Optional[UsageInfo]]:
        if self.config.disabled:
            return self._disabled_vector(), None
        if self.config.provider == VectorizeProvider.OLLAMA:
            embeddings = await self._make_request_ollama([text], instruction, is_query)
            if not embeddings:
                raise VectorizeError("Invalid Ollama response: missing embedding")
            return embeddings[0], None

        response = await self._make_request([text], instruction, is_query)
        if not response.data:
            raise VectorizeError("Invalid API response: missing data")

        embeddings = self._parse_embeddings_response(response)
        embedding = np.array(embeddings[0], dtype=np.float32)
        usage_info = (
            UsageInfo.from_openai_usage(response.usage) if response.usage else None
        )
        return embedding, usage_info

    async def get_embeddings(
        self,
        texts: List[str],
        instruction: Optional[str] = None,
        is_query: bool = False,
    ) -> List[np.ndarray]:
        if self.config.disabled:
            return [self._disabled_vector() for _ in texts]
        if not texts:
            return []

        if self.config.provider == VectorizeProvider.OLLAMA:
            return await self._make_request_ollama(texts, instruction, is_query)

        if len(texts) <= self.config.batch_size:
            response = await self._make_request(texts, instruction, is_query)
            return self._parse_embeddings_response(response)

        embeddings = []
        for i in range(0, len(texts), self.config.batch_size):
            batch_texts = texts[i : i + self.config.batch_size]
            response = await self._make_request(batch_texts, instruction, is_query)
            embeddings.extend(self._parse_embeddings_response(response))
            if i + self.config.batch_size < len(texts):
                await asyncio.sleep(0.1)
        return embeddings

    def _parse_embeddings_response(self, response) -> List[np.ndarray]:
        if not response.data:
            raise VectorizeError("Invalid API response: missing data")

        embeddings = []
        for item in response.data:
            emb = np.array(item.embedding, dtype=np.float32)
            emb = self._normalize_embedding_vector(emb)
            embeddings.append(emb)
        return embeddings

    async def get_embeddings_batch(
        self,
        text_batches: List[List[str]],
        instruction: Optional[str] = None,
        is_query: bool = False,
    ) -> List[List[np.ndarray]]:
        if self.config.disabled:
            return [[self._disabled_vector() for _ in batch] for batch in text_batches]
        tasks = [
            self.get_embeddings(batch, instruction, is_query) for batch in text_batches
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        embeddings_batches = []
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                logger.error(f"Error processing batch {i}: {result}")
                embeddings_batches.append([])
            else:
                embeddings_batches.append(result)
        return embeddings_batches

    def get_model_name(self) -> str:
        """
        Get the current model name

        Returns:
            str: Model name
        """
        return self.config.model

    def get_model_info(self) -> Dict[str, Any]:
        return {
            "provider": self.config.provider.value,
            "model": self.config.model,
            "base_url": self.config.base_url,
            "timeout": self.config.timeout,
            "batch_size": self.config.batch_size,
            "max_concurrent": self.config.max_concurrent_requests,
            "encoding_format": self.config.encoding_format,
        }


def get_vectorize_service() -> VectorizeServiceInterface:
    return get_bean("vectorize_service")


# Utility functions
async def get_text_embedding(
    text: str, instruction: Optional[str] = None, is_query: bool = False
) -> np.ndarray:
    return await get_vectorize_service().get_embedding(text, instruction, is_query)


async def get_text_embeddings(
    texts: List[str], instruction: Optional[str] = None, is_query: bool = False
) -> List[np.ndarray]:
    return await get_vectorize_service().get_embeddings(texts, instruction, is_query)


async def get_text_embeddings_batch(
    text_batches: List[List[str]],
    instruction: Optional[str] = None,
    is_query: bool = False,
) -> List[List[np.ndarray]]:
    return await get_vectorize_service().get_embeddings_batch(
        text_batches, instruction, is_query
    )


async def get_text_embedding_with_usage(
    text: str, instruction: Optional[str] = None, is_query: bool = False
) -> Tuple[np.ndarray, Optional[UsageInfo]]:
    return await get_vectorize_service().get_embedding_with_usage(
        text, instruction, is_query
    )
