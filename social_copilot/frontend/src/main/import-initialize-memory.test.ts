import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { describe, expect, it, vi } from 'vitest'

import { DataImporter } from '../services/data-importer'
import type { DataImportResult } from '../services/data-importer'
import { ingestChatRecordsAndGetRecent, loadStoredChatRecordSessions } from './chat-records'
import {
  convertImportedMessagesToChatRecordEvents,
  executeImportAndInitializeMemory
} from './import-initialize-memory'

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'social-claw-import-init-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('import initialize memory', () => {
  it('normalizes imported messages into chat-record events grouped by conversation', () => {
    const events = convertImportedMessagesToChatRecordEvents(
      [
        {
          msgId: 'm1',
          msgType: 1,
          content: '你好',
          fromUser: 'Alice',
          toUser: 'captain1307',
          createTime: Date.parse('2026-04-01T09:00:00Z'),
          isSend: false
        },
        {
          msgId: 'm2',
          msgType: 1,
          content: '晚上聊',
          fromUser: 'captain1307',
          toUser: 'Alice',
          createTime: Date.parse('2026-04-01T09:01:00Z'),
          isSend: true
        }
      ],
      'captain1307',
      'Enigma'
    )

    expect(events).toEqual([
      expect.objectContaining({
        sender: 'contact',
        text: '你好',
        contact_name: 'Alice',
        conversation_title: 'Alice',
        session_key: '微信::Alice',
        window_id: '微信',
        timestamp: '2026-04-01T09:00:00.000Z'
      }),
      expect.objectContaining({
        sender: 'user',
        text: '晚上聊',
        contact_name: 'Alice',
        conversation_title: 'Alice',
        session_key: '微信::Alice',
        window_id: '微信',
        timestamp: '2026-04-01T09:01:00.000Z'
      })
    ])
  })

  it('avoids treating the owner display name as a friend when deriving imported titles', () => {
    const events = convertImportedMessagesToChatRecordEvents(
      [
        {
          msgId: 'm1',
          msgType: 1,
          content: '晚点回你',
          fromUser: 'Enigma',
          toUser: 'Alice',
          createTime: Date.parse('2026-04-01T09:00:00Z'),
          isSend: false
        }
      ],
      'wxid_h6cbjnu4re9722',
      'Enigma'
    )

    expect(events).toEqual([
      expect.objectContaining({
        sender: 'contact',
        text: '晚点回你',
        contact_name: 'Alice',
        conversation_title: 'Alice',
        session_key: '微信::Alice',
        window_id: '微信'
      })
    ])
  })

  it('normalizes second-based legacy timestamps into ISO datetimes', () => {
    const events = convertImportedMessagesToChatRecordEvents(
      [
        {
          msgId: 'm-seconds',
          msgType: 1,
          content: '秒级时间戳',
          fromUser: 'Alice',
          toUser: 'wxid_h6cbjnu4re9722',
          createTime: 1628863895,
          isSend: false
        }
      ],
      'wxid_h6cbjnu4re9722',
      'Enigma'
    )

    expect(events[0]).toEqual(
      expect.objectContaining({
        timestamp: '2021-08-13T14:11:35.000Z'
      })
    )
  })

  it('replaces imported XML media payloads with stable placeholders', () => {
    const events = convertImportedMessagesToChatRecordEvents(
      [
        {
          msgId: 'm-emoji',
          msgType: 47,
          content: '<msg><emoji md5="123" /></msg>',
          fromUser: 'Alice',
          toUser: 'wxid_h6cbjnu4re9722',
          createTime: 1628863895,
          isSend: false
        }
      ],
      'wxid_h6cbjnu4re9722',
      'Enigma'
    )

    expect(events[0]).toEqual(
      expect.objectContaining({
        text: '图片',
        content_type: 'image',
        non_text_description: '图片',
        timestamp: '2021-08-13T14:11:35.000Z'
      })
    )
  })

  it('persists imported history into chat_records and then triggers backfill', async () => {
    await withTempDir(async (recordsDir) => {
      const importData = vi.fn(
        async (
          _folderPath: string,
          _ownerUserId: string,
          ownerDisplayName?: string
        ): Promise<DataImportResult> => ({
          format: 'wechatmsg_csv',
          messages: [
            {
              msgId: 'm1',
              msgType: 1,
              content: '你好',
              fromUser: 'Alice',
              toUser: 'captain1307',
              createTime: Date.parse('2026-04-01T09:00:00Z'),
              isSend: false
            },
            {
              msgId: 'm2',
              msgType: 1,
              content: '收到',
              fromUser: 'captain1307',
              toUser: 'Alice',
              createTime: Date.parse('2026-04-01T09:01:00Z'),
              isSend: true
            }
          ],
          contacts: ['Alice'],
          errors: []
        })
      )

      const backfillHistory = vi.fn().mockResolvedValue({
        scannedSessions: 1,
        processedSessions: 1,
        skippedSessions: 0,
        failedSessions: 0,
        updatedProfiles: 1,
        failedSessionNames: [],
        failedReasons: []
      })

      const result = await executeImportAndInitializeMemory({
        folderPath: '/mock/import-folder',
        ownerUserId: 'captain1307',
        ownerDisplayName: 'Captain',
        recordsDir,
        importData,
        ingestChatRecords: (targetDir, events, ownerUserId, ownerDisplayName, limit, options) =>
          ingestChatRecordsAndGetRecent(targetDir, events, ownerUserId, ownerDisplayName, limit, options),
        backfillHistory
      })

      expect(result.success).toBe(true)
      expect(result.importedMessages).toBe(2)
      expect(result.importedContacts).toBe(1)
      expect(result.writtenSessions).toBe(1)
      expect(result.appendedMessages).toBe(2)
      expect(result.initializedSessions).toBe(1)
      expect(result.updatedProfiles).toBe(1)
      expect(importData).toHaveBeenCalledWith('/mock/import-folder', 'captain1307', 'Captain')
      expect(backfillHistory).toHaveBeenCalledTimes(1)

      const appDirs = await readdir(recordsDir)
      expect(appDirs).toContain('微信')

      const sessions = await loadStoredChatRecordSessions(recordsDir, 'captain1307', 20)
      expect(sessions).toHaveLength(1)
      expect(sessions[0]?.sessionName).toBe('Alice')
      expect(sessions[0]?.recentMessages.map((item) => item.content)).toEqual(['你好', '收到'])
    })
  })

  it('keeps import success while surfacing partial backfill failures', async () => {
    await withTempDir(async (recordsDir) => {
      const result = await executeImportAndInitializeMemory({
        folderPath: '/mock/import-folder',
        ownerUserId: 'captain1307',
        ownerDisplayName: 'Enigma',
        recordsDir,
        importData: async () => ({
          format: 'wechatmsg_csv',
          messages: [
            {
              msgId: 'm1',
              msgType: 1,
              content: '周末见',
              fromUser: 'Bob',
              toUser: 'captain1307',
              createTime: Date.parse('2026-04-01T10:00:00Z'),
              isSend: false
            }
          ],
          contacts: ['Bob'],
          errors: []
        }),
        ingestChatRecords: (targetDir, events, ownerUserId, ownerDisplayName, limit, options) =>
          ingestChatRecordsAndGetRecent(targetDir, events, ownerUserId, ownerDisplayName, limit, options),
        backfillHistory: async () => ({
          scannedSessions: 1,
          processedSessions: 0,
          skippedSessions: 0,
          failedSessions: 1,
          updatedProfiles: 0,
          failedSessionNames: ['Bob'],
          failedReasons: ['Bob: evermemos timeout']
        })
      })

      expect(result.success).toBe(true)
      expect(result.importedMessages).toBe(1)
      expect(result.writtenSessions).toBe(1)
      expect(result.failedInitializationSessions).toBe(1)
      expect(result.failedSessionNames).toEqual(['Bob'])
      expect(result.errors).toContain('Bob: evermemos timeout')
    })
  })

  it('imports a legacy MemoTrace folder as one dialogue and keeps both sides in the same session', async () => {
    await withTempDir(async (recordsDir) => {
      const sourceDir = join(recordsDir, '21-新传-宋悦(wxid_h6cbjnu4re9722)')
      const csvPath = join(sourceDir, '21-新传-宋悦.csv')
      await rm(sourceDir, { recursive: true, force: true }).catch(() => {})
      await mkdir(sourceDir, { recursive: true })
      await writeFile(
        csvPath,
        '\uFEFF' + [
          'localId,TalkerId,Type,SubType,IsSender,CreateTime,Status,StrContent,StrTime,Remark,NickName,Sender',
          '1854662,217,1,0,0,1628863878,,我通过了你的朋友验证请求，现在我们可以开始聊天了,2021-08-13 22:11:18,21-新传-宋悦,Viζa.,wxid_h6cbjnu4re9722',
          '1854663,217,1,0,1,1628863886,,你好,2021-08-13 22:11:26,21-新传-宋悦,Viζa.,wxid_h6cbjnu4re9722',
          '1854664,217,47,0,1,1628863895,,"<msg><emoji fromusername=""wxid_h6cbjnu4re9722"" tousername=""qq2456280322"" type=""2"" idbuffer=""media:0_0"" /></msg>",2021-08-13 22:11:35,Enigma,Enigma,qq2456280322'
        ].join('\n'),
        'utf-8'
      )

      const importer = new DataImporter()
      const backfillHistory = vi.fn().mockResolvedValue({
        scannedSessions: 1,
        processedSessions: 1,
        skippedSessions: 0,
        failedSessions: 0,
        updatedProfiles: 1,
        failedSessionNames: [],
        failedReasons: []
      })

      const result = await executeImportAndInitializeMemory({
        folderPath: sourceDir,
        ownerUserId: 'wxid_h6cbjnu4re9722',
        ownerDisplayName: 'Enigma',
        recordsDir,
        importData: (folderPath, ownerUserId, ownerDisplayName) =>
          importer.importData(folderPath, ownerUserId, ownerDisplayName),
        ingestChatRecords: (targetDir, events, ownerUserId, ownerDisplayName, limit, options) =>
          ingestChatRecordsAndGetRecent(targetDir, events, ownerUserId, ownerDisplayName, limit, options),
        backfillHistory
      })

      expect(result.success).toBe(true)
      expect(result.importedMessages).toBe(3)
      expect(result.writtenSessions).toBe(1)
      expect(result.appendedMessages).toBeGreaterThan(0)
      expect(backfillHistory).toHaveBeenCalledTimes(1)

      const sessions = await loadStoredChatRecordSessions(recordsDir, 'wxid_h6cbjnu4re9722', 20)
      expect(sessions).toHaveLength(1)
      expect(sessions[0]?.sessionName).toBe('21-新传-宋悦')
      expect(sessions[0]?.recentMessages.map((item) => item.content)).toEqual([
        '我通过了你的朋友验证请求，现在我们可以开始聊天了',
        '你好',
        '图片'
      ])
      expect(sessions[0]?.recentMessages[2]?.content_type).toBe('image')
      expect(sessions[0]?.recentMessages.some((item) => item.sender_type === 'user')).toBe(true)
      expect(sessions[0]?.recentMessages.some((item) => item.sender_type === 'contact')).toBe(true)
    })
  })
})
