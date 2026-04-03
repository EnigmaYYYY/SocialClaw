from social_copilot.visual_monitor.core.change_detector import ChangeDetector


def test_change_detector_skips_almost_identical_frames() -> None:
    detector = ChangeDetector(hash_similarity_skip=0.99, histogram_similarity_skip=0.985)
    decision = detector.detect(b"abcdefgh", b"abcdefgh")
    assert decision.changed is False
    assert decision.reason == "hash_skip"


def test_change_detector_marks_change_for_different_frame() -> None:
    detector = ChangeDetector(hash_similarity_skip=0.99, histogram_similarity_skip=0.985)
    decision = detector.detect(b"abcdefgh", b"12345678")
    assert decision.changed is True
    assert decision.reason in {"hist_change", "hash_change"}


def test_change_detector_handles_missing_previous_frame() -> None:
    detector = ChangeDetector()
    decision = detector.detect(None, b"newframe")
    assert decision.changed is True
    assert decision.reason == "no_previous"


def test_change_detector_recall_first_mode_processes_near_duplicate_frames() -> None:
    detector = ChangeDetector(skip_near_duplicate_frames=False)
    previous = bytes([0]) * 300
    current = bytes([0]) * 299 + bytes([1])

    decision = detector.detect(previous, current)

    assert decision.changed is True
    assert decision.reason == "near_duplicate_forced_process"


def test_change_detector_skips_localized_motion_even_in_recall_first_mode() -> None:
    detector = ChangeDetector(skip_near_duplicate_frames=False, localized_motion_ratio_skip=0.05)
    previous = bytes([0, 0, 0]) * 5000
    current = bytearray(previous)
    for pixel_index in range(3):
        start = pixel_index * 3
        current[start:start + 3] = bytes([255, 255, 255])

    decision = detector.detect(previous, bytes(current))

    assert decision.changed is False
    assert decision.reason == "localized_motion_skip"


def test_change_detector_keeps_large_motion_as_change() -> None:
    detector = ChangeDetector(skip_near_duplicate_frames=False, localized_motion_ratio_skip=0.05)
    previous = bytes([0, 0, 0]) * 5000
    current = bytearray(previous)
    for pixel_index in range(400):
        start = pixel_index * 3
        current[start:start + 3] = bytes([255, 255, 255])

    decision = detector.detect(previous, bytes(current))

    assert decision.changed is True
    assert decision.reason == "near_duplicate_forced_process"
