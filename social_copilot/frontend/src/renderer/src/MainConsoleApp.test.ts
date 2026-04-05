import { describe, expect, it } from 'vitest'

import {
  assistantTimeoutMsToSeconds,
  assistantTimeoutSecondsToMs,
  captureSensitivityToScheme,
  formatCleanupResultMessage,
  chatRecordCaptureDedupWindowMsToSeconds,
  chatRecordCaptureDedupWindowSecondsToMs,
  normalizeCleanupRetentionHours
} from './MainConsoleApp'

describe('MainConsoleApp visual monitor helpers', () => {
  it('formats chat-record capture dedup window from milliseconds to seconds', () => {
    expect(chatRecordCaptureDedupWindowMsToSeconds(120000)).toBe(120)
    expect(chatRecordCaptureDedupWindowMsToSeconds(45000)).toBe(45)
  })

  it('parses chat-record capture dedup window from seconds to milliseconds', () => {
    expect(chatRecordCaptureDedupWindowSecondsToMs(120)).toBe(120000)
    expect(chatRecordCaptureDedupWindowSecondsToMs(45)).toBe(45000)
  })

  it('formats assistant timeout from milliseconds to seconds', () => {
    expect(assistantTimeoutMsToSeconds(30000)).toBe(30)
    expect(assistantTimeoutMsToSeconds(12000)).toBe(12)
  })

  it('parses assistant timeout from seconds to milliseconds', () => {
    expect(assistantTimeoutSecondsToMs(30)).toBe(30000)
    expect(assistantTimeoutSecondsToMs(12)).toBe(12000)
  })

  it('maps capture sensitivity selections to internal schemes', () => {
    expect(captureSensitivityToScheme('high')).toBe('legacy')
    expect(captureSensitivityToScheme('medium')).toBe('current')
    expect(captureSensitivityToScheme('low')).toBe('current')
  })

  it('normalizes cleanup retention hours with default and minimum fallback', () => {
    expect(normalizeCleanupRetentionHours('24')).toBe(24)
    expect(normalizeCleanupRetentionHours('0')).toBe(1)
    expect(normalizeCleanupRetentionHours('')).toBe(24)
  })

  it('formats cleanup result summary message', () => {
    const message = formatCleanupResultMessage({
      cutoffIso: '2026-04-05T00:00:00.000Z',
      chat: {
        scannedSessions: 3,
        deletedMessages: 8,
        deletedFiles: 1,
        errors: 0
      },
      cache: {
        scannedFiles: 5,
        deletedFiles: 2,
        deletedDirs: 1,
        errors: 0,
        skippedActiveRunDir: true
      }
    })

    expect(message).toContain('聊天记录删除 8 条消息')
    expect(message).toContain('缓存删除 2 个文件、1 个目录')
  })
})
