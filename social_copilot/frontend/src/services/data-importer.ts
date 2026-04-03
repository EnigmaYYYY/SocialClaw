/**
 * Data Importer Service
 *
 * Responsible for detecting and parsing multiple WeChat data export formats:
 * - WeChatMsg CSV format
 * - wechatDataBackup exported data
 * - Decrypted SQLite database
 *
 * References:
 * - WeChatMsg/exporter/exporter_csv.py
 * - wechatDataBackup/pkg/wechat/wechatDataProvider.go
 *
 * _Requirements: 1.2_
 */

import * as fs from 'fs'
import * as path from 'path'
import { RawMessage, MSG_TYPE } from '../models/schemas'

// ============================================================================
// Data Format Types
// ============================================================================

export type DataFormat = 'wechatmsg_csv' | 'wechatdatabackup' | 'decrypted_db' | 'unknown'

export interface DataImportResult {
  format: DataFormat
  messages: RawMessage[]
  contacts: string[]
  errors: string[]
}

// ============================================================================
// Format Detection Patterns
// ============================================================================

// WeChatMsg CSV columns (reference: WeChatMsg/exporter/exporter_csv.py)
// columns = ['消息ID', '类型', '发送人', '时间', '内容', '备注', '昵称', '更多信息']
const WECHATMSG_CSV_HEADER = '消息ID,类型,发送人,时间,内容,备注,昵称,更多信息'
const WECHATMSG_CSV_HEADER_ALT = '消息ID,类型,发送人,时间,内容'
const LEGACY_WECHAT_CSV_HEADER = 'localId,TalkerId,Type,SubType,IsSender,CreateTime,Status,StrContent,StrTime,Remark,NickName,Sender'

// wechatDataBackup database files
const WECHATDATABACKUP_DB_FILES = ['MSG.db', 'MicroMsg.db']
const WECHATDATABACKUP_MSG_PATTERN = /MSG\d*\.db$/

// Decrypted database patterns
const DECRYPTED_DB_EXTENSIONS = ['.db', '.sqlite', '.sqlite3']

// ============================================================================
// Message Type Mapping (reference: wechatDataBackup/pkg/wechat/wechatDataProvider.go)
// ============================================================================

const MESSAGE_TYPE_NAMES: Record<string, number> = {
  文本: MSG_TYPE.TEXT,
  图片: MSG_TYPE.IMAGE,
  语音: MSG_TYPE.VOICE,
  名片: MSG_TYPE.CARD,
  视频: MSG_TYPE.VIDEO,
  动画表情: MSG_TYPE.EMOJI,
  位置: MSG_TYPE.POSITION,
  链接: MSG_TYPE.APP,
  文件: MSG_TYPE.APP,
  小程序: MSG_TYPE.APP,
  音乐: MSG_TYPE.APP,
  转账: MSG_TYPE.APP,
  红包: MSG_TYPE.APP,
  引用: MSG_TYPE.APP,
  系统消息: MSG_TYPE.SYSTEM,
  撤回消息: MSG_TYPE.SYSTEM,
  拍一拍: MSG_TYPE.SYSTEM
}

// ============================================================================
// DataImporter Class
// ============================================================================

export class DataImporter {
  /**
   * Detect the data format of a given folder or file path
   *
   * @param folderPath - Path to the data folder or file
   * @returns The detected data format
   */
  async detectFormat(folderPath: string): Promise<DataFormat> {
    try {
      const stats = await fs.promises.stat(folderPath)

      if (stats.isFile()) {
        return this.detectFileFormat(folderPath)
      }

      if (stats.isDirectory()) {
        return this.detectFolderFormat(folderPath)
      }

      return 'unknown'
    } catch {
      return 'unknown'
    }
  }

