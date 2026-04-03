import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DataImporter } from './data-importer'

let testDir: string

beforeAll(async () => {
  testDir = path.join(os.tmpdir(), `data-importer-legacy-csv-${Date.now()}`)
  await fs.promises.mkdir(testDir, { recursive: true })
})

afterAll(async () => {
  await fs.promises.rm(testDir, { recursive: true, force: true }).catch(() => {})
})

describe('DataImporter legacy WeChat CSV', () => {
  it('detects and parses the old localId/StrContent export format', async () => {
    const folderPath = path.join(testDir, '21-新传-宋悦(wxid_h6cbjnu4re9722)')
    await fs.promises.mkdir(folderPath, { recursive: true })
    const filePath = path.join(folderPath, '21-新传-宋悦.csv')
    const csv = [
      'localId,TalkerId,Type,SubType,IsSender,CreateTime,Status,StrContent,StrTime,Remark,NickName,Sender',
      '1854662,217,1,0,0,1628863878,,我通过了你的朋友验证请求，现在我们可以开始聊天了,2021-08-13 22:11:18,21-新传-宋悦,Viζa.,wxid_h6cbjnu4re9722',
      '1854663,217,1,0,1,1628863886,,你好,2021-08-13 22:11:26,21-新传-宋悦,Viζa.,wxid_h6cbjnu4re9722',
      '1854664,wxid_friend,1,0,0,1628863892,,晚点聊,2021-08-13 22:11:32,Enigma,Enigma,Enigma'
    ].join('\n')

    await fs.promises.writeFile(filePath, '\uFEFF' + csv, 'utf-8')

    const importer = new DataImporter()
    await expect(importer.detectFormat(folderPath)).resolves.toBe('wechatmsg_csv')

    const result = await importer.importData(folderPath, 'wxid_h6cbjnu4re9722', 'Enigma')
    expect(result.format).toBe('wechatmsg_csv')
    expect(result.errors).toEqual([])
    expect(result.messages).toHaveLength(3)
    expect(result.messages[0]).toMatchObject({
      msgId: '1854662',
      msgType: 1,
      content: '我通过了你的朋友验证请求，现在我们可以开始聊天了',
      fromUser: '21-新传-宋悦',
      toUser: 'wxid_h6cbjnu4re9722',
      isSend: false,
      speakerId: '21-新传-宋悦',
      speakerName: 'Viζa.',
      conversationTitle: '21-新传-宋悦'
    })
    expect(result.messages[1]).toMatchObject({
      msgId: '1854663',
      msgType: 1,
      content: '你好',
      fromUser: 'wxid_h6cbjnu4re9722',
      toUser: '21-新传-宋悦',
      isSend: true,
      speakerId: 'wxid_h6cbjnu4re9722',
      speakerName: 'Enigma',
      conversationTitle: '21-新传-宋悦'
    })
    expect(result.messages[2]).toMatchObject({
      msgId: '1854664',
      msgType: 1,
      content: '晚点聊',
      fromUser: '21-新传-宋悦',
      toUser: 'wxid_h6cbjnu4re9722',
      isSend: false
    })
    expect(result.contacts).toContain('21-新传-宋悦')
    expect(result.contacts).not.toContain('Enigma')
    expect(result.contacts).not.toContain('wxid_friend')
  })
})
