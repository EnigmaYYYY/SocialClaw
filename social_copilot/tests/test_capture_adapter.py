from social_copilot.visual_monitor.adapters.capture_mss import MSSCaptureAdapter


def test_capture_adapter_maps_roi_to_mss_monitor() -> None:
    monitor = MSSCaptureAdapter.to_mss_monitor({"x": 10, "y": 20, "w": 30, "h": 40})
    assert monitor == {"left": 10, "top": 20, "width": 30, "height": 40}
