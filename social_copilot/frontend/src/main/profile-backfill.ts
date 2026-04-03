import type { ChatRecordEntry, StoredChatRecordSession } from './chat-records'

export interface BackfillSelectionOptions {
  forceFullRebuild?: boolean
  deletedSessionKeys?: Set<string>
  sessionBackfillProgress?: Record<string, string>
}

export interface BackfillSessionSummary {
  sessionKey: string
  sessionName: string
  messageCount: number
  pendingMessageCount: number
  updatedAt: string
  lastProcessedTimestamp: string | null
}

export const PROFILE_BACKFILL_MIN_TIMEOUT_MS = 1_000
export const PROFILE_BACKFILL_DEFAULT_MESSAGE_BUDGET_SECONDS = 3

export function mergeBackfillProgress(
  currentProgress: Record<string, string> | null | undefined,
  updatedProgress: Record<string, string>
): Record<string, string> {
  return {
    ...(currentProgress ?? {}),
    ...updatedProgress
  }
}

function normalizeLookupText(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

export function selectBackfillMessages(
  session: Pick<StoredChatRecordSession, 'sessionKey' | 'recentMessages'>,
  options: BackfillSelectionOptions = {}
): ChatRecordEntry[] {
  const forceFullRebuild = options.forceFullRebuild ?? false
  const sessionKey = normalizeLookupText(session.sessionKey)
  const deletedSessionKeys = options.deletedSessionKeys ?? new Set<string>()
  const sessionBackfillProgress = options.sessionBackfillProgress ?? {}
  const messages = session.recentMessages ?? []

  if (forceFullRebuild) {
    return messages
  }

  if (sessionKey && deletedSessionKeys.has(sessionKey)) {
    return []
  }

  const lastProcessedTimestamp = sessionKey ? sessionBackfillProgress[sessionKey] : undefined
  if (!lastProcessedTimestamp) {
    return messages
  }

  return messages.filter((message) => {
    if (!message.timestamp) {
      return true
    }
    return message.timestamp > lastProcessedTimestamp
  })
}

export function chunkBackfillMessages(
  messages: ChatRecordEntry[],
  chunkSize: number
): ChatRecordEntry[][] {
  const normalizedChunkSize = Number.isFinite(chunkSize)
    ? Math.max(1, Math.floor(chunkSize))
    : 100
  if (messages.length === 0) {
    return []
  }

  const chunks: ChatRecordEntry[][] = []
  for (let index = 0; index < messages.length; index += normalizedChunkSize) {
    chunks.push(messages.slice(index, index + normalizedChunkSize))
  }
  return chunks
}

export function computeBackfillChunkTimeoutMs(
  requestTimeoutMs: number | null | undefined,
  chunkMessageCount: number,
  messageBudgetSeconds: number | null | undefined
): number {
  const normalizedChunkMessageCount = Number.isFinite(chunkMessageCount)
    ? Math.max(1, Math.floor(chunkMessageCount))
    : 1
  const normalizedRequestTimeoutMs = Number.isFinite(requestTimeoutMs)
    ? Math.max(0, Math.floor(requestTimeoutMs ?? 0))
    : 0
  const normalizedMessageBudgetSeconds = Number.isFinite(messageBudgetSeconds)
    ? Math.max(1, Math.floor(messageBudgetSeconds ?? PROFILE_BACKFILL_DEFAULT_MESSAGE_BUDGET_SECONDS))
    : PROFILE_BACKFILL_DEFAULT_MESSAGE_BUDGET_SECONDS
  const scaledTimeoutMs = normalizedChunkMessageCount * normalizedMessageBudgetSeconds * 1000

  return Math.max(normalizedRequestTimeoutMs, PROFILE_BACKFILL_MIN_TIMEOUT_MS, scaledTimeoutMs)
}

export function summarizeBackfillSession(
  session: Pick<StoredChatRecordSession, 'sessionKey' | 'sessionName' | 'updatedAt' | 'messageCount' | 'recentMessages'>,
  options: BackfillSelectionOptions = {}
): BackfillSessionSummary {
  const pendingMessages = selectBackfillMessages(session, options)
  const sessionKey = normalizeLookupText(session.sessionKey)
  const lastProcessedTimestamp = sessionKey
    ? options.sessionBackfillProgress?.[sessionKey] ?? null
    : null

  return {
    sessionKey: session.sessionKey,
    sessionName: session.sessionName,
    messageCount: session.messageCount,
    pendingMessageCount: pendingMessages.length,
    updatedAt: session.updatedAt,
    lastProcessedTimestamp
  }
}
