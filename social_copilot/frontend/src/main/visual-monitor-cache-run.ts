import { join } from 'path'

export interface FrameCacheRunDirStateInput {
  currentRunDir: string | null
  previousMonitorRunning: boolean | null
  monitorRunning: boolean
  cacheDir: string
  now: Date
}

export interface FrameCacheRunDirState {
  runDir: string
  monitorRunning: boolean
}

export function resolveFrameCacheRunDirState(input: FrameCacheRunDirStateInput): FrameCacheRunDirState {
  const shouldRotate = input.previousMonitorRunning === true && input.monitorRunning === false
  const currentRunDir = shouldRotate ? null : input.currentRunDir
  const runDir = currentRunDir ?? join(input.cacheDir, `monitor_frames_${formatTimeStampForPath(input.now)}`)
  return {
    runDir,
    monitorRunning: input.monitorRunning
  }
}

function formatTimeStampForPath(date: Date): string {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${yyyy}${mm}${dd}_${hh}${min}${ss}`
}
