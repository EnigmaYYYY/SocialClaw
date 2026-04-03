import { describe, expect, it } from 'vitest'

import {
  countVisibleWindowOverlap,
  normalizeTimeAnchorKey
} from './chat-records'

describe('chat record time anchors', () => {
  it('normalizes ISO timestamps to minute anchors', () => {
    expect(normalizeTimeAnchorKey('2026-03-03T10:00:05Z')).toBe('2026-03-03T10:00')
    expect(normalizeTimeAnchorKey('2026-03-03T10:00:59Z')).toBe('2026-03-03T10:00')
  })

  it('keeps capture fallback anchors distinct from exact anchors', () => {
    expect(normalizeTimeAnchorKey('capture_fallback:2026-03-03T10:00:05Z')).toBe(
      'capture_fallback:2026-03-03T10:00'
    )
    expect(normalizeTimeAnchorKey('capture_fallback:2026-03-03T10:00:05Z')).not.toBe(
      normalizeTimeAnchorKey('2026-03-03T10:00:05Z')
    )
  })

  it('counts suffix-prefix overlap for visible message windows', () => {
    expect(
      countVisibleWindowOverlap(
        [
          { sender: 'contact', text: 'C', timestamp: '2026-03-03T10:00:00Z' },
          { sender: 'contact', text: 'D', timestamp: '2026-03-03T10:01:00Z' },
          { sender: 'contact', text: 'E', timestamp: '2026-03-03T10:02:00Z' }
        ],
        [
          { sender: 'contact', text: 'C', timestamp: '2026-03-03T10:00:00Z' },
          { sender: 'contact', text: 'D', timestamp: '2026-03-03T10:01:00Z' },
          { sender: 'contact', text: 'E', timestamp: '2026-03-03T10:02:00Z' },
          { sender: 'contact', text: 'F', timestamp: '2026-03-03T10:03:00Z' }
        ]
      )
    ).toBe(3)
  })

  it('uses capture timestamps when one side lacks an explicit time anchor', () => {
    expect(
      countVisibleWindowOverlap(
        [
          {
            sender: 'contact',
            text: 'hello',
            timestamp: null,
            metadata: { capture_timestamp: '2026-03-03T10:00:00Z' }
          }
        ],
        [
          {
            sender: 'contact',
            text: 'hello',
            timestamp: '10:00',
            metadata: { capture_timestamp: '2026-03-03T10:01:00Z' }
          }
        ]
      )
    ).toBe(1)
  })

  it('treats capture-derived ISO anchors as the same message window across adjacent minutes', () => {
    expect(
      countVisibleWindowOverlap(
        [
          {
            sender: 'contact',
            text: 'hello',
            timestamp: '2026-03-03T10:00:59Z',
            metadata: { capture_timestamp: '2026-03-03T10:00:59Z' }
          }
        ],
        [
          {
            sender: 'contact',
            text: 'hello',
            timestamp: '2026-03-03T10:01:10Z',
            metadata: { capture_timestamp: '2026-03-03T10:01:10Z' }
          }
        ]
      )
    ).toBe(1)
  })
})
