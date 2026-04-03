import { describe, expect, it } from 'vitest'

import {
  assistantTimeoutMsToSeconds,
  assistantTimeoutSecondsToMs,
  captureSensitivityToScheme,
  chatRecordCaptureDedupWindowMsToSeconds,
  chatRecordCaptureDedupWindowSecondsToMs
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
})
