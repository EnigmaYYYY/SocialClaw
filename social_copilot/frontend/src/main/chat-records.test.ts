import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  __chatRecordsTestUtils,
  confirmPendingChatRecordSession,
  ingestChatRecordsAndGetRecent,
  type ChatRecordEventRow
} from './chat-records'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

async function createTempRecordsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sc-chat-records-'))
  tempDirs.push(dir)
  return dir
}

describe('chat-records window-default normalization', () => {
  it('normalizes window-default and empty app names to 微信', () => {
    expect(__chatRecordsTestUtils.normalizeAppName('window-default')).toBe('微信')
    expect(__chatRecordsTestUtils.normalizeAppName('WeChat')).toBe('微信')
    expect(__chatRecordsTestUtils.normalizeAppName(null)).toBe('微信')
  })

  it('forces normalized app name into session keys', () => {
    expect(
      __chatRecordsTestUtils.normalizeSessionKey('window-default::Alice', 'window-default', null, null)
    ).toBe('微信::alice')

    expect(
      __chatRecordsTestUtils.normalizeSessionKey(null, 'window-default', 'Alice', null)
    ).toBe('微信::alice')
  })

  it('builds pending ids with normalized app names', () => {
    const pendingId = __chatRecordsTestUtils.buildPendingSessionId({
      appName: 'window-default',
      sessionKey: 'window-default::Alice',
      sessionName: 'Alice',
      suggestedSessionKey: null
    })
    expect(pendingId.startsWith('微信_')).toBe(true)
    expect(pendingId.includes('window-default')).toBe(false)
  })
})

describe('chat-records name mapping flow', () => {
  it('resolves mapped session name before confirmation path', async () => {
    const recordsDir = await createTempRecordsDir()
    const mappings = new Map<string, string>([['alyce', 'Alice']])
    await __chatRecordsTestUtils.saveSessionNameMappings(recordsDir, 'u1', mappings)
    const loaded = await __chatRecordsTestUtils.loadSessionNameMappings(recordsDir, 'u1')
    expect(__chatRecordsTestUtils.resolveMappedSessionName('Alyce', loaded)).toBe('Alice')
  })

  it('learns mappings on pending confirmation and avoids repeated pending', async () => {
    const recordsDir = await createTempRecordsDir()
    const ownerUserId = 'u1'
    const ownerDisplayName = 'Me'
    const makeEvent = (text: string): ChatRecordEventRow => ({
      sender: 'contact',
      text,
      contact_name: 'Alyce',
      conversation_title: 'Alyce',
      window_id: 'window-default',
      session_key: 'window-default::Alyce'
    })

    const first = await ingestChatRecordsAndGetRecent(
      recordsDir,
      [makeEvent('hello')],
      ownerUserId,
      ownerDisplayName,
      10,
      { sessionConfirmationMode: 'realtime' }
    )
    expect(first.pendingConfirmation).not.toBeNull()

    const pendingId = first.pendingConfirmation?.pendingId
    expect(pendingId).toBeTruthy()
    if (!pendingId) {
      throw new Error('pending id missing')
    }

    await confirmPendingChatRecordSession(
      recordsDir,
      pendingId,
      'Alice',
      ownerUserId,
      ownerDisplayName,
      10,
      { sessionConfirmationMode: 'realtime' }
    )

    const second = await ingestChatRecordsAndGetRecent(
      recordsDir,
      [makeEvent('hello again')],
      ownerUserId,
      ownerDisplayName,
      10,
      { sessionConfirmationMode: 'realtime' }
    )
    expect(second.pendingConfirmation).toBeNull()
    expect(second.currentSession.sessionName).toBe('Alice')
    expect(second.currentSession.sessionKey.startsWith('微信::')).toBe(true)
  })

  it('overwrites existing mapping with latest confirmed name', () => {
    const mappings = new Map<string, string>([['alyce', 'AliceV1']])
    const changed = __chatRecordsTestUtils.learnSessionNameMappingsForAliases(
      ['Alyce'],
      'AliceV2',
      mappings
    )
    expect(changed).toBe(true)
    expect(__chatRecordsTestUtils.resolveMappedSessionName('Alyce', mappings)).toBe('AliceV2')
  })
})
