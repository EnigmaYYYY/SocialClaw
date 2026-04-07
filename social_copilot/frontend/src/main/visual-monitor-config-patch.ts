import type { AppSettings } from '../models/schemas'

const ASSISTANT_TIMEOUT_MIN_MS = 1000
const ASSISTANT_TIMEOUT_MAX_MS = 120000
const ASSISTANT_TIMEOUT_DEFAULT_MS = 30000
const DEFAULT_CONFIRMATION_SAMPLES = 3
const DEFAULT_CONFIRMATION_INTERVAL_MS = 120

type CaptureSensitivityProfile = {
  captureScheme: AppSettings['visualMonitor']['captureScheme']
  fps: {
    idle: number
    active_min: number
    active_max: number
    burst: number
  }
  defaultWindowGate: {
    confirmationSamples: number
    confirmationIntervalMs: number
  }
}

export function resolveCaptureSensitivityProfile(
  captureSensitivity: AppSettings['visualMonitor']['captureSensitivity']
): CaptureSensitivityProfile {
  if (captureSensitivity === 'high') {
    return {
      captureScheme: 'legacy',
      fps: {
        idle: 4,
        active_min: 5,
        active_max: 6,
        burst: 7
      },
      defaultWindowGate: {
        confirmationSamples: 1,
        confirmationIntervalMs: 0
      }
    }
  }
  if (captureSensitivity === 'medium') {
    return {
      captureScheme: 'current',
      fps: {
        idle: 2,
        active_min: 4,
        active_max: 5,
        burst: 6
      },
      defaultWindowGate: {
        confirmationSamples: 1,
        confirmationIntervalMs: 0
      }
    }
  }
  return {
    captureScheme: 'current',
    fps: {
      idle: 1,
      active_min: 3,
      active_max: 4,
      burst: 5
    },
    defaultWindowGate: {
      confirmationSamples: 2,
      confirmationIntervalMs: 80
    }
  }
}

function resolveCaptureFps(profile: CaptureSensitivityProfile): {
  idle: number
  active_min: number
  active_max: number
  burst: number
} {
  return profile.fps
}

function resolveWindowGateTuning(options: {
  profile: CaptureSensitivityProfile
  confirmationSamples: number
  confirmationIntervalMs: number
}): { confirmationSamples: number; confirmationIntervalMs: number } {
  const { profile, confirmationSamples, confirmationIntervalMs } = options
  if (
    confirmationSamples === DEFAULT_CONFIRMATION_SAMPLES
    && confirmationIntervalMs === DEFAULT_CONFIRMATION_INTERVAL_MS
  ) {
    return profile.defaultWindowGate
  }
  return {
    confirmationSamples,
    confirmationIntervalMs
  }
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback
  }
  return Math.min(max, Math.max(min, value))
}

export function buildVisualMonitorConfigPatchPayload(options: {
  settings: AppSettings
  runDir: string
}): Record<string, unknown> {
  const { settings, runDir } = options
  const assistantProvider = settings.modelProviders.assistant
  const visionProvider = settings.modelProviders.vision
  const testingMode = settings.visualMonitor.testingMode
  const captureSensitivity = settings.visualMonitor.captureSensitivity
  const captureScope = settings.visualMonitor.captureScope
  const roiStrategy = settings.visualMonitor.roiStrategy
  const manualRoi = settings.visualMonitor.manualRoi
  const autoRoi = settings.visualMonitor.autoRoi
  const windowGate = settings.visualMonitor.windowGate
  const captureTuning = settings.visualMonitor.captureTuning
  const monitoredAppName = settings.visualMonitor.monitoredAppName?.trim() || 'WeChat'
  const captureProfile = resolveCaptureSensitivityProfile(captureSensitivity)
  const captureScheme = captureProfile.captureScheme
  const confirmationSamples = Math.round(
    clampNumber(windowGate.confirmationSamples, 1, 5, DEFAULT_CONFIRMATION_SAMPLES)
  )
  const confirmationIntervalMs = Math.round(
    clampNumber(windowGate.confirmationIntervalMs, 0, 500, DEFAULT_CONFIRMATION_INTERVAL_MS)
  )
  const effectiveWindowGate = resolveWindowGateTuning({
    profile: captureProfile,
    confirmationSamples,
    confirmationIntervalMs
  })
  const effectiveFps = resolveCaptureFps(captureProfile)
  const hashSimilaritySkip = clampNumber(captureTuning.hashSimilaritySkip, 0, 1, 0.99)
  const ssimChange = clampNumber(captureTuning.ssimChange, 0, 1, 0.985)
  const keptFrameDedupSimilarityThreshold = clampNumber(
    captureTuning.keptFrameDedupSimilarityThreshold,
    0,
    1,
    0.99
  )
  const coarseLeftRatio = clampNumber(autoRoi.coarseLeftRatio, 0, 1, 0.27)
  const coarseTopRatio = clampNumber(autoRoi.coarseTopRatio, 0, 1, 0)
  const coarseWidthRatio = clampNumber(autoRoi.coarseWidthRatio, 0.1, 1, 0.71)
  const coarseHeightRatio = clampNumber(autoRoi.coarseHeightRatio, 0.1, 1, 0.92)
  const assistantTimeoutMs = Math.round(
    clampNumber(
      assistantProvider.requestTimeoutMs,
      ASSISTANT_TIMEOUT_MIN_MS,
      ASSISTANT_TIMEOUT_MAX_MS,
      ASSISTANT_TIMEOUT_DEFAULT_MS
    )
  )

  const payload: Record<string, unknown> = {
    monitor: {
      capture_scheme: captureScheme,
      capture_scope: captureScope,
      capture_exclusion_regions: [],
      window_gate: {
        enabled: true,
        app_name: monitoredAppName,
        foreground_settle_seconds: 0.0,
        confirmation_samples: effectiveWindowGate.confirmationSamples,
        confirmation_interval_ms: effectiveWindowGate.confirmationIntervalMs
      },
      roi_strategy: {
        mode: roiStrategy,
        auto: {
          coarse_left_ratio: coarseLeftRatio,
          coarse_top_ratio: coarseTopRatio,
          coarse_width_ratio: coarseWidthRatio,
          coarse_height_ratio: coarseHeightRatio
        }
      },
      fps: effectiveFps,
      thresholds: {
        hash_similarity_skip: hashSimilaritySkip,
        ssim_change: ssimChange
      },
      vision: {
        mode: 'vlm_structured',
        strict_only: true,
        litellm: {
          enabled: true,
          base_url: visionProvider.baseUrl,
          model: visionProvider.modelName,
          api_key: visionProvider.apiKey,
          max_tokens: visionProvider.maxTokens,
          disable_thinking: visionProvider.disableThinking
        }
      },
      frame_cache: {
        enabled: true,
        cache_dir: runDir,
        testing_mode: testingMode,
        cache_all_frames: testingMode ? false : captureScheme === 'current',
        keep_processed_frames: true,
        deduplicate_kept_frames: true,
        dedup_similarity_threshold: keptFrameDedupSimilarityThreshold,
        max_kept_frames: 0
      },
      assistant: {
        enabled: true,
        base_url: assistantProvider.baseUrl,
        model: assistantProvider.modelName,
        api_key: assistantProvider.apiKey,
        timeout_ms: assistantTimeoutMs
      }
    }
  }

  if (captureScope === 'roi' && roiStrategy === 'manual' && manualRoi) {
    ;(payload.monitor as Record<string, unknown>).roi = {
      x: manualRoi.x,
      y: manualRoi.y,
      w: manualRoi.w,
      h: manualRoi.h
    }
  }

  return payload
}
