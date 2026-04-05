import { describe, expect, it } from 'vitest'

import {
  type AppSettings,
  DEFAULT_APP_SETTINGS,
  deserializeAppSettings,
  serializeAppSettings,
} from './schemas'

describe('app settings schema', () => {
  it('preserves visual monitor tuning fields through serialization', () => {
    const settings = {
      ...DEFAULT_APP_SETTINGS,
      visualMonitor: {
        ...DEFAULT_APP_SETTINGS.visualMonitor,
        captureTuning: {
          hashSimilaritySkip: 0.993,
          ssimChange: 0.989,
          keptFrameDedupSimilarityThreshold: 0.965,
          chatRecordCaptureDedupWindowMs: 45000,
        },
      },
    }

    const roundTripped = deserializeAppSettings(serializeAppSettings(settings))

    expect(roundTripped.visualMonitor.captureTuning).toEqual({
      hashSimilaritySkip: 0.993,
      ssimChange: 0.989,
      keptFrameDedupSimilarityThreshold: 0.965,
      chatRecordCaptureDedupWindowMs: 45000,
    })
  })

  it('preserves visual monitor capture sensitivity and roi settings through serialization', () => {
    const settings: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      visualMonitor: {
        ...DEFAULT_APP_SETTINGS.visualMonitor,
        captureSensitivity: 'medium',
        captureScheme: 'current',
        captureScope: 'full_window',
        roiStrategy: 'manual',
        manualRoi: {
          x: 11,
          y: 22,
          w: 333,
          h: 444,
        },
        autoRoi: {
          coarseLeftRatio: 0.31,
          coarseTopRatio: 0.04,
          coarseWidthRatio: 0.66,
          coarseHeightRatio: 0.88,
        },
      },
    }

    const roundTripped = deserializeAppSettings(serializeAppSettings(settings))

    expect(roundTripped.visualMonitor).toMatchObject({
      captureSensitivity: 'medium',
      captureScheme: 'current',
      captureScope: 'full_window',
      roiStrategy: 'manual',
      manualRoi: {
        x: 11,
        y: 22,
        w: 333,
        h: 444,
      },
      autoRoi: {
        coarseLeftRatio: 0.31,
        coarseTopRatio: 0.04,
        coarseWidthRatio: 0.66,
        coarseHeightRatio: 0.88,
      },
    })
  })

  it('defaults missing visual monitor capture sensitivity to medium', () => {
    const legacyVisualMonitor = { ...DEFAULT_APP_SETTINGS.visualMonitor } as Record<string, unknown>
    delete legacyVisualMonitor.captureSensitivity

    const roundTripped = deserializeAppSettings(
      JSON.stringify({
        ...DEFAULT_APP_SETTINGS,
        visualMonitor: {
          ...legacyVisualMonitor,
          captureScheme: 'legacy'
        }
      })
    )

    expect(roundTripped.visualMonitor.captureSensitivity).toBe('medium')
    expect(roundTripped.visualMonitor.captureScheme).toBe('legacy')
  })

  it('preserves assistant timeout through serialization', () => {
    const settings = {
      ...DEFAULT_APP_SETTINGS,
      modelProviders: {
        ...DEFAULT_APP_SETTINGS.modelProviders,
        assistant: {
          ...DEFAULT_APP_SETTINGS.modelProviders.assistant,
          requestTimeoutMs: 30000,
        },
      },
    }

    const roundTripped = deserializeAppSettings(serializeAppSettings(settings))

    expect(roundTripped.modelProviders.assistant.requestTimeoutMs).toBe(30000)
  })

  it('preserves evermemos backfill chunk size through serialization', () => {
    const settings: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      evermemos: {
        ...DEFAULT_APP_SETTINGS.evermemos,
        backfillChunkSize: 20,
        backfillChunkTimeoutMs: 65000,
        backfillChunkMessageBudgetSeconds: 3,
        backfillMaxRetryPerChunk: 2,
        backfillMinChunkSize: 4,
      },
    }

    const roundTripped = deserializeAppSettings(serializeAppSettings(settings))

    expect(roundTripped.evermemos.backfillChunkSize).toBe(20)
    expect(roundTripped.evermemos.backfillChunkTimeoutMs).toBe(65000)
    expect(roundTripped.evermemos.backfillChunkMessageBudgetSeconds).toBe(3)
    expect(roundTripped.evermemos.backfillMaxRetryPerChunk).toBe(2)
    expect(roundTripped.evermemos.backfillMinChunkSize).toBe(4)
  })
})
