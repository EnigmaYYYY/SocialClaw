from memory_rebuild_flags import (
    should_force_memory_replay,
    should_skip_duplicate_memcell,
)


def test_force_memory_replay_prefers_historical_rebuild():
    assert should_force_memory_replay(True, 12) is True
    assert should_force_memory_replay(False, 0) is True
    assert should_force_memory_replay(False, 3) is False


def test_duplicate_memcell_skip_is_disabled_for_rebuild_modes():
    assert should_skip_duplicate_memcell("abc", "abc") is True
    assert should_skip_duplicate_memcell("abc", "abc", force_memory_backfill=True) is False
    assert should_skip_duplicate_memcell("abc", "abc", force_profile_extraction=True) is False
