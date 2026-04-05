import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RealtimeSuggestionAdapter } from './realtime-suggestion-adapter'

function jsonResponse(payload: unknown, status: number = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  } as Response
}

describe('RealtimeSuggestionAdapter stop behavior', () => {
  const ingestAndGetRecent = vi.fn()
  const getRecentSessionMessages = vi.fn()

  beforeEach(() => {
    ingestAndGetRecent.mockReset()
    getRecentSessionMessages.mockReset()
    ingestAndGetRecent.mockResolvedValue({
      currentSession: {
        sessionKey: '微信::测试会话',
        sessionName: '测试会话',
        filePath: '/tmp/chat_records/test.md',
        recentMessages: []
      },
      latestUpdatedSession: {
        sessionKey: '微信::测试会话',
        sessionName: '测试会话',
        filePath: '/tmp/chat_records/test.md',
        recentMessages: []
      },
      updatedSessions: [
        {
          sessionKey: '微信::测试会话',
          sessionName: '测试会话',
          filePath: '/tmp/chat_records/test.md',
          appendedCount: 1
        }
      ]
    })
    getRecentSessionMessages.mockResolvedValue({
      sessionKey: '微信::测试会话',
      sessionName: '测试会话',
      filePath: '/tmp/chat_records/test.md',
      recentMessages: []
    })

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        electronAPI: {
          settings: {
            load: vi.fn().mockResolvedValue({
              visualMonitor: { apiBaseUrl: 'http://127.0.0.1:18777' },
              evermemos: { enabled: false }
            })
          },
          hotRun: {
            updateSettings: vi.fn().mockResolvedValue(undefined)
          },
          assistantWindow: {
            syncExclusion: vi.fn().mockResolvedValue(undefined)
          },
          chatRecords: {
            ingestAndGetRecent,
            getRecentSessionMessages
          },
          profile: {
            loadUser: vi.fn().mockResolvedValue(null),
            loadContact: vi.fn().mockResolvedValue(null)
          },
          profileAdmin: {
            updateBackfillProgress: vi.fn().mockResolvedValue(undefined)
          }
        }
      }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('drains pending monitor events into chat records before monitoring goes idle', async () => {
    const debugPayloads = [
      {
        running: true,
        pipeline: {
          last_frontmost_app: 'WeChat',
          per_session_inflight: {}
        }
      },
      {
        running: false,
        pipeline: {
          last_frontmost_app: 'WeChat',
          per_session_inflight: {}
        }
      },
      {
        running: false,
        pipeline: {
          last_frontmost_app: 'WeChat',
          per_session_inflight: {}
        }
      }
    ]
    const eventPayloads = [
      { count: 0, events: [] },
      {
        count: 1,
        events: [
          {
            sender: 'contact',
            text: '新消息',
            session_key: '微信::测试会话',
            conversation_title: '测试会话',
            timestamp: '2026-04-02T09:00:00Z',
            event_id: 'e_1',
            frame_id: 'f_000001'
          }
        ]
      },
      { count: 0, events: [] }
    ]

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/monitor/start')) {
        return jsonResponse({ running: true })
      }
      if (url.endsWith('/monitor/stop')) {
        expect(init?.method).toBe('POST')
        return jsonResponse({ running: false })
      }
      if (url.includes('/events/poll')) {
        const next = eventPayloads.shift()
        return jsonResponse(next ?? { count: 0, events: [] })
      }
      if (url.endsWith('/monitor/debug')) {
        const next = debugPayloads.shift()
        return jsonResponse(next ?? { running: false, pipeline: { per_session_inflight: {} } })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new RealtimeSuggestionAdapter({ pollIntervalMs: 10_000 })

    await adapter.start()
    await adapter.stopMonitoring()
    await (adapter as unknown as { tick: () => Promise<void> }).tick()

    expect(ingestAndGetRecent).toHaveBeenCalledTimes(1)
    expect(ingestAndGetRecent).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          text: '新消息',
          session_key: '微信::测试会话',
          conversation_title: '测试会话'
        })
      ],
      10
    )

    await adapter.stop()
  })

  it('keeps polling backlog events after stop-monitoring without generating new suggestions', async () => {
    const debugPayloads = [
      {
        running: true,
        pipeline: {
          last_frontmost_app: 'WeChat',
          per_session_inflight: { '微信::测试会话': 2 }
        }
      },
      {
        running: false,
        pipeline: {
          last_frontmost_app: 'WeChat',
          per_session_inflight: { '微信::测试会话': 1 }
        }
      },
      {
        running: false,
        pipeline: {
          last_frontmost_app: 'WeChat',
          per_session_inflight: {}
        }
      }
    ]
    const eventPayloads = [
      { count: 0, events: [] },
      {
        count: 1,
        events: [
          {
            sender: 'contact',
            text: '停止后补到的消息',
            session_key: '微信::测试会话',
            conversation_title: '测试会话',
            timestamp: '2026-04-02T09:05:00Z',
            event_id: 'e_stop_1',
            frame_id: 'f_stop_1'
          }
        ]
      }
    ]

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/monitor/start')) {
        return jsonResponse({ running: true })
      }
      if (url.endsWith('/monitor/stop')) {
        expect(init?.method).toBe('POST')
        return jsonResponse({ running: false })
      }
      if (url.includes('/events/poll')) {
        return jsonResponse(eventPayloads.shift() ?? { count: 0, events: [] })
      }
      if (url.endsWith('/monitor/debug')) {
        return jsonResponse(debugPayloads.shift() ?? {
          running: false,
          pipeline: { last_frontmost_app: 'WeChat', per_session_inflight: {} }
        })
      }
      if (url.endsWith('/assistant/suggestions')) {
        return jsonResponse({ count: 0, suggestions: [] })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new RealtimeSuggestionAdapter({ pollIntervalMs: 10_000 })

    await adapter.start()
    await adapter.stopMonitoring()
    await (adapter as unknown as { tick: () => Promise<void> }).tick()
    await (adapter as unknown as { tick: () => Promise<void> }).tick()

    expect(ingestAndGetRecent).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          text: '停止后补到的消息',
          session_key: '微信::测试会话'
        })
      ],
      10
    )
    expect(fetchMock).not.toHaveBeenCalledWith(
      'http://127.0.0.1:18777/assistant/suggestions',
      expect.objectContaining({ method: 'POST' })
    )

    await adapter.stop()
  })

  it('still posts monitor stop when settings were not preloaded', async () => {
    let debugCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/monitor/stop')) {
        expect(init?.method).toBe('POST')
        return jsonResponse({ running: false })
      }
      if (url.includes('/events/poll')) {
        return jsonResponse({ count: 0, events: [] })
      }
      if (url.endsWith('/monitor/debug')) {
        debugCalls += 1
        return jsonResponse({
          running: false,
          pipeline: { last_frontmost_app: 'WeChat', per_session_inflight: {} }
        })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new RealtimeSuggestionAdapter()
    await adapter.stopMonitoring()

    expect(window.electronAPI.settings.load).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18777/monitor/stop',
      expect.objectContaining({ method: 'POST' })
    )
    expect(debugCalls).toBeGreaterThanOrEqual(1)
  })
})

