import { describe, expect, it } from 'vitest'
import {
  chunkBackfillMessages,
  computeBackfillChunkTimeoutMs,
  mergeBackfillProgress,
  selectBackfillMessages,
  summarizeBackfillSession
} from './profile-backfill'

describe('selectBackfillMessages', () => {
  it('returns the full session when a full rebuild is requested', () => {
    const messages = selectBackfillMessages(
      {
        sessionKey: '微信::老聊天',
        recentMessages: [
          { sender: 'contact', text: 'a', contact_name: 'A', conversation_title: '老聊天', window_id: '微信', session_key: '微信::老聊天', timestamp: '2026-01-01T00:00:00Z' },
          { sender: 'user', text: 'b', contact_name: 'A', conversation_title: '老聊天', window_id: '微信', session_key: '微信::老聊天', timestamp: '2026-01-01T00:01:00Z' }
        ]
      },
      {
        forceFullRebuild: true,
        deletedSessionKeys: new Set(['微信::老聊天']),
        sessionBackfillProgress: { '微信::老聊天': '2026-01-01T00:02:00Z' }
      }
    )

    expect(messages.map((item) => item.text)).toEqual(['a', 'b'])
  })

  it('skips deleted sessions during incremental backfill', () => {
    const messages = selectBackfillMessages(
      {
        sessionKey: '微信::老聊天',
        recentMessages: [
          { sender: 'contact', text: 'a', contact_name: 'A', conversation_title: '老聊天', window_id: '微信', session_key: '微信::老聊天', timestamp: '2026-01-01T00:00:00Z' }
        ]
      },
      {
        deletedSessionKeys: new Set(['微信::老聊天'])
      }
    )

    expect(messages).toHaveLength(0)
  })

  it('filters incremental backfill by last processed timestamp', () => {
    const messages = selectBackfillMessages(
      {
        sessionKey: '微信::老聊天',
        recentMessages: [
          { sender: 'contact', text: 'a', contact_name: 'A', conversation_title: '老聊天', window_id: '微信', session_key: '微信::老聊天', timestamp: '2026-01-01T00:00:00Z' },
          { sender: 'contact', text: 'b', contact_name: 'A', conversation_title: '老聊天', window_id: '微信', session_key: '微信::老聊天', timestamp: '2026-01-02T00:00:00Z' }
        ]
      },
      {
        sessionBackfillProgress: { '微信::老聊天': '2026-01-01T12:00:00Z' }
      }
    )

    expect(messages.map((item) => item.text)).toEqual(['b'])
  })
})

describe('mergeBackfillProgress', () => {
  it('keeps existing progress while applying updated timestamps', () => {
    expect(
      mergeBackfillProgress(
        {
          '微信::老聊天': '2026-01-01T00:00:00Z'
        },
        {
          '微信::老聊天': '2026-01-02T00:00:00Z',
          '微信::新聊天': '2026-01-03T00:00:00Z'
        }
      )
    ).toEqual({
      '微信::老聊天': '2026-01-02T00:00:00Z',
      '微信::新聊天': '2026-01-03T00:00:00Z'
    })
  })
})

describe('chunkBackfillMessages', () => {
  it('splits large histories into deterministic 100-message batches', () => {
    const messages = Array.from({ length: 205 }, (_, index) => ({
      sender: 'contact' as const,
      text: `m-${index + 1}`,
      contact_name: 'A',
      conversation_title: '老聊天',
      window_id: '微信',
      session_key: '微信::老聊天',
      timestamp: `2026-01-01T00:${String(index).padStart(2, '0')}:00Z`
    }))

    const chunks = chunkBackfillMessages(messages, 100)
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toHaveLength(100)
    expect(chunks[1]).toHaveLength(100)
    expect(chunks[2]).toHaveLength(5)
    expect(chunks[0]?.[0]?.text).toBe('m-1')
    expect(chunks[2]?.[4]?.text).toBe('m-205')
  })
})

describe('computeBackfillChunkTimeoutMs', () => {
  it('scales timeout with chunk size for historical backfill', () => {
    expect(computeBackfillChunkTimeoutMs(12_000, 10, 3)).toBe(30_000)
    expect(computeBackfillChunkTimeoutMs(12_000, 20, 3)).toBe(60_000)
  })

  it('respects an explicitly larger base timeout and user-provided message budget', () => {
    expect(computeBackfillChunkTimeoutMs(120_000, 10, 3)).toBe(120_000)
    expect(computeBackfillChunkTimeoutMs(12_000, 20, 5)).toBe(100_000)
  })
})

describe('summarizeBackfillSession', () => {
  it('reports pending message counts using incremental progress', () => {
    const summary = summarizeBackfillSession(
      {
        sessionKey: '微信::老聊天',
        sessionName: '老聊天',
        updatedAt: '2026-01-02T00:00:00Z',
        messageCount: 3,
        recentMessages: [
          { sender: 'contact', text: 'a', contact_name: 'A', conversation_title: '老聊天', window_id: '微信', session_key: '微信::老聊天', timestamp: '2026-01-01T00:00:00Z' },
          { sender: 'contact', text: 'b', contact_name: 'A', conversation_title: '老聊天', window_id: '微信', session_key: '微信::老聊天', timestamp: '2026-01-02T00:00:00Z' },
          { sender: 'contact', text: 'c', contact_name: 'A', conversation_title: '老聊天', window_id: '微信', session_key: '微信::老聊天', timestamp: '2026-01-03T00:00:00Z' }
        ]
      },
      {
        sessionBackfillProgress: { '微信::老聊天': '2026-01-02T12:00:00Z' }
      }
    )

    expect(summary).toEqual({
      sessionKey: '微信::老聊天',
      sessionName: '老聊天',
      messageCount: 3,
      pendingMessageCount: 1,
      updatedAt: '2026-01-02T00:00:00Z',
      lastProcessedTimestamp: '2026-01-02T12:00:00Z'
    })
  })
})
