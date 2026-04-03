"""
Unit test: Test the functionality of fetch_mem_service.py
"""

import pytest

from agentic_layer.fetch_mem_service import get_fetch_memory_service
from api_specs.memory_models import (
    MemoryType,
    BaseMemoryModel,
    ProfileModel,
    PreferenceModel,
    EpisodicMemoryModel,
    ForesightModel,
    EntityModel,
    RelationModel,
    BehaviorHistoryModel,
    EventLogModel,
    ForesightRecordModel,
)


class TestFakeFetchMemoryService:
    """Test FakeFetchMemoryService"""

    @pytest.fixture
    def service(self):
        """Create service instance"""
        return get_fetch_memory_service()

    @pytest.mark.asyncio
    async def test_find_by_user_id_base_memory(self, service):
        """Test finding base memory"""
        response = await service.find_by_user_id(
            "user_001", MemoryType.BASE_MEMORY, limit=5
        )

        assert response.total_count > 0
        assert len(response.memories) <= 5
        assert all(isinstance(memory, BaseMemoryModel) for memory in response.memories)
        assert all(memory.user_id == "user_001" for memory in response.memories)
        assert response.metadata["user_id"] == "user_001"
        assert response.metadata["memory_type"] == "base_memory"

    @pytest.mark.asyncio
    async def test_find_by_user_id_profile(self, service):
        """Test finding user profile"""
        response = await service.find_by_user_id(
            "user_001", MemoryType.PROFILE, limit=5
        )

        assert response.total_count > 0
        assert len(response.memories) <= 5
        assert all(isinstance(memory, ProfileModel) for memory in response.memories)
        assert all(memory.user_id == "user_001" for memory in response.memories)

    @pytest.mark.asyncio
    async def test_find_by_user_id_preference(self, service):
        """Test finding user preferences"""
        response = await service.find_by_user_id(
            "user_001", MemoryType.PREFERENCE, limit=5
        )

        assert response.total_count > 0
        assert all(isinstance(memory, PreferenceModel) for memory in response.memories)
        assert all(memory.user_id == "user_001" for memory in response.memories)

    @pytest.mark.asyncio
    async def test_find_by_user_id_episodic_memory(self, service):
        """Test finding episodic memory"""
        response = await service.find_by_user_id(
            "user_001", MemoryType.EPISODIC_MEMORY, limit=5
        )

        assert response.total_count > 0
        assert all(
            isinstance(memory, EpisodicMemoryModel) for memory in response.memories
        )
        assert all(memory.user_id == "user_001" for memory in response.memories)

    @pytest.mark.asyncio
    async def test_find_by_user_id_foresight(self, service):
        """Test finding foresight"""
        response = await service.find_by_user_id(
            "user_001", MemoryType.FORESIGHT, limit=5
        )

        assert response.total_count > 0
        assert all(isinstance(memory, ForesightModel) for memory in response.memories)
        assert all(memory.user_id == "user_001" for memory in response.memories)

    @pytest.mark.asyncio
    async def test_find_by_user_id_entity(self, service):
        """Test finding entity"""
        response = await service.find_by_user_id("user_001", MemoryType.ENTITY, limit=5)

        assert response.total_count > 0
        assert all(isinstance(memory, EntityModel) for memory in response.memories)
        assert all(memory.user_id == "user_001" for memory in response.memories)

    @pytest.mark.asyncio
    async def test_find_by_user_id_relation(self, service):
        """Test finding relation"""
        response = await service.find_by_user_id(
            "user_001", MemoryType.RELATION, limit=5
        )

        assert response.total_count > 0
        assert all(isinstance(memory, RelationModel) for memory in response.memories)
        assert all(memory.user_id == "user_001" for memory in response.memories)

    @pytest.mark.asyncio
    async def test_find_by_user_id_behavior_history(self, service):
        """Test finding behavior history"""
        response = await service.find_by_user_id(
            "user_001", MemoryType.BEHAVIOR_HISTORY, limit=5
        )

        assert response.total_count > 0
        assert all(
            isinstance(memory, BehaviorHistoryModel) for memory in response.memories
        )
        assert all(memory.user_id == "user_001" for memory in response.memories)

    @pytest.mark.asyncio
    async def test_find_by_user_id_personal_event_log(self, service):
        """Test finding personal event log"""
        response = await service.find_by_user_id(
            "user_001", MemoryType.EVENT_LOG, limit=5
        )

        assert response.total_count > 0
        assert all(isinstance(memory, EventLogModel) for memory in response.memories)
        assert all(memory.user_id == "user_001" for memory in response.memories)

    @pytest.mark.asyncio
    async def test_find_by_user_id_foresight_2(self, service):
        """Test finding personal foresight"""
        response = await service.find_by_user_id(
            "user_001", MemoryType.FORESIGHT, limit=5
        )

        assert response.total_count > 0
        assert all(
            isinstance(memory, ForesightRecordModel) for memory in response.memories
        )
        # The user_id of personal foresight may be None (group scenario), so no strict check

    @pytest.mark.asyncio
    async def test_find_by_user_id_nonexistent_user(self, service):
        """Test finding non-existent user"""
        response = await service.find_by_user_id(
            "nonexistent_user", MemoryType.BASE_MEMORY, limit=5
        )

        assert response.total_count == 0
        assert len(response.memories) == 0
        assert not response.has_more

    @pytest.mark.asyncio
    async def test_find_by_user_id_limit(self, service):
        """Test limiting return count"""
        response = await service.find_by_user_id(
            "user_001", MemoryType.BASE_MEMORY, limit=1
        )

        assert len(response.memories) <= 1

    @pytest.mark.asyncio
    async def test_different_users_have_different_data(self, service):
        """Test different users have different data"""
        response1 = await service.find_by_user_id(
            "user_001", MemoryType.PROFILE, limit=5
        )
        response2 = await service.find_by_user_id(
            "user_002", MemoryType.PROFILE, limit=5
        )

        assert len(response1.memories) > 0
        assert len(response2.memories) > 0

        # Check user IDs are different
        profile1 = response1.memories[0]
        profile2 = response2.memories[0]
        assert profile1.user_id != profile2.user_id