describe('RealtimeSuggestionAdapter suggestion flow', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        electronAPI: {
          settings: {
            load: vi.fn().mockResolvedValue({
              visualMonitor: { apiBaseUrl: 'http://127.0.0.1:18777' },
              evermemos: { enabled: false }
            })
          },
          hotRun: {
            updateSettings: vi.fn().mockResolvedValue(undefined)
          },
          assistantWindow: {
            syncExclusion: vi.fn().mockResolvedValue(undefined)
          },
          chatRecords: {
            ingestAndGetRecent: vi.fn(),
            getRecentSessionMessages: vi.fn()
          },
          profile: {
            loadUser: vi.fn().mockResolvedValue(null),
            loadContact: vi.fn().mockResolvedValue(null)
          },
          profileAdmin: {
            updateBackfillProgress: vi.fn().mockResolvedValue(undefined)
          }
        }
      }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('automatically generates the next suggestion round after new messages arrive', async () => {
    const ingestAndGetRecent = window.electronAPI.chatRecords.ingestAndGetRecent as unknown as ReturnType<typeof vi.fn>
    ingestAndGetRecent
      .mockResolvedValueOnce({
        currentSession: {
          sessionKey: '微信::测试会话',
          sessionName: '测试会话',
          filePath: '/tmp/chat_records/test.json',
          recentMessages: [
            {
              message_id: 'm_1',
              conversation_id: '微信::测试会话',
              sender_id: 'alice',
              sender_name: 'Alice',
              sender_type: 'contact',
              content: '第一条',
              timestamp: '2026-04-02T09:00:00Z',
              content_type: 'text',
              reply_to: null,
              quoted_message: null,
              metadata: {
                window_id: '微信',
                non_text_description: null,
                event_id: 'e_1',
                frame_id: 'f_1'
              }
            }
          ]
        },
        latestUpdatedSession: {
          sessionKey: '微信::测试会话',
          sessionName: '测试会话',
          filePath: '/tmp/chat_records/test.json',
          recentMessages: [
            {
              message_id: 'm_1',
              conversation_id: '微信::测试会话',
              sender_id: 'alice',
              sender_name: 'Alice',
              sender_type: 'contact',
              content: '第一条',
              timestamp: '2026-04-02T09:00:00Z',
              content_type: 'text',
              reply_to: null,
              quoted_message: null,
              metadata: {
                window_id: '微信',
                non_text_description: null,
                event_id: 'e_1',
                frame_id: 'f_1'
              }
            }
          ]
        },
        updatedSessions: [
          {
            sessionKey: '微信::测试会话',
            sessionName: '测试会话',
            filePath: '/tmp/chat_records/test.json',
            appendedCount: 1
          }
        ]
      })
      .mockResolvedValueOnce({
        currentSession: {
          sessionKey: '微信::测试会话',
          sessionName: '测试会话',
          filePath: '/tmp/chat_records/test.json',
          recentMessages: [
            {
              message_id: 'm_1',
              conversation_id: '微信::测试会话',
              sender_id: 'alice',
              sender_name: 'Alice',
              sender_type: 'contact',
              content: '第一条',
              timestamp: '2026-04-02T09:00:00Z',
              content_type: 'text',
              reply_to: null,
              quoted_message: null,
              metadata: {
                window_id: '微信',
                non_text_description: null,
                event_id: 'e_1',
                frame_id: 'f_1'
              }
            },
            {
              message_id: 'm_2',
              conversation_id: '微信::测试会话',
              sender_id: 'alice',
              sender_name: 'Alice',
              sender_type: 'contact',
              content: '第二条',
              timestamp: '2026-04-02T09:01:00Z',
              content_type: 'text',
              reply_to: null,
              quoted_message: null,
              metadata: {
                window_id: '微信',
                non_text_description: null,
                event_id: 'e_2',
                frame_id: 'f_2'
              }
            }
          ]
        },
        latestUpdatedSession: {
          sessionKey: '微信::测试会话',
          sessionName: '测试会话',
          filePath: '/tmp/chat_records/test.json',
          recentMessages: [
            {
              message_id: 'm_1',
              conversation_id: '微信::测试会话',
              sender_id: 'alice',
              sender_name: 'Alice',
              sender_type: 'contact',
              content: '第一条',
              timestamp: '2026-04-02T09:00:00Z',
              content_type: 'text',
              reply_to: null,
              quoted_message: null,
              metadata: {
                window_id: '微信',
                non_text_description: null,
                event_id: 'e_1',
                frame_id: 'f_1'
              }
            },
            {
              message_id: 'm_2',
              conversation_id: '微信::测试会话',
              sender_id: 'alice',
              sender_name: 'Alice',
              sender_type: 'contact',
              content: '第二条',
              timestamp: '2026-04-02T09:01:00Z',
              content_type: 'text',
              reply_to: null,
              quoted_message: null,
              metadata: {
                window_id: '微信',
                non_text_description: null,
                event_id: 'e_2',
                frame_id: 'f_2'
              }
            }
          ]
        },
        updatedSessions: [
          {
            sessionKey: '微信::测试会话',
            sessionName: '测试会话',
            filePath: '/tmp/chat_records/test.json',
            appendedCount: 1
          }
        ]
      })

    const eventPayloads = [
      {
        count: 1,
        events: [
          {
            sender: 'contact',
            text: '第一条',
            session_key: '微信::测试会话',
            conversation_title: '测试会话',
            timestamp: '2026-04-02T09:00:00Z',
            event_id: 'e_1',
            frame_id: 'f_1'
          }
        ]
      },
      { count: 0, events: [] },
      {
        count: 1,
        events: [
          {
            sender: 'contact',
            text: '第二条',
            session_key: '微信::测试会话',
            conversation_title: '测试会话',
            timestamp: '2026-04-02T09:01:00Z',
            event_id: 'e_2',
            frame_id: 'f_2'
          }
        ]
      },
      { count: 0, events: [] }
    ]

    const suggestionPayloads = [
      {
        count: 1,
        suggestions: [{ content: '先回第一轮', reason: '接住第一条消息' }]
      },
      {
        count: 1,
        suggestions: [{ content: '第二轮可以这样回', reason: '基于新消息继续' }]
      }
    ]
    let monitorRunning = true

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/monitor/start')) {
        monitorRunning = true
        return jsonResponse({ running: true })
      }
      if (url.endsWith('/monitor/debug')) {
        return jsonResponse({ running: monitorRunning, pipeline: { last_frontmost_app: 'WeChat', per_session_inflight: {} } })
      }
      if (url.includes('/events/poll')) {
        return jsonResponse(eventPayloads.shift() ?? { count: 0, events: [] })
      }
      if (url.endsWith('/assistant/suggestions')) {
        return jsonResponse(suggestionPayloads.shift() ?? { count: 0, suggestions: [] })
      }
      if (url.endsWith('/monitor/stop')) {
        expect(init?.method).toBe('POST')
        monitorRunning = false
        return jsonResponse({ running: false })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const updates: string[] = []
    const adapter = new RealtimeSuggestionAdapter({ pollIntervalMs: 10_000 })
    adapter.onSuggestions((update) => {
      if (update.suggestions.length > 0) {
        updates.push(update.suggestions[0]!.content)
      }
    })

    await adapter.start()
    expect(updates).toEqual(['先回第一轮'])

    await adapter.acknowledgeCurrentRound()
    await (adapter as unknown as { tick: () => Promise<void> }).tick()
    await (adapter as unknown as { tick: () => Promise<void> }).tick()

    expect(updates).toEqual(['先回第一轮', '第二轮可以这样回'])
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18777/assistant/suggestions',
      expect.objectContaining({ method: 'POST' })
    )

    await adapter.stop()
  })

  it('rerolls suggestions from the current session chat-record snapshot after skip even without new messages', async () => {
    const ingestAndGetRecent = window.electronAPI.chatRecords.ingestAndGetRecent as unknown as ReturnType<typeof vi.fn>
    const getRecentSessionMessages = window.electronAPI.chatRecords.getRecentSessionMessages as unknown as ReturnType<typeof vi.fn>

    const currentSession = {
      sessionKey: '微信::测试会话',
      sessionName: '测试会话',
      filePath: '/tmp/chat_records/test.json',
      recentMessages: [
        {
          message_id: 'm_1',
          conversation_id: '微信::测试会话',
          sender_id: 'alice',
          sender_name: 'Alice',
          sender_type: 'contact',
          content: '第一条',
          timestamp: '2026-04-02T09:00:00Z',
          content_type: 'text',
          reply_to: null,
          quoted_message: null,
          metadata: {
            window_id: '微信',
            non_text_description: null,
            event_id: 'e_1',
            frame_id: 'f_1'
          }
        }
      ]
    }

    ingestAndGetRecent.mockResolvedValueOnce({
      currentSession,
      latestUpdatedSession: currentSession,
      updatedSessions: [
        {
          sessionKey: '微信::测试会话',
          sessionName: '测试会话',
          filePath: '/tmp/chat_records/test.json',
          appendedCount: 1
        }
      ]
    })
    getRecentSessionMessages.mockResolvedValue(currentSession)

    const suggestionPayloads = [
      {
        count: 1,
        suggestions: [{ content: '第一轮建议', reason: '基于当前会话' }]
      },
      {
        count: 1,
        suggestions: [{ content: '跳过后重来一轮', reason: '基于同一份最近消息重算' }]
      }
    ]

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/monitor/start')) {
        return jsonResponse({ running: true })
      }
      if (url.endsWith('/monitor/debug')) {
        return jsonResponse({ running: true, pipeline: { last_frontmost_app: 'WeChat', per_session_inflight: {} } })
      }
      if (url.includes('/events/poll')) {
        return jsonResponse({
          count: 1,
          events: [
            {
              sender: 'contact',
              text: '第一条',
              session_key: '微信::测试会话',
              conversation_title: '测试会话',
              timestamp: '2026-04-02T09:00:00Z',
              event_id: 'e_1',
              frame_id: 'f_1'
            }
          ]
        })
      }
      if (url.endsWith('/assistant/suggestions')) {
        return jsonResponse(suggestionPayloads.shift() ?? { count: 0, suggestions: [] })
      }
      if (url.endsWith('/monitor/stop')) {
        expect(init?.method).toBe('POST')
        return jsonResponse({ running: false })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const updates: string[] = []
    const adapter = new RealtimeSuggestionAdapter({ pollIntervalMs: 10_000 })
    adapter.onSuggestions((update) => {
      if (update.suggestions.length > 0) {
        updates.push(update.suggestions[0]!.content)
      }
    })

    await adapter.start()
    expect(updates).toEqual(['第一轮建议'])

    await adapter.rerollCurrentRound()

    expect(getRecentSessionMessages).toHaveBeenCalledWith('微信::测试会话', 10)
    expect(updates).toEqual(['第一轮建议', '跳过后重来一轮'])

    await adapter.stop()
  })
})
