"""Value discriminator for profile extraction - determines if memcell contains profile-worthy content."""

import ast
import json
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from memory_layer.llm.llm_provider import LLMProvider
from core.observation.logger import get_logger
from common_utils.logging_utils import summarize_text, dump_llm_artifacts

logger = get_logger(__name__)


@dataclass
class DiscriminatorConfig:
    """Configuration for value discrimination.
    
    Attributes:
        min_confidence: Minimum confidence threshold (0.0-1.0)
        use_context: Whether to use previous memcells as context
        context_window: Number of previous memcells to include as context
    """
    
    min_confidence: float = 0.6
    use_context: bool = True
    context_window: int = 2


class ValueDiscriminator:
    """LLM-based discriminator to judge if a memcell contains high-value profile information.
    
    This component uses an LLM to analyze memcells and determine whether they contain
    concrete, attributable information worth extracting into user profiles.
    
    For private/group scenarios, it looks for:
    - Personality indicators
    - Decision-making patterns
    - Interests and goals
    - Values, motivations, and habitual styles
    
    The assistant scenario is deprecated and mapped to private.
    """
    
    def __init__(
        self,
        llm_provider: LLMProvider,
        config: Optional[DiscriminatorConfig] = None,
        scenario: str = "private"
    ):
        """Initialize value discriminator.
        
        Args:
            llm_provider: LLM provider for discrimination
            config: Discriminator configuration
            scenario: "private" or "group"
        """
        self.llm_provider = llm_provider
        self.config = config or DiscriminatorConfig()
        self.scenario = scenario.lower()
        # Backward compatibility
        if self.scenario == "assistant":
            self.scenario = "private"
        elif self.scenario == "companion":
            self.scenario = "group"
    
    async def is_high_value(
        self,
        latest_memcell: Any,
        recent_memcells: Optional[List[Any]] = None
    ) -> Tuple[bool, float, str]:
        """Determine if the latest memcell contains high-value profile information.
        
        Args:
            latest_memcell: The memcell to evaluate
            recent_memcells: Previous memcells for context (optional)
        
        Returns:
            Tuple of (is_high_value, confidence, reason)
        """
        recent_memcells = recent_memcells or []
        
        # Build prompt based on scenario (private/group share the same prompt)
        prompt = self._build_companion_prompt(latest_memcell, recent_memcells)
        
        try:
            response = await self.llm_provider.generate(prompt, temperature=0.0)
            is_high, conf, reason = self._parse_response(response, prompt=prompt)
            
            # Apply confidence threshold
            if is_high and conf >= self.config.min_confidence:
                return True, conf, reason
            else:
                return False, conf, reason or "Below confidence threshold"
        
        except Exception as e:
            logger.warning(f"Value discrimination failed: {e}")
            logger.warning(
                "Discriminator context: prompt_len=%s response_len=%s",
                len(prompt) if prompt else 0,
                len(response) if "response" in locals() and response else 0,
            )
            if prompt:
                logger.warning(
                    "Discriminator prompt preview: %s",
                    summarize_text(prompt, 800),
                )
            if "response" in locals() and response:
                logger.warning(
                    "Discriminator response preview: %s",
                    summarize_text(response, 800),
                )
            return False, 0.0, f"Discrimination error: {str(e)}"
    
    def _build_companion_prompt(
        self,
        latest: Any,
        recent: List[Any]
    ) -> str:
        """Build prompt for private/group scenario."""
        context_texts = []
        if self.config.use_context and recent:
            window = recent[-self.config.context_window:]
            for i, mc in enumerate(window):
                text = self._extract_text(mc)
                if text:
                    context_texts.append(f"[Context {i+1}]\n{text}")
        
        latest_text = self._extract_text(latest)
        context_block = "\n\n".join(context_texts) if context_texts else "No context available"
        
        prompt = f"""You are a precise profile value discriminator for private/group chat scenario.

Given the latest conversation MemCell and recent context, determine if the latest MemCell contains 
new, concrete, and attributable information about user profile fields such as:

Profile Fields to Consider:
- personality: Character traits, temperament
- way_of_decision_making: Decision patterns, priorities
- interests: Long-term interests or recurring topics
- life_habit_preference: Daily habits or lifestyle preferences
- motivation_system: What drives the user
- fear_system: What the user wants to avoid
- value_system: Core values and principles
- humor_use: Humor and expression style
- catchphrase: Habitual phrasing or catchphrases

Rules for Judgment:
1. Reject small talk, vague statements, or non-attributable content
2. Prefer explicit statements (e.g., "I am responsible for X", "I have experience with Y")
3. Look for concrete evidence, not assumptions
4. Consider if the information is stable/lasting vs transient
5. Ensure the information is clearly attributable to a specific user

Context (Previous MemCells):
{context_block}

Latest MemCell to Evaluate:
{latest_text}

Respond with strict JSON only (no extra text):
{{
  "is_high_value": true/false,
  "confidence": 0.0-1.0,
  "reasons": "Brief explanation of your judgment"
}}"""
        
        return prompt
    
    def _build_assistant_prompt(
        self,
        latest: Any,
        recent: List[Any]
    ) -> str:
        """Build prompt for legacy assistant scenario (deprecated)."""
        context_texts = []
        if self.config.use_context and recent:
            window = recent[-self.config.context_window:]
            for i, mc in enumerate(window):
                text = self._extract_text(mc)
                if text:
                    context_texts.append(f"[Context {i+1}]\n{text}")
        
        latest_text = self._extract_text(latest)
        context_block = "\n\n".join(context_texts) if context_texts else "No context available"
        
        prompt = f"""You are a precise value discriminator for companion/assistant scenario.

Determine if the latest MemCell reveals stable personal traits or preferences worth capturing:

Profile Fields to Consider:
- personality: Enduring personality dimensions (Big Five, MBTI indicators)
- way_of_decision_making: Stable decision-making patterns
- interests: Long-term hobbies, passions, areas of interest
- life_habit_preference: Behavioral patterns or recurring preferences
- value_system: Core values, beliefs, principles
- motivation_system: What drives/motivates the user

Rules for Judgment:
1. Focus on stable, enduring traits (not transient moods or one-time events)
2. Reject casual chit-chat and vague statements
3. Look for repeated patterns or explicit self-descriptions
4. Prefer concrete examples over abstract claims
5. Ensure information is clearly attributable

Context (Previous MemCells):
{context_block}

Latest MemCell to Evaluate:
{latest_text}

Respond with strict JSON only (no extra text):
{{
  "is_high_value": true/false,
  "confidence": 0.0-1.0,
  "reasons": "Brief explanation of your judgment"
}}"""
        
        return prompt
    
    def _extract_text(self, memcell: Any) -> str:
        """Extract representative text from a memcell.
        
        Priority: episode > summary > original_data
        """
        if memcell is None:
            return ""
        
        # Try episode first
        episode = getattr(memcell, "episode", None)
        if isinstance(episode, str) and episode.strip():
            return episode.strip()
        
        # Try summary
        summary = getattr(memcell, "summary", None)
        if isinstance(summary, str) and summary.strip():
            return summary.strip()
        
        # Fallback to compact original_data
        lines = []
        original_data = getattr(memcell, "original_data", None)
        if isinstance(original_data, list):
            for item in original_data[:5]:  # Limit to first 5 messages
                if isinstance(item, dict):
                    content = item.get("content") or item.get("summary")
                    if content:
                        text = str(content).strip()
                        if text:
                            lines.append(text)
        
        return "\n".join(lines) if lines else "Empty memcell"
    
    def _parse_response(
        self, response: str, prompt: Optional[str] = None
    ) -> Tuple[bool, float, str]:
        """Parse LLM response to extract judgment.
        
        Returns:
            (is_high_value, confidence, reasons)
        """
        if not response:
            return False, 0.0, "Empty response"
        
        # Try to extract JSON from code blocks first
        fenced_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", response, re.DOTALL)
        
        payload: Optional[Dict[str, Any]] = None
        
        try:
            if fenced_match:
                payload = json.loads(fenced_match.group(1))
            else:
                # Try direct JSON parsing
                try:
                    payload = json.loads(response)
                except json.JSONDecodeError:
                    # Try AST literal_eval as fallback
                    parsed = ast.literal_eval(response)
                    if isinstance(parsed, dict):
                        payload = parsed
        except Exception:
            # Last resort: find first {...} in response
            obj_match = re.search(r"\{[\s\S]*?\}", response)
            if obj_match:
                try:
                    payload = json.loads(obj_match.group())
                except Exception:
                    pass
        
        if not payload:
            logger.warning(
                "Failed to parse discriminator response: response_len=%s response_preview=%s",
                len(response) if response else 0,
                summarize_text(response, 800),
            )
            if prompt:
                logger.warning(
                    "Discriminator prompt preview: %s",
                    summarize_text(prompt, 800),
                )
            artifact_path = dump_llm_artifacts(
                "discriminator_parse",
                prompt=prompt,
                response=response,
            )
            if artifact_path:
                logger.error(
                    "Discriminator parse artifact saved: %s", artifact_path
                )
            return False, 0.0, "Failed to parse response"
        
        is_high = bool(payload.get("is_high_value", False))
        conf = float(payload.get("confidence", 0.0) or 0.0)
        reasons = str(payload.get("reasons", ""))
        
        return is_high, conf, reasons

