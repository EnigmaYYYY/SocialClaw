from pathlib import Path

from social_copilot.visual_monitor.core.frame_cache import FrameCacheManager


def test_frame_cache_writes_and_removes_after_done(tmp_path: Path) -> None:
    manager = FrameCacheManager(
        enabled=True,
        cache_dir=tmp_path,
        keep_processed_frames=False,
        cache_all_frames=False,
    )
    entry = manager.put("f_000001", b"abc", ".bin")
    assert entry is not None
    assert entry.path.exists()
    assert manager.load(entry) == b"abc"
    manager.done(entry)
    assert not entry.path.exists()


def test_frame_cache_keeps_file_when_configured(tmp_path: Path) -> None:
    manager = FrameCacheManager(
        enabled=True,
        cache_dir=tmp_path,
        keep_processed_frames=True,
        cache_all_frames=False,
    )
    entry = manager.put("f_000002", b"xyz", ".bin")
    assert entry is not None
    manager.done(entry)
    assert entry.path.exists()


def test_frame_cache_testing_mode_keeps_file_even_when_keep_disabled(tmp_path: Path) -> None:
    manager = FrameCacheManager(
        enabled=True,
        cache_dir=tmp_path,
        keep_processed_frames=False,
        cache_all_frames=False,
        testing_mode=True,
    )
    entry = manager.put("f_000003", b"dbg", ".bin")
    assert entry is not None
    manager.done(entry)
    assert entry.path.exists()


def test_frame_cache_deduplicates_high_similarity_kept_png(tmp_path: Path) -> None:
    manager = FrameCacheManager(
        enabled=True,
        cache_dir=tmp_path,
        keep_processed_frames=True,
        cache_all_frames=False,
        deduplicate_kept_frames=True,
        dedup_similarity_threshold=0.99,
    )
    first = manager.put("f_000010", b"same-image", ".png")
    second = manager.put("f_000011", b"same-image", ".png")
    assert first is not None
    assert second is None
    kept = sorted(path.name for path in tmp_path.glob("*.png"))
    assert kept == ["f_000010.png"]


def test_frame_cache_prunes_old_kept_frames_when_limit_reached(tmp_path: Path) -> None:
    manager = FrameCacheManager(
        enabled=True,
        cache_dir=tmp_path,
        keep_processed_frames=True,
        cache_all_frames=False,
        deduplicate_kept_frames=False,
        max_kept_frames=2,
    )
    manager.put("f_000020", b"a", ".png")
    manager.put("f_000021", b"b", ".png")
    manager.put("f_000022", b"c", ".png")
    kept = sorted(path.name for path in tmp_path.glob("*.png"))
    assert kept == ["f_000021.png", "f_000022.png"]


def test_frame_cache_testing_mode_still_honors_kept_frame_dedup(tmp_path: Path) -> None:
    manager = FrameCacheManager(
        enabled=True,
        cache_dir=tmp_path,
        keep_processed_frames=True,
        cache_all_frames=False,
        deduplicate_kept_frames=True,
        dedup_similarity_threshold=0.99,
        max_kept_frames=1,
        testing_mode=True,
    )
    first = manager.put("f_000030", b"same-image", ".png")
    second = manager.put("f_000031", b"same-image", ".png")
    assert first is not None
    assert second is None
    kept = sorted(path.name for path in tmp_path.glob("*.png"))
    assert kept == ["f_000030.png"]


def test_frame_cache_relocates_pending_entries_into_session_subdir(tmp_path: Path) -> None:
    manager = FrameCacheManager(
        enabled=True,
        cache_dir=tmp_path,
        keep_processed_frames=True,
        cache_all_frames=True,
        testing_mode=True,
    )
    raw = manager.put("f_000001", b"raw", ".rgb", "_pending")
    processed = manager.put("f_000001", b"png", ".png", "_pending")

    assert raw is not None
    assert processed is not None

    session_subdir = Path("微信") / "面试小组"
    session_frame_id = manager.next_frame_id(session_subdir)
    manager.relocate(raw, session_subdir, session_frame_id)
    manager.relocate(processed, session_subdir, session_frame_id)

    assert not (tmp_path / "_pending" / "f_000001.rgb").exists()
    assert not (tmp_path / "_pending" / "f_000001.png").exists()
    assert (tmp_path / "微信" / "面试小组" / "f_000001.rgb").exists()
    assert (tmp_path / "微信" / "面试小组" / "f_000001.png").exists()


def test_frame_cache_allocates_sequence_per_session_subdir(tmp_path: Path) -> None:
    manager = FrameCacheManager(
        enabled=True,
        cache_dir=tmp_path,
        keep_processed_frames=True,
        cache_all_frames=True,
        testing_mode=True,
    )
    session_a = Path("微信") / "A群"
    session_b = Path("微信") / "B群"

    assert manager.next_frame_id(session_a) == "f_000001"
    assert manager.next_frame_id(session_a) == "f_000002"
    assert manager.next_frame_id(session_b) == "f_000001"


def test_frame_cache_preserves_timestamped_filename_when_relocating_entries(tmp_path: Path) -> None:
    manager = FrameCacheManager(
        enabled=True,
        cache_dir=tmp_path,
        keep_processed_frames=True,
        cache_all_frames=True,
        testing_mode=True,
    )
    timestamp_token = "20260331T165910123456Z"
    pending = manager.put(
        "f_000001",
        b"png",
        ".png",
        "_pending",
        filename_token=timestamp_token,
    )

    assert pending is not None
    assert pending.path.name == "f_000001_20260331T165910123456Z.png"

    session_subdir = Path("微信") / "面试小组"
    relocated = manager.relocate(
        pending,
        session_subdir,
        "f_000001",
        filename_token=timestamp_token,
    )

    assert relocated is not None
    assert relocated.path == tmp_path / "微信" / "面试小组" / "f_000001_20260331T165910123456Z.png"


def test_frame_cache_lists_pending_entries_in_timestamp_order(tmp_path: Path) -> None:
    manager = FrameCacheManager(
        enabled=True,
        cache_dir=tmp_path,
        keep_processed_frames=True,
        cache_all_frames=True,
        testing_mode=True,
    )
    manager.put("f_000001", b"late", ".png", "_pending", filename_token="20260402T104023647578Z")
    manager.put("f_000001", b"early", ".png", "_pending", filename_token="20260402T104011351282Z")
    manager.put("f_000002", b"later", ".png", "_pending", filename_token="20260402T104025115384Z")

    entries = manager.list_entries("_pending", ".png")

    assert [entry.path.name for entry in entries] == [
        "f_000001_20260402T104011351282Z.png",
        "f_000001_20260402T104023647578Z.png",
        "f_000002_20260402T104025115384Z.png",
    ]
