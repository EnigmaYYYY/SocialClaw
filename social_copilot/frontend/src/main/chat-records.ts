import { mkdir, readFile, readdir, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

const DEFAULT_MAX_RECORDS = 2000
const DEFAULT_WINDOW_SIZE = 120
const DEFAULT_MEDIA_SIMILARITY_THRESHOLD = 0.85
const DEFAULT_TEXT_SIMILARITY_THRESHOLD = 0.94
const DEFAULT_CAPTURE_DEDUP_WINDOW_MS = 2 * 60 * 1000

interface DuplicateDecision {
  duplicate: boolean
  replaceIndex: number | null
}

export interface ChatRecordEventRow {
  sender: 'user' | 'contact' | 'unknown'
  text: string
  sender_id?: string
  sender_name?: string
  quoted_message?: {
    text: string
    sender_name?: string | null
  } | null
  contact_name?: string | null
  conversation_title?: string | null
  conversationTitle?: string | null
  window_id?: string | null
  session_key?: string | null
  content_type?: string | null
  non_text_description?: string | null
  non_text_signature?: string | null
  time_anchor?: string | null
  timestamp?: string
  event_id?: string
  frame_id?: string
  metadata?: {
    contact_name?: string | null
    window_id?: string | null
    conversation_title?: string | null
    session_key?: string | null
    non_text_description?: string | null
    non_text_signature?: string | null
    event_id?: string | null
    frame_id?: string | null
    time_anchor?: string | null
    capture_timestamp?: string | null
  }
}

export interface ChatRecordEntry {
  message_id: string
  conversation_id: string
  sender_id: string
  sender_name: string
  sender_type: 'user' | 'contact' | 'unknown'
  content: string
  timestamp: string | null
  content_type: string
  reply_to: string | null
  quoted_message?: {
    text: string
    sender_name: string | null
  } | null
  metadata: {
    window_id: string | null
    non_text_description: string | null
    non_text_signature?: string | null
    capture_timestamp?: string | null
    event_id: string | null
    frame_id: string | null
  }
  readonly sender?: 'user' | 'contact' | 'unknown'
  readonly text?: string
  readonly contact_name?: string | null
  readonly conversation_title?: string | null
  readonly window_id?: string | null
  readonly session_key?: string
  readonly non_text_description?: string | null
  readonly event_id?: string | null
  readonly frame_id?: string | null
}

interface ChatRecordFile {
  schema_version?: number
  session_name: string
  session_key: string
  app_name: string
  canonical_title_key?: string
  title_aliases?: string[]
  confirmed_title_aliases?: string[]
  owner_user_id?: string
  updated_at: string
  messages: ChatRecordEntry[]
}

interface PendingChatRecordFile {
  schema_version?: number
  pending_id: string
  session_name: string
  session_key: string
  app_name: string
  suggested_session_name?: string | null
  suggested_session_key?: string | null
  title_aliases?: string[]
  owner_user_id?: string
  updated_at: string
  messages: ChatRecordEntry[]
}

interface SessionNameMappingsFile {
  schema_version?: number
  mappings_by_owner?: Record<string, Record<string, string>>
  mappings?: Record<string, string>
}

export interface ChatRecordCurrentSession {
  sessionKey: string
  sessionName: string
  filePath: string
  recentMessages: ChatRecordEntry[]
}

export interface PendingChatRecordSession {
  pendingId: string
  sessionKey: string
  sessionName: string
  filePath: string
  suggestedSessionKey: string | null
  suggestedSessionName: string | null
  recentMessages: ChatRecordEntry[]
}

export interface ChatRecordUpdatedSession {
  sessionKey: string
  sessionName: string
  filePath: string
  appendedCount: number
}

export interface StoredChatRecordSession {
  sessionKey: string
  sessionName: string
  filePath: string
  updatedAt: string
  messageCount: number
  recentMessages: ChatRecordEntry[]
}

export interface ChatRecordRepairResult {
  scannedFiles: number
  repairedFiles: number
  repairedMessages: number
}

export interface ChatRecordIngestResult {
  currentSession: ChatRecordCurrentSession
  latestUpdatedSession: ChatRecordCurrentSession | null
  updatedSessions: ChatRecordUpdatedSession[]
  pendingConfirmation: PendingChatRecordSession | null
}

export interface ChatRecordMaintenanceOptions {
  captureDedupWindowMs?: number | null
  sessionConfirmationMode?: 'off' | 'realtime' | null
}

interface SessionSplit {
  appName: string
  sessionName: string
}

interface StoredSessionCandidate {
  sessionKey: string
  sessionName: string
  filePath: string
  appName: string
  canonicalTitleKey: string | null
  titleAliases: string[]
  confirmedTitleAliases: string[]
}

interface StoredSessionMatch {
  candidate: StoredSessionCandidate
  score: number
  exact: boolean
  aliasScore: number
  confirmedAliasScore: number
  matchedViaConfirmedAlias: boolean
}

interface PendingSessionCandidate {
  pendingId: string
  sessionKey: string
  sessionName: string
  filePath: string
  appName: string
  suggestedSessionKey: string | null
  suggestedSessionName: string | null
  titleAliases: string[]
  messages: ChatRecordEntry[]
}

const CHAT_RECORD_SCHEMA_VERSION = 3
const PENDING_CHAT_RECORD_SCHEMA_VERSION = 1
const PENDING_SESSIONS_DIR_NAME = '.pending_sessions'
const SESSION_ALIAS_SIMILARITY_THRESHOLD = 0.76
const CONFIRMED_SESSION_ALIAS_SIMILARITY_THRESHOLD = 0.5
const AUTO_REUSE_ALIAS_COUNT_THRESHOLD = 2
const WECHAT_APP_NAME = '\u5fae\u4fe1'
const WINDOW_DEFAULT_APP_NAME = 'window-default'
const UNKNOWN_APP_NAMES = new Set(['unknown', 'unknown_app', 'n/a', 'na', 'none', 'null'])
const NAME_MAPPINGS_FILE_NAME = '.name_mappings.json'
const NAME_MAPPINGS_SCHEMA_VERSION = 1

const INVISIBLE_TITLE_REGEX = /[\u200B-\u200D\uFE0E\uFE0F]/gu
const TITLE_TEXT_CHAR_REGEX = /[A-Za-z0-9\u3400-\u9fff]/
const CAPTURE_FALLBACK_PREFIX = 'capture_fallback:'
const LEGACY_LOCAL_FRAME_ID_REGEX = /^f_\d+$/i
const LEGACY_LOCAL_EVENT_ID_REGEX = /^m_\d+$/i
const PUBLIC_FRAME_ID_SUFFIX_REGEX = /_\d{8}T\d{12}Z$/i
const NON_TEXT_SIGNATURE_STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'with',
  'and',
  'sticker',
  'emoji',
  'image',
  'photo',
  'picture',
  'animated',
  'animation',
  '表情',
  '表情包',
  '图片',
  '照片',
  '截图'
])

function attachLegacyAliases(
  entry: ChatRecordEntry,
  aliases?: {
    contact_name?: string | null
    conversation_title?: string | null
    session_key?: string | null
  }
): ChatRecordEntry {
  const conversationTitle =
    normalizeConversationTitle(aliases?.conversation_title ?? null)
    || deriveConversationTitleFromConversationId(entry.conversation_id)
  const contactName =
    normalizeOptionalText(aliases?.contact_name ?? null)
    || (entry.sender_type === 'contact' ? entry.sender_name : null)
  const sessionKey = normalizeOptionalText(aliases?.session_key ?? null) || entry.conversation_id
  Object.defineProperties(entry, {
    sender: { value: entry.sender_type, enumerable: false },
    text: { value: entry.content, enumerable: false },
    contact_name: { value: contactName, enumerable: false },
    conversation_title: { value: conversationTitle, enumerable: false },
    window_id: { value: entry.metadata.window_id, enumerable: false },
    session_key: { value: sessionKey, enumerable: false },
    non_text_description: { value: entry.metadata.non_text_description, enumerable: false },
    event_id: { value: entry.metadata.event_id, enumerable: false },
    frame_id: { value: entry.metadata.frame_id, enumerable: false }
  })
  return entry
}

export async function ingestChatRecordsAndGetRecent(
  recordsDir: string,
  events: ChatRecordEventRow[],
  ownerUserId: string,
  ownerDisplayName: string,
  limit: number = 10,
  options?: ChatRecordMaintenanceOptions
): Promise<ChatRecordIngestResult> {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('events cannot be empty')
  }

  await mkdir(recordsDir, { recursive: true })
  const normalized = events
    .map((item) => normalizeChatRecordEvent(item, ownerDisplayName))
    .filter((item): item is ChatRecordEntry => item !== null)
  if (normalized.length === 0) {
    throw new Error('no_valid_events')
  }

  const grouped = new Map<string, ChatRecordEntry[]>()
  for (const row of normalized) {
    const sessionKey = row.conversation_id
    if (!grouped.has(sessionKey)) {
      grouped.set(sessionKey, [])
    }
    grouped.get(sessionKey)?.push(row)
  }

  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 10
  const captureDedupWindowMs = normalizeCaptureDedupWindowMs(options?.captureDedupWindowMs)
  const confirmationEnabled = options?.sessionConfirmationMode === 'realtime'
  const updatedSessions: ChatRecordUpdatedSession[] = []
  const currentSessionKey = normalized[normalized.length - 1]?.conversation_id
  let currentSession: ChatRecordCurrentSession | null = null
  const sessionSnapshots = new Map<string, ChatRecordCurrentSession>()
  let pendingConfirmation: PendingChatRecordSession | null = null
  const confirmedCandidateCache = new Map<string, StoredSessionCandidate[]>()
  const pendingCandidateCache = new Map<string, PendingSessionCandidate[]>()
  const sessionNameMappings = await loadSessionNameMappings(recordsDir, ownerUserId)

  for (const [sessionKey, rows] of grouped.entries()) {
    const split = splitSessionKey(sessionKey)
    const authoritativeTitleKey = resolveAuthoritativeSessionTitleKey(sessionKey, split.sessionName)
    const displaySessionNameRaw = resolveDisplaySessionName(
      rows.map((row) => row.conversation_title ?? deriveConversationTitleFromConversationId(row.conversation_id)).reverse(),
      split.sessionName,
      authoritativeTitleKey
    )
    const mappedSessionName = resolveMappedSessionName(displaySessionNameRaw, sessionNameMappings)
    const displaySessionName = mappedSessionName || displaySessionNameRaw
    if (!confirmationEnabled) {
      const appDir = join(recordsDir, sanitizeSessionName(split.appName))
      await mkdir(appDir, { recursive: true })
      const filePath = join(appDir, `${sanitizeSessionName(split.sessionName)}.json`)
      const snapshot = await appendRowsToStoredChatRecordFile(
        recordsDir,
        filePath,
        {
          appName: split.appName,
          sessionKey,
          sessionName: displaySessionName
        },
        rows,
        ownerUserId,
        safeLimit,
        captureDedupWindowMs
      )
      updatedSessions.push({
        sessionKey: snapshot.sessionKey,
        sessionName: snapshot.sessionName,
        filePath: snapshot.filePath,
        appendedCount: snapshot.appendedCount
      })
      const currentSnapshot: ChatRecordCurrentSession = {
        sessionKey: snapshot.sessionKey,
        sessionName: snapshot.sessionName,
        filePath: snapshot.filePath,
        recentMessages: snapshot.recentMessages
      }
      sessionSnapshots.set(snapshot.sessionKey, currentSnapshot)
      if (sessionKey === currentSessionKey) {
        currentSession = currentSnapshot
      }
      continue
    }
    const confirmedCandidates = await getStoredSessionCandidates(
      recordsDir,
      split.appName,
      confirmedCandidateCache,
      options
    )
    const storedMatch = findBestStoredSessionMatch(confirmedCandidates, displaySessionName)

    if (mappedSessionName && (!storedMatch || !storedMatch.exact)) {
      const mappedSessionKey = normalizeSessionKey(null, split.appName, mappedSessionName, mappedSessionName)
      const mappedSplit = splitSessionKey(mappedSessionKey)
      const appDir = join(recordsDir, sanitizeSessionName(mappedSplit.appName))
      await mkdir(appDir, { recursive: true })
      const filePath = join(appDir, `${sanitizeSessionName(mappedSplit.sessionName)}.json`)
      const snapshot = await appendRowsToStoredChatRecordFile(
        recordsDir,
        filePath,
        {
          appName: mappedSplit.appName,
          sessionKey: mappedSessionKey,
          sessionName: mappedSessionName
        },
        rows,
        ownerUserId,
        safeLimit,
        captureDedupWindowMs,
        [displaySessionNameRaw, ...rows.map((row) => row.conversation_title ?? null)]
      )
      updatedSessions.push({
        sessionKey: snapshot.sessionKey,
        sessionName: snapshot.sessionName,
        filePath: snapshot.filePath,
        appendedCount: snapshot.appendedCount
      })
      const currentSnapshot: ChatRecordCurrentSession = {
        sessionKey: snapshot.sessionKey,
        sessionName: snapshot.sessionName,
        filePath: snapshot.filePath,
        recentMessages: snapshot.recentMessages
      }
      sessionSnapshots.set(snapshot.sessionKey, currentSnapshot)
      if (sessionKey === currentSessionKey) {
        currentSession = currentSnapshot
      }
      confirmedCandidateCache.delete(split.appName)
      continue
    }

    if (storedMatch && (storedMatch.exact || canAutoReuseStoredSessionMatch(storedMatch))) {
      const snapshot = await appendRowsToStoredChatRecordFile(
        recordsDir,
        storedMatch.candidate.filePath,
        {
          appName: storedMatch.candidate.appName,
          sessionKey: storedMatch.candidate.sessionKey,
          sessionName: storedMatch.candidate.sessionName
        },
        rows,
        ownerUserId,
        safeLimit,
        captureDedupWindowMs,
        storedMatch.matchedViaConfirmedAlias
          ? [displaySessionName, ...rows.map((row) => row.conversation_title ?? null)]
          : []
      )

      updatedSessions.push({
        sessionKey: snapshot.sessionKey,
        sessionName: snapshot.sessionName,
        filePath: snapshot.filePath,
        appendedCount: snapshot.appendedCount
      })

      const currentSnapshot: ChatRecordCurrentSession = {
        sessionKey: snapshot.sessionKey,
        sessionName: snapshot.sessionName,
        filePath: snapshot.filePath,
        recentMessages: snapshot.recentMessages
      }
      sessionSnapshots.set(snapshot.sessionKey, currentSnapshot)
      if (sessionKey === currentSessionKey) {
        currentSession = currentSnapshot
      }
      confirmedCandidateCache.delete(split.appName)
      continue
    }

    const shouldRequireConfirmation = !storedMatch || !storedMatch.exact
    if (shouldRequireConfirmation) {
      const pendingCandidates = await getPendingSessionCandidates(
        recordsDir,
        split.appName,
        pendingCandidateCache
      )
      const pendingMatch = findBestPendingSessionMatch(pendingCandidates, displaySessionName, storedMatch)
      const pendingSnapshot = await appendRowsToPendingChatRecordFile(
        recordsDir,
        pendingMatch,
        {
          appName: split.appName,
          sessionKey,
          sessionName: displaySessionName,
          suggestedSessionKey: storedMatch?.candidate.sessionKey ?? null,
          suggestedSessionName: storedMatch?.candidate.sessionName ?? null
        },
        rows,
        ownerUserId,
        safeLimit,
        captureDedupWindowMs
      )

      if (sessionKey === currentSessionKey) {
        currentSession = {
          sessionKey: pendingSnapshot.sessionKey,
          sessionName: pendingSnapshot.sessionName,
          filePath: pendingSnapshot.filePath,
          recentMessages: pendingSnapshot.recentMessages
        }
        pendingConfirmation = pendingSnapshot
      }
      pendingCandidateCache.delete(split.appName)
      continue
    }
  }

  if (!currentSession && updatedSessions.length > 0) {
    const fallback = updatedSessions[updatedSessions.length - 1]
    const split = splitSessionKey(fallback.sessionKey)
    const file = await loadChatRecordFile(fallback.filePath, split)
    currentSession = {
      sessionKey: fallback.sessionKey,
      sessionName: fallback.sessionName,
      filePath: fallback.filePath,
      recentMessages: file.messages.slice(-safeLimit)
    }
  }

  if (!currentSession) {
    if (pendingConfirmation) {
      currentSession = {
        sessionKey: pendingConfirmation.sessionKey,
        sessionName: pendingConfirmation.sessionName,
        filePath: pendingConfirmation.filePath,
        recentMessages: pendingConfirmation.recentMessages
      }
    } else {
      throw new Error('current_session_not_found')
    }
  }

  const appendedSessionKeys = new Set(
    updatedSessions.filter((item) => item.appendedCount > 0).map((item) => item.sessionKey)
  )
  let latestUpdatedSession: ChatRecordCurrentSession | null = null
  if (appendedSessionKeys.size > 0) {
    for (let index = normalized.length - 1; index >= 0; index -= 1) {
      const sessionKey = normalized[index]?.conversation_id
      if (!sessionKey || !appendedSessionKeys.has(sessionKey)) {
        continue
      }
      latestUpdatedSession = sessionSnapshots.get(sessionKey) ?? null
      if (latestUpdatedSession) {
        break
      }
    }
  }

  return {
    currentSession,
    latestUpdatedSession,
    updatedSessions,
    pendingConfirmation
  }
}

