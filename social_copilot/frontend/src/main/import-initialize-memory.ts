import type { RawMessage } from '../models'
import type { DataFormat, DataImportResult } from '../services/data-importer'
import type {
  ChatRecordEventRow,
  ChatRecordIngestResult,
  ChatRecordMaintenanceOptions
} from './chat-records'

export interface ProfileBackfillResult {
  scannedSessions: number
  processedSessions: number
  skippedSessions: number
  failedSessions: number
  updatedProfiles: number
  failedSessionNames: string[]
  failedReasons: string[]
  boundaryMode?: 'memcell'
}

export interface ImportInitializeMemoryProgress {
  stage: 'importing' | 'normalizing' | 'persisting' | 'backfilling' | 'complete'
  progress: number
  message: string
}

export interface ImportInitializeMemoryResult {
  success: boolean
  format: DataFormat
  importedMessages: number
  importedContacts: number
  writtenSessions: number
  appendedMessages: number
  initializedSessions: number
  skippedInitializationSessions: number
  failedInitializationSessions: number
  updatedProfiles: number
  failedSessionNames: string[]
  failedReasons: string[]
  errors: string[]
  boundaryMode?: 'memcell'
}

export interface ExecuteImportAndInitializeMemoryOptions {
  folderPath: string
  ownerUserId: string
  ownerDisplayName: string
  recordsDir: string
  limit?: number
  maintenanceOptions?: ChatRecordMaintenanceOptions
  importData: (
    folderPath: string,
    ownerUserId: string,
    ownerDisplayName?: string
  ) => Promise<DataImportResult>
  ingestChatRecords: (
    recordsDir: string,
    events: ChatRecordEventRow[],
    ownerUserId: string,
    ownerDisplayName: string,
    limit?: number,
    options?: ChatRecordMaintenanceOptions
  ) => Promise<ChatRecordIngestResult>
  backfillHistory: () => Promise<ProfileBackfillResult>
  onProgress?: (progress: ImportInitializeMemoryProgress) => void
}

export function convertImportedMessagesToChatRecordEvents(
  messages: RawMessage[],
  ownerUserId: string,
  ownerDisplayName?: string
): ChatRecordEventRow[] {
  return messages.map((message) =>
    convertImportedMessageToChatRecordEvent(message, ownerUserId, ownerDisplayName)
  )
}

export async function executeImportAndInitializeMemory(
  options: ExecuteImportAndInitializeMemoryOptions
): Promise<ImportInitializeMemoryResult> {
  reportProgress(options.onProgress, 'importing', 10, '正在读取历史聊天导出...')

  const importResult = await options.importData(
    options.folderPath,
    options.ownerUserId,
    options.ownerDisplayName
  )
  const baseErrors = [...importResult.errors]

  if (importResult.format === 'unknown') {
    return buildFailureResult(importResult.format, importResult, baseErrors)
  }

  if (importResult.messages.length === 0) {
    return buildFailureResult(importResult.format, importResult, [
      ...baseErrors,
      '未在导入目录中发现可用聊天消息。'
    ])
  }

  reportProgress(
    options.onProgress,
    'normalizing',
    35,
    `正在清洗并标准化 ${importResult.messages.length} 条历史消息...`
  )

  const events = convertImportedMessagesToChatRecordEvents(
    importResult.messages,
    options.ownerUserId,
    options.ownerDisplayName
  )
    .filter((event) => event.text.trim().length > 0)

  if (events.length === 0) {
    return buildFailureResult(importResult.format, importResult, [
      ...baseErrors,
      '导入消息无法转换为可写入的聊天记录。'
    ])
  }

  reportProgress(options.onProgress, 'persisting', 60, '正在写入本地 chat_records...')

  const ingestResult = await options.ingestChatRecords(
    options.recordsDir,
    events,
    options.ownerUserId,
    options.ownerDisplayName,
    options.limit ?? 20,
    options.maintenanceOptions
  )

  reportProgress(options.onProgress, 'backfilling', 85, '正在初始化 EverMemOS 记忆系统...')

  const backfillResult = await options.backfillHistory()
  const result: ImportInitializeMemoryResult = {
    success: true,
    format: importResult.format,
    importedMessages: importResult.messages.length,
    importedContacts: importResult.contacts.length,
    writtenSessions: ingestResult.updatedSessions.length,
    appendedMessages: ingestResult.updatedSessions.reduce((sum, item) => sum + item.appendedCount, 0),
    initializedSessions: backfillResult.processedSessions,
    skippedInitializationSessions: backfillResult.skippedSessions,
    failedInitializationSessions: backfillResult.failedSessions,
    updatedProfiles: backfillResult.updatedProfiles,
    failedSessionNames: backfillResult.failedSessionNames,
    failedReasons: backfillResult.failedReasons,
    errors: [...baseErrors, ...backfillResult.failedReasons],
    boundaryMode: backfillResult.boundaryMode
  }

  reportProgress(options.onProgress, 'complete', 100, '历史聊天导入与记忆初始化完成')
  return result
}

