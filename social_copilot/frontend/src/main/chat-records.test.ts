import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { describe, expect, it } from 'vitest'

import {
  ingestChatRecordsAndGetRecent,
  loadRecentChatRecordSession,
  loadStoredChatRecordSessions,
  normalizeSessionTitleKey,
  repairStoredChatRecordSessions,
  type ChatRecordEventRow
} from './chat-records'

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'social-copilot-chat-records-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('chat-records ingest', () => {
  it('writes mixed-session batches into separate files by session_key', async () => {
    await withTempDir(async (recordsDir) => {
      const events: ChatRecordEventRow[] = [
        {
          sender: 'contact',
          text: 'A-1',
          contact_name: 'Alice',
          conversation_title: 'Session A',
          window_id: 'WeChat',
          session_key: 'WeChat::Session A',
          timestamp: '2026-03-03T10:00:00Z'
        },
        {
          sender: 'contact',
          text: 'B-1',
          contact_name: 'Bob',
          conversation_title: 'Session B',
          window_id: 'WeChat',
          session_key: 'WeChat::Session B',
          timestamp: '2026-03-03T10:00:01Z'
        }
      ]

      const result = await ingestChatRecordsAndGetRecent(recordsDir, events, 'test-user', 'Me', 10)
      expect(result.updatedSessions).toHaveLength(2)
      expect(result.currentSession.sessionName).toBe('Session B')
      expect(result.latestUpdatedSession?.sessionName).toBe('Session B')

      const fileA = result.updatedSessions.find((item) => item.sessionName === 'Session A')?.filePath
      const fileB = result.updatedSessions.find((item) => item.sessionName === 'Session B')?.filePath
      expect(fileA).toBeTruthy()
      expect(fileB).toBeTruthy()
      const payloadA = JSON.parse(await readFile(fileA!, 'utf-8')) as {
        messages: Array<{ content: string; conversation_id: string; sender_name: string; metadata: Record<string, unknown> }>
      }
      const payloadB = JSON.parse(await readFile(fileB!, 'utf-8')) as { messages: Array<{ content: string }> }
      expect(payloadA.messages.map((item) => item.content)).toEqual(['A-1'])
      expect(payloadB.messages.map((item) => item.content)).toEqual(['B-1'])
      expect(payloadA.messages[0]?.conversation_id).toBe('WeChat::sessiona')
      expect(payloadA.messages[0]?.sender_name).toBe('Alice')
      expect(payloadA.messages[0]?.metadata).not.toHaveProperty('session_key')
      expect(payloadA.messages[0]?.metadata).not.toHaveProperty('contact_name')
      expect(payloadA.messages[0]?.metadata).not.toHaveProperty('conversation_title')
    })
  })

  it('tracks latestUpdatedSession by true append order instead of last event session', async () => {
    await withTempDir(async (recordsDir) => {
      await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: 'A-1',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A'
          },
          {
            sender: 'contact',
            text: 'B-1',
            contact_name: 'Bob',
            conversation_title: 'Session B',
            window_id: 'WeChat',
            session_key: 'WeChat::Session B'
          }
        ],
        'test-user',
        'Me',
        10
      )

      const result = await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: 'A-2',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A'
          },
          {
            sender: 'contact',
            text: 'B-1',
            contact_name: 'Bob',
            conversation_title: 'Session B',
            window_id: 'WeChat',
            session_key: 'WeChat::Session B'
          }
        ],
        'test-user',
        'Me',
        10
      )

      expect(result.currentSession.sessionName).toBe('Session B')
      expect(result.latestUpdatedSession?.sessionName).toBe('Session A')
      expect(result.latestUpdatedSession?.recentMessages.map((item) => item.content).at(-1)).toBe('A-2')
    })
  })

  it('orders capture-only ISO timestamps by full capture time instead of minute anchors', async () => {
    await withTempDir(async (recordsDir) => {
      await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: 'older',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            timestamp: '14:01',
            metadata: {
              capture_timestamp: '2026-03-03T10:00:08Z'
            }
          },
          {
            sender: 'user',
            text: 'later',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            timestamp: '2026-03-03T10:00:16Z',
            metadata: {
              capture_timestamp: '2026-03-03T10:00:16Z'
            }
          }
        ],
        'test-user',
        'Me',
        10
      )

      const filePath = join(recordsDir, 'WeChat', 'SessionA.json')
      const payload = JSON.parse(await readFile(filePath, 'utf-8')) as {
        messages: Array<{ content: string }>
      }
      expect(payload.messages.map((item) => item.content)).toEqual(['older', 'later'])
    })
  })

  it('deduplicates text messages when they share the same time anchor', async () => {
    await withTempDir(async (recordsDir) => {
      const first: ChatRecordEventRow[] = [
        {
          sender: 'contact',
          text: 'same text',
          contact_name: 'Alice',
          conversation_title: 'Session A',
          window_id: 'WeChat',
          session_key: 'WeChat::Session A',
          timestamp: '2026-03-03T10:00:00Z'
        }
      ]
      const second: ChatRecordEventRow[] = [
        {
          sender: 'contact',
          text: 'same text',
          contact_name: 'Alice',
          conversation_title: 'Session A',
          window_id: 'WeChat',
          session_key: 'WeChat::Session A',
          timestamp: '2026-03-03T10:00:30Z'
        }
      ]

      const r1 = await ingestChatRecordsAndGetRecent(recordsDir, first, 'test-user', 'Me', 10)
      const r2 = await ingestChatRecordsAndGetRecent(recordsDir, second, 'test-user', 'Me', 10)
      expect(r1.updatedSessions[0].appendedCount).toBe(1)
      expect(r2.updatedSessions[0].appendedCount).toBe(0)
      expect(r2.currentSession.recentMessages).toHaveLength(1)
    })
  })

  it('loads the latest messages for a specific session even without new ingest updates', async () => {
    await withTempDir(async (recordsDir) => {
      const seed = await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: '第一条',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            timestamp: '2026-03-03T10:00:00Z'
          },
          {
            sender: 'user',
            text: '第二条',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            timestamp: '2026-03-03T10:01:00Z'
          },
          {
            sender: 'contact',
            text: '别的会话',
            contact_name: 'Bob',
            conversation_title: 'Session B',
            window_id: 'WeChat',
            session_key: 'WeChat::Session B',
            timestamp: '2026-03-03T10:02:00Z'
          }
        ],
        'test-user',
        'Me',
        10
      )

      const session = await loadRecentChatRecordSession(
        recordsDir,
        'test-user',
        seed.updatedSessions[0]!.sessionKey,
        2
      )

      expect(session).not.toBeNull()
      expect(session?.sessionName).toBe('Session A')
      expect(session?.recentMessages.map((item) => item.content)).toEqual(['第一条', '第二条'])
      expect(session?.filePath).toContain('/WeChat/')
      expect(session?.filePath.toLowerCase()).toContain('sessiona.json')
    })
  })

  it('deduplicates snapshot repeats within a two-minute capture window when no explicit time anchor exists', async () => {
    await withTempDir(async (recordsDir) => {
      const first: ChatRecordEventRow[] = [
        {
          sender: 'contact',
          text: 'same text',
          contact_name: 'Alice',
          conversation_title: 'Session A',
          window_id: 'WeChat',
          session_key: 'WeChat::Session A',
          timestamp: '2026-03-03T10:00:00Z',
          event_id: 'm_000001',
          frame_id: 'f_000001'
        }
      ]
      const second: ChatRecordEventRow[] = [
        {
          sender: 'contact',
          text: 'same text',
          contact_name: 'Alice',
          conversation_title: 'Session A',
          window_id: 'WeChat',
          session_key: 'WeChat::Session A',
          timestamp: '2026-03-03T10:01:30Z',
          event_id: 'm_000201',
          frame_id: 'f_000201'
        }
      ]

      await ingestChatRecordsAndGetRecent(recordsDir, first, 'test-user', 'Me', 10)
      const result = await ingestChatRecordsAndGetRecent(recordsDir, second, 'test-user', 'Me', 10)
      expect(result.updatedSessions[0]?.appendedCount).toBe(0)
      expect(result.currentSession.recentMessages).toHaveLength(1)
    })
  })

  it('keeps quoted messages structured and does not merge different quotes into one row', async () => {
    await withTempDir(async (recordsDir) => {
      const result = await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: '快快关注 助力每一个梦想好吧😎',
            quoted_message: {
              sender_name: '赵梓涵',
              text: '刷到叶老师的小红书了'
            },
            contact_name: '宝宝💗',
            conversation_title: '六个猫猫铃西西又八八',
            window_id: '微信',
            session_key: '微信::六个猫猫铃西西又八八',
            timestamp: '2026-04-02T08:00:08Z'
          },
          {
            sender: 'contact',
            text: '快快关注 助力每一个梦想好吧😎',
            quoted_message: {
              sender_name: '李四',
              text: '这周末去不去'
            },
            contact_name: '宝宝💗',
            conversation_title: '六个猫猫铃西西又八八',
            window_id: '微信',
            session_key: '微信::六个猫猫铃西西又八八',
            timestamp: '2026-04-02T08:02:08Z'
          }
        ],
        'test-user',
        'Me',
        10
      )

      expect(result.currentSession.recentMessages).toHaveLength(2)
      expect(result.currentSession.recentMessages[0]?.quoted_message).toEqual({
        sender_name: '赵梓涵',
        text: '刷到叶老师的小红书了'
      })
      expect(result.currentSession.recentMessages[1]?.quoted_message).toEqual({
        sender_name: '李四',
        text: '这周末去不去'
      })
    })
  })

  it('deduplicates when one side lacks timestamp but capture timestamps stay within two minutes', async () => {
    await withTempDir(async (recordsDir) => {
      await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: 'same text',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            timestamp: null,
            event_id: 'm_100001',
            frame_id: 'f_100001',
            metadata: {
              capture_timestamp: '2026-03-03T10:00:00Z'
            }
          }
        ],
        'test-user',
        'Me',
        10
      )

      const result = await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: 'same text',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            time_anchor: '10:00',
            timestamp: '2026-03-03T10:01:00Z',
            event_id: 'm_100002',
            frame_id: 'f_100002',
            metadata: {
              capture_timestamp: '2026-03-03T10:01:00Z'
            }
          }
        ],
        'test-user',
        'Me',
        10
      )

      expect(result.updatedSessions[0]?.appendedCount).toBe(0)
      expect(result.currentSession.recentMessages).toHaveLength(1)
      expect(result.currentSession.recentMessages[0]?.timestamp).toBe('10:00')
    })
  })

  it('uses a configurable capture dedup window when explicit time anchors are missing', async () => {
    await withTempDir(async (recordsDir) => {
      await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: 'same text',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            timestamp: null,
            event_id: 'm_200001',
            frame_id: 'f_200001',
            metadata: {
              capture_timestamp: '2026-03-03T10:00:00Z'
            }
          }
        ],
        'test-user',
        'Me',
        10,
        { captureDedupWindowMs: 10_000 }
      )

      const result = await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: 'same text',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            timestamp: null,
            event_id: 'm_200002',
            frame_id: 'f_200002',
            metadata: {
              capture_timestamp: '2026-03-03T10:00:20Z'
            }
          }
        ],
        'test-user',
        'Me',
        10,
        { captureDedupWindowMs: 10_000 }
      )

      expect(result.updatedSessions[0]?.appendedCount).toBe(1)
      expect(result.currentSession.recentMessages).toHaveLength(2)
    })
  })

  it('falls back to capture time dedup when only one side has an explicit visible chat time', async () => {
    await withTempDir(async (recordsDir) => {
      await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: '包的哥么',
            contact_name: '姜添翼（同济）',
            conversation_title: 'mcp数据合成交流',
            window_id: '微信',
            session_key: '微信::mcp数据合成交流',
            timestamp: '20:08',
            event_id: 'm_300001',
            frame_id: 'f_300001',
            metadata: {
              capture_timestamp: '2026-04-02T14:44:24.223239Z'
            }
          }
        ],
        'test-user',
        'Me',
        10
      )

      const result = await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: '包的哥么',
            contact_name: '姜添翼（同济）',
            conversation_title: 'mcp数据合成交流',
            window_id: '微信',
            session_key: '微信::mcp数据合成交流',
            timestamp: '2026-04-02T14:44:33.646375Z',
            event_id: 'm_300002',
            frame_id: 'f_300002',
            metadata: {
              capture_timestamp: '2026-04-02T14:44:33.646375Z'
            }
          }
        ],
        'test-user',
        'Me',
        10
      )

      expect(result.updatedSessions[0]?.appendedCount).toBe(0)
      expect(result.currentSession.recentMessages).toHaveLength(1)
      expect(result.currentSession.recentMessages[0]?.timestamp).toBe('20:08')
    })
  })

  it('maps title variants to the same canonical session key', () => {
    expect(normalizeSessionTitleKey('AI Lab（测试群）')).toBe(
      normalizeSessionTitleKey('AILab (测试群)')
    )
    expect(normalizeSessionTitleKey('上海辛巴宠物医院 - 客服专员')).toBe(
      normalizeSessionTitleKey('上海辛巴宠物医院-客服专员')
    )
  })

  it('writes title variants into one session file and preserves aliases', async () => {
    await withTempDir(async (recordsDir) => {
      await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: 'first',
            contact_name: 'Alice',
            conversation_title: 'AI Lab（测试群）',
            window_id: 'WeChat',
            session_key: 'WeChat::AI Lab（测试群）',
            timestamp: '2026-03-03T10:00:00Z'
          }
        ],
        'test-user',
        'Me',
        10
      )

      const result = await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: 'second',
            contact_name: 'Alice',
            conversation_title: 'AILab (测试群)',
            window_id: 'WeChat',
            session_key: 'WeChat::AILab (测试群)',
            timestamp: '2026-03-03T10:01:00Z'
          }
        ],
        'test-user',
        'Me',
        10
      )

      expect(result.updatedSessions).toHaveLength(1)
      expect(result.updatedSessions[0]?.appendedCount).toBe(1)

      const wechatDir = join(recordsDir, 'WeChat')
      const files = await readdir(wechatDir)
      expect(files).toHaveLength(1)

      const payload = JSON.parse(await readFile(join(wechatDir, files[0] ?? ''), 'utf-8')) as {
        session_name: string
        canonical_title_key?: string
        title_aliases?: string[]
        messages: Array<{ content: string }>
      }
      expect(payload.session_name).toBe('AILab (测试群)')
      expect(payload.canonical_title_key).toBe(normalizeSessionTitleKey('AILab (测试群)'))
      expect(payload.title_aliases).toEqual(expect.arrayContaining(['AI Lab（测试群）', 'AILab (测试群)']))
      expect(payload.messages.map((item) => item.content)).toEqual(['first', 'second'])
    })
  })

  it('keeps repeated short text when timestamps fall on different time anchors', async () => {
    await withTempDir(async (recordsDir) => {
      await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: '好的',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            timestamp: '2026-03-03T10:00:00Z'
          }
        ],
        'test-user',
        'Me',
        10
      )

      const result = await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: '好的',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            timestamp: '2026-03-03T10:05:00Z'
          }
        ],
        'test-user',
        'Me',
        10
      )

      expect(result.updatedSessions[0]?.appendedCount).toBe(1)
      expect(result.currentSession.recentMessages).toHaveLength(2)
      expect(result.currentSession.recentMessages.map((item) => item.content)).toEqual(['好的', '好的'])
    })
  })

  it('appends only the non-overlapping tail of a visible message window', async () => {
    await withTempDir(async (recordsDir) => {
      await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: 'C',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            timestamp: '2026-03-03T10:00:00Z'
          },
          {
            sender: 'contact',
            text: 'D',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            timestamp: '2026-03-03T10:01:00Z'
          },
          {
            sender: 'contact',
            text: 'E',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            timestamp: '2026-03-03T10:02:00Z'
          }
        ],
        'test-user',
        'Me',
        10
      )

      const result = await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: 'C',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            timestamp: '2026-03-03T10:00:00Z'
          },
          {
            sender: 'contact',
            text: 'D',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            timestamp: '2026-03-03T10:01:00Z'
          },
          {
            sender: 'contact',
            text: 'E',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            timestamp: '2026-03-03T10:02:00Z'
          },
          {
            sender: 'contact',
            text: 'F',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            timestamp: '2026-03-03T10:03:00Z'
          }
        ],
        'test-user',
        'Me',
        10
      )

      expect(result.updatedSessions[0]?.appendedCount).toBe(1)
      expect(result.currentSession.recentMessages.map((item) => item.content)).toEqual(['C', 'D', 'E', 'F'])
    })
  })

  it('writes merged messages in chronological order using time anchor first and capture time second', async () => {
    await withTempDir(async (recordsDir) => {
      const result = await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: 'later visible time',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            time_anchor: '2026-03-03T10:05:00Z',
            timestamp: '2026-03-03T10:09:00Z',
            event_id: 'm_000101',
            frame_id: 'f_000101'
          },
          {
            sender: 'contact',
            text: 'earlier visible time',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            time_anchor: '2026-03-03T10:00:00Z',
            timestamp: '2026-03-03T10:10:00Z',
            event_id: 'm_000102',
            frame_id: 'f_000102'
          },
          {
            sender: 'contact',
            text: 'capture only',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            timestamp: '2026-03-03T10:07:00Z',
            event_id: 'm_000103',
            frame_id: 'f_000103'
          }
        ],
        'test-user',
        'Me',
        10
      )

      expect(result.currentSession.recentMessages.map((item) => item.content)).toEqual([
        'earlier visible time',
        'later visible time',
        'capture only'
      ])
    })
  })

  it('deduplicates text variants with mixed chinese-english spacing', async () => {
    await withTempDir(async (recordsDir) => {
      const first: ChatRecordEventRow[] = [
        {
          sender: 'contact',
          text: 'use developeropus with sonnet',
          contact_name: 'Alice',
          conversation_title: 'Session A',
          window_id: 'WeChat',
          session_key: 'WeChat::Session A'
        }
      ]
      const second: ChatRecordEventRow[] = [
        {
          sender: 'contact',
          text: 'use developer opus with sonnet',
          contact_name: 'Alice',
          conversation_title: 'Session A',
          window_id: 'WeChat',
          session_key: 'WeChat::Session A'
        }
      ]
      await ingestChatRecordsAndGetRecent(recordsDir, first, 'test-user', 'Me', 10)
      const result = await ingestChatRecordsAndGetRecent(recordsDir, second, 'test-user', 'Me', 10)
      expect(result.updatedSessions[0].appendedCount).toBe(0)
      expect(result.currentSession.recentMessages).toHaveLength(1)
    })
  })

  it('deduplicates non-text messages with high description similarity', async () => {
    await withTempDir(async (recordsDir) => {
      const first: ChatRecordEventRow[] = [
        {
          sender: 'contact',
          text: '',
          contact_name: 'Alice',
          conversation_title: 'Session A',
          window_id: 'WeChat',
          session_key: 'WeChat::Session A',
          content_type: 'image',
          non_text_description: 'cat sticker pack',
          timestamp: '2026-03-03T10:00:00Z'
        }
      ]
      const second: ChatRecordEventRow[] = [
        {
          sender: 'contact',
          text: '',
          contact_name: 'Alice',
          conversation_title: 'Session A',
          window_id: 'WeChat',
          session_key: 'WeChat::Session A',
          content_type: 'image',
          non_text_description: 'cat sticker pack ',
          timestamp: '2026-03-03T10:00:10Z'
        }
      ]

      const r1 = await ingestChatRecordsAndGetRecent(recordsDir, first, 'test-user', 'Me', 10)
      const r2 = await ingestChatRecordsAndGetRecent(recordsDir, second, 'test-user', 'Me', 10)
      expect(r1.updatedSessions[0].appendedCount).toBe(1)
      expect(r2.updatedSessions[0].appendedCount).toBe(0)
      expect(r2.currentSession.recentMessages).toHaveLength(1)
    })
  })

  it('deduplicates animated media variants from the same sender within one capture window', async () => {
    await withTempDir(async (recordsDir) => {
      await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: '[sticker] 线条小狗举着信封的简笔画贴纸',
            contact_name: 'Wiii',
            conversation_title: '101的好同志们',
            window_id: '微信',
            session_key: '微信::101的好同志们',
            timestamp: '18:06',
            content_type: 'sticker',
            non_text_description: '线条小狗举着信封的简笔画贴纸',
            metadata: {
              capture_timestamp: '2026-04-02T13:41:47.281946Z'
            }
          }
        ],
        'test-user',
        'Me',
        10
      )

      const result = await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: '[sticker] 线条小狗举信封表情包',
            contact_name: 'Wiii',
            conversation_title: '101的好同志们',
            window_id: '微信',
            session_key: '微信::101的好同志们',
            timestamp: '18:06',
            content_type: 'sticker',
            non_text_description: '线条小狗举信封表情包',
            metadata: {
              capture_timestamp: '2026-04-02T13:41:49.361511Z'
            }
          }
        ],
        'test-user',
        'Me',
        10
      )

      expect(result.currentSession.recentMessages).toHaveLength(1)
      expect(result.currentSession.recentMessages[0]?.sender_name).toBe('Wiii')
    })
  })

  it('deduplicates sticker descriptions that normalize to the same non-text signature', async () => {
    await withTempDir(async (recordsDir) => {
      await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: '',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            content_type: 'image',
            non_text_description: 'white cat sticker waving',
            timestamp: '2026-03-03T10:00:00Z'
          }
        ],
        'test-user',
        'Me',
        10
      )

      const result = await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: '',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            content_type: 'image',
            non_text_description: 'waving white cat sticker',
            timestamp: '2026-03-03T10:00:15Z'
          }
        ],
        'test-user',
        'Me',
        10
      )

      expect(result.updatedSessions[0]?.appendedCount).toBe(0)
      expect(result.currentSession.recentMessages).toHaveLength(1)
    })
  })

  it('replaces incomplete media description with a more complete one', async () => {
    await withTempDir(async (recordsDir) => {
      await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: '',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            content_type: 'image',
            non_text_description: 'code screenshot, top area',
            timestamp: '2026-03-03T10:00:00Z'
          }
        ],
        'test-user',
        'Me',
        10
      )
      const result = await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: '',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            content_type: 'image',
            non_text_description: 'code screenshot, full window, includes terminal output',
            timestamp: '2026-03-03T10:00:05Z'
          }
        ],
        'test-user',
        'Me',
        10
      )
      expect(result.updatedSessions[0].appendedCount).toBe(0)
      expect(result.currentSession.recentMessages).toHaveLength(1)
      expect(result.currentSession.recentMessages[0]?.metadata.non_text_description).toBe(
        'code screenshot, full window, includes terminal output'
      )
    })
  })

  it('repairs direct-chat contact names in stored records using the session title', async () => {
    await withTempDir(async (recordsDir) => {
      await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: '全球AI失控',
            contact_name: 'Palmar鸡儿',
            conversation_title: 'Palmar鸡儿',
            window_id: 'WeChat',
            session_key: 'WeChat::Palmar鸡儿',
            timestamp: '2026-03-17T08:42:00Z'
          },
          {
            sender: 'contact',
            text: '好科幻的话',
            contact_name: '默',
            conversation_title: 'Palmar鸡儿',
            window_id: 'WeChat',
            session_key: 'WeChat::Palmar鸡儿',
            timestamp: '2026-03-17T08:42:10Z'
          },
          {
            sender: 'contact',
            text: '真的不知道买什么衣服',
            contact_name: 'Palmar鸡儿',
            conversation_title: 'Palmar鸡儿',
            window_id: 'WeChat',
            session_key: 'WeChat::Palmar鸡儿',
            timestamp: '2026-03-17T08:42:20Z'
          }
        ],
        'test-user',
        'Me',
        10
      )

      await repairStoredChatRecordSessions(recordsDir)

      const sessions = await loadStoredChatRecordSessions(recordsDir, 'test-user', 10)
      expect(sessions).toHaveLength(1)
      const contactNames = sessions[0].recentMessages
        .filter((item) => item.sender_type === 'contact')
        .map((item) => item.sender_name)
      expect(contactNames).toEqual(['Palmar鸡儿', 'Palmar鸡儿', 'Palmar鸡儿'])
    })
  })

  it('loads the full session history when the backfill limit is disabled', async () => {
    await withTempDir(async (recordsDir) => {
      await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: 'first',
            contact_name: 'Alice',
            conversation_title: 'Full History',
            window_id: 'WeChat',
            session_key: 'WeChat::Full History'
          },
          {
            sender: 'contact',
            text: 'second',
            contact_name: 'Alice',
            conversation_title: 'Full History',
            window_id: 'WeChat',
            session_key: 'WeChat::Full History'
          },
          {
            sender: 'user',
            text: 'third',
            contact_name: 'Alice',
            conversation_title: 'Full History',
            window_id: 'WeChat',
            session_key: 'WeChat::Full History'
          }
        ],
        'test-user',
        'Me',
        10
      )

      const sessions = await loadStoredChatRecordSessions(recordsDir, 'test-user', 0)
      expect(sessions).toHaveLength(1)
      expect(sessions[0].recentMessages).toHaveLength(3)
      expect(sessions[0].recentMessages.map((item) => item.text)).toEqual(['first', 'second', 'third'])
    })
  })

  it('does not collapse likely group-chat speakers into the session title', async () => {
    await withTempDir(async (recordsDir) => {
      await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: 'A-1',
            contact_name: 'Alice',
            conversation_title: 'Study Group',
            window_id: 'WeChat',
            session_key: 'WeChat::Study Group'
          },
          {
            sender: 'contact',
            text: 'A-2',
            contact_name: 'Alice',
            conversation_title: 'Study Group',
            window_id: 'WeChat',
            session_key: 'WeChat::Study Group'
          },
          {
            sender: 'contact',
            text: 'Bob-1',
            contact_name: 'Bob',
            conversation_title: 'Study Group',
            window_id: 'WeChat',
            session_key: 'WeChat::Study Group'
          },
          {
            sender: 'contact',
            text: 'Bob-2',
            contact_name: 'Bob',
            conversation_title: 'Study Group',
            window_id: 'WeChat',
            session_key: 'WeChat::Study Group'
          }
        ],
        'test-user',
        'Me',
        10
      )

      const repair = await repairStoredChatRecordSessions(recordsDir)
      expect(repair.repairedFiles).toBe(0)
      expect(repair.repairedMessages).toBe(0)

      const sessions = await loadStoredChatRecordSessions(recordsDir, 'test-user', 10)
      const contactNames = sessions[0].recentMessages
        .filter((item) => item.sender_type === 'contact')
        .map((item) => item.sender_name)
      expect(contactNames).toEqual(['Alice', 'Alice', 'Bob', 'Bob'])
    })
  })

  it('repairs stored files whose messages are out of chronological order', async () => {
    await withTempDir(async (recordsDir) => {
      await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: 'placeholder',
            contact_name: 'Alice',
            conversation_title: 'Session A',
            window_id: 'WeChat',
            session_key: 'WeChat::Session A',
            timestamp: '2026-03-03T10:00:00Z'
          }
        ],
        'test-user',
        'Me',
        10
      )

      const filePath = join(recordsDir, 'WeChat', 'SessionA.json')
      const payload = JSON.parse(await readFile(filePath, 'utf-8')) as {
        schema_version: number
        session_name: string
        session_key: string
        app_name: string
        canonical_title_key?: string
        title_aliases?: string[]
        owner_user_id?: string
        updated_at: string
        messages: Array<Record<string, unknown>>
      }
      payload.messages = [
        {
          message_id: 'm_2',
          conversation_id: 'WeChat::sessiona',
          sender_id: 'Alice',
          sender_name: 'Alice',
          sender_type: 'contact',
          content: 'later',
          timestamp: '2026-03-03T10:05:00Z',
          content_type: 'text',
          reply_to: null,
          metadata: {
            window_id: 'WeChat',
            non_text_description: null,
            non_text_signature: '',
            capture_timestamp: '2026-03-03T10:05:00Z',
            event_id: 'm_2',
            frame_id: 'f_2'
          }
        },
        {
          message_id: 'm_1',
          conversation_id: 'WeChat::sessiona',
          sender_id: 'Alice',
          sender_name: 'Alice',
          sender_type: 'contact',
          content: 'earlier',
          timestamp: '2026-03-03T10:00:00Z',
          content_type: 'text',
          reply_to: null,
          metadata: {
            window_id: 'WeChat',
            non_text_description: null,
            non_text_signature: '',
            capture_timestamp: '2026-03-03T10:00:00Z',
            event_id: 'm_1',
            frame_id: 'f_1'
          }
        }
      ]
      await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8')

      const repair = await repairStoredChatRecordSessions(recordsDir, 'test-user')
      expect(repair.repairedFiles).toBe(1)

      const repaired = JSON.parse(await readFile(filePath, 'utf-8')) as {
        messages: Array<{ content: string }>
      }
      expect(repaired.messages.map((item) => item.content)).toEqual(['earlier', 'later'])
    })
  })

  it('upgrades legacy local frame and event ids using capture timestamps during repair', async () => {
    await withTempDir(async (recordsDir) => {
      const appDir = join(recordsDir, '微信')
      await rm(appDir, { recursive: true, force: true })
      await mkdir(appDir, { recursive: true })
      await writeFile(
        join(recordsDir, '微信', '六个猫猫铃西西又八八.json'),
        JSON.stringify({
          session_name: '六个猫猫铃西西又八八',
          session_key: '微信::六个猫猫铃西西又八八',
          app_name: '微信',
          owner_user_id: 'test-user',
          updated_at: '2026-04-02T08:02:00Z',
          messages: [
            {
              message_id: 'm_000001',
              conversation_id: '微信::六个猫猫铃西西又八八',
              sender_id: 'self',
              sender_name: 'Me',
              sender_type: 'user',
              content: '第一轮',
              timestamp: '2026-04-02T08:00:08.376306Z',
              content_type: 'text',
              reply_to: null,
              metadata: {
                window_id: '微信',
                non_text_description: null,
                non_text_signature: '',
                capture_timestamp: '2026-04-02T08:00:08.376306Z',
                event_id: 'm_000001',
                frame_id: 'f_000001'
              }
            },
            {
              message_id: 'm_000001',
              conversation_id: '微信::六个猫猫铃西西又八八',
              sender_id: 'self',
              sender_name: 'Me',
              sender_type: 'user',
              content: '第二轮',
              timestamp: '2026-04-02T08:01:06.613582Z',
              content_type: 'text',
              reply_to: null,
              metadata: {
                window_id: '微信',
                non_text_description: null,
                non_text_signature: '',
                capture_timestamp: '2026-04-02T08:01:06.613582Z',
                event_id: 'm_000001',
                frame_id: 'f_000001'
              }
            }
          ]
        }, null, 2),
        'utf-8'
      )

      const repair = await repairStoredChatRecordSessions(recordsDir, 'test-user')
      expect(repair.repairedFiles).toBe(1)

      const repaired = JSON.parse(
        await readFile(join(recordsDir, '微信', '六个猫猫铃西西又八八.json'), 'utf-8')
      ) as {
        messages: Array<{
          message_id: string
          metadata: {
            event_id: string
            frame_id: string
          }
        }>
      }

      expect(repaired.messages[0]?.metadata.frame_id).toBe('f_000001_20260402T080008376306Z')
      expect(repaired.messages[1]?.metadata.frame_id).toBe('f_000001_20260402T080106613582Z')
      expect(repaired.messages[0]?.metadata.event_id).toBe('m_000001__f_000001_20260402T080008376306Z')
      expect(repaired.messages[1]?.metadata.event_id).toBe('m_000001__f_000001_20260402T080106613582Z')
      expect(repaired.messages[0]?.message_id).toBe('m_000001__f_000001_20260402T080008376306Z')
      expect(repaired.messages[1]?.message_id).toBe('m_000001__f_000001_20260402T080106613582Z')
    })
  })

  it('repairs files whose session_name drifted away from their session_key identity', async () => {
    await withTempDir(async (recordsDir) => {
      const appDir = join(recordsDir, '微信')
      await mkdir(appDir, { recursive: true })
      const filePath = join(appDir, '四个超级汪汪队.json')
      await writeFile(
        filePath,
        JSON.stringify({
          session_name: '101的好同志们',
          session_key: '微信::四个超级汪汪队',
          app_name: '微信',
          owner_user_id: 'test-user',
          updated_at: '2026-04-02T13:45:04.338Z',
          title_aliases: ['四个超级汪汪队', '101的好同志们'],
          messages: []
        }, null, 2),
        'utf-8'
      )

      const repair = await repairStoredChatRecordSessions(recordsDir, 'test-user')
      expect(repair.repairedFiles).toBe(1)

      const repaired = JSON.parse(await readFile(filePath, 'utf-8')) as {
        session_name: string
        session_key: string
        canonical_title_key: string
        title_aliases: string[]
      }

      expect(repaired.session_key).toBe('微信::四个超级汪汪队')
      expect(repaired.session_name).toBe('四个超级汪汪队')
      expect(repaired.canonical_title_key).toBe(normalizeSessionTitleKey('四个超级汪汪队'))
      expect(repaired.title_aliases).toEqual(['四个超级汪汪队'])
    })
  })

  it('ignores foreign conversation titles when the session_key points at another chat', async () => {
    await withTempDir(async (recordsDir) => {
      const result = await ingestChatRecordsAndGetRecent(
        recordsDir,
        [
          {
            sender: 'contact',
            text: '串会话测试',
            contact_name: '赵梓涵',
            conversation_title: '101的好同志们',
            window_id: '微信',
            session_key: '微信::四个超级汪汪队',
            timestamp: '2026-04-02T13:45:04.338Z'
          }
        ],
        'test-user',
        'Me',
        10
      )

      expect(result.currentSession.sessionKey).toBe('微信::四个超级汪汪队')
      expect(result.currentSession.sessionName).toBe('四个超级汪汪队')

      const filePath = join(recordsDir, '微信', '四个超级汪汪队.json')
      const repaired = JSON.parse(await readFile(filePath, 'utf-8')) as {
        session_name: string
        title_aliases: string[]
      }

      expect(repaired.session_name).toBe('四个超级汪汪队')
      expect(repaired.title_aliases).toEqual(['四个超级汪汪队'])
    })
  })

  it('repairs suspicious imported timestamps and raw xml payloads during stored-file normalization', async () => {
    await withTempDir(async (recordsDir) => {
      const appDir = join(recordsDir, '微信')
      await mkdir(appDir, { recursive: true })
      const filePath = join(appDir, '21新传宋悦.json')
      await writeFile(
        filePath,
        JSON.stringify({
          session_name: '21-新传-宋悦',
          session_key: '微信::21新传宋悦',
          app_name: '微信',
          owner_user_id: 'test-user',
          updated_at: '2026-04-02T08:02:00Z',
          messages: [
            {
              message_id: 'm_1',
              conversation_id: '微信::21新传宋悦',
              sender_id: '21-新传-宋悦',
              sender_name: '21-新传-宋悦',
              sender_type: 'contact',
              content: '<msg><emoji md5="123" /></msg>',
              timestamp: '1970-01-21T11:01:28.364Z',
              content_type: 'imported',
              reply_to: null,
              metadata: {
                window_id: '微信',
                non_text_description: null,
                non_text_signature: '',
                capture_timestamp: '1970-01-21T11:01:28.364Z',
                event_id: 'm_1',
                frame_id: null
              }
            }
          ]
        }, null, 2),
        'utf-8'
      )

      const repair = await repairStoredChatRecordSessions(recordsDir, 'test-user')
      expect(repair.repairedFiles).toBe(1)

      const repaired = JSON.parse(await readFile(filePath, 'utf-8')) as {
        messages: Array<{
          content: string
          timestamp: string | null
          metadata: {
            non_text_description: string | null
            capture_timestamp: string | null
          }
          content_type: string
        }>
      }
      expect(repaired.messages[0]?.content).toBe('图片')
      expect(repaired.messages[0]?.content_type).toBe('image')
      expect(repaired.messages[0]?.metadata.non_text_description).toBe('图片')
      expect(repaired.messages[0]?.timestamp).toBeNull()
      expect(repaired.messages[0]?.metadata.capture_timestamp).toBeNull()
    })
  })

})