export async function loadStoredChatRecordSessions(
  recordsDir: string,
  ownerUserId: string,
  limitPerSession: number = DEFAULT_WINDOW_SIZE,
  options?: ChatRecordMaintenanceOptions
): Promise<StoredChatRecordSession[]> {
  await mkdir(recordsDir, { recursive: true })
  const filePaths = await collectChatRecordFiles(recordsDir, ownerUserId)
  const loadAllMessages = Number.isFinite(limitPerSession) && limitPerSession <= 0
  const safeLimit = loadAllMessages
    ? null
    : (Number.isFinite(limitPerSession)
      ? Math.max(1, Math.min(limitPerSession, DEFAULT_MAX_RECORDS))
      : DEFAULT_WINDOW_SIZE)
  const sessions: StoredChatRecordSession[] = []

  for (const filePath of filePaths) {
    try {
      const raw = await readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<ChatRecordFile>
      if (!parsed || !Array.isArray(parsed.messages)) {
        continue
      }

      // Filter by owner_user_id
      if (ownerUserId && parsed.owner_user_id && parsed.owner_user_id !== ownerUserId) {
        continue
      }

      const fallback = buildFallbackSessionFromFilePath(recordsDir, filePath)
      const loaded = await loadChatRecordFile(filePath, fallback, options)
      if (loaded.messages.length === 0) {
        continue
      }

      sessions.push({
        sessionKey: loaded.session_key,
        sessionName: loaded.session_name,
        filePath,
        updatedAt: loaded.updated_at,
        messageCount: loaded.messages.length,
        recentMessages: safeLimit === null ? loaded.messages : loaded.messages.slice(-safeLimit)
      })
    } catch {
      // Ignore malformed files during backfill discovery.
    }
  }

  sessions.sort((a, b) => {
    const timeA = Date.parse(a.updatedAt || '') || 0
    const timeB = Date.parse(b.updatedAt || '') || 0
    return timeB - timeA
  })

  return sessions
}

export async function loadRecentChatRecordSession(
  recordsDir: string,
  ownerUserId: string,
  sessionKey: string,
  limit: number = 10,
  options?: ChatRecordMaintenanceOptions
): Promise<ChatRecordCurrentSession | null> {
  const normalizedTarget = normalizeOptionalText(sessionKey)
  if (!normalizedTarget) {
    return null
  }

  const sessions = await loadStoredChatRecordSessions(recordsDir, ownerUserId, limit, options)
  const matched = sessions.find((session) => normalizeOptionalText(session.sessionKey) === normalizedTarget)
  if (!matched) {
    return null
  }

  return {
    sessionKey: matched.sessionKey,
    sessionName: matched.sessionName,
    filePath: matched.filePath,
    recentMessages: matched.recentMessages
  }
}

export async function confirmPendingChatRecordSession(
  recordsDir: string,
  pendingId: string,
  confirmedSessionName: string,
  ownerUserId: string,
  ownerDisplayName: string,
  limit: number = 10,
  options?: ChatRecordMaintenanceOptions
): Promise<ChatRecordCurrentSession> {
  const normalizedPendingId = normalizeOptionalText(pendingId)
  const normalizedConfirmedSessionName = normalizeConversationTitle(confirmedSessionName)
  if (!normalizedPendingId) {
    throw new Error('pendingId is required')
  }
  if (!normalizedConfirmedSessionName) {
    throw new Error('confirmedSessionName is required')
  }

  await mkdir(recordsDir, { recursive: true })
  const pendingCandidate = await findPendingSessionCandidateById(recordsDir, normalizedPendingId)
  if (!pendingCandidate) {
    throw new Error('pending_session_not_found')
  }

  const storedCandidates = await getStoredSessionCandidates(
    recordsDir,
    pendingCandidate.appName,
    new Map(),
    options
  )
  const explicitMatch = findBestStoredSessionMatch(storedCandidates, normalizedConfirmedSessionName)
  const targetSessionKey = explicitMatch?.exact
    ? explicitMatch.candidate.sessionKey
    : normalizeSessionKey(null, pendingCandidate.appName, normalizedConfirmedSessionName, normalizedConfirmedSessionName)
  const targetSplit = splitSessionKey(targetSessionKey)
  const targetAppDir = join(recordsDir, sanitizeSessionName(targetSplit.appName))
  await mkdir(targetAppDir, { recursive: true })
  const targetFilePath = explicitMatch?.exact
    ? explicitMatch.candidate.filePath
    : join(targetAppDir, `${sanitizeSessionName(targetSplit.sessionName)}.json`)

  const captureDedupWindowMs = normalizeCaptureDedupWindowMs(options?.captureDedupWindowMs)
  const existing = await loadChatRecordFile(targetFilePath, {
    appName: targetSplit.appName,
    sessionName: normalizedConfirmedSessionName
  }, options)
  const pendingRows = retargetChatRecordEntriesToSession(
    pendingCandidate.messages,
    targetSessionKey,
    normalizedConfirmedSessionName
  )
  const mergedMessages = mergeRecordMessages(
    existing.messages,
    pendingRows,
    DEFAULT_WINDOW_SIZE,
    DEFAULT_MEDIA_SIMILARITY_THRESHOLD,
    captureDedupWindowMs
  )
  const next: ChatRecordFile = {
    schema_version: CHAT_RECORD_SCHEMA_VERSION,
    session_name: normalizedConfirmedSessionName,
    session_key: targetSessionKey,
    app_name: targetSplit.appName,
    canonical_title_key: normalizeSessionTitleKey(normalizedConfirmedSessionName) || targetSplit.sessionName,
    title_aliases: mergeForcedTitleAliases(
      mergeTitleAliases(
        existing.title_aliases,
        existing.session_name,
        pendingRows,
        normalizedConfirmedSessionName,
        normalizeSessionTitleKey(normalizedConfirmedSessionName) || targetSplit.sessionName
      ),
      [
        ...pendingCandidate.titleAliases,
        pendingCandidate.sessionName
      ]
    ),
    confirmed_title_aliases: mergeForcedTitleAliases(
      existing.confirmed_title_aliases,
      [
        ...pendingCandidate.titleAliases,
        pendingCandidate.sessionName
      ]
    ),
    owner_user_id: ownerUserId || existing.owner_user_id,
    updated_at: new Date().toISOString(),
    messages: mergedMessages
  }
  await writeFile(targetFilePath, JSON.stringify(next, null, 2), 'utf-8')
  await unlink(pendingCandidate.filePath).catch(() => undefined)
  const sessionNameMappings = await loadSessionNameMappings(recordsDir, ownerUserId)
  const mappingChanged = learnSessionNameMappingsFromPending(
    pendingCandidate,
    normalizedConfirmedSessionName,
    sessionNameMappings
  )
  if (mappingChanged) {
    await saveSessionNameMappings(recordsDir, ownerUserId, sessionNameMappings)
  }

  return {
    sessionKey: targetSessionKey,
    sessionName: normalizedConfirmedSessionName,
    filePath: targetFilePath,
    recentMessages: mergedMessages.slice(-Math.min(Math.max(limit, 1), 100))
  }
}

async function appendRowsToStoredChatRecordFile(
  recordsDir: string,
  filePath: string,
  target: { appName: string; sessionKey: string; sessionName: string },
  rows: ChatRecordEntry[],
  ownerUserId: string,
  limit: number,
  captureDedupWindowMs: number,
  forcedTitleAliases: Array<string | null | undefined> = []
): Promise<ChatRecordCurrentSession & { appendedCount: number }> {
  const targetSplit = splitSessionKey(target.sessionKey)
  const existing = await loadChatRecordFile(filePath, {
    appName: target.appName,
    sessionName: target.sessionName
  })
  const retargetedRows = retargetChatRecordEntriesToSession(rows, target.sessionKey, target.sessionName)
  const mergedMessages = mergeRecordMessages(
    existing.messages,
    retargetedRows,
    DEFAULT_WINDOW_SIZE,
    DEFAULT_MEDIA_SIMILARITY_THRESHOLD,
    captureDedupWindowMs
  )
  const appendedCount = Math.max(0, mergedMessages.length - existing.messages.length)
  const next: ChatRecordFile = {
    schema_version: CHAT_RECORD_SCHEMA_VERSION,
    session_name: target.sessionName,
    session_key: target.sessionKey,
    app_name: target.appName,
    canonical_title_key: normalizeSessionTitleKey(target.sessionName) || targetSplit.sessionName,
    title_aliases: mergeForcedTitleAliases(
      mergeTitleAliases(
        existing.title_aliases,
        existing.session_name,
        rows,
        target.sessionName,
        normalizeSessionTitleKey(target.sessionName) || targetSplit.sessionName
      ),
      forcedTitleAliases
    ),
    confirmed_title_aliases: existing.confirmed_title_aliases ?? [],
    owner_user_id: ownerUserId || existing.owner_user_id,
    updated_at: new Date().toISOString(),
    messages: mergedMessages
  }
  await writeFile(filePath, JSON.stringify(next, null, 2), 'utf-8')
  return {
    sessionKey: target.sessionKey,
    sessionName: target.sessionName,
    filePath,
    appendedCount,
    recentMessages: mergedMessages.slice(-limit)
  }
}