function buildFailureResult(
  format: DataFormat,
  importResult: DataImportResult,
  errors: string[]
): ImportInitializeMemoryResult {
  return {
    success: false,
    format,
    importedMessages: importResult.messages.length,
    importedContacts: importResult.contacts.length,
    writtenSessions: 0,
    appendedMessages: 0,
    initializedSessions: 0,
    skippedInitializationSessions: 0,
    failedInitializationSessions: 0,
    updatedProfiles: 0,
    failedSessionNames: [],
    failedReasons: [],
    errors
  }
}

function convertImportedMessageToChatRecordEvent(
  message: RawMessage,
  ownerUserId: string,
  ownerDisplayName?: string
): ChatRecordEventRow {
  const normalizedContent = normalizeImportedMessageContent(message)
  const conversationTitle =
    normalizeOptionalText(message.conversationTitle) ??
    deriveConversationTitle(message, ownerUserId, ownerDisplayName)
  const senderIdentity = normalizeOptionalText(message.speakerId) ?? message.fromUser
  const senderDisplayName =
    normalizeOptionalText(message.speakerName) ??
    (message.isSend ? ownerDisplayName ?? ownerUserId : senderIdentity)
  return {
    sender: message.isSend ? 'user' : 'contact',
    text: normalizedContent.text,
    sender_id: senderIdentity,
    sender_name: senderDisplayName,
    contact_name: conversationTitle,
    conversation_title: conversationTitle,
    window_id: '微信',
    session_key: `微信::${conversationTitle}`,
    content_type: normalizedContent.contentType,
    non_text_description: normalizedContent.nonTextDescription,
    timestamp: normalizeImportedTimestamp(message.createTime),
    event_id: normalizeOptionalText(message.msgId) ?? undefined
  }
}

interface ImportedMessageContentNormalization {
  text: string
  contentType: string
  nonTextDescription?: string | null
}

function normalizeImportedMessageContent(message: RawMessage): ImportedMessageContentNormalization {
  const rawContent = normalizeOptionalText(message.content) ?? ''
  const contentType = inferImportedContentType(message, rawContent)
  const isTextLike = contentType === 'text'

  if (isTextLike && rawContent.length > 0 && !looksLikeStructuredPayload(rawContent)) {
    return {
      text: rawContent,
      contentType: 'text',
      nonTextDescription: null
    }
  }

  const placeholder = buildImportedContentPlaceholder(message, rawContent, contentType)
  return {
    text: placeholder,
    contentType,
    nonTextDescription: contentType === 'text' ? null : placeholder
  }
}

function deriveConversationTitle(
  message: RawMessage,
  ownerUserId: string,
  ownerDisplayName?: string
): string {
  const normalizedOwner = new Set(
    [ownerUserId, ownerDisplayName]
      .map((value) => normalizeIdentity(value ?? null))
      .filter((value) => value.length > 0)
  )
  const sender = normalizeOptionalText(message.fromUser)
  const recipient = normalizeOptionalText(message.toUser)
  const fallback = sender || recipient || 'Unknown Session'

  if (message.isSend) {
    if (recipient && !isSelfAlias(recipient, normalizedOwner)) {
      return recipient
    }
    return fallback
  }

  if (sender && !isSelfAlias(sender, normalizedOwner)) {
    return sender
  }

  if (recipient && !isSelfAlias(recipient, normalizedOwner)) {
    return recipient
  }

  return fallback
}

