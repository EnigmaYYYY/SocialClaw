import { describe, expect, it } from 'vitest'

import { resolveFrameCacheRunDirState } from './visual-monitor-cache-run'

describe('resolveFrameCacheRunDirState', () => {
  it('reuses the same run directory across repeated idle config syncs', () => {
    const first = resolveFrameCacheRunDirState({
      currentRunDir: null,
      previousMonitorRunning: null,
      monitorRunning: false,
      cacheDir: '/tmp/cache',
      now: new Date('2026-03-31T21:10:12+08:00')
    })

    const second = resolveFrameCacheRunDirState({
      currentRunDir: first.runDir,
      previousMonitorRunning: first.monitorRunning,
      monitorRunning: false,
      cacheDir: '/tmp/cache',
      now: new Date('2026-03-31T21:10:13+08:00')
    })

    expect(second.runDir).toBe(first.runDir)
  })

  it('rotates the run directory after a running session stops', () => {
    const stopped = resolveFrameCacheRunDirState({
      currentRunDir: '/tmp/cache/monitor_frames_20260331_211144',
      previousMonitorRunning: true,
      monitorRunning: false,
      cacheDir: '/tmp/cache',
      now: new Date('2026-03-31T21:12:00+08:00')
    })

    expect(stopped.runDir).toBe('/tmp/cache/monitor_frames_20260331_211200')
  })
})