async function appendRowsToPendingChatRecordFile(
  recordsDir: string,
  existingPending: PendingSessionCandidate | null,
  target: {
    appName: string
    sessionKey: string
    sessionName: string
    suggestedSessionKey: string | null
    suggestedSessionName: string | null
  },
  rows: ChatRecordEntry[],
  ownerUserId: string,
  limit: number,
  captureDedupWindowMs: number
): Promise<PendingChatRecordSession> {
  const pendingId = existingPending?.pendingId || buildPendingSessionId(target)
  const filePath = existingPending?.filePath || join(
    getPendingSessionsRoot(recordsDir),
    sanitizeSessionName(target.appName),
    `${pendingId}.json`
  )
  await mkdir(join(getPendingSessionsRoot(recordsDir), sanitizeSessionName(target.appName)), { recursive: true })
  const pendingFile = await loadPendingChatRecordFile(filePath, {
    appName: target.appName,
    sessionName: target.sessionName,
    sessionKey: target.sessionKey,
    pendingId,
    suggestedSessionKey: target.suggestedSessionKey,
    suggestedSessionName: target.suggestedSessionName
  })
  const mergedMessages = mergeRecordMessages(
    pendingFile.messages,
    rows,
    DEFAULT_WINDOW_SIZE,
    DEFAULT_MEDIA_SIMILARITY_THRESHOLD,
    captureDedupWindowMs
  )
  const next: PendingChatRecordFile = {
    schema_version: PENDING_CHAT_RECORD_SCHEMA_VERSION,
    pending_id: pendingId,
    session_name: pendingFile.session_name,
    session_key: pendingFile.session_key,
    app_name: pendingFile.app_name,
    suggested_session_key: target.suggestedSessionKey ?? pendingFile.suggested_session_key ?? null,
    suggested_session_name: target.suggestedSessionName ?? pendingFile.suggested_session_name ?? null,
    title_aliases: mergePendingTitleAliases(
      pendingFile.title_aliases,
      pendingFile.session_name,
      rows,
      target.sessionName
    ),
    owner_user_id: ownerUserId || pendingFile.owner_user_id,
    updated_at: new Date().toISOString(),
    messages: mergedMessages
  }
  await writeFile(filePath, JSON.stringify(next, null, 2), 'utf-8')
  return {
    pendingId,
    sessionKey: next.session_key,
    sessionName: next.session_name,
    filePath,
    suggestedSessionKey: next.suggested_session_key ?? null,
    suggestedSessionName: next.suggested_session_name ?? null,
    recentMessages: mergedMessages.slice(-limit)
  }
}

async function getStoredSessionCandidates(
  recordsDir: string,
  appName: string,
  cache: Map<string, StoredSessionCandidate[]>,
  options?: ChatRecordMaintenanceOptions
): Promise<StoredSessionCandidate[]> {
  const cached = cache.get(appName)
  if (cached) {
    return cached
  }
  const filePaths = await collectChatRecordFiles(recordsDir)
  const candidates: StoredSessionCandidate[] = []
  for (const filePath of filePaths) {
    const fallback = buildFallbackSessionFromFilePath(recordsDir, filePath)
    if (fallback.appName !== sanitizeSessionName(appName)) {
      continue
    }
    const loaded = await loadChatRecordFile(filePath, fallback, options)
    candidates.push({
      sessionKey: loaded.session_key,
      sessionName: loaded.session_name,
      filePath,
      appName: loaded.app_name,
      canonicalTitleKey: normalizeSessionTitleKey(loaded.canonical_title_key ?? loaded.session_name),
      titleAliases: mergeTitleAliases(
        loaded.title_aliases,
        loaded.session_name,
        [],
        loaded.session_name,
        normalizeSessionTitleKey(loaded.session_name) || fallback.sessionName
      ),
      confirmedTitleAliases: normalizeConfirmedTitleAliases(loaded.confirmed_title_aliases)
    })
  }
  cache.set(appName, candidates)
  return candidates
}

async function getPendingSessionCandidates(
  recordsDir: string,
  appName: string,
  cache: Map<string, PendingSessionCandidate[]>
): Promise<PendingSessionCandidate[]> {
  const cached = cache.get(appName)
  if (cached) {
    return cached
  }
  const filePaths = await collectPendingSessionFiles(recordsDir, appName)
  const candidates: PendingSessionCandidate[] = []
  for (const filePath of filePaths) {
    const file = await loadPendingChatRecordFile(filePath)
    candidates.push({
      pendingId: file.pending_id,
      sessionKey: file.session_key,
      sessionName: file.session_name,
      filePath,
      appName: file.app_name,
      suggestedSessionKey: file.suggested_session_key ?? null,
      suggestedSessionName: file.suggested_session_name ?? null,
      titleAliases: file.title_aliases ?? [],
      messages: file.messages
    })
  }
  cache.set(appName, candidates)
  return candidates
}

function findBestStoredSessionMatch(
  candidates: StoredSessionCandidate[],
  sessionName: string
): StoredSessionMatch | null {
  const normalizedTitleKey = normalizeSessionTitleKey(sessionName)
  let bestMatch: StoredSessionMatch | null = null

  for (const candidate of candidates) {
    const exact =
      (normalizedTitleKey && candidate.canonicalTitleKey === normalizedTitleKey)
      || candidate.titleAliases.some((alias) => normalizeSessionTitleKey(alias) === normalizedTitleKey)
      || candidate.confirmedTitleAliases.some((alias) => normalizeSessionTitleKey(alias) === normalizedTitleKey)
    const aliasScore = Math.max(
      computeSessionTitleSimilarity(candidate.sessionName, sessionName),
      ...candidate.titleAliases.map((alias) => computeSessionTitleSimilarity(alias, sessionName)),
      0
    )
    const confirmedAliasScore = Math.max(
      ...candidate.confirmedTitleAliases.map((alias) => computeSessionTitleSimilarity(alias, sessionName)),
      0
    )
    const score = exact ? 1 : Math.max(aliasScore, confirmedAliasScore)
    const eligible =
      exact
      || aliasScore >= SESSION_ALIAS_SIMILARITY_THRESHOLD
      || confirmedAliasScore >= CONFIRMED_SESSION_ALIAS_SIMILARITY_THRESHOLD
    if (!eligible) {
      continue
    }
    const matchedViaConfirmedAlias =
      !exact
      && confirmedAliasScore >= CONFIRMED_SESSION_ALIAS_SIMILARITY_THRESHOLD
      && confirmedAliasScore >= aliasScore
    if (!bestMatch || score > bestMatch.score || (score === bestMatch.score && exact && !bestMatch.exact)) {
      bestMatch = {
        candidate,
        score,
        exact,
        aliasScore,
        confirmedAliasScore,
        matchedViaConfirmedAlias
      }
    }
  }

  return bestMatch
}

function canAutoReuseStoredSessionMatch(match: StoredSessionMatch): boolean {
  if (match.exact) {
    return true
  }
  if (match.matchedViaConfirmedAlias) {
    return match.confirmedAliasScore >= CONFIRMED_SESSION_ALIAS_SIMILARITY_THRESHOLD
  }
  return match.score >= SESSION_ALIAS_SIMILARITY_THRESHOLD
    && match.candidate.titleAliases.length >= AUTO_REUSE_ALIAS_COUNT_THRESHOLD
}

function findBestPendingSessionMatch(
  candidates: PendingSessionCandidate[],
  sessionName: string,
  storedMatch: StoredSessionMatch | null
): PendingSessionCandidate | null {
  let bestCandidate: PendingSessionCandidate | null = null
  let bestScore = 0
  for (const candidate of candidates) {
    if (
      storedMatch?.candidate.sessionKey
      && candidate.suggestedSessionKey
      && candidate.suggestedSessionKey !== storedMatch.candidate.sessionKey
    ) {
      continue
    }
    const score = Math.max(
      computeSessionTitleSimilarity(candidate.sessionName, sessionName),
      ...candidate.titleAliases.map((alias) => computeSessionTitleSimilarity(alias, sessionName)),
      0
    )
    if (score >= SESSION_ALIAS_SIMILARITY_THRESHOLD && score > bestScore) {
      bestScore = score
      bestCandidate = candidate
    }
  }
  return bestCandidate
}

async function findPendingSessionCandidateById(
  recordsDir: string,
  pendingId: string
): Promise<PendingSessionCandidate | null> {
  const filePaths = await collectPendingSessionFiles(recordsDir)
  for (const filePath of filePaths) {
    const file = await loadPendingChatRecordFile(filePath)
    if (file.pending_id !== pendingId) {
      continue
    }
    return {
      pendingId: file.pending_id,
      sessionKey: file.session_key,
      sessionName: file.session_name,
      filePath,
      appName: file.app_name,
      suggestedSessionKey: file.suggested_session_key ?? null,
      suggestedSessionName: file.suggested_session_name ?? null,
      titleAliases: file.title_aliases ?? [],
      messages: file.messages
    }
  }
  return null
}

function buildPendingSessionId(target: {
  appName: string
  sessionKey: string
  sessionName: string
  suggestedSessionKey: string | null
}): string {
  const candidateKey =
    normalizeSessionTitleKey(target.suggestedSessionKey ? splitSessionKey(target.suggestedSessionKey).sessionName : null)
    || normalizeSessionTitleKey(target.sessionName)
    || sanitizeSessionName(target.sessionName)
  return sanitizeSessionName(`${sanitizeSessionName(target.appName)}_${candidateKey}`)
}

function retargetChatRecordEntriesToSession(
  rows: ChatRecordEntry[],
  sessionKey: string,
  sessionName: string
): ChatRecordEntry[] {
  return rows.map((row) =>
    attachLegacyAliases(
      {
        ...row,
        conversation_id: sessionKey
      },
      {
        contact_name: row.sender_type === 'contact' ? sessionName : row.contact_name ?? null,
        conversation_title: sessionName,
        session_key: sessionKey
      }
    )
  )
}

async function loadPendingChatRecordFile(
  filePath: string,
  fallback?: {
    appName: string
    sessionName: string
    sessionKey: string
    pendingId: string
    suggestedSessionKey: string | null
    suggestedSessionName: string | null
  }
): Promise<PendingChatRecordFile> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PendingChatRecordFile>
    if (parsed && Array.isArray(parsed.messages)) {
      return {
        schema_version: typeof parsed.schema_version === 'number' ? parsed.schema_version : PENDING_CHAT_RECORD_SCHEMA_VERSION,
        pending_id: normalizeOptionalText(parsed.pending_id) || fallback?.pendingId || sanitizeSessionName('pending'),
        session_name: normalizeConversationTitle(parsed.session_name ?? null) || fallback?.sessionName || 'unknown_session',
        session_key: normalizeOptionalText(parsed.session_key) || fallback?.sessionKey || `${fallback?.appName ?? '微信'}::unknown_session`,
        app_name: normalizeOptionalText(parsed.app_name) || fallback?.appName || '微信',
        suggested_session_key: normalizeOptionalText(parsed.suggested_session_key) ?? fallback?.suggestedSessionKey ?? null,
        suggested_session_name: normalizeConversationTitle(parsed.suggested_session_name ?? null) ?? fallback?.suggestedSessionName ?? null,
        title_aliases: Array.isArray(parsed.title_aliases) ? parsed.title_aliases.filter((item): item is string => typeof item === 'string') : [],
        owner_user_id: normalizeOptionalText(parsed.owner_user_id),
        updated_at: normalizeOptionalText(parsed.updated_at) || new Date().toISOString(),
        messages: parsed.messages
          .map((item) => normalizeChatRecordEvent(item as unknown as ChatRecordEventRow))
          .filter((item): item is ChatRecordEntry => item !== null)
      }
    }
  } catch {
    // ignore and fallback
  }

  if (!fallback) {
    throw new Error('pending_fallback_required')
  }

  return {
    schema_version: PENDING_CHAT_RECORD_SCHEMA_VERSION,
    pending_id: fallback.pendingId,
    session_name: fallback.sessionName,
    session_key: fallback.sessionKey,
    app_name: fallback.appName,
    suggested_session_key: fallback.suggestedSessionKey,
    suggested_session_name: fallback.suggestedSessionName,
    title_aliases: [fallback.sessionName],
    updated_at: new Date().toISOString(),
    messages: []
  }
}

