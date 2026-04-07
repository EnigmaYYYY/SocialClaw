from __future__ import annotations

import errno
import hashlib
import re
import shutil
from dataclasses import dataclass
from pathlib import Path


@dataclass(slots=True)
class FrameCacheEntry:
    frame_id: str
    path: Path
    filename_token: str = ""


@dataclass(slots=True)
class _KeptFrameSignature:
    frame_id: str
    path: Path
    digest: bytes


class FrameCacheManager:
    _FRAME_NAME_PATTERN = re.compile(r"^f_(\d{6})(?:_.+)?$")
    _FRAME_STEM_PATTERN = re.compile(r"^(f_\d{6})(?:_(.+))?$")
    _TIMESTAMP_TOKEN_PATTERN = re.compile(r"^\d{8}T\d{12}Z$")

    def __init__(
        self,
        enabled: bool,
        cache_dir: str | Path,
        keep_processed_frames: bool,
        cache_all_frames: bool,
        deduplicate_kept_frames: bool = True,
        dedup_similarity_threshold: float = 0.99,
        max_kept_frames: int = 0,
        testing_mode: bool = False,
    ) -> None:
        self.enabled = enabled
        self.cache_dir = Path(cache_dir)
        self.testing_mode = testing_mode
        self.keep_processed_frames = keep_processed_frames or testing_mode
        self.cache_all_frames = cache_all_frames and not testing_mode
        self.deduplicate_kept_frames = deduplicate_kept_frames
        self.dedup_similarity_threshold = max(0.0, min(1.0, dedup_similarity_threshold))
        self.max_kept_frames = 0 if testing_mode else max(0, int(max_kept_frames))
        self._kept_signatures: list[_KeptFrameSignature] = []
        self._kept_signatures_loaded = False
        self._next_sequence_by_dir: dict[str, int] = {}

    def put(
        self,
        frame_id: str,
        image: bytes,
        suffix: str = ".png",
        subdir: str | Path | None = None,
        filename_token: str | None = None,
    ) -> FrameCacheEntry | None:
        if not self.enabled:
            return None

        target_dir = self._resolve_dir(subdir)
        target_dir.mkdir(parents=True, exist_ok=True)
        suffix_lower = suffix.lower()
        should_track_kept_png = self.keep_processed_frames and suffix_lower == ".png"
        digest: bytes | None = None
        sanitized_token = self._sanitize_filename_token(filename_token)

        if should_track_kept_png and self.deduplicate_kept_frames:
            self._load_existing_kept_signatures()
            digest = self._digest(image)
            for item in self._kept_signatures:
                if self._digest_similarity(digest, item.digest) >= self.dedup_similarity_threshold:
                    return None

        path = target_dir / f"{self._compose_file_stem(frame_id, sanitized_token)}{suffix}"
        try:
            path.write_bytes(image)
        except OSError as exc:
            _is_disk_full = exc.errno == errno.ENOSPC or getattr(exc, "winerror", None) == 112
            if _is_disk_full:
                raise OSError(
                    f"[DiskFull] No space left on device — cannot write frame cache to {path}. "
                    "Free up disk space and restart the monitor."
                ) from exc
            raise
        entry = FrameCacheEntry(frame_id=frame_id, path=path, filename_token=sanitized_token)

        if should_track_kept_png:
            if digest is None:
                digest = self._digest(image)
            self._kept_signatures.append(_KeptFrameSignature(frame_id=frame_id, path=path, digest=digest))
            self._prune_kept_frames()
        return entry

    @staticmethod
    def load(entry: FrameCacheEntry | None) -> bytes | None:
        if entry is None:
            return None
        return entry.path.read_bytes()

    def done(self, entry: FrameCacheEntry | None) -> None:
        if entry is None:
            return
        if self.keep_processed_frames or self.testing_mode:
            return
        try:
            entry.path.unlink(missing_ok=True)
            self._cleanup_empty_dirs(entry.path.parent)
        except Exception:
            return

    def list_entries(
        self,
        subdir: str | Path | None = None,
        suffix: str | None = None,
    ) -> list[FrameCacheEntry]:
        target_dir = self._resolve_dir(subdir)
        if not target_dir.exists():
            return []

        suffix_lower = suffix.lower() if suffix is not None else None
        entries: list[FrameCacheEntry] = []
        for path in target_dir.iterdir():
            if not path.is_file():
                continue
            if suffix_lower is not None and path.suffix.lower() != suffix_lower:
                continue
            parsed = self._parse_frame_stem(path.stem)
            if parsed is None:
                continue
            frame_id, filename_token = parsed
            entries.append(FrameCacheEntry(frame_id=frame_id, path=path, filename_token=filename_token))

        entries.sort(key=self._entry_sort_key)
        return entries

    def next_frame_id(self, subdir: str | Path | None = None) -> str:
        target_dir = self._resolve_dir(subdir)
        key = str(target_dir)
        next_value = self._next_sequence_by_dir.get(key)
        if next_value is None:
            next_value = self._discover_next_sequence(target_dir)
        frame_id = f"f_{next_value:06d}"
        self._next_sequence_by_dir[key] = next_value + 1
        return frame_id

    def relocate(
        self,
        entry: FrameCacheEntry | None,
        subdir: str | Path | None = None,
        frame_id: str | None = None,
        filename_token: str | None = None,
    ) -> FrameCacheEntry | None:
        if entry is None or not entry.path.exists():
            return entry
        target_dir = self._resolve_dir(subdir)
        target_dir.mkdir(parents=True, exist_ok=True)
        next_frame_id = frame_id or entry.frame_id
        next_filename_token = self._sanitize_filename_token(filename_token) or entry.filename_token
        target_path = target_dir / f"{self._compose_file_stem(next_frame_id, next_filename_token)}{entry.path.suffix}"
        if target_path == entry.path:
            return entry
        source_parent = entry.path.parent
        shutil.move(str(entry.path), str(target_path))
        self._update_signature_path(entry.path, target_path)
        entry.frame_id = next_frame_id
        entry.path = target_path
        entry.filename_token = next_filename_token
        self._cleanup_empty_dirs(source_parent)
        return entry

    def sanitize_subdir_component(self, value: str | None, fallback: str = "unknown_session") -> str:
        raw = (value or "").strip()
        cleaned = re.sub(r'[\\/:*?"<>|]+', "_", raw).strip().strip(".")
        return cleaned or fallback

    def _load_existing_kept_signatures(self) -> None:
        if self._kept_signatures_loaded:
            return
        self._kept_signatures_loaded = True
        if not self.cache_dir.exists():
            return
        for path in sorted(self.cache_dir.rglob("*.png")):
            try:
                image = path.read_bytes()
            except Exception:
                continue
            self._kept_signatures.append(
                _KeptFrameSignature(frame_id=path.stem, path=path, digest=self._digest(image))
            )
        self._prune_kept_frames()

    def _prune_kept_frames(self) -> None:
        if self.max_kept_frames <= 0:
            return
        while len(self._kept_signatures) > self.max_kept_frames:
            dropped = self._kept_signatures.pop(0)
            try:
                dropped.path.unlink(missing_ok=True)
            except Exception:
                continue

    @staticmethod
    def _digest(image: bytes) -> bytes:
        return hashlib.blake2b(image, digest_size=16).digest()

    @staticmethod
    def _digest_similarity(digest_a: bytes, digest_b: bytes) -> float:
        xor_bits = int.from_bytes(digest_a, byteorder="big") ^ int.from_bytes(digest_b, byteorder="big")
        hamming = xor_bits.bit_count()
        total_bits = len(digest_a) * 8
        return 1.0 - (hamming / float(total_bits))

    def _resolve_dir(self, subdir: str | Path | None) -> Path:
        if subdir is None or str(subdir).strip() == "":
            return self.cache_dir
        return self.cache_dir / Path(subdir)

    @staticmethod
    def _sanitize_filename_token(value: str | None) -> str:
        raw = (value or "").strip()
        if not raw:
            return ""
        return re.sub(r"[^0-9A-Za-z_.-]+", "_", raw)

    @staticmethod
    def _compose_file_stem(frame_id: str, filename_token: str) -> str:
        if not filename_token:
            return frame_id
        return f"{frame_id}_{filename_token}"

    @classmethod
    def _parse_frame_stem(cls, stem: str) -> tuple[str, str] | None:
        match = cls._FRAME_STEM_PATTERN.match(stem)
        if match is None:
            return None
        frame_id = match.group(1)
        filename_token = (match.group(2) or "").strip()
        return frame_id, filename_token

    @classmethod
    def _entry_sort_key(cls, entry: FrameCacheEntry) -> tuple[int, str]:
        token = entry.filename_token.strip()
        if token and cls._TIMESTAMP_TOKEN_PATTERN.match(token):
            return (0, f"{token}:{entry.path.name}")
        try:
            mtime_ns = entry.path.stat().st_mtime_ns
        except OSError:
            mtime_ns = 0
        return (1, f"{mtime_ns:020d}:{entry.path.name}")

    def _discover_next_sequence(self, target_dir: Path) -> int:
        max_sequence = 0
        if target_dir.exists():
            for path in target_dir.iterdir():
                if not path.is_file():
                    continue
                match = self._FRAME_NAME_PATTERN.match(path.stem)
                if not match:
                    continue
                max_sequence = max(max_sequence, int(match.group(1)))
        return max_sequence + 1

    def _update_signature_path(self, old_path: Path, new_path: Path) -> None:
        for signature in self._kept_signatures:
            if signature.path == old_path:
                signature.path = new_path
                return

    def _cleanup_empty_dirs(self, start_dir: Path) -> None:
        current = start_dir
        cache_root = self.cache_dir.resolve()
        while True:
            try:
                resolved = current.resolve()
            except Exception:
                break
            if resolved == cache_root:
                break
            try:
                next(current.iterdir())
                break
            except StopIteration:
                try:
                    current.rmdir()
                except OSError:
                    break
                current = current.parent
                continue
            except OSError:
                break