function normalizeImportedTimestamp(createTime: number): string | undefined {
  if (!Number.isFinite(createTime) || createTime <= 0) {
    return undefined
  }
  let normalizedTime = createTime
  if (normalizedTime < 1e11) {
    normalizedTime *= 1000
  } else if (normalizedTime > 1e14) {
    normalizedTime = Math.floor(normalizedTime / 1000)
  }
  return new Date(normalizedTime).toISOString()
}

function normalizeIdentity(value: string | null): string {
  return (value ?? '').trim().toLowerCase()
}

function isSelfAlias(value: string, aliases: Set<string>): boolean {
  const normalized = normalizeIdentity(value)
  return normalized.length > 0 && aliases.has(normalized)
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function looksLikeStructuredPayload(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return (
    normalized.startsWith('<msg') ||
    normalized.startsWith('<xml') ||
    normalized.startsWith('<?xml') ||
    normalized.includes('<appmsg') ||
    normalized.includes('<emoji') ||
    normalized.includes('<img') ||
    normalized.includes('<videomsg') ||
    normalized.includes('<voicemsg')
  )
}

function inferImportedContentType(message: RawMessage, rawContent: string): string {
  if (message.msgType === 1 && !looksLikeStructuredPayload(rawContent)) {
    return 'text'
  }

  switch (message.msgType) {
    case 2:
    case 47:
      return 'image'
    case 3:
    case 43:
      return 'video'
    case 34:
      return 'audio'
    case 42:
      return 'card'
    case 48:
      return 'position'
    case 49:
      return inferStructuredAppContentType(rawContent)
    case 10000:
      return 'system'
    default:
      return looksLikeStructuredPayload(rawContent) ? inferStructuredAppContentType(rawContent) : 'text'
  }
}

function inferStructuredAppContentType(rawContent: string): string {
  const normalized = rawContent.trim().toLowerCase()
  if (!normalized) {
    return 'imported'
  }
  if (normalized.includes('<emoji') || normalized.includes('<img')) {
    return 'image'
  }
  if (normalized.includes('<videomsg')) {
    return 'video'
  }
  if (normalized.includes('<voicemsg')) {
    return 'audio'
  }
  if (normalized.includes('<location')) {
    return 'position'
  }
  if (normalized.includes('<type>6</type>') || normalized.includes('<attachfile')) {
    return 'file'
  }
  if (normalized.includes('<type>5</type>') || normalized.includes('<url>')) {
    return 'link'
  }
  if (normalized.includes('<type>2000</type>')) {
    return 'transfer'
  }
  if (normalized.includes('<type>2001</type>')) {
    return 'red-packet'
  }
  if (normalized.includes('<refermsg')) {
    return 'quote'
  }
  return 'imported'
}

function buildImportedContentPlaceholder(
  message: RawMessage,
  rawContent: string,
  contentType: string
): string {
  if (contentType === 'text') {
    return rawContent || '文本'
  }

  switch (contentType) {
    case 'image':
      return '图片'
    case 'video':
      return '视频'
    case 'audio':
      return '语音'
    case 'card':
      return '名片'
    case 'position':
      return '位置'
    case 'file':
      return '文件'
    case 'link':
      return '链接'
    case 'transfer':
      return '转账'
    case 'red-packet':
      return '红包'
    case 'quote':
      return '引用消息'
    case 'system':
      return rawContent && !looksLikeStructuredPayload(rawContent) ? rawContent : '系统消息'
    default:
      if (message.msgType === 47 || looksLikeStructuredPayload(rawContent)) {
        return '图片'
      }
      return '图片'
  }
}

function reportProgress(
  callback: ExecuteImportAndInitializeMemoryOptions['onProgress'],
  stage: ImportInitializeMemoryProgress['stage'],
  progress: number,
  message: string
): void {
  if (!callback) {
    return
  }
  callback({ stage, progress, message })
}