async function collectPendingSessionFiles(recordsDir: string, appName?: string): Promise<string[]> {
  const pendingRoot = getPendingSessionsRoot(recordsDir)
  const targetRoot = appName ? join(pendingRoot, sanitizeSessionName(appName)) : pendingRoot
  const pending = [targetRoot]
  const result: string[] = []

  while (pending.length > 0) {
    const currentDir = pending.pop()
    if (!currentDir) {
      continue
    }
    let entries
    try {
      entries = await readdir(currentDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const nextPath = join(currentDir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === PENDING_SESSIONS_DIR_NAME) {
          continue
        }
        pending.push(nextPath)
        continue
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        if (entry.name.toLowerCase() === NAME_MAPPINGS_FILE_NAME) {
          continue
        }
        result.push(nextPath)
      }
    }
  }

  return result
}

function getPendingSessionsRoot(recordsDir: string): string {
  return join(recordsDir, PENDING_SESSIONS_DIR_NAME)
}

function getNameMappingsFilePath(recordsDir: string): string {
  return join(dirname(recordsDir), NAME_MAPPINGS_FILE_NAME)
}

function getLegacyNameMappingsFilePath(recordsDir: string): string {
  return join(recordsDir, NAME_MAPPINGS_FILE_NAME)
}

async function loadSessionNameMappings(recordsDir: string, ownerUserId: string): Promise<Map<string, string>> {
  const candidatePaths = [getNameMappingsFilePath(recordsDir), getLegacyNameMappingsFilePath(recordsDir)]
  for (const path of candidatePaths) {
    try {
      const raw = await readFile(path, 'utf-8')
      const parsed = JSON.parse(raw) as SessionNameMappingsFile
      const root = parsed && typeof parsed === 'object' ? parsed : {}
      const byOwner = root.mappings_by_owner && typeof root.mappings_by_owner === 'object'
        ? root.mappings_by_owner
        : {}
      const ownerKey = normalizeOptionalText(ownerUserId) || 'default'
      const scoped = byOwner[ownerKey]
      const fallback = root.mappings
      const source = (scoped && typeof scoped === 'object' ? scoped : fallback) ?? {}
      const mappings = new Map<string, string>()
      for (const [from, to] of Object.entries(source)) {
        const key = normalizeSessionTitleKey(from)
        const value = normalizeConversationTitle(to)
        if (!key || !value) {
          continue
        }
        mappings.set(key, value)
      }
      return mappings
    } catch {
      // try next candidate path
    }
  }
  return new Map()
}

async function saveSessionNameMappings(
  recordsDir: string,
  ownerUserId: string,
  mappings: Map<string, string>
): Promise<void> {
  const path = getNameMappingsFilePath(recordsDir)
  await mkdir(dirname(path), { recursive: true })
  let parsed: SessionNameMappingsFile = {
    schema_version: NAME_MAPPINGS_SCHEMA_VERSION,
    mappings_by_owner: {}
  }
  try {
    const raw = await readFile(path, 'utf-8')
    const existing = JSON.parse(raw) as SessionNameMappingsFile
    if (existing && typeof existing === 'object') {
      parsed = {
        schema_version: NAME_MAPPINGS_SCHEMA_VERSION,
        mappings_by_owner: existing.mappings_by_owner && typeof existing.mappings_by_owner === 'object'
          ? existing.mappings_by_owner
          : {}
      }
    }
  } catch {
    // create fresh mappings file
  }
  const nextOwnerMap: Record<string, string> = {}
  for (const [from, to] of Array.from(mappings.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const key = normalizeSessionTitleKey(from)
    const value = normalizeConversationTitle(to)
    if (!key || !value) {
      continue
    }
    nextOwnerMap[key] = value
  }
  const ownerKey = normalizeOptionalText(ownerUserId) || 'default'
  parsed.schema_version = NAME_MAPPINGS_SCHEMA_VERSION
  parsed.mappings_by_owner = parsed.mappings_by_owner ?? {}
  parsed.mappings_by_owner[ownerKey] = nextOwnerMap
  await writeFile(path, JSON.stringify(parsed, null, 2), 'utf-8')
}

function resolveMappedSessionName(rawSessionName: string | null, mappings: Map<string, string>): string | null {
  const key = normalizeSessionTitleKey(rawSessionName)
  if (!key) {
    return null
  }
  const mapped = mappings.get(key)
  return normalizeConversationTitle(mapped ?? null)
}

function learnSessionNameMappingsForAliases(
  aliases: Array<string | null | undefined>,
  confirmedSessionName: string,
  mappings: Map<string, string>
): boolean {
  const canonical = normalizeConversationTitle(confirmedSessionName)
  if (!canonical) {
    return false
  }
  let changed = false
  for (const alias of aliases) {
    const key = normalizeSessionTitleKey(alias ?? null)
    if (!key) {
      continue
    }
    if (mappings.get(key) === canonical) {
      continue
    }
    mappings.set(key, canonical)
    changed = true
  }
  return changed
}

function learnSessionNameMappingsFromPending(
  pendingCandidate: PendingSessionCandidate,
  confirmedSessionName: string,
  mappings: Map<string, string>
): boolean {
  return learnSessionNameMappingsForAliases(
    [pendingCandidate.sessionName, ...pendingCandidate.titleAliases],
    confirmedSessionName,
    mappings
  )
}

function computeSessionTitleSimilarity(left: string | null, right: string | null): number {
  const a = normalizeSessionTitleKey(left)
  const b = normalizeSessionTitleKey(right)
  if (!a || !b) {
    return 0
  }
  if (a === b) {
    return 1
  }
  if (a.includes(b) || b.includes(a)) {
    return Math.max(Math.min(a.length, b.length) / Math.max(a.length, b.length), 0.88)
  }
  return Math.max(computeDiceCoefficient(a, b), computeOverlapRatio(a, b))
}

function computeDiceCoefficient(left: string, right: string): number {
  const leftBigrams = buildCharacterBigrams(left)
  const rightBigrams = buildCharacterBigrams(right)
  if (leftBigrams.length === 0 || rightBigrams.length === 0) {
    return 0
  }
  const rightCounts = new Map<string, number>()
  for (const item of rightBigrams) {
    rightCounts.set(item, (rightCounts.get(item) ?? 0) + 1)
  }
  let matches = 0
  for (const item of leftBigrams) {
    const count = rightCounts.get(item) ?? 0
    if (count <= 0) {
      continue
    }
    matches += 1
    rightCounts.set(item, count - 1)
  }
  return (2 * matches) / (leftBigrams.length + rightBigrams.length)
}

function computeOverlapRatio(left: string, right: string): number {
  const shorter = left.length <= right.length ? left : right
  const longer = shorter === left ? right : left
  let best = 0
  for (let start = 0; start < shorter.length; start += 1) {
    for (let end = start + 1; end <= shorter.length; end += 1) {
      const slice = shorter.slice(start, end)
      if (slice.length <= best || !longer.includes(slice)) {
        continue
      }
      best = slice.length
    }
  }
  return best / Math.max(left.length, right.length)
}

function buildCharacterBigrams(value: string): string[] {
  if (value.length < 2) {
    return [value]
  }
  const result: string[] = []
  for (let index = 0; index < value.length - 1; index += 1) {
    result.push(value.slice(index, index + 2))
  }
  return result
}

function mergePendingTitleAliases(
  existingAliases: string[] | undefined,
  existingSessionName: string,
  rows: ChatRecordEntry[],
  displaySessionName: string
): string[] {
  const aliases: string[] = []
  const seen = new Set<string>()
  const pushAlias = (value: string | null | undefined) => {
    const normalized = normalizeConversationTitle(value ?? null)
    if (!normalized) {
      return
    }
    const key = normalized.normalize('NFKC').toLowerCase()
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    aliases.push(normalized)
  }
  for (const alias of existingAliases ?? []) {
    pushAlias(alias)
  }
  pushAlias(existingSessionName)
  for (const row of rows) {
    pushAlias(row.conversation_title ?? null)
  }
  pushAlias(displaySessionName)
  return aliases
}

function mergeForcedTitleAliases(
  existingAliases: string[] | undefined,
  forcedAliases: Array<string | null | undefined>
): string[] {
  const aliases: string[] = []
  const seen = new Set<string>()
  const pushAlias = (value: string | null | undefined) => {
    const normalized = normalizeConversationTitle(value ?? null)
    if (!normalized) {
      return
    }
    const key = normalized.normalize('NFKC').toLowerCase()
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    aliases.push(normalized)
  }

  for (const alias of existingAliases ?? []) {
    pushAlias(alias)
  }
  for (const alias of forcedAliases) {
    pushAlias(alias)
  }
  return aliases
}

function normalizeConfirmedTitleAliases(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return mergeForcedTitleAliases([], value.filter((item): item is string => typeof item === 'string'))
}

export async function repairStoredChatRecordSessions(
  recordsDir: string,
  ownerUserId?: string,
  options?: ChatRecordMaintenanceOptions
): Promise<ChatRecordRepairResult> {
  await mkdir(recordsDir, { recursive: true })
  const filePaths = await collectChatRecordFiles(recordsDir)
  const result: ChatRecordRepairResult = {
    scannedFiles: filePaths.length,
    repairedFiles: 0,
    repairedMessages: 0
  }

  for (const filePath of filePaths) {
    try {
      const raw = await readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<ChatRecordFile>

      // Skip files that already belong to a different user
      if (parsed.owner_user_id && parsed.owner_user_id !== ownerUserId) {
        continue
      }

      const fallback = buildFallbackSessionFromFilePath(recordsDir, filePath)
      const normalized = normalizeLoadedChatRecordFile(parsed, fallback, options)

      // Check if we need to add owner_user_id (only if not already set)
      // This claims legacy files for the current user
      const needsOwnerId = ownerUserId && !parsed.owner_user_id
      const needsRepair = normalized.repairedMessages > 0 || normalized.normalizationChanged

      if (!needsOwnerId && !needsRepair) {
        continue
      }

      // Add owner_user_id if missing
      if (needsOwnerId) {
        normalized.file.owner_user_id = ownerUserId
      }

      await writeFile(filePath, JSON.stringify(normalized.file, null, 2), 'utf-8')
      result.repairedFiles += 1
      result.repairedMessages += normalized.repairedMessages
    } catch {
      // Ignore malformed files during repair.
    }
  }

  return result
}

export async function deleteStoredChatRecordSession(
  recordsDir: string,
  sessionKey: string,
  ownerUserId?: string
): Promise<number> {
  const normalizedTarget = normalizeOptionalText(sessionKey)
  if (!normalizedTarget) {
    return 0
  }

  const sessions = await loadStoredChatRecordSessions(recordsDir, ownerUserId ?? '', 1)
  const filePaths = new Set(
    sessions
      .filter((session) => normalizeOptionalText(session.sessionKey) === normalizedTarget)
      .map((session) => session.filePath)
  )

  let deletedCount = 0
  for (const filePath of filePaths) {
    try {
      await unlink(filePath)
      deletedCount += 1
    } catch {
      // Ignore missing or locked files during best-effort local cleanup.
    }
  }
  return deletedCount
}

function normalizeChatRecordEvent(event: ChatRecordEventRow, ownerDisplayName: string = 'Me'): ChatRecordEntry | null {
  if (!event || typeof event !== 'object') {
    return null
  }
  const legacy = event as ChatRecordEventRow & Record<string, unknown>
  const senderType = normalizeSender(legacy.sender_type ?? legacy.sender)
  const rawText = String(legacy.content ?? legacy.text ?? '').trim()
  const rawNonTextDescription = normalizeOptionalText(
    isRecord(legacy.metadata) ? legacy.metadata.non_text_description : legacy.non_text_description
  )
  const normalizedContentType = normalizeContentType(legacy.content_type)
  const contentType = looksLikeStructuredStoredPayload(rawText)
    ? (normalizedContentType === 'system'
      ? 'system'
      : inferStoredStructuredContentType(rawText))
    : (normalizedContentType || inferStoredStructuredContentType(rawText))
  const sanitizedContent = normalizeStoredStructuredMessage(rawText, contentType, rawNonTextDescription)
  const text = sanitizedContent.text
  const nonTextDescription = sanitizedContent.nonTextDescription
  if (!text && !nonTextDescription) {
    return null
  }

  const metadata = isRecord(legacy.metadata) ? legacy.metadata : null
  const quotedMessage = normalizeQuotedMessage(metadata?.quoted_message ?? legacy.quoted_message)
  const contactName = normalizeOptionalText(metadata?.contact_name ?? legacy.contact_name)
  const windowId = normalizeOptionalText(metadata?.window_id ?? legacy.window_id)
  const normalizedTitle = normalizeConversationTitle(
    normalizeOptionalText(metadata?.conversation_title ?? legacy.conversation_title)
  )
  const appName = normalizeAppName(windowId)
  const sessionKey = normalizeSessionKey(
    normalizeOptionalText(metadata?.session_key ?? legacy.session_key),
    appName,
    normalizedTitle,
    contactName
  )
  const conversationId = normalizeOptionalText(legacy.conversation_id) || sessionKey
  const senderId = normalizeOptionalText(legacy.sender_id)
    || (senderType === 'user' ? 'self' : contactName || sessionKey)
  const senderName = normalizeOptionalText(legacy.sender_name)
    || (senderType === 'user' ? ownerDisplayName : contactName || normalizedTitle || 'Unknown')
  const nonTextSignature = normalizeOptionalText(metadata?.non_text_signature ?? legacy.non_text_signature)
    || deriveNonTextSignature(contentType, nonTextDescription)
  const rawTimestamp = normalizeOptionalText(legacy.timestamp)
  const rawFrameId = normalizeOptionalText(metadata?.frame_id ?? legacy.frame_id)
  const rawEventId = normalizeOptionalText(metadata?.event_id ?? legacy.event_id)
  const normalizedRawTimestamp = normalizeAbsoluteTimestamp(rawTimestamp)
  const preliminaryCaptureTimestamp = normalizeAbsoluteTimestamp(metadata?.capture_timestamp)
  const useLegacyTimestampAsTimeAnchor = shouldTreatLegacyTimestampAsTimeAnchor(
    rawTimestamp,
    preliminaryCaptureTimestamp ?? normalizedRawTimestamp,
    rawEventId,
    rawFrameId
  )
  const explicitTimeAnchor = normalizeOptionalText(metadata?.time_anchor ?? legacy.time_anchor)
    ?? (useLegacyTimestampAsTimeAnchor ? rawTimestamp : null)
  const captureTimestamp = preliminaryCaptureTimestamp ?? normalizedRawTimestamp
  const normalizedTimestamp = explicitTimeAnchor ?? (useLegacyTimestampAsTimeAnchor ? rawTimestamp : null)
  const frameId = normalizeFrameIdForStorage(
    rawFrameId,
    captureTimestamp
  )
  const eventId = normalizeEventIdForStorage(
    rawEventId,
    frameId
  )
  const messageId = buildStoredMessageId(
    normalizeOptionalText(legacy.message_id),
    eventId,
    frameId,
    `${sessionKey}:${senderType}:${text || nonTextDescription || 'message'}`
  )

  return attachLegacyAliases({
    message_id: messageId,
    conversation_id: conversationId,
    sender_id: senderId,
    sender_name: senderName,
    sender_type: senderType,
    content: text,
    timestamp: normalizeStoredTimestampValue(normalizedTimestamp ?? explicitTimeAnchor ?? null),
    content_type: contentType,
    reply_to: normalizeOptionalText(legacy.reply_to),
    quoted_message: quotedMessage,
    metadata: {
      window_id: windowId,
      non_text_description: nonTextDescription,
      non_text_signature: nonTextSignature,
      capture_timestamp: captureTimestamp,
      event_id: eventId,
      frame_id: frameId
    }
  }, {
    contact_name: contactName,
    conversation_title: normalizedTitle,
    session_key: normalizeOptionalText(metadata?.session_key ?? legacy.session_key) || sessionKey
  })
}

function normalizeSender(sender: unknown): 'user' | 'contact' | 'unknown' {
  if (sender === 'user' || sender === 'contact' || sender === 'unknown') {
    return sender
  }
  return 'unknown'
}

function normalizeQuotedMessage(
  value: unknown
): { text: string; sender_name: string | null } | null {
  if (!isRecord(value)) {
    return null
  }
  const text = normalizeOptionalText(value.text)
  if (!text) {
    return null
  }
  return {
    text,
    sender_name: normalizeOptionalText(value.sender_name)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeAbsoluteTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return normalizeAbsoluteEpoch(value)
  }
  const raw = normalizeOptionalText(value)
  if (!raw) {
    return null
  }
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(raw)) {
    return null
  }
  if (/^\d{9,16}$/.test(raw)) {
    return normalizeAbsoluteEpoch(Number(raw))
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/i.test(raw)) {
    return isSuspiciousHistoricalTimestamp(raw) ? null : raw
  }
  const parsed = Date.parse(raw)
  if (!Number.isFinite(parsed)) {
    return null
  }
  const iso = new Date(parsed).toISOString()
  return isSuspiciousHistoricalTimestamp(iso) ? null : iso
}

