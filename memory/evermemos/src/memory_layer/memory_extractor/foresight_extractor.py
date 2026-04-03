"""
Foresight Extractor - Based on associative prediction method
Generate predictions of potential impacts on user's future life and decisions from MemCell
"""

import json
from typing import List, Dict, Any, Optional
from datetime import datetime, timedelta

from memory_layer.prompts import get_prompt_by
from memory_layer.llm.llm_provider import LLMProvider
from memory_layer.memory_extractor.base_memory_extractor import (
    MemoryExtractor,
    MemoryExtractRequest,
)
from api_specs.memory_types import (
    MemoryType,
    MemCell,
    Foresight,
    BaseMemory,
    EpisodeMemory,
)
from agentic_layer.vectorize_service import get_vectorize_service
from core.observation.logger import get_logger
from common_utils.datetime_utils import get_now_with_timezone
from common_utils.logging_utils import (
    summarize_text,
    dump_llm_artifacts,
    dump_llm_success,
)

logger = get_logger(__name__)


class ForesightExtractor(MemoryExtractor):
    """
    Foresight Extractor - Based on associative prediction method

    Supports two modes:
    1. use_group_prompt=False: Generate associations based on EpisodeMemory object, add foresights field to returned EpisodeMemory object
    2. use_group_prompt=True: Generate associations based on MemCell object, add foresights field to returned MemCell object

    New strategy implementation:
    1. Based on content, large model associates 3-7 potential impacts on user's subsequent life and decisions
    2. Each association considers its possible duration
    3. Focus on personal-level impacts for the user

    Main methods:
    - generate_foresights_for_memcell(): Generate foresights for MemCell
    - generate_foresights_for_episode(): Generate foresights for EpisodeMemory
    """

    def __init__(self, llm_provider: LLMProvider):
        """
        Initialize foresight extractor

        Args:
            llm_provider: LLM provider
        """
        super().__init__(MemoryType.FORESIGHT)
        self.llm_provider = llm_provider

        logger.info("Foresight extractor initialized (associative prediction mode)")

    async def extract_memory(
        self, request: MemoryExtractRequest
    ) -> Optional[BaseMemory]:
        """
        Implement abstract base class required extract_memory method

        Note: ForesightExtractor should not directly use extract_memory method
        Use generate_foresights_for_memcell or generate_foresights_for_episode instead

        Args:
            request: Memory extraction request

        Returns:
            None - This method should not be called
        """
        raise NotImplementedError(
            "ForesightExtractor should not directly use extract_memory method."
            "Please use generate_foresights_for_memcell or generate_foresights_for_episode method."
        )

    async def generate_foresights_for_memcell(
        self, memcell: MemCell
    ) -> List[Foresight]:
        """
        Generate foresight association predictions for MemCell

        This is the new strategy: Based on MemCell content, large model associates 3-7 potential impacts on user's subsequent life and decisions

        Args:
            memcell: MemCell object

        Returns:
            List of foresight items (3-7 items), including time information
        """
        # Maximum 5 retries
        for retry in range(5):
            try:
                if retry == 0:
                    logger.info(
                        f"🎯 Generating foresight associations for MemCell: {memcell.subject}"
                    )
                else:
                    logger.info(
                        f"🎯 Generating foresight associations for MemCell: {memcell.subject}, retry {retry}/5"
                    )

                # Build prompt (get function type prompt via PromptManager)
                get_group_foresight_generation_prompt = get_prompt_by(
                    "get_group_foresight_generation_prompt"
                )
                prompt = get_group_foresight_generation_prompt(
                    memcell_summary=memcell.summary or "",
                    memcell_episode=memcell.episode or "",
                    user_ids=memcell.user_id_list,
                )

                # Call LLM to generate associations
                logger.debug(
                    f"📝 Starting LLM call to generate foresight associations, prompt length: {len(prompt)}"
                )
                response = await self.llm_provider.generate(
                    prompt=prompt, temperature=0.0
                )
                logger.debug(
                    f"✅ LLM call completed, response length: {len(response) if response else 0}"
                )

                # Parse JSON response
                start_time = self._extract_start_time_from_timestamp(memcell.timestamp)
                # For memcell, user_id comes from user_id_list (first user)
                user_id = memcell.user_id_list[0] if memcell.user_id_list else ""
                foresights = await self._parse_foresights_response(
                    response,
                    start_time=start_time,
                    user_id=user_id,
                    timestamp=memcell.timestamp,
                    ori_event_id_list=[memcell.event_id] if memcell.event_id else [],
                    group_id=memcell.group_id,
                    prompt=prompt,
                )

                # Validate at least 1 item is returned
                if len(foresights) == 0:
                    raise ValueError("LLM returned empty foresight list")

                # Keep 3-7 items (warn if insufficient, but do not retry)
                if len(foresights) > 7:
                    foresights = foresights[:7]
                elif len(foresights) < 3:
                    logger.warning(
                        "Generated foresight associations less than 3, actual count: %s",
                        len(foresights),
                    )

                logger.info(
                    f"✅ Successfully generated {len(foresights)} foresight associations"
                )
                for i, memory in enumerate(foresights[:3], 1):
                    logger.info(f"  Association {i}: {memory.foresight}")

                return foresights

            except Exception as e:
                logger.warning(f"Foresight generation retry {retry+1}/5: {e}")
                if retry == 4:
                    logger.error(f"Foresight generation failed after 5 retries")
                    return []
                continue

        return []

    async def generate_foresights_for_episode(
        self, episode: EpisodeMemory
    ) -> List[Foresight]:
        """
        Generate foresight association predictions for EpisodeMemory

        This is personal mode: Based on EpisodeMemory content, large model associates 3-7 potential impacts on user's subsequent life and decisions

        Args:
            episode: EpisodeMemory object

        Returns:
            List of foresight items (3-7 items), including time information
        """
        # Maximum 5 retries
        for retry in range(5):
            try:
                if retry == 0:
                    logger.info(
                        f"🎯 Generating foresight associations for EpisodeMemory: {episode.subject}"
                    )
                else:
                    logger.info(
                        f"🎯 Generating foresight associations for EpisodeMemory: {episode.subject}, retry {retry+1}/5"
                    )

                # Build prompt (get function type prompt via PromptManager)
                # Directly use episode's user_id
                get_foresight_generation_prompt = get_prompt_by(
                    "get_foresight_generation_prompt"
                )
                prompt = get_foresight_generation_prompt(
                    episode_memory=episode.summary or "",
                    episode_content=episode.episode or "",
                    user_id=episode.user_id,
                )

                # Call LLM to generate associations
                response = await self.llm_provider.generate(
                    prompt=prompt, temperature=0.0
                )

                # Parse JSON response
                start_time = self._extract_start_time_from_timestamp(episode.timestamp)
                foresights = await self._parse_foresights_response(
                    response,
                    start_time=start_time,
                    user_id=episode.user_id,
                    timestamp=episode.timestamp,
                    ori_event_id_list=episode.ori_event_id_list or [],
                    group_id=episode.group_id,
                    prompt=prompt,
                )

                # Validate at least 1 item is returned
                if len(foresights) == 0:
                    raise ValueError("LLM returned empty foresight list")

                # Keep 3-7 items (warn if insufficient, but do not retry)
                if len(foresights) > 7:
                    foresights = foresights[:7]
                elif len(foresights) < 3:
                    logger.warning(
                        "Generated foresight associations less than 3, actual count: %s",
                        len(foresights),
                    )

                logger.info(
                    f"✅ Successfully generated {len(foresights)} foresight associations"
                )
                for i, memory in enumerate(foresights[:3], 1):
                    logger.info(f"  Association {i}: {memory.foresight}")

                return foresights

            except Exception as e:
                logger.warning(f"Foresight generation retry {retry+1}/5: {e}")
                if retry == 4:
                    logger.error(f"Foresight generation failed after 5 retries")
                    return []
                continue

        return []

    @staticmethod
    def _clean_date_string(date_str: Optional[str]) -> Optional[str]:
        """Clean date string, remove invalid characters and validate date validity

        Args:
            date_str: Original date string

        Returns:
            Cleaned date string, return None if invalid
        """
        if not date_str or not isinstance(date_str, str):
            return None

        import re

        # Keep only digits and hyphens, remove other characters (e.g., Chinese, spaces, etc.)
        cleaned = re.sub(r'[^\d\-]', '', date_str)

        # Validate format is YYYY-MM-DD
        if not re.match(r'^\d{4}-\d{2}-\d{2}$', cleaned):
            logger.warning(
                f"Invalid time format, does not match YYYY-MM-DD: original='{date_str}', cleaned='{cleaned}'"
            )
            return None

        # Validate date values are valid (month 1-12, day 1-31, etc.)
        try:
            year, month, day = map(int, cleaned.split('-'))
            # Use datetime to validate date validity
            datetime(year, month, day)
            return cleaned
        except ValueError as e:
            logger.warning(f"Invalid date value: '{cleaned}', error: {e}")
            return None

    async def _parse_foresights_response(
        self,
        response: str,
        start_time: Optional[str] = None,
        user_id: str = "",
        timestamp: Optional[datetime] = None,
        ori_event_id_list: Optional[List[str]] = None,
        group_id: Optional[str] = None,
        prompt: Optional[str] = None,
    ) -> List[Foresight]:
        """
        Parse LLM's JSON response to extract foresight association list

        Args:
            response: LLM response text
            start_time: Start time, format YYYY-MM-DD
            user_id: User ID for the foresight
            timestamp: Timestamp for the foresight
            ori_event_id_list: Original event ID list
            group_id: Group ID

        Returns:
            List of foresight association items
        """
        try:
            # First try to extract JSON from code block
            if '```json' in response:
                start = response.find('```json') + 7
                end = response.find('```', start)
                if end > start:
                    json_str = response[start:end].strip()
                    data = json.loads(json_str)
                else:
                    data = json.loads(response)
            else:
                # Try to parse entire response as JSON array
                data = json.loads(response)

            # Ensure data is a list
            if isinstance(data, list):
                foresights = []

                # First collect all data to be processed
                items_to_process = []
                for item in data:
                    content = item.get('content', '')
                    evidence = item.get('evidence', '')

                    # Use passed start_time or LLM-provided time
                    item_start_time = item.get('start_time', start_time)
                    item_end_time = item.get('end_time')
                    item_duration_days = item.get('duration_days')

                    # Clean time format (prevent LLM outputting incorrect format)
                    item_start_time = self._clean_date_string(item_start_time)
                    item_end_time = self._clean_date_string(item_end_time)

                    # Smart time calculation: prioritize LLM-provided time information
                    if item_start_time:
                        # If LLM provides duration_days but no end_time, calculate end_time
                        if item_duration_days and not item_end_time:
                            item_end_time = self._calculate_end_time_from_duration(
                                item_start_time, item_duration_days
                            )
                        # If LLM provides end_time but no duration_days, calculate duration_days
                        elif item_end_time and not item_duration_days:
                            item_duration_days = self._calculate_duration_days(
                                item_start_time, item_end_time
                            )
                        # If LLM provides neither, keep as None (no additional extraction)

                    items_to_process.append(
                        {
                            'foresight': content,
                            'evidence': evidence,
                            'start_time': item_start_time,
                            'end_time': item_end_time,
                            'duration_days': item_duration_days,
                            'parent_episode_id': item.get('parent_episode_id'),
                        }
                    )

                # Batch compute embeddings for all content (performance optimization)
                vs = get_vectorize_service()
                contents = [item['foresight'] for item in items_to_process]
                vectors_batch = await vs.get_embeddings(
                    contents
                )  # Use get_embeddings (List[str])

                # Create Foresight objects
                for i, item_data in enumerate(items_to_process):
                    # Handle embedding: could be numpy array or already list
                    vector = vectors_batch[i]
                    if hasattr(vector, 'tolist'):
                        vector = vector.tolist()
                    elif not isinstance(vector, list):
                        vector = list(vector)

                    memory_item = Foresight(
                        memory_type=MemoryType.FORESIGHT,
                        user_id=user_id,
                        timestamp=timestamp or get_now_with_timezone(),
                        ori_event_id_list=ori_event_id_list or [],
                        group_id=group_id,
                        foresight=item_data['foresight'],
                        evidence=item_data['evidence'],
                        start_time=item_data['start_time'],
                        end_time=item_data['end_time'],
                        duration_days=item_data['duration_days'],
                        parent_episode_id=item_data['parent_episode_id'],
                        vector=vector,
                        vector_model=vs.get_model_name(),
                    )
                    foresights.append(memory_item)

                artifact_path = dump_llm_success(
                    "foresight_parse",
                    prompt=prompt,
                    response=response,
                    meta={"count": len(foresights)},
                )
                if artifact_path:
                    logger.info("Foresight parse success saved: %s", artifact_path)

                return foresights
            else:
                logger.error(f"Response is not in JSON array format: {data}")
                return []

        except json.JSONDecodeError as e:
            logger.error(f"Error parsing JSON response: {e}")
            artifact_path = dump_llm_artifacts(
                "foresight_parse",
                prompt=prompt,
                response=response,
                meta={"error": str(e)},
            )
            if artifact_path:
                logger.error("Foresight parse artifact saved: %s", artifact_path)
            return []
        except Exception as e:
            logger.error(f"Error parsing foresight response: {e}", exc_info=True)
            artifact_path = dump_llm_artifacts(
                "foresight_parse_error",
                prompt=prompt,
                response=response,
                meta={"error": str(e)},
            )
            if artifact_path:
                logger.error("Foresight parse artifact saved: %s", artifact_path)
            return []

    def _extract_start_time_from_timestamp(self, timestamp: datetime) -> str:
        """
        Extract start time from MemCell's timestamp field

        Args:
            timestamp: MemCell timestamp

        Returns:
            Start time string in YYYY-MM-DD format
        """
        return timestamp.strftime('%Y-%m-%d')

    def _calculate_end_time_from_duration(
        self, start_time: str, duration_days: int
    ) -> Optional[str]:
        """
        Calculate end time based on start time and duration

        Args:
            start_time: Start time in YYYY-MM-DD format
            duration_days: Duration in days

        Returns:
            End time string in YYYY-MM-DD format, return None if calculation fails
        """
        try:
            if not start_time or duration_days is None:
                return None

            start_date = datetime.strptime(start_time, '%Y-%m-%d')
            end_date = start_date + timedelta(days=duration_days)

            return end_date.strftime('%Y-%m-%d')

        except Exception as e:
            logger.error(f"Error calculating end time from duration: {e}")
            return None

    def _calculate_duration_days(self, start_time: str, end_time: str) -> Optional[int]:
        """
        Calculate duration (in days)

        Args:
            start_time: Start time in YYYY-MM-DD format
            end_time: End time in YYYY-MM-DD format

        Returns:
            Duration in days, return None if calculation fails
        """
        try:
            if not start_time or not end_time:
                return None

            start_date = datetime.strptime(start_time, '%Y-%m-%d')
            end_date = datetime.strptime(end_time, '%Y-%m-%d')

            duration = end_date - start_date
            return duration.days

        except Exception as e:
            logger.error(f"Error calculating duration: {e}")
            return None