  /**
   * Detect format for a single file
   */
  private async detectFileFormat(filePath: string): Promise<DataFormat> {
    const ext = path.extname(filePath).toLowerCase()

    // Check for CSV file
    if (ext === '.csv') {
      const isWeChatMsgCSV = await this.isWeChatMsgCSV(filePath)
      const isLegacyWeChatCSV = !isWeChatMsgCSV && (await this.isLegacyWeChatCSV(filePath))
      if (isWeChatMsgCSV || isLegacyWeChatCSV) {
        return 'wechatmsg_csv'
      }
    }

    // Check for SQLite database
    if (DECRYPTED_DB_EXTENSIONS.includes(ext)) {
      const isDecryptedDB = await this.isDecryptedDB(filePath)
      if (isDecryptedDB) {
        return 'decrypted_db'
      }
    }

    return 'unknown'
  }

  /**
   * Detect format for a folder
   */
  private async detectFolderFormat(folderPath: string): Promise<DataFormat> {
    try {
      const files = await fs.promises.readdir(folderPath)

      // Check for CSV files first (highest priority)
      const csvFiles = files.filter((f) => f.endsWith('.csv'))
      for (const csvFile of csvFiles) {
        const csvPath = path.join(folderPath, csvFile)
        if (await this.isRecognizedWeChatCSV(csvPath)) {
          return 'wechatmsg_csv'
        }
      }

      // Check for wechatDataBackup structure (has Msg subfolder with MSG.db files)
      if (files.includes('Msg')) {
        const msgPath = path.join(folderPath, 'Msg')
        const msgStats = await fs.promises.stat(msgPath)
        if (msgStats.isDirectory()) {
          const msgFiles = await fs.promises.readdir(msgPath)
          // Check for Multi subfolder with MSG*.db files
          if (msgFiles.includes('Multi')) {
            const multiPath = path.join(msgPath, 'Multi')
            const multiFiles = await fs.promises.readdir(multiPath)
            const hasDBFiles = multiFiles.some(
              (f) => f === 'MSG.db' || WECHATDATABACKUP_MSG_PATTERN.test(f)
            )
            if (hasDBFiles) {
              return 'wechatdatabackup'
            }
          }
          // Check for direct MSG.db or MicroMsg.db
          const hasDBFiles = msgFiles.some((f) => WECHATDATABACKUP_DB_FILES.includes(f))
          if (hasDBFiles) {
            return 'wechatdatabackup'
          }
        }
      }

      // Check for SQLite database files (lowest priority)
      const dbFiles = files.filter((f) => DECRYPTED_DB_EXTENSIONS.some((ext) => f.endsWith(ext)))
      for (const dbFile of dbFiles) {
        const dbPath = path.join(folderPath, dbFile)
        if (await this.isDecryptedDB(dbPath)) {
          return 'decrypted_db'
        }
      }

      return 'unknown'
    } catch {
      return 'unknown'
    }
  }

  /**
   * Check if a file is a WeChatMsg CSV export
   */
  private async isWeChatMsgCSV(filePath: string): Promise<boolean> {
    try {
      // Read first line to check header
      const content = await fs.promises.readFile(filePath, 'utf-8')
      const firstLine = content.split('\n')[0].trim()
      // Remove BOM if present (utf-8-sig encoding)
      const cleanFirstLine = firstLine.replace(/^\uFEFF/, '')
      return (
        cleanFirstLine.startsWith(WECHATMSG_CSV_HEADER) ||
        cleanFirstLine.startsWith(WECHATMSG_CSV_HEADER_ALT)
      )
    } catch {
      return false
    }
  }