function normalizeStoredTimestampValue(value: string | null): string | null {
  const raw = normalizeOptionalText(value)
  if (!raw) {
    return null
  }
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(raw)) {
    return raw
  }
  return normalizeAbsoluteTimestamp(raw)
}

function normalizeAbsoluteEpoch(value: number): string | null {
  let normalizedTime = value
  if (normalizedTime < 1e11) {
    normalizedTime *= 1000
  } else if (normalizedTime > 1e14) {
    normalizedTime = Math.floor(normalizedTime / 1000)
  }
  const iso = new Date(normalizedTime).toISOString()
  return isSuspiciousHistoricalTimestamp(iso) ? null : iso
}

function isSuspiciousHistoricalTimestamp(value: string): boolean {
  const year = Number(value.slice(0, 4))
  return Number.isFinite(year) && year > 0 && year < 2011
}

function normalizeStoredStructuredMessage(
  rawText: string,
  rawContentType: string,
  rawNonTextDescription: string | null
): { text: string; nonTextDescription: string | null } {
  const contentType = normalizeContentType(rawContentType) || 'text'
  const nonTextDescription = normalizeOptionalText(rawNonTextDescription)
  const trimmedText = rawText.trim()

  if (contentType === 'text' && trimmedText && !looksLikeStructuredStoredPayload(trimmedText)) {
    return {
      text: trimmedText,
      nonTextDescription
    }
  }

  const placeholder = buildStoredStructuredPlaceholder(contentType, trimmedText, nonTextDescription)
  return {
    text: placeholder,
    nonTextDescription: contentType === 'text' ? nonTextDescription : (nonTextDescription ?? placeholder)
  }
}

function inferStoredStructuredContentType(rawText: string): string {
  if (!looksLikeStructuredStoredPayload(rawText)) {
    return 'text'
  }
  const normalized = rawText.trim().toLowerCase()
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

function looksLikeStructuredStoredPayload(value: string): boolean {
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

function buildStoredStructuredPlaceholder(
  contentType: string,
  rawText: string,
  rawNonTextDescription: string | null
): string {
  const nonTextDescription = normalizeOptionalText(rawNonTextDescription)
  if (nonTextDescription) {
    return nonTextDescription
  }
  switch (contentType) {
    case 'image':
    case 'emoji':
    case 'imported':
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
      return rawText && !looksLikeStructuredStoredPayload(rawText) ? rawText : '系统消息'
    default:
      return '图片'
  }
}

function captureTimestampToToken(value: string | null): string | null {
  const normalized = normalizeOptionalText(value)
  if (!normalized) {
    return null
  }
  const match = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/i
  )
  if (!match) {
    return null
  }
  const fractional = (match[7] ?? '').padEnd(6, '0')
  return `${match[1]}${match[2]}${match[3]}T${match[4]}${match[5]}${match[6]}${fractional}Z`
}

function normalizeFrameIdForStorage(frameId: string | null, captureTimestamp: string | null): string | null {
  const normalized = normalizeOptionalText(frameId)
  if (!normalized) {
    return null
  }
  if (PUBLIC_FRAME_ID_SUFFIX_REGEX.test(normalized) || !LEGACY_LOCAL_FRAME_ID_REGEX.test(normalized)) {
    return normalized
  }
  const token = captureTimestampToToken(captureTimestamp)
  if (!token) {
    return normalized
  }
  return `${normalized}_${token}`
}

function normalizeEventIdForStorage(eventId: string | null, frameId: string | null): string | null {
  const normalized = normalizeOptionalText(eventId)
  if (!normalized) {
    return null
  }
  if (!LEGACY_LOCAL_EVENT_ID_REGEX.test(normalized) || !frameId) {
    return normalized
  }
  return `${normalized}__${frameId}`
}

function buildStoredMessageId(
  rawMessageId: string | null,
  eventId: string | null,
  frameId: string | null,
  fallback: string
): string {
  const normalized = normalizeOptionalText(rawMessageId)
  if (eventId) {
    return eventId
  }
  if (normalized && (!LEGACY_LOCAL_EVENT_ID_REGEX.test(normalized) || !frameId)) {
    return normalized
  }
  if (normalized && frameId) {
    return `${normalized}__${frameId}`
  }
  return normalized || fallback
}

function normalizeContentType(value: unknown): string | null {
  const raw = normalizeOptionalText(value)
  if (!raw) {
    return null
  }
  return raw.toLowerCase()
}

function normalizeCaptureDedupWindowMs(value: number | null | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CAPTURE_DEDUP_WINDOW_MS
  }
  return Math.min(600000, Math.max(1000, Math.round(value as number)))
}

function shouldTreatLegacyTimestampAsTimeAnchor(
  rawTimestamp: string | null,
  captureTimestamp: string | null,
  eventId: string | null,
  frameId: string | null
): boolean {
  const value = normalizeOptionalText(rawTimestamp)
  if (!value) {
    return false
  }
  if (!eventId && !frameId) {
    return true
  }
  if (/^capture_fallback:/i.test(value)) {
    return true
  }
  if (/\b\d{1,2}:\d{2}\b/.test(value)) {
    return true
  }
  return Boolean(captureTimestamp && captureTimestamp !== value)
}

function normalizeSessionKey(
  rawSessionKey: string | null,
  appName: string,
  title: string | null,
  contactName: string | null
): string {
  const fromEvent = normalizeOptionalText(rawSessionKey)
  if (fromEvent) {
    const split = splitSessionKey(fromEvent)
    return `${normalizeAppName(split.appName)}::${split.sessionName}`
  }
  const sessionName =
    normalizeSessionTitleKey(title)
    || normalizeSessionTitleKey(contactName)
    || 'unknown_session'
  return `${normalizeAppName(appName)}::${sessionName}`
}

function splitSessionKey(sessionKey: string): SessionSplit {
  const raw = normalizeOptionalText(sessionKey) || `${WECHAT_APP_NAME}::unknown_session`
  const idx = raw.indexOf('::')
  if (idx <= 0 || idx >= raw.length - 2) {
    return {
      appName: WECHAT_APP_NAME,
      sessionName: sanitizeSessionName(normalizeSessionTitleKey(raw) || raw)
    }
  }
  const appName = sanitizeSessionName(normalizeAppName(raw.slice(0, idx)))
  const sessionName = sanitizeSessionName(normalizeSessionTitleKey(raw.slice(idx + 2)) || raw.slice(idx + 2))
  return { appName, sessionName }
}

async function collectChatRecordFiles(rootDir: string, _ownerUserId?: string): Promise<string[]> {
  const pending = [rootDir]
  const result: string[] = []

  while (pending.length > 0) {
    const currentDir = pending.pop()
    if (!currentDir) {
      continue
    }
    let entries
    try {
      entries = await readdir(currentDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const nextPath = join(currentDir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === PENDING_SESSIONS_DIR_NAME) {
          continue
        }
        pending.push(nextPath)
        continue
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        result.push(nextPath)
      }
    }
  }

  return result
}

function buildFallbackSessionFromFilePath(recordsDir: string, filePath: string): SessionSplit {
  const relative = filePath.slice(recordsDir.length).replace(/^[\\/]+/, '')
  const parts = relative.split(/[\\/]+/).filter(Boolean)
  const fileName = parts.pop() ?? 'unknown_session.json'
  const appName = parts.pop() ?? '微信'
  const sessionName = fileName.replace(/\.json$/i, '')
  return {
    appName: sanitizeSessionName(appName),
    sessionName: sanitizeSessionName(sessionName)
  }
}

function normalizeConversationTitle(rawTitle: string | null): string | null {
  if (!rawTitle) {
    return null
  }
  let title = rawTitle.trim()
  if (!title) {
    return null
  }
  title = title
    .replace(/[（(]\d+[)）]\s*$/, '')
    .replace(/\s+-\s*(微信|wechat)\s*$/i, '')
    .trim()
  if (!title) {
    return null
  }
  const lower = title.toLowerCase()
  if (lower === 'wechat' || title === '微信') {
    return null
  }
  return title
}

export function normalizeSessionTitleKey(rawTitle: string | null): string | null {
  const normalizedTitle = normalizeConversationTitle(rawTitle)
  if (!normalizedTitle) {
    return null
  }

  const visible = normalizedTitle
    .normalize('NFKC')
    .replace(INVISIBLE_TITLE_REGEX, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([._-])/g, '$1')
    .replace(/([._-])\s+/g, '$1')
    .trim()

  const textCore = buildSessionTitleTextFingerprint(visible)
  if (textCore.length > 0) {
    return textCore
  }

  return visible.length > 0 ? visible : null
}

function resolveAuthoritativeSessionTitleKey(sessionKey: string, fallbackSessionName: string): string {
  const split = splitSessionKey(sessionKey)
  return normalizeSessionTitleKey(split.sessionName) || normalizeSessionTitleKey(fallbackSessionName) || split.sessionName
}

function resolveDisplaySessionName(
  candidates: Array<string | null | undefined>,
  fallbackSessionName: string,
  authoritativeTitleKey: string
): string {
  for (const candidate of candidates) {
    const normalized = normalizeConversationTitle(candidate ?? null)
    if (!normalized) {
      continue
    }
    if (normalizeSessionTitleKey(normalized) === authoritativeTitleKey) {
      return normalized
    }
  }
  return fallbackSessionName
}

