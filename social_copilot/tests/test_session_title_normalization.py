from social_copilot.visual_monitor.core.pipeline import VisualMonitorPipeline


def _pipeline() -> VisualMonitorPipeline:
    return VisualMonitorPipeline.__new__(VisualMonitorPipeline)


def test_resolve_session_title_alias_keeps_current_emoji_title_variant() -> None:
    pipeline = _pipeline()

    resolved = pipeline._resolve_session_title_alias("微信", "WeChat", "⭐💖🐯")

    assert resolved == "⭐💖🐯"


def test_build_session_key_ignores_decorative_moon_for_text_titles() -> None:
    pipeline = _pipeline()

    left = pipeline._build_session_key("WeChat", "小岳岳 1.27 🌙")
    right = pipeline._build_session_key("微信", "小岳岳 1.27")

    assert left == right == "微信::小岳岳 1.27"


def test_resolve_session_title_alias_preserves_visible_title_without_manual_hint() -> None:
    pipeline = _pipeline()

    resolved = pipeline._resolve_session_title_alias("微信", "WeChat", "小岳岳 1.27 🌙")

    assert resolved == "小岳岳 1.27 🌙"