  /**
   * Check if a file is the older WeChat CSV export with localId/StrContent columns.
   */
  private async isLegacyWeChatCSV(filePath: string): Promise<boolean> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8')
      const firstLine = content.split('\n')[0].trim()
      const cleanFirstLine = firstLine.replace(/^\uFEFF/, '')
      return cleanFirstLine.startsWith(LEGACY_WECHAT_CSV_HEADER)
    } catch {
      return false
    }
  }

  /**
   * Check if a file is any supported WeChat CSV export.
   */
  private async isRecognizedWeChatCSV(filePath: string): Promise<boolean> {
    return (await this.isWeChatMsgCSV(filePath)) || (await this.isLegacyWeChatCSV(filePath))
  }

  /**
   * Check if a file is a decrypted WeChat SQLite database
   */
  private async isDecryptedDB(filePath: string): Promise<boolean> {
    try {
      // Check SQLite magic bytes
      const fd = await fs.promises.open(filePath, 'r')
      const buffer = Buffer.alloc(16)
      await fd.read(buffer, 0, 16, 0)
      await fd.close()

      // SQLite database file header starts with "SQLite format 3\0"
      const sqliteHeader = 'SQLite format 3'
      return buffer.toString('utf-8', 0, 15) === sqliteHeader
    } catch {
      return false
    }
  }

  /**
   * Parse WeChatMsg CSV format
   *
   * CSV columns: ['消息ID', '类型', '发送人', '时间', '内容', '备注', '昵称', '更多信息']
   *
   * @param filePath - Path to the CSV file
   * @param selfUserId - The user's own ID (to determine isSend)
   * @returns Array of RawMessage objects
   */
  async parseWeChatMsgCSV(
    filePath: string,
    selfUserId: string = 'self',
    ownerDisplayName?: string
  ): Promise<RawMessage[]> {
    const content = await fs.promises.readFile(filePath, 'utf-8')
    // Remove BOM if present
    const cleanContent = content.replace(/^\uFEFF/, '')
    const lines = cleanContent.split('\n')

    if (lines.length < 2) {
      return []
    }

    const messages: RawMessage[] = []
    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      const parsed = this.parseCSVLine(line)
      if (parsed.length < 5) continue

      const [msgId, typeName, sender, timeStr, content] = parsed
      const msgType = this.mapTypeNameToMsgType(typeName)
      const createTime = this.parseTimeString(timeStr)
      const conversationTitle =
        this.deriveLegacyConversationHint(filePath) ||
        path.basename(filePath, path.extname(filePath)) ||
        'Unknown Session'

      // Determine if message is sent by user
      // In WeChatMsg CSV, the sender field contains the display name
      // We need to compare with the contact name to determine direction
      const isSend = this.isSelfIdentity(sender, selfUserId, ownerDisplayName)

      messages.push({
        msgId: msgId || `msg_${i}`,
        msgType,
        content: content || '',
        fromUser: isSend ? selfUserId : sender,
        toUser: isSend ? sender : selfUserId,
        createTime,
        isSend,
        speakerId: isSend ? selfUserId : sender,
        speakerName: isSend ? ownerDisplayName || selfUserId : sender,
        conversationTitle
      })
    }

    return messages
  }

  private async parseSupportedWeChatCSV(
    filePath: string,
    selfUserId: string = 'self',
    ownerDisplayName?: string
  ): Promise<RawMessage[]> {
    if (await this.isLegacyWeChatCSV(filePath)) {
      return this.parseLegacyWeChatCSV(filePath, selfUserId, ownerDisplayName)
    }
    return this.parseWeChatMsgCSV(filePath, selfUserId, ownerDisplayName)
  }

  /**
   * Parse the older WeChat CSV export with localId/StrContent columns.
   *
   * CSV columns:
   * ['localId', 'TalkerId', 'Type', 'SubType', 'IsSender', 'CreateTime', 'Status', 'StrContent', 'StrTime', 'Remark', 'NickName', 'Sender']
   */
  async parseLegacyWeChatCSV(
    filePath: string,
    selfUserId: string = 'self',
    ownerDisplayName?: string
  ): Promise<RawMessage[]> {
    const content = await fs.promises.readFile(filePath, 'utf-8')
    const cleanContent = content.replace(/^\uFEFF/, '')
    const lines = cleanContent.split('\n')

    if (lines.length < 2) {
      return []
    }

    const messages: RawMessage[] = []
    const conversationHint = this.deriveLegacyConversationHint(filePath)
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i].trim()
      if (!line) continue

      const parsed = this.parseCSVLine(line)
      if (parsed.length < 12) continue

      const [
        localId,
        talkerId,
        typeValue,
        subTypeValue,
        isSenderValue,
        createTimeValue,
        _status,
        content,
        timeStr,
        remark,
        nickName,
        sender
      ] = parsed

      const isSend = this.parseBooleanFlag(isSenderValue)
      const conversationTitle = this.pickLegacyContactName(
        conversationHint,
        remark,
        nickName,
        talkerId,
        selfUserId,
        ownerDisplayName
      )
      const speakerId = isSend ? selfUserId : conversationTitle
      const speakerName = isSend
        ? ownerDisplayName || selfUserId
        : this.pickLegacySpeakerName(nickName, remark, conversationTitle, talkerId)

      messages.push({
        msgId: localId || `msg_${i}`,
        msgType: this.parseNumericField(typeValue, MSG_TYPE.TEXT),
        subType: this.parseOptionalNumericField(subTypeValue),
        content: content || '',
        fromUser: isSend ? selfUserId : speakerId,
        toUser: isSend ? conversationTitle : selfUserId,
        createTime: this.parseLegacyCreateTime(createTimeValue, timeStr),
        isSend,
        speakerId,
        speakerName,
        conversationTitle
      })
    }

    return messages
  }

  /**
   * Parse a CSV line handling quoted fields
   */
  private parseCSVLine(line: string): string[] {
    const result: string[] = []
    let current = ''
    let inQuotes = false

    for (let i = 0; i < line.length; i++) {
      const char = line[i]

      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          // Escaped quote
          current += '"'
          i++
        } else {
          // Toggle quote mode
          inQuotes = !inQuotes
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current)
        current = ''
      } else {
        current += char
      }
    }
    result.push(current)

    return result
  }

  private parseBooleanFlag(value: string): boolean {
    const normalized = value.trim().toLowerCase()
    return normalized === '1' || normalized === 'true' || normalized === 'yes'
  }

  private parseNumericField(value: string, fallback: number): number {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  private parseOptionalNumericField(value: string): number | undefined {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  private parseLegacyCreateTime(createTimeValue: string, timeStr: string): number {
    const parsed = Number(createTimeValue)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }

    return this.parseTimeString(timeStr)
  }

  private pickLegacyContactName(
    conversationHint: string | null,
    remark: string,
    nickName: string,
    talkerId: string,
    selfUserId?: string,
    ownerDisplayName?: string
  ): string {
    const candidates = [conversationHint, remark, nickName, talkerId]
    for (const candidate of candidates) {
      const normalized = candidate.trim()
      if (normalized.length > 0 && !this.isSelfIdentity(normalized, selfUserId, ownerDisplayName)) {
        return normalized
      }
    }
    return 'Unknown Session'
  }

  private pickLegacySpeakerName(
    nickName: string,
    remark: string,
    sender: string,
    fallback: string
  ): string {
    const candidates = [nickName, remark, sender, fallback]
    for (const candidate of candidates) {
      const normalized = candidate.trim()
      if (normalized.length > 0) {
        return normalized
      }
    }
    return fallback
  }

  private deriveLegacyConversationHint(filePath: string): string | null {
    const parentDirName = this.normalizeLegacyConversationHintSegment(path.basename(path.dirname(filePath)))
    if (parentDirName) {
      return parentDirName
    }

    const fileName = path.basename(filePath, path.extname(filePath))
    return this.normalizeLegacyConversationHintSegment(fileName)
  }

  private normalizeLegacyConversationHintSegment(value: string): string | null {
    const normalized = value
      .replace(/\((?:wxid_[^)]+|[^)]+)\)\s*$/i, '')
      .trim()
    return normalized.length > 0 ? normalized : null
  }

  private isSelfIdentity(
    value: string,
    selfUserId?: string,
    ownerDisplayName?: string
  ): boolean {
    const normalized = value.trim().toLowerCase()
    if (!normalized) {
      return false
    }
    if (normalized === '我' || normalized === 'me' || normalized === 'self') {
      return true
    }
    if (selfUserId && normalized === selfUserId.trim().toLowerCase()) {
      return true
    }
    if (ownerDisplayName && normalized === ownerDisplayName.trim().toLowerCase()) {
      return true
    }
    return false
  }

  /**
   * Map Chinese type name to message type number
   */
  private mapTypeNameToMsgType(typeName: string): number {
    // Clean up type name
    const cleanName = typeName.trim()

    // Direct mapping
    if (MESSAGE_TYPE_NAMES[cleanName] !== undefined) {
      return MESSAGE_TYPE_NAMES[cleanName]
    }

    // Partial matching for complex types
    for (const [name, type] of Object.entries(MESSAGE_TYPE_NAMES)) {
      if (cleanName.includes(name)) {
        return type
      }
    }

    // Default to text
    return MSG_TYPE.TEXT
  }

  /**
   * Parse time string to Unix timestamp
   */
  private parseTimeString(timeStr: string): number {
    try {
      // Try parsing as ISO date or common formats
      const date = new Date(timeStr)
      if (!isNaN(date.getTime())) {
        return Math.floor(date.getTime() / 1000)
      }

      // Try parsing Chinese date format: 2023-01-01 12:00:00
      const match = timeStr.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/)
      if (match) {
        const [, year, month, day, hour, minute, second] = match
        const d = new Date(
          parseInt(year),
          parseInt(month) - 1,
          parseInt(day),
          parseInt(hour),
          parseInt(minute),
          parseInt(second)
        )
        return Math.floor(d.getTime() / 1000)
      }

      return Math.floor(Date.now() / 1000)
    } catch {
      return Math.floor(Date.now() / 1000)
    }
  }

  /**
   * Parse wechatDataBackup exported data
   *
   * This reads from the MSG.db SQLite database files in the Msg/Multi folder
   *
   * @param folderPath - Path to the wechatDataBackup export folder
   * @returns Array of RawMessage objects
   */
  async parseWechatDataBackup(
    folderPath: string,
    selfUserId: string = 'self',
    ownerDisplayName?: string
  ): Promise<RawMessage[]> {
    // Note: This requires better-sqlite3 which is an optional dependency
    // For now, we'll implement a basic structure that can be extended
    const messages: RawMessage[] = []

    try {
      // Find MSG database files
      const msgPath = path.join(folderPath, 'Msg', 'Multi')
      const files = await fs.promises.readdir(msgPath)
      const dbFiles = files.filter((f) => f === 'MSG.db' || WECHATDATABACKUP_MSG_PATTERN.test(f))

      // Sort by name to process in order
      dbFiles.sort()

      for (const dbFile of dbFiles) {
        const dbPath = path.join(msgPath, dbFile)
        const dbMessages = await this.parseDecryptedDB(dbPath, selfUserId, ownerDisplayName)
        messages.push(...dbMessages)
      }
    } catch (error) {
      // If Multi folder doesn't exist, try direct Msg folder
      try {
        const msgPath = path.join(folderPath, 'Msg')
        const files = await fs.promises.readdir(msgPath)
        const dbFiles = files.filter((f) => f === 'MSG.db' || WECHATDATABACKUP_MSG_PATTERN.test(f))

        for (const dbFile of dbFiles) {
          const dbPath = path.join(msgPath, dbFile)
          const dbMessages = await this.parseDecryptedDB(dbPath, selfUserId, ownerDisplayName)
          messages.push(...dbMessages)
        }
      } catch {
        // Folder structure not as expected
      }
    }

    // Sort by createTime
    messages.sort((a, b) => a.createTime - b.createTime)

    return messages
  }

  /**
   * Parse decrypted SQLite database
   *
   * This reads messages from a decrypted WeChat MSG.db database
   *
   * @param dbPath - Path to the SQLite database file
   * @returns Array of RawMessage objects
   */
  async parseDecryptedDB(
    dbPath: string,
    selfUserId: string = 'self',
    ownerDisplayName?: string
  ): Promise<RawMessage[]> {
    // Note: This requires better-sqlite3 which needs to be dynamically imported
    // to avoid issues in environments where native modules aren't available
    const messages: RawMessage[] = []

    try {
      // Dynamic import of better-sqlite3
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require('better-sqlite3')
      const db = new Database(dbPath, { readonly: true })

      // Query messages from MSG table
      // Reference: wechatDataBackup/pkg/wechat/wechatDataProvider.go
      const query = `
        SELECT 
          localId,
          MsgSvrID,
          Type,
          SubType,
          IsSender,
          CreateTime,
          ifnull(StrTalker,'') as StrTalker,
          ifnull(StrContent,'') as StrContent
        FROM MSG
        ORDER BY CreateTime ASC
      `

      const rows = db.prepare(query).all()

      for (const row of rows) {
        const conversationTitle =
          path.basename(dbPath, path.extname(dbPath)) ||
          (row.StrTalker || 'Unknown Session')
        messages.push({
          msgId: String(row.MsgSvrID || row.localId),
          msgType: row.Type,
          subType: row.SubType || undefined,
          content: row.StrContent || '',
          fromUser: row.IsSender ? selfUserId : row.StrTalker,
          toUser: row.IsSender ? row.StrTalker : selfUserId,
          createTime: row.CreateTime,
          isSend: row.IsSender === 1,
          speakerId: row.IsSender ? selfUserId : row.StrTalker,
          speakerName: row.IsSender ? ownerDisplayName || selfUserId : row.StrTalker,
          conversationTitle
        })
      }

      db.close()
    } catch (error) {
      // Database parsing failed - might not have better-sqlite3 installed
      // or database structure is different
      console.error('Failed to parse database:', error)
    }

    return messages
  }

  /**
   * Import data from a folder or file path
   *
   * This is the main entry point that auto-detects format and parses accordingly
   *
   * @param inputPath - Path to the data folder or file
   * @param selfUserId - The user's own ID (for CSV parsing)
   * @returns DataImportResult with messages and metadata
   */
  async importData(
    inputPath: string,
    selfUserId: string = 'self',
    ownerDisplayName?: string
  ): Promise<DataImportResult> {
    const format = await this.detectFormat(inputPath)
    const result: DataImportResult = {
      format,
      messages: [],
      contacts: [],
      errors: []
    }

    if (format === 'unknown') {
      result.errors.push(`Unable to detect data format for: ${inputPath}`)
      return result
    }

    try {
      switch (format) {
        case 'wechatmsg_csv': {
          const stats = await fs.promises.stat(inputPath)
          if (stats.isFile()) {
            result.messages = await this.parseSupportedWeChatCSV(inputPath, selfUserId, ownerDisplayName)
          } else {
            // Parse all CSV files in folder
            const files = await fs.promises.readdir(inputPath)
            const csvFiles = files.filter((f) => f.endsWith('.csv'))
            for (const csvFile of csvFiles) {
              const csvPath = path.join(inputPath, csvFile)
              if (await this.isRecognizedWeChatCSV(csvPath)) {
                const messages = await this.parseSupportedWeChatCSV(csvPath, selfUserId, ownerDisplayName)
                result.messages.push(...messages)
              }
            }
          }
          break
        }

        case 'wechatdatabackup':
          result.messages = await this.parseWechatDataBackup(inputPath, selfUserId, ownerDisplayName)
          break

        case 'decrypted_db':
          result.messages = await this.parseDecryptedDB(inputPath, selfUserId, ownerDisplayName)
          break
      }

      // Extract unique contacts
      const contactSet = new Set<string>()
      for (const msg of result.messages) {
        if (msg.fromUser !== selfUserId && msg.fromUser !== 'self') {
          contactSet.add(msg.fromUser)
        }
        if (msg.toUser !== selfUserId && msg.toUser !== 'self') {
          contactSet.add(msg.toUser)
        }
      }
      result.contacts = Array.from(contactSet)
    } catch (error) {
      result.errors.push(`Error parsing data: ${error}`)
    }

    return result
  }
}

// Export singleton instance
export const dataImporter = new DataImporter()