function buildSessionTitleTextFingerprint(value: string): string {
  if (!value || !TITLE_TEXT_CHAR_REGEX.test(value)) {
    return ''
  }
  const chars: string[] = []
  for (const char of value) {
    if (/[\p{L}\p{N}]/u.test(char) || /[\u3400-\u9fff]/u.test(char)) {
      chars.push(char.toLowerCase())
    }
  }
  return chars.join('').trim()
}

function mergeTitleAliases(
  existingAliases: string[] | undefined,
  existingSessionName: string | undefined,
  rows: ChatRecordEntry[],
  displaySessionName: string,
  authoritativeTitleKey: string | null = null
): string[] {
  const aliases: string[] = []
  const seen = new Set<string>()

  const pushAlias = (value: string | null | undefined) => {
    const normalized = normalizeConversationTitle(value ?? null)
    if (!normalized) {
      return
    }
    if (
      authoritativeTitleKey
      && normalizeSessionTitleKey(normalized) !== authoritativeTitleKey
      && computeSessionTitleSimilarity(normalized, displaySessionName) < SESSION_ALIAS_SIMILARITY_THRESHOLD
    ) {
      return
    }
    const key = normalized.normalize('NFKC').toLowerCase()
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    aliases.push(normalized)
  }

  for (const alias of existingAliases ?? []) {
    pushAlias(alias)
  }
  pushAlias(existingSessionName)
  for (const row of rows) {
    pushAlias(row.conversation_title ?? null)
  }
  pushAlias(displaySessionName)

  return aliases
}

function normalizeAppName(raw: string | null): string {
  if (!raw) {
    return WECHAT_APP_NAME
  }
  const value = raw.trim()
  if (!value) {
    return WECHAT_APP_NAME
  }
  const lower = value.toLowerCase()
  if (lower === WINDOW_DEFAULT_APP_NAME || UNKNOWN_APP_NAMES.has(lower)) {
    return WECHAT_APP_NAME
  }
  if (lower.includes('wechat') || value.includes(WECHAT_APP_NAME)) {
    return WECHAT_APP_NAME
  }
  return value
}

function sanitizeSessionName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|]/g, '_').trim()
  return clean.length > 0 ? clean : 'unknown_session'
}

async function loadChatRecordFile(
  filePath: string,
  fallback: SessionSplit,
  options?: ChatRecordMaintenanceOptions
): Promise<ChatRecordFile> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as ChatRecordFile
    if (parsed && Array.isArray(parsed.messages)) {
      return normalizeLoadedChatRecordFile(parsed, fallback, options).file
    }
  } catch {
    // ignore and fallback
  }
  return {
    session_name: fallback.sessionName,
    session_key: `${fallback.appName}::${fallback.sessionName}`,
    app_name: fallback.appName,
    canonical_title_key: normalizeSessionTitleKey(fallback.sessionName) || fallback.sessionName,
    title_aliases: fallback.sessionName !== 'unknown_session' ? [fallback.sessionName] : [],
    confirmed_title_aliases: [],
    updated_at: new Date().toISOString(),
    schema_version: CHAT_RECORD_SCHEMA_VERSION,
    messages: []
  }
}

function mergeRecordMessages(
  existing: ChatRecordEntry[],
  incoming: ChatRecordEntry[],
  windowSize: number,
  mediaSimilarityThreshold: number,
  captureDedupWindowMs: number = DEFAULT_CAPTURE_DEDUP_WINDOW_MS
): ChatRecordEntry[] {
  const merged = [...existing]
  const overlapCount = countVisibleWindowOverlap(
    merged.slice(-Math.max(windowSize, incoming.length)),
    incoming,
    captureDedupWindowMs
  )
  if (overlapCount > 0) {
    const overlapStart = Math.max(0, merged.length - overlapCount)
    for (let index = 0; index < overlapCount; index += 1) {
      const existingRow = merged[overlapStart + index]
      const incomingRow = incoming[index]
      if (!existingRow || !incomingRow) {
        continue
      }
      merged[overlapStart + index] = mergePreferMoreComplete(existingRow, incomingRow)
    }
  }
  const incomingTail = incoming.slice(overlapCount)
  for (const item of incomingTail) {
    const recentWindow = merged.slice(-windowSize)
    const duplicateDecision = findDuplicateInWindow(
      item,
      recentWindow,
      mediaSimilarityThreshold,
      DEFAULT_TEXT_SIMILARITY_THRESHOLD,
      captureDedupWindowMs
    )
    if (duplicateDecision.duplicate) {
      if (duplicateDecision.replaceIndex !== null) {
        const absoluteIndex = Math.max(0, merged.length - recentWindow.length + duplicateDecision.replaceIndex)
        merged[absoluteIndex] = mergePreferMoreComplete(merged[absoluteIndex], item)
      }
      continue
    }
    merged.push(item)
  }
  return finalizeMergedMessages(merged, windowSize, mediaSimilarityThreshold, captureDedupWindowMs)
}

function finalizeMergedMessages(
  messages: ChatRecordEntry[],
  windowSize: number,
  mediaSimilarityThreshold: number,
  captureDedupWindowMs: number = DEFAULT_CAPTURE_DEDUP_WINDOW_MS
): ChatRecordEntry[] {
  const sorted = sortChatRecordEntries(messages)
  const compacted: ChatRecordEntry[] = []
  for (const item of sorted) {
    const recentWindow = compacted.slice(-windowSize)
    const duplicateDecision = findDuplicateInWindow(
      item,
      recentWindow,
      mediaSimilarityThreshold,
      DEFAULT_TEXT_SIMILARITY_THRESHOLD,
      captureDedupWindowMs
    )
    if (duplicateDecision.duplicate) {
      if (duplicateDecision.replaceIndex !== null) {
        const absoluteIndex = Math.max(0, compacted.length - recentWindow.length + duplicateDecision.replaceIndex)
        compacted[absoluteIndex] = mergePreferMoreComplete(compacted[absoluteIndex], item)
      }
      continue
    }
    compacted.push(item)
  }
  if (compacted.length > DEFAULT_MAX_RECORDS) {
    return compacted.slice(-DEFAULT_MAX_RECORDS)
  }
  return compacted
}

interface ComparableChatRecordRow {
  sender?: 'user' | 'contact' | 'unknown'
  sender_type?: 'user' | 'contact' | 'unknown'
  text?: string
  content?: string
  contact_name?: string | null
  sender_name?: string
  content_type?: string | null
  quoted_message?: {
    text: string
    sender_name?: string | null
  } | null
  non_text_description?: string | null
  non_text_signature?: string | null
  timestamp?: string | null
  metadata?: {
    non_text_description?: string | null
    non_text_signature?: string | null
    capture_timestamp?: string | null
  } | null
}

export function countVisibleWindowOverlap(
  existingRows: ComparableChatRecordRow[],
  incomingRows: ComparableChatRecordRow[],
  captureDedupWindowMs: number = DEFAULT_CAPTURE_DEDUP_WINDOW_MS
): number {
  const maxOverlap = Math.min(existingRows.length, incomingRows.length)
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    let matches = true
    for (let index = 0; index < overlap; index += 1) {
      const existing = existingRows[existingRows.length - overlap + index]
      const incoming = incomingRows[index]
      if (!existing || !incoming || !rowsMatchForOverlap(existing, incoming, captureDedupWindowMs)) {
        matches = false
        break
      }
    }
    if (matches) {
      return overlap
    }
  }
  return 0
}

function findDuplicateInWindow(
  item: ChatRecordEntry,
  windowRows: ChatRecordEntry[],
  mediaSimilarityThreshold: number,
  textSimilarityThreshold: number,
  captureDedupWindowMs: number = DEFAULT_CAPTURE_DEDUP_WINDOW_MS
): DuplicateDecision {
  const result: DuplicateDecision = {
    duplicate: false,
    replaceIndex: null
  }

  const itemTextNormalized = normalizeText(item.content)
  const itemTextCanonical = canonicalizeText(item.content)
  const itemTextFp = buildTextFingerprint(item, itemTextCanonical)
  const itemTimeAnchor = normalizeTimeAnchorKey(item.timestamp)
  const contentType = normalizeText(item.content_type || '')
  const itemDescriptionCanonical = canonicalizeText(item.metadata.non_text_description ?? '')
  const itemNonTextSignature = getNonTextSignature(item)
  const shouldUseMediaSimilarity = contentType.length > 0 && contentType !== 'text' && itemDescriptionCanonical.length > 0

  for (let i = windowRows.length - 1; i >= 0; i -= 1) {
    const row = windowRows[i]
    if (!sameSpeaker(row, item)) {
      continue
    }

    const rowTextCanonical = canonicalizeText(row.content)
    const rowTextFp = buildTextFingerprint(row, rowTextCanonical)
    const rowTimeAnchor = normalizeTimeAnchorKey(row.timestamp)
    const sameTemporalAnchor = hasTemporalMatch(item, row, itemTimeAnchor, rowTimeAnchor, captureDedupWindowMs)
    if (itemTextFp && rowTextFp && rowTextFp === itemTextFp && sameTemporalAnchor) {
      result.duplicate = true
      if (shouldReplaceExisting(row, item)) {
        result.replaceIndex = i
      }
      return result
    }

    if (itemTextCanonical && rowTextCanonical) {
      const similarText =
        sameTemporalAnchor
        && normalizeQuotedMessageKey(item) === normalizeQuotedMessageKey(row)
        && isSimilarText(itemTextCanonical, rowTextCanonical, textSimilarityThreshold)
      if (similarText) {
        result.duplicate = true
        if (shouldReplaceExisting(row, item)) {
          result.replaceIndex = i
        }
        return result
      }
    }

    if (!shouldUseMediaSimilarity) {
      continue
    }
    const rowContentType = normalizeText(row.content_type || '')
    if (rowContentType !== contentType) {
      continue
    }
    const rowNonTextSignature = getNonTextSignature(row)
    if (itemNonTextSignature && rowNonTextSignature && itemNonTextSignature === rowNonTextSignature) {
      if (sameTemporalAnchor) {
        if (normalizeQuotedMessageKey(item) !== normalizeQuotedMessageKey(row)) {
          continue
        }
        result.duplicate = true
        if (shouldReplaceExisting(row, item)) {
          result.replaceIndex = i
        }
        return result
      }
      continue
    }
    const rowDescriptionCanonical = canonicalizeText(row.metadata.non_text_description ?? '')
    if (!rowDescriptionCanonical) {
      continue
    }
    const similarMedia = isSimilarMedia(
      itemDescriptionCanonical,
      rowDescriptionCanonical,
      mediaSimilarityThreshold
    )
    if (similarMedia && sameTemporalAnchor) {
      if (normalizeQuotedMessageKey(item) !== normalizeQuotedMessageKey(row)) {
        continue
      }
      result.duplicate = true
      if (shouldReplaceExisting(row, item)) {
        result.replaceIndex = i
      }
      return result
    }
  }

  if (itemTextNormalized.length > 0) {
    return result
  }

  const nonTextCategory = normalizeText(item.content_type || 'unknown')
  if (!itemDescriptionCanonical) {
    return result
  }
  for (let i = windowRows.length - 1; i >= 0; i -= 1) {
    const row = windowRows[i]
    if (normalizeText(row.content).length > 0) {
      continue
    }
    if (!sameSpeaker(row, item)) {
      continue
    }
    const rowCategory = normalizeText(row.content_type || 'unknown')
    if (rowCategory !== nonTextCategory) {
      continue
    }
    const rowNonTextSignature = getNonTextSignature(row)
    if (itemNonTextSignature && rowNonTextSignature && itemNonTextSignature === rowNonTextSignature) {
      const sameTemporalAnchor =
        hasTemporalMatch(
          item,
          row,
          itemTimeAnchor,
          normalizeTimeAnchorKey(row.timestamp),
          captureDedupWindowMs
        )
      if (sameTemporalAnchor) {
        if (normalizeQuotedMessageKey(item) !== normalizeQuotedMessageKey(row)) {
          continue
        }
        result.duplicate = true
        if (shouldReplaceExisting(row, item)) {
          result.replaceIndex = i
        }
        return result
      }
      continue
    }
    const rowDescriptionCanonical = canonicalizeText(row.metadata.non_text_description ?? '')
    if (!rowDescriptionCanonical) {
      continue
    }
    const similarMedia = isSimilarMedia(itemDescriptionCanonical, rowDescriptionCanonical, mediaSimilarityThreshold)
    if (
      similarMedia
      && normalizeQuotedMessageKey(item) === normalizeQuotedMessageKey(row)
      && hasTemporalMatch(
        item,
        row,
        itemTimeAnchor,
        normalizeTimeAnchorKey(row.timestamp),
        captureDedupWindowMs
      )
    ) {
      result.duplicate = true
      if (shouldReplaceExisting(row, item)) {
        result.replaceIndex = i
      }
      return result
    }
  }
  return result
}

