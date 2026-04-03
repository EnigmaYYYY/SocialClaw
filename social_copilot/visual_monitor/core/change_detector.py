from __future__ import annotations

import hashlib
from dataclasses import dataclass


@dataclass(slots=True)
class ChangeDecision:
    changed: bool
    similarity_score: float
    reason: str


class ChangeDetector:
    """Three-stage frame change detector.

    Stage 1: blake2b digest similarity (fast byte-level check)
    Stage 0.5: localized-motion suppression for tiny animated regions
    Stage 2: average perceptual hash on downscaled grayscale (spatial awareness)
    Stage 3: byte histogram similarity (distribution-level check)

    Stages are ordered by computational cost.  If any stage reports high
    similarity the frame is considered unchanged.
    """

    def __init__(
        self,
        hash_similarity_skip: float = 0.99,
        histogram_similarity_skip: float = 0.985,
        phash_similarity_skip: float = 0.96,
        phash_size: int = 8,
        enable_phash: bool = False,
        skip_near_duplicate_frames: bool = True,
        localized_motion_ratio_skip: float = 0.03,
        localized_motion_min_pixels: int = 1024,
    ) -> None:
        self.hash_similarity_skip = hash_similarity_skip
        self.histogram_similarity_skip = histogram_similarity_skip
        self.phash_similarity_skip = phash_similarity_skip
        self._phash_size = max(4, min(32, phash_size))
        self.enable_phash = enable_phash
        self.skip_near_duplicate_frames = skip_near_duplicate_frames
        self.localized_motion_ratio_skip = max(0.0, min(1.0, localized_motion_ratio_skip))
        self.localized_motion_min_pixels = max(0, int(localized_motion_min_pixels))

    def detect(self, previous_frame: bytes | None, current_frame: bytes) -> ChangeDecision:
        if previous_frame is None:
            return ChangeDecision(changed=True, similarity_score=0.0, reason="no_previous")
        if previous_frame == current_frame:
            return ChangeDecision(changed=False, similarity_score=1.0, reason="hash_skip")
        localized_motion_ratio = self._pixel_change_ratio(previous_frame, current_frame)
        if (
            localized_motion_ratio is not None
            and localized_motion_ratio > 0.0
            and localized_motion_ratio <= self.localized_motion_ratio_skip
        ):
            return ChangeDecision(
                changed=False,
                similarity_score=1.0 - localized_motion_ratio,
                reason="localized_motion_skip",
            )
        if not self.skip_near_duplicate_frames:
            return ChangeDecision(changed=True, similarity_score=0.0, reason="near_duplicate_forced_process")

        # Stage 1: cryptographic digest — extremely fast, catches identical content
        hash_similarity = self._digest_similarity(previous_frame, current_frame)
        if hash_similarity >= self.hash_similarity_skip:
            return ChangeDecision(changed=False, similarity_score=hash_similarity, reason="hash_skip")

        # Stage 2: perceptual hash — spatial structure awareness
        #   Catches cases where bytes differ but visual content is the same
        #   (e.g. anti-aliasing noise, minor compression artifacts).
        #   Skip when digest already indicates extreme difference (uniform frames).
        if self.enable_phash and hash_similarity > 0.5 and len(previous_frame) == len(current_frame):
            phash_sim = self._phash_similarity(previous_frame, current_frame)
            if phash_sim >= self.phash_similarity_skip:
                return ChangeDecision(changed=False, similarity_score=phash_sim, reason="phash_skip")

        # Stage 3: histogram — byte distribution check
        hist_similarity = self._histogram_similarity(previous_frame, current_frame)
        if hist_similarity >= self.histogram_similarity_skip:
            return ChangeDecision(changed=False, similarity_score=hist_similarity, reason="hist_skip")

        return ChangeDecision(changed=True, similarity_score=hist_similarity, reason="hist_change")

    @staticmethod
    def _digest_similarity(first: bytes, second: bytes) -> float:
        digest_a = hashlib.blake2b(first, digest_size=16).digest()
        digest_b = hashlib.blake2b(second, digest_size=16).digest()
        xor_bits = int.from_bytes(digest_a, byteorder="big") ^ int.from_bytes(digest_b, byteorder="big")
        hamming = xor_bits.bit_count()
        total_bits = len(digest_a) * 8
        return 1.0 - (hamming / float(total_bits))

    def _pixel_change_ratio(self, first: bytes, second: bytes) -> float | None:
        if len(first) != len(second) or len(first) < 3:
            return None
        pixel_count = min(len(first), len(second)) // 3
        if pixel_count <= 0:
            return None
        if pixel_count < self.localized_motion_min_pixels:
            return None
        changed_pixels = 0
        for idx in range(0, pixel_count * 3, 3):
            if first[idx:idx + 3] != second[idx:idx + 3]:
                changed_pixels += 1
        return changed_pixels / float(pixel_count)

    def _phash_similarity(self, first: bytes, second: bytes) -> float:
        """Compute average perceptual hash similarity between two raw RGB frames."""
        hash_a = self._compute_phash(first)
        hash_b = self._compute_phash(second)
        if hash_a is None or hash_b is None:
            return 0.0
        return self._hamming_similarity(hash_a, hash_b)

    def _compute_phash(self, raw_rgb: bytes) -> int | None:
        """Compute average-hash for raw RGB pixel data.

        Assumes the data is a flat row-major RGB buffer where pixel count
        can be inferred from length.  Falls back to a width of sqrt(pixels)
        if the aspect ratio is unknown.
        """
        n_bytes = len(raw_rgb)
        if n_bytes < 3:
            return None
        n_pixels = n_bytes // 3
        if n_pixels < self._phash_size * self._phash_size:
            return None

        # Determine frame dimensions — assume square-ish layout
        import math
        approx_w = int(math.isqrt(n_pixels))
        if approx_w < self._phash_size:
            return None
        approx_h = n_pixels // approx_w

        size = self._phash_size
        # Sample grid to produce size x size grayscale values
        grays: list[int] = []
        for oy in range(size):
            src_y = min(approx_h - 1, int((oy + 0.5) * approx_h / size))
            row_offset = src_y * approx_w * 3
            for ox in range(size):
                src_x = min(approx_w - 1, int((ox + 0.5) * approx_w / size))
                idx = row_offset + src_x * 3
                if idx + 2 >= n_bytes:
                    return None
                r, g, b = raw_rgb[idx], raw_rgb[idx + 1], raw_rgb[idx + 2]
                grays.append((r * 299 + g * 587 + b * 114) // 1000)

        if not grays:
            return None
        avg = sum(grays) / len(grays)
        # Pack bits into an integer
        bits = 0
        for val in grays:
            bits = (bits << 1) | (1 if val >= avg else 0)
        return bits

    @staticmethod
    def _hamming_similarity(hash_a: int, hash_b: int) -> float:
        xor = hash_a ^ hash_b
        hamming = xor.bit_count()
        # Total bits = number of bits needed to represent either hash
        max_bits = max(hash_a.bit_length(), hash_b.bit_length(), 1)
        return 1.0 - (hamming / float(max_bits))

    @staticmethod
    def _histogram_similarity(first: bytes, second: bytes) -> float:
        hist_a = [0] * 256
        hist_b = [0] * 256

        for value in first:
            hist_a[value] += 1
        for value in second:
            hist_b[value] += 1

        total_a = max(len(first), 1)
        total_b = max(len(second), 1)
        distance = 0.0
        for idx in range(256):
            distance += abs((hist_a[idx] / total_a) - (hist_b[idx] / total_b))

        # L1 distance for two distributions is in [0, 2].
        similarity = 1.0 - min(distance / 2.0, 1.0)
        return similarity
