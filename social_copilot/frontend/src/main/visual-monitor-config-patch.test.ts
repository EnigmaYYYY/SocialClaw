import { describe, expect, it } from 'vitest'

import { DEFAULT_APP_SETTINGS } from '../models/schemas'
import {
  buildVisualMonitorConfigPatchPayload,
  resolveCaptureSensitivityProfile,
} from './visual-monitor-config-patch'

describe('buildVisualMonitorConfigPatchPayload', () => {
  it('includes the assistant timeout in the monitor config patch', () => {
    const payload = buildVisualMonitorConfigPatchPayload({
      settings: {
        ...DEFAULT_APP_SETTINGS,
        modelProviders: {
          ...DEFAULT_APP_SETTINGS.modelProviders,
          assistant: {
            ...DEFAULT_APP_SETTINGS.modelProviders.assistant,
            requestTimeoutMs: 30000
          }
        }
      },
      runDir: '/tmp/cache/monitor_frames_20260331_230000'
    })

    expect(payload).toMatchObject({
      monitor: {
        assistant: {
          enabled: true,
          timeout_ms: 30000
        }
      }
    })
  })

  it('maps high sensitivity to the recall-first legacy capture profile', () => {
    const payload = buildVisualMonitorConfigPatchPayload({
      settings: {
        ...DEFAULT_APP_SETTINGS,
        visualMonitor: {
          ...DEFAULT_APP_SETTINGS.visualMonitor,
          captureSensitivity: 'high',
          captureScheme: 'legacy',
          captureScope: 'roi',
          roiStrategy: 'manual',
          manualRoi: {
            x: 10,
            y: 20,
            w: 300,
            h: 400
          }
        }
      },
      runDir: '/tmp/cache/monitor_frames_20260401_120000'
    })

    expect(payload).toMatchObject({
      monitor: {
        capture_scheme: 'legacy',
        capture_scope: 'roi',
        window_gate: {
          confirmation_samples: 1,
          confirmation_interval_ms: 0
        },
        fps: {
          idle: 4,
          active_min: 5,
          active_max: 6,
          burst: 7
        },
        roi_strategy: {
          mode: 'manual'
        },
        roi: {
          x: 10,
          y: 20,
          w: 300,
          h: 400
        },
        frame_cache: {
          cache_all_frames: false
        }
      }
    })
  })

  it('maps medium sensitivity to the balanced current capture profile', () => {
    const payload = buildVisualMonitorConfigPatchPayload({
      settings: {
        ...DEFAULT_APP_SETTINGS,
        visualMonitor: {
          ...DEFAULT_APP_SETTINGS.visualMonitor,
          captureSensitivity: 'medium',
          captureScheme: 'current',
          captureScope: 'full_window',
          roiStrategy: 'hybrid',
          manualRoi: {
            x: 10,
            y: 20,
            w: 300,
            h: 400
          }
        }
      },
      runDir: '/tmp/cache/monitor_frames_20260401_120000'
    })

    expect(payload).toMatchObject({
      monitor: {
        capture_scheme: 'current',
        capture_scope: 'full_window',
        window_gate: {
          confirmation_samples: 1,
          confirmation_interval_ms: 0
        },
        fps: {
          idle: 2,
          active_min: 4,
          active_max: 5,
          burst: 6
        },
        frame_cache: {
          cache_all_frames: true
        }
      }
    })
    expect((payload.monitor as Record<string, unknown>).roi).toBeUndefined()
  })

  it('maps low sensitivity to the conservative current capture profile', () => {
    const payload = buildVisualMonitorConfigPatchPayload({
      settings: {
        ...DEFAULT_APP_SETTINGS,
        visualMonitor: {
          ...DEFAULT_APP_SETTINGS.visualMonitor,
          captureSensitivity: 'low',
          captureScheme: 'current',
        }
      },
      runDir: '/tmp/cache/monitor_frames_20260401_120000'
    })

    expect(payload).toMatchObject({
      monitor: {
        capture_scheme: 'current',
        window_gate: {
          confirmation_samples: 2,
          confirmation_interval_ms: 80
        },
        fps: {
          idle: 1,
          active_min: 3,
          active_max: 4,
          burst: 5
        }
      }
    })
  })

  it('enables debug screenshot mode without caching skipped raw frames', () => {
    const payload = buildVisualMonitorConfigPatchPayload({
      settings: {
        ...DEFAULT_APP_SETTINGS,
        visualMonitor: {
          ...DEFAULT_APP_SETTINGS.visualMonitor,
          testingMode: true
        }
      },
      runDir: '/tmp/cache/monitor_frames_20260402_120000'
    })

    expect(payload).toMatchObject({
      monitor: {
        frame_cache: {
          testing_mode: true,
          cache_all_frames: false,
          keep_processed_frames: true
        }
      }
    })
  })

  it('exposes stable sensitivity profiles for the settings UI', () => {
    expect(resolveCaptureSensitivityProfile('high')).toMatchObject({
      captureScheme: 'legacy',
      fps: { idle: 4, active_min: 5, active_max: 6, burst: 7 }
    })
    expect(resolveCaptureSensitivityProfile('medium')).toMatchObject({
      captureScheme: 'current',
      fps: { idle: 2, active_min: 4, active_max: 5, burst: 6 }
    })
    expect(resolveCaptureSensitivityProfile('low')).toMatchObject({
      captureScheme: 'current',
      fps: { idle: 1, active_min: 3, active_max: 4, burst: 5 }
    })
  })

  it('keeps a meaningful capture gap between high, medium, and low sensitivity', () => {
    const high = resolveCaptureSensitivityProfile('high')
    const medium = resolveCaptureSensitivityProfile('medium')
    const low = resolveCaptureSensitivityProfile('low')

    expect(high.captureScheme).toBe('legacy')
    expect(medium.captureScheme).toBe('current')
    expect(low.captureScheme).toBe('current')
    expect(high.fps.idle).toBeGreaterThan(medium.fps.idle)
    expect(high.fps.active_min).toBeGreaterThan(medium.fps.active_min)
    expect(high.fps.active_max).toBeGreaterThan(medium.fps.active_max)
    expect(medium.fps.active_min).toBeGreaterThanOrEqual(low.fps.active_min)
    expect(medium.defaultWindowGate.confirmationSamples).toBeLessThan(low.defaultWindowGate.confirmationSamples)
  })
})