function buildTextFingerprint(row: ChatRecordEntry, normalizedText: string): string {
  if (!normalizedText) {
    return ''
  }
  return [
    row.sender_type,
    canonicalizeText(row.sender_type === 'contact' ? row.sender_name : ''),
    normalizedText,
    normalizeQuotedMessageKey(row)
  ].join('|')
}

function normalizeQuotedMessageKey(row: ComparableChatRecordRow): string {
  const quoted = normalizeQuotedMessage(row.quoted_message)
  if (!quoted) {
    return ''
  }
  return `${canonicalizeText(quoted.sender_name ?? '')}|${canonicalizeText(quoted.text)}`
}

export function normalizeTimeAnchorKey(value: string | null): string {
  const raw = normalizeOptionalText(value)
  if (!raw) {
    return ''
  }
  const isCaptureFallback = raw.toLowerCase().startsWith(CAPTURE_FALLBACK_PREFIX)
  const baseValue = isCaptureFallback ? raw.slice(CAPTURE_FALLBACK_PREFIX.length) : raw
  const iso = Date.parse(baseValue)
  if (Number.isFinite(iso)) {
    const normalized = new Date(iso).toISOString().slice(0, 16)
    return isCaptureFallback ? `${CAPTURE_FALLBACK_PREFIX}${normalized}` : normalized
  }
  const visibleTime = baseValue.match(/\b(\d{1,2}):(\d{2})\b/)
  if (visibleTime) {
    const hour = visibleTime[1]?.padStart(2, '0') ?? '00'
    const minute = visibleTime[2] ?? '00'
    const normalized = `${hour}:${minute}`
    return isCaptureFallback ? `${CAPTURE_FALLBACK_PREFIX}${normalized}` : normalized
  }
  const normalized = baseValue.normalize('NFKC').trim()
  return isCaptureFallback ? `${CAPTURE_FALLBACK_PREFIX}${normalized}` : normalized
}

function sameTimeAnchor(
  a: string,
  b: string,
  captureDedupWindowMs: number = DEFAULT_CAPTURE_DEDUP_WINDOW_MS
): boolean {
  if (!a || !b) {
    return false
  }
  const fallbackA = a.startsWith(CAPTURE_FALLBACK_PREFIX)
  const fallbackB = b.startsWith(CAPTURE_FALLBACK_PREFIX)
  if (fallbackA || fallbackB) {
    const timeA = parseAnchorEpochMs(a)
    const timeB = parseAnchorEpochMs(b)
    if (timeA !== null && timeB !== null) {
      return Math.abs(timeA - timeB) <= captureDedupWindowMs
    }
    return a === b
  }
  return a === b
}

function parseAnchorEpochMs(value: string): number | null {
  const normalized = normalizeOptionalText(value)
  if (!normalized) {
    return null
  }
  const base = normalized.startsWith(CAPTURE_FALLBACK_PREFIX)
    ? normalized.slice(CAPTURE_FALLBACK_PREFIX.length)
    : normalized
  const parsed = Date.parse(base)
  return Number.isFinite(parsed) ? parsed : null
}

function parseCaptureTimestamp(value: string | null | undefined): number | null {
  const normalized = normalizeOptionalText(value)
  if (!normalized) {
    return null
  }
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function sameCaptureWindow(
  a: ComparableChatRecordRow,
  b: ComparableChatRecordRow,
  windowMs: number = DEFAULT_CAPTURE_DEDUP_WINDOW_MS
): boolean {
  const left = parseCaptureTimestamp(a.metadata?.capture_timestamp ?? null)
  const right = parseCaptureTimestamp(b.metadata?.capture_timestamp ?? null)
  if (left === null || right === null) {
    return false
  }
  return Math.abs(left - right) <= windowMs
}

function isCaptureDerivedAnchor(row: ComparableChatRecordRow, anchor: string): boolean {
  if (!anchor) {
    return false
  }
  return anchor === normalizeTimeAnchorKey(row.metadata?.capture_timestamp ?? null)
}

function hasTemporalMatch(
  a: ComparableChatRecordRow,
  b: ComparableChatRecordRow,
  anchorA: string,
  anchorB: string,
  captureDedupWindowMs: number = DEFAULT_CAPTURE_DEDUP_WINDOW_MS
): boolean {
  const explicitAnchorA = Boolean(anchorA) && !isCaptureDerivedAnchor(a, anchorA)
  const explicitAnchorB = Boolean(anchorB) && !isCaptureDerivedAnchor(b, anchorB)
  if (explicitAnchorA && explicitAnchorB) {
    return sameTimeAnchor(anchorA, anchorB, captureDedupWindowMs)
  }
  if (sameCaptureWindow(a, b, captureDedupWindowMs)) {
    return true
  }
  if (anchorA && anchorB) {
    if (sameTimeAnchor(anchorA, anchorB, captureDedupWindowMs)) {
      return true
    }
    return false
  }
  return !anchorA && !anchorB && !hasCaptureTimestamp(a) && !hasCaptureTimestamp(b)
}

function hasCaptureTimestamp(row: ComparableChatRecordRow): boolean {
  return parseCaptureTimestamp(row.metadata?.capture_timestamp ?? null) !== null
}

function sortChatRecordEntries(messages: ChatRecordEntry[]): ChatRecordEntry[] {
  return messages
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const leftTime = resolveOrderingTimestamp(left.entry)
      const rightTime = resolveOrderingTimestamp(right.entry)
      if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
        return leftTime - rightTime
      }
      if (leftTime !== null && rightTime === null) {
        return -1
      }
      if (leftTime === null && rightTime !== null) {
        return 1
      }
      return left.index - right.index
    })
    .map(({ entry }) => entry)
}

function resolveOrderingTimestamp(entry: ComparableChatRecordRow): number | null {
  const anchor = normalizeTimeAnchorKey(entry.timestamp ?? null)
  if (anchor && !isCaptureDerivedAnchor(entry, anchor)) {
    const anchorTime = parseAnchorEpochMs(anchor)
    if (anchorTime !== null) {
      return anchorTime
    }
  }
  return parseCaptureTimestamp(entry.metadata?.capture_timestamp ?? null)
    ?? parseAnchorEpochMs(anchor)
}

export function deriveNonTextSignature(contentType: string | null, description: string | null): string {
  const type = normalizeText(contentType || 'unknown') || 'unknown'
  const base = normalizeOptionalText(description)
  if (!base) {
    return ''
  }
  const tokens = (base.normalize('NFKC').toLowerCase().match(/[a-z0-9\u3400-\u9fff]+/g) ?? [])
    .filter((token) => token.length > 0 && !NON_TEXT_SIGNATURE_STOP_WORDS.has(token))
  const signatureCore = Array.from(new Set(tokens)).sort().join('|')
  if (signatureCore) {
    return `${type}:${signatureCore}`
  }
  const fallback = canonicalizeText(base)
  return fallback ? `${type}:${fallback}` : ''
}

function getNonTextSignature(row: ComparableChatRecordRow): string {
  const direct = normalizeOptionalText(row.non_text_signature ?? row.metadata?.non_text_signature ?? null)
  if (direct) {
    return direct
  }
  return deriveNonTextSignature(
    normalizeContentType(row.content_type) || 'unknown',
    normalizeOptionalText(row.non_text_description ?? row.metadata?.non_text_description ?? null)
  )
}

function rowsMatchForOverlap(
  a: ComparableChatRecordRow,
  b: ComparableChatRecordRow,
  captureDedupWindowMs: number = DEFAULT_CAPTURE_DEDUP_WINDOW_MS
): boolean {
  if (normalizeComparableSenderType(a) !== normalizeComparableSenderType(b)) {
    return false
  }
  if (normalizeComparableSenderName(a) !== normalizeComparableSenderName(b)) {
    return false
  }
  const textA = canonicalizeText(a.content ?? a.text ?? '')
  const textB = canonicalizeText(b.content ?? b.text ?? '')
  if (textA && textB && textA === textB) {
    if (normalizeQuotedMessageKey(a) !== normalizeQuotedMessageKey(b)) {
      return false
    }
    const anchorA = normalizeTimeAnchorKey(a.timestamp ?? null)
    const anchorB = normalizeTimeAnchorKey(b.timestamp ?? null)
    return hasTemporalMatch(a, b, anchorA, anchorB, captureDedupWindowMs)
  }
  const nonTextA = getNonTextSignature(a)
  const nonTextB = getNonTextSignature(b)
  if (nonTextA && nonTextB && nonTextA === nonTextB) {
    if (normalizeQuotedMessageKey(a) !== normalizeQuotedMessageKey(b)) {
      return false
    }
    const anchorA = normalizeTimeAnchorKey(a.timestamp ?? null)
    const anchorB = normalizeTimeAnchorKey(b.timestamp ?? null)
    return hasTemporalMatch(a, b, anchorA, anchorB, captureDedupWindowMs)
  }
  return false
}

function normalizeComparableSenderType(row: ComparableChatRecordRow): 'user' | 'contact' | 'unknown' {
  return row.sender_type ?? row.sender ?? 'unknown'
}

function normalizeComparableSenderName(row: ComparableChatRecordRow): string {
  const senderType = normalizeComparableSenderType(row)
  const raw = senderType === 'contact' ? (row.sender_name ?? row.contact_name ?? '') : ''
  return canonicalizeText(raw)
}

function sameSpeaker(a: ChatRecordEntry, b: ChatRecordEntry): boolean {
  return (
    a.sender_type === b.sender_type
    && normalizeText(a.sender_type === 'contact' ? a.sender_name : '') === normalizeText(b.sender_type === 'contact' ? b.sender_name : '')
  )
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

function canonicalizeText(value: string): string {
  return normalizeText(value)
    .replace(/([\u3400-\u9fff])\s+([a-z0-9])/gi, '$1$2')
    .replace(/([a-z0-9])\s+([\u3400-\u9fff])/gi, '$1$2')
    .replace(/[^a-z0-9\u3400-\u9fff]+/gi, '')
}

function isSimilarText(a: string, b: string, threshold: number): boolean {
  if (!a || !b) {
    return false
  }
  if (a === b) {
    return true
  }
  if (hasStrongTextContainment(a, b, 6)) {
    return true
  }
  if (Math.min(a.length, b.length) < 6) {
    return false
  }
  return textSimilarity(a, b) >= threshold
}

function isSimilarMedia(a: string, b: string, threshold: number): boolean {
  if (!a || !b) {
    return false
  }
  if (a === b) {
    return true
  }
  if (hasStrongContainment(a, b, 8)) {
    return true
  }
  if (textOverlapRatio(a, b) >= 0.6) {
    return true
  }
  return textSimilarity(a, b) >= threshold
}

function hasStrongContainment(a: string, b: string, minLen: number): boolean {
  if (a.length < minLen || b.length < minLen) {
    return false
  }
  return a.includes(b) || b.includes(a)
}

function hasStrongTextContainment(a: string, b: string, minLen: number): boolean {
  if (!containsCjk(a) && !containsCjk(b)) {
    return false
  }
  return hasStrongContainment(a, b, minLen)
}

function containsCjk(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value)
}

