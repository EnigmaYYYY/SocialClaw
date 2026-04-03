import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'

import { DataImporter } from './data-importer'

let tempDir = ''

afterAll(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('DataImporter decrypted DB', () => {
  it('parses decrypted db without crashing on sender identity mapping', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'data-importer-db-'))
    const dbPath = join(tempDir, 'MSG.db')

    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE MSG (
        localId INTEGER,
        MsgSvrID INTEGER,
        Type INTEGER,
        SubType INTEGER,
        IsSender INTEGER,
        CreateTime INTEGER,
        StrTalker TEXT,
        StrContent TEXT
      )
    `)
    db.prepare(
      `
      INSERT INTO MSG (
        localId, MsgSvrID, Type, SubType, IsSender, CreateTime, StrTalker, StrContent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(1, 10001, 1, 0, 1, 1628863878, 'wxid_friend', 'hello')
    db.close()

    const importer = new DataImporter()
    const messages = await importer.parseDecryptedDB(dbPath)

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      msgId: '10001',
      msgType: 1,
      content: 'hello',
      fromUser: 'self',
      toUser: 'wxid_friend',
      isSend: true,
      speakerId: 'self',
      speakerName: 'self',
      conversationTitle: 'MSG'
    })
  })
})
