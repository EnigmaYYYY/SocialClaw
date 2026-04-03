from historical_import_flags import resolve_historical_import_flag


def test_resolve_historical_import_flag_treats_force_memory_backfill_as_historical_import():
    assert resolve_historical_import_flag({"force_memory_backfill": True}) is True


def test_resolve_historical_import_flag_prefers_explicit_historical_flag():
    assert resolve_historical_import_flag(
        {"force_memory_backfill": False, "is_historical_import": True}
    ) is True


def test_resolve_historical_import_flag_defaults_to_false():
    assert resolve_historical_import_flag({}) is False