function textOverlapRatio(a: string, b: string): number {
  const gramsA = buildBigrams(a)
  const gramsB = buildBigrams(b)
  if (gramsA.length === 0 || gramsB.length === 0) {
    return 0
  }
  const counts = new Map<string, number>()
  for (const gram of gramsA) {
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  let overlap = 0
  for (const gram of gramsB) {
    const available = counts.get(gram) ?? 0
    if (available <= 0) {
      continue
    }
    overlap += 1
    counts.set(gram, available - 1)
  }
  return overlap / Math.max(1, Math.min(gramsA.length, gramsB.length))
}

function shouldReplaceExisting(existing: ChatRecordEntry, incoming: ChatRecordEntry): boolean {
  if (!normalizeOptionalText(existing.timestamp) && normalizeOptionalText(incoming.timestamp)) {
    return true
  }

  const existingScore = informationScore(existing)
  const incomingScore = informationScore(incoming)
  if (incomingScore > existingScore + 4) {
    return true
  }

  const existingText = canonicalizeText(existing.content)
  const incomingText = canonicalizeText(incoming.content)
  const existingQuoted = normalizeQuotedMessage(existing.quoted_message)
  const incomingQuoted = normalizeQuotedMessage(incoming.quoted_message)
  if (existingText && incomingText && incomingText.length > existingText.length + 4 && incomingText.includes(existingText)) {
    return true
  }
  if (!existingQuoted && incomingQuoted) {
    return true
  }
  if (
    existingQuoted
    && incomingQuoted
    && canonicalizeText(incomingQuoted.text).length > canonicalizeText(existingQuoted.text).length + 4
    && canonicalizeText(incomingQuoted.text).includes(canonicalizeText(existingQuoted.text))
  ) {
    return true
  }

  const existingMedia = canonicalizeText(existing.metadata.non_text_description ?? '')
  const incomingMedia = canonicalizeText(incoming.metadata.non_text_description ?? '')
  const existingSignature = getNonTextSignature(existing)
  const incomingSignature = getNonTextSignature(incoming)
  if (!existingSignature && incomingSignature) {
    return true
  }
  if (
    existingMedia
    && incomingMedia
    && incomingMedia.length > existingMedia.length + 4
    && incomingMedia.includes(existingMedia)
  ) {
    return true
  }
  return false
}

function informationScore(entry: ChatRecordEntry): number {
  const textScore = canonicalizeText(entry.content).length
  const mediaScore = canonicalizeText(entry.metadata.non_text_description ?? '').length
  const quotedScore = canonicalizeText(entry.quoted_message?.text ?? '').length
  const typeBonus = entry.content_type && entry.content_type !== 'text' ? 4 : 0
  return textScore + mediaScore + quotedScore + typeBonus
}

function prefersVisibleTimestamp(row: ComparableChatRecordRow): boolean {
  const anchor = normalizeTimeAnchorKey(row.timestamp ?? null)
  return Boolean(anchor) && !isCaptureDerivedAnchor(row, anchor)
}

function pickPreferredTimestamp(existing: ChatRecordEntry, incoming: ChatRecordEntry): string | null {
  const existingTimestamp = normalizeStoredTimestampValue(existing.timestamp ?? null)
  const incomingTimestamp = normalizeStoredTimestampValue(incoming.timestamp ?? null)
  if (!existingTimestamp) {
    return incomingTimestamp
  }
  if (!incomingTimestamp) {
    return existingTimestamp
  }
  const existingVisible = prefersVisibleTimestamp(existing)
  const incomingVisible = prefersVisibleTimestamp(incoming)
  if (existingVisible && !incomingVisible) {
    return existingTimestamp
  }
  if (!existingVisible && incomingVisible) {
    return incomingTimestamp
  }
  return incomingTimestamp
}

function mergePreferMoreComplete(existing: ChatRecordEntry, incoming: ChatRecordEntry): ChatRecordEntry {
  const keepIncomingText = canonicalizeText(incoming.content).length >= canonicalizeText(existing.content).length
  const keepIncomingMedia =
    canonicalizeText(incoming.metadata.non_text_description ?? '').length
    >= canonicalizeText(existing.metadata.non_text_description ?? '').length
  const existingQuoted = normalizeQuotedMessage(existing.quoted_message)
  const incomingQuoted = normalizeQuotedMessage(incoming.quoted_message)
  const keepIncomingQuoted =
    canonicalizeText(incomingQuoted?.text ?? '').length >= canonicalizeText(existingQuoted?.text ?? '').length
  return attachLegacyAliases({
    message_id: incoming.message_id || existing.message_id,
    conversation_id: incoming.conversation_id || existing.conversation_id,
    sender_id: incoming.sender_id || existing.sender_id,
    sender_name: incoming.sender_name || existing.sender_name,
    sender_type: incoming.sender_type || existing.sender_type,
    content: keepIncomingText ? incoming.content : existing.content,
    content_type: incoming.content_type ?? existing.content_type,
    reply_to: incoming.reply_to ?? existing.reply_to,
    quoted_message: keepIncomingQuoted ? (incomingQuoted ?? existingQuoted) : (existingQuoted ?? incomingQuoted),
    timestamp: pickPreferredTimestamp(existing, incoming),
    metadata: {
      window_id: incoming.metadata.window_id ?? existing.metadata.window_id,
      non_text_description: keepIncomingMedia
        ? incoming.metadata.non_text_description
        : existing.metadata.non_text_description,
      non_text_signature: keepIncomingMedia
        ? (incoming.metadata.non_text_signature ?? getNonTextSignature(incoming) ?? null)
        : (existing.metadata.non_text_signature ?? getNonTextSignature(existing) ?? null),
      capture_timestamp: incoming.metadata.capture_timestamp ?? existing.metadata.capture_timestamp,
      event_id: incoming.metadata.event_id ?? existing.metadata.event_id,
      frame_id: incoming.metadata.frame_id ?? existing.metadata.frame_id
    }
  })
}

function textSimilarity(a: string, b: string): number {
  if (!a || !b) {
    return 0
  }
  if (a === b) {
    return 1
  }
  const gramsA = buildBigrams(a)
  const gramsB = buildBigrams(b)
  if (gramsA.length === 0 || gramsB.length === 0) {
    return 0
  }
  const counts = new Map<string, number>()
  for (const gram of gramsA) {
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  let overlap = 0
  for (const gram of gramsB) {
    const available = counts.get(gram) ?? 0
    if (available <= 0) {
      continue
    }
    overlap += 1
    counts.set(gram, available - 1)
  }
  return (2 * overlap) / (gramsA.length + gramsB.length)
}

function buildBigrams(value: string): string[] {
  const compact = value.trim()
  if (compact.length < 2) {
    return compact.length === 1 ? [compact] : []
  }
  const result: string[] = []
  for (let i = 0; i < compact.length - 1; i += 1) {
    result.push(compact.slice(i, i + 2))
  }
  return result
}

function deriveConversationTitleFromConversationId(conversationId: string | null): string | null {
  const raw = normalizeOptionalText(conversationId)
  if (!raw) {
    return null
  }
  const idx = raw.indexOf('::')
  const title = idx >= 0 ? raw.slice(idx + 2) : raw
  return normalizeConversationTitle(title)
}

function didNormalizeStoredEvent(source: unknown, normalized: ChatRecordEntry): boolean {
  if (!isRecord(source)) {
    return false
  }
  const metadata = isRecord(source.metadata) ? source.metadata : null
  return (
    normalizeOptionalText(source.content ?? source.text) !== normalized.content
    || normalizeOptionalText(source.timestamp) !== normalized.timestamp
    || normalizeContentType(source.content_type) !== normalized.content_type
    || normalizeOptionalText(metadata?.non_text_description ?? source.non_text_description)
      !== normalized.metadata.non_text_description
    ||
    normalizeOptionalText(source.message_id) !== normalized.message_id
    || normalizeOptionalText(metadata?.event_id ?? source.event_id) !== normalized.metadata.event_id
    || normalizeOptionalText(metadata?.frame_id ?? source.frame_id) !== normalized.metadata.frame_id
    || normalizeOptionalText(metadata?.capture_timestamp ?? source.timestamp) !== normalized.metadata.capture_timestamp
    || JSON.stringify(normalizeQuotedMessage(source.quoted_message)) !== JSON.stringify(normalized.quoted_message)
  )
}

function normalizeLoadedChatRecordFile(
  parsed: Partial<ChatRecordFile>,
  fallback: SessionSplit,
  options?: ChatRecordMaintenanceOptions
): { file: ChatRecordFile; repairedMessages: number; normalizationChanged: boolean } {
  const captureDedupWindowMs = normalizeCaptureDedupWindowMs(options?.captureDedupWindowMs)
  const rawSessionName = normalizeOptionalText(parsed.session_name) || fallback.sessionName
  const sessionKey = normalizeSessionKey(parsed.session_key ?? null, fallback.appName, rawSessionName, null)
  const authoritativeTitleKey = resolveAuthoritativeSessionTitleKey(sessionKey, fallback.sessionName)
  const sessionName = resolveDisplaySessionName(
    [
      parsed.session_name,
      ...(Array.isArray(parsed.title_aliases) ? parsed.title_aliases : []),
      fallback.sessionName,
    ],
    fallback.sessionName,
    authoritativeTitleKey
  )
  let sourceNormalizationChanged = false
  const normalizedMessages = Array.isArray(parsed.messages)
    ? parsed.messages
      .map((item) => {
        const normalized = normalizeChatRecordEvent(item as unknown as ChatRecordEventRow)
        if (normalized && didNormalizeStoredEvent(item, normalized)) {
          sourceNormalizationChanged = true
        }
        return normalized
      })
      .filter((item): item is ChatRecordEntry => item !== null)
    : []
  const repaired = repairDirectChatMessages(sessionName, sessionKey, normalizedMessages)
  const finalizedMessages = finalizeMergedMessages(
    repaired.messages,
    DEFAULT_WINDOW_SIZE,
    DEFAULT_MEDIA_SIMILARITY_THRESHOLD,
    captureDedupWindowMs
  )
  const compactionRepairs = Math.max(0, repaired.messages.length - finalizedMessages.length)
  const normalizedAppName = normalizeOptionalText(parsed.app_name) || fallback.appName
  const normalizedCanonicalTitleKey = authoritativeTitleKey
  const normalizedTitleAliases = mergeTitleAliases(
    Array.isArray(parsed.title_aliases) ? parsed.title_aliases : [],
    sessionName,
    finalizedMessages,
    sessionName,
    authoritativeTitleKey
  )
  const normalizedConfirmedAliases = normalizeConfirmedTitleAliases(parsed.confirmed_title_aliases)
  const fileNormalizationChanged =
    normalizeOptionalText(parsed.session_name) !== sessionName
    || normalizeOptionalText(parsed.session_key) !== sessionKey
    || normalizeOptionalText(parsed.app_name) !== normalizedAppName
    || normalizeOptionalText(parsed.updated_at) === null
    || normalizeSessionTitleKey(normalizeOptionalText(parsed.canonical_title_key) || sessionName) !== normalizedCanonicalTitleKey
    || JSON.stringify(Array.isArray(parsed.title_aliases) ? parsed.title_aliases : []) !== JSON.stringify(normalizedTitleAliases)
    || JSON.stringify(Array.isArray(parsed.confirmed_title_aliases) ? normalizeConfirmedTitleAliases(parsed.confirmed_title_aliases) : []) !== JSON.stringify(normalizedConfirmedAliases)
  const normalizationChanged =
    sourceNormalizationChanged
    || fileNormalizationChanged
    || !areChatRecordEntriesEqual(repaired.messages, finalizedMessages)

  return {
    file: {
      session_name: sessionName,
      session_key: sessionKey,
      app_name: normalizedAppName,
      canonical_title_key: normalizedCanonicalTitleKey,
      title_aliases: normalizedTitleAliases,
      confirmed_title_aliases: normalizedConfirmedAliases,
      owner_user_id: parsed.owner_user_id, // Preserve existing owner_user_id
      updated_at: normalizeOptionalText(parsed.updated_at) || new Date().toISOString(),
      schema_version: typeof parsed.schema_version === 'number' ? parsed.schema_version : CHAT_RECORD_SCHEMA_VERSION,
      messages: finalizedMessages
    },
    repairedMessages: repaired.repairedMessages + compactionRepairs,
    normalizationChanged
  }
}

function areChatRecordEntriesEqual(left: ChatRecordEntry[], right: ChatRecordEntry[]): boolean {
  if (left.length !== right.length) {
    return false
  }
  for (let index = 0; index < left.length; index += 1) {
    if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) {
      return false
    }
  }
  return true
}

function repairDirectChatMessages(
  sessionName: string,
  sessionKey: string,
  messages: ChatRecordEntry[]
): { messages: ChatRecordEntry[]; repairedMessages: number } {
  const normalizedTitle =
    normalizeConversationTitle(sessionName)
    || deriveConversationTitleFromConversationId(sessionKey)
  if (!normalizedTitle) {
    return { messages, repairedMessages: 0 }
  }

  const titleKey = normalizeSessionTitleKey(normalizedTitle)
  if (!titleKey) {
    return { messages, repairedMessages: 0 }
  }

  const contactMessages = messages.filter((message) => message.sender_type === 'contact')
  if (contactMessages.length === 0) {
    return { messages, repairedMessages: 0 }
  }

  const distinctCounts = new Map<string, number>()
  for (const message of contactMessages) {
    const senderKey = normalizeSessionTitleKey(message.sender_name)
    if (!senderKey) {
      continue
    }
    distinctCounts.set(senderKey, (distinctCounts.get(senderKey) ?? 0) + 1)
  }

  const titleMatchCount = distinctCounts.get(titleKey) ?? 0
  if (titleMatchCount <= 0) {
    return { messages, repairedMessages: 0 }
  }

  const repeatedConflictingNames = Array.from(distinctCounts.entries()).filter(
    ([nameKey, count]) => nameKey !== titleKey && count >= 2
  )
  if (repeatedConflictingNames.length >= 2) {
    return { messages, repairedMessages: 0 }
  }

  const canonicalSenderId = titleKey
  let repairedMessages = 0
  const nextMessages = messages.map((message) => {
    if (message.sender_type !== 'contact') {
      return message
    }
    const needsRepair =
      normalizeSessionTitleKey(message.sender_name) !== titleKey
      || normalizeOptionalText(message.sender_id) !== canonicalSenderId
    if (!needsRepair) {
      return message
    }
    repairedMessages += 1
    return attachLegacyAliases({
      ...message,
      sender_id: canonicalSenderId,
      sender_name: normalizedTitle
    }, {
      contact_name: normalizedTitle,
      conversation_title: normalizedTitle,
      session_key: message.conversation_id
    })
  })

  return { messages: nextMessages, repairedMessages }
}

export const __chatRecordsTestUtils = {
  normalizeAppName,
  normalizeSessionKey,
  buildPendingSessionId,
  resolveMappedSessionName,
  learnSessionNameMappingsForAliases,
  loadSessionNameMappings,
  saveSessionNameMappings
}