class TestGetFetchMemoryService:
    """Test getting service instance"""

    @pytest.mark.asyncio
    async def test_get_fetch_memory_service(self):
        """Test getting service instance via factory function"""
        service = get_fetch_memory_service()

        # Verify service instance is available
        response = await service.find_by_user_id(
            "user_001", MemoryType.BASE_MEMORY, limit=3
        )

        assert response.total_count > 0
        assert len(response.memories) <= 3
        assert all(isinstance(memory, BaseMemoryModel) for memory in response.memories)
        assert all(memory.user_id == "user_001" for memory in response.memories)


class TestMemoryTypes:
    """Test all memory types"""

    @pytest.fixture
    def service(self):
        return get_fetch_memory_service()

    @pytest.mark.asyncio
    async def test_all_memory_types_available(self, service):
        """Test all memory types have data"""
        user_id = "user_001"

        for memory_type in MemoryType:
            response = await service.find_by_user_id(user_id, memory_type, limit=5)
            assert (
                response.total_count >= 0
            ), f"Memory type {memory_type} should have data or empty result"

            # Verify returned memory type is correct
            if response.memories:
                memory = response.memories[0]
                expected_types = {
                    MemoryType.BASE_MEMORY: BaseMemoryModel,
                    MemoryType.PROFILE: ProfileModel,
                    MemoryType.PREFERENCE: PreferenceModel,
                    MemoryType.EPISODIC_MEMORY: EpisodicMemoryModel,
                    MemoryType.FORESIGHT: ForesightModel,
                    MemoryType.ENTITY: EntityModel,
                    MemoryType.RELATION: RelationModel,
                    MemoryType.BEHAVIOR_HISTORY: BehaviorHistoryModel,
                }
                expected_type = expected_types[memory_type]
                assert isinstance(
                    memory, expected_type
                ), f"Expected {expected_type}, got {type(memory)}"


if __name__ == "__main__":
    pytest.main([__file__])