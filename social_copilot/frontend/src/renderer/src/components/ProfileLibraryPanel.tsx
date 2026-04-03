import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import {
  createDefaultUnifiedContactProfile,
  createDefaultUnifiedUserProfile,
  type UnifiedEvidence,
  type UnifiedFact,
  type UnifiedProfile
} from '../../../models/schemas'
import { resolveImportPathFromFiles } from './memory-import-upload'

// ProfileField type for new structure
interface ProfileField {
  value: string
  evidence_level?: string  // L1 显式 / L2 强隐含
  evidences: string[]
}

type EpisodicMemoryItem = Awaited<
  ReturnType<typeof window.electronAPI.profileAdmin.listEpisodes>
>[number]
type ForesightItem = Awaited<
  ReturnType<typeof window.electronAPI.profileAdmin.listForesights>
>[number]
type MemCellItem = Awaited<
  ReturnType<typeof window.electronAPI.profileAdmin.listMemcells>
>[number]
type ProfileBackfillResult = Awaited<
  ReturnType<typeof window.electronAPI.profileAdmin.backfillHistory>
>
type BackfillSessionSummary = Awaited<
  ReturnType<typeof window.electronAPI.profileAdmin.listBackfillSessions>
>[number]
type ProfileBackfillJobState = Awaited<
  ReturnType<typeof window.electronAPI.profileAdmin.getBackfillJobState>
>
type RegenerateProfilesResult = Awaited<
  ReturnType<typeof window.electronAPI.profileAdmin.regenerateProfiles>
>
type ImportInitializeMemoryResult = Awaited<
  ReturnType<typeof window.electronAPI.import.initializeMemoryFromPath>
>

interface ImportInitializeMemoryProgress {
  stage: 'importing' | 'normalizing' | 'persisting' | 'backfilling' | 'complete'
  progress: number
  message: string
}

type DetailTab = 'profile' | 'memcells' | 'episodes' | 'foresights'

interface ProfileLibraryPanelProps {
  ownerUserId: string
  ownerDisplayName: string
  refreshToken: number
  onRefresh: () => Promise<void> | void
}

interface ContextMenuState {
  x: number
  y: number
  profile: UnifiedProfile
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeText(value?: string | null): string {
  return (value ?? '').trim().toLowerCase()
}

function formatTime(value?: string | null): string {
  if (!value) {
    return '--'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  const hour = `${date.getHours()}`.padStart(2, '0')
  const minute = `${date.getMinutes()}`.padStart(2, '0')
  return `${month}/${day} ${hour}:${minute}`
}

function splitList(value: string): string[] {
  return value
    .split(/[,\n，]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function formatProfileType(type: UnifiedProfile['profile_type']): string {
  return type === 'user' ? '自己' : '好友'
}

function formatIntimacy(level?: string | null): string {
  switch (level) {
    case 'formal':
      return '正式'
    case 'close':
      return '熟悉'
    case 'intimate':
      return '亲密'
    default:
      return '陌生'
  }
}

function formatRole(role?: string | null): string {
  if (!role || role === 'unknown') {
    return '未设置角色'
  }
  if (role === 'self') {
    return '本人'
  }
  return role
}

// Helper: extract values from profile fields (supports multiple formats)
// - New format: ProfileField[] = [{value: "...", evidences: [...]}]
// - Old format: string[] = ["direct", "systematic"]
// - Old nested dict: {tone_style: "friendly", frequent_phrases: [...]}
function getFieldValues(fields: unknown): string[] {
  if (!fields) return []

  // New format: ProfileField[]
  if (Array.isArray(fields)) {
    if (fields.length === 0) return []
    if (typeof fields[0] === 'object' && fields[0] !== null && 'value' in fields[0]) {
      return (fields as ProfileField[]).map(f => f.value).filter((v): v is string => !!v)
    }
    // Old string[] format
    return fields.filter((v): v is string => typeof v === 'string')
  }

  // Old nested dict format (e.g., communication_style = {tone_style: "friendly", frequent_phrases: [...]})
  if (typeof fields === 'object' && fields !== null) {
    const result: string[] = []
    const obj = fields as Record<string, unknown>

    // Extract from nested arrays like frequent_phrases
    for (const key of ['frequent_phrases', 'emoji_usage']) {
      const arr = obj[key]
      if (Array.isArray(arr)) {
        for (const v of arr) {
          if (typeof v === 'string' && v.trim()) {
            result.push(v.trim())
          }
        }
      }
    }

    // Extract string values like tone_style
    for (const key of ['tone_style', 'punctuation_style']) {
      const val = obj[key]
      if (typeof val === 'string' && val.trim() && !['unknown', 'short', 'medium', 'long'].includes(val)) {
        result.push(val.trim())
      }
    }

    // Single value field with "value" key
    if ('value' in obj && typeof obj.value === 'string') {
      result.push(obj.value)
    }

    return result
  }

  return []
}

function getFieldValue(field: unknown): string {
  if (!field) return ''
  if (typeof field === 'string') return field
  if (typeof field === 'object' && field !== null && 'value' in field) {
    return (field as ProfileField).value || ''
  }
  return ''
}

function getEvidenceLevel(field: unknown): string {
  if (!field) return ''
  if (typeof field === 'object' && field !== null && 'evidence_level' in field) {
    return (field as ProfileField).evidence_level || ''
  }
  return ''
}

// Format field values with evidence_level prefix: [L1] value1, [L2] value2
function formatFieldsWithLevel(fields: unknown): string {
  if (!fields) return ''
  if (!Array.isArray(fields)) return getFieldValue(fields)

  return fields
    .filter((f): f is ProfileField => typeof f === 'object' && f !== null && 'value' in f && (f as ProfileField).value)
    .map(f => {
      const level = f.evidence_level ? `[${f.evidence_level}] ` : ''
      return `${level}${f.value}`
    })
    .join('\n')
}

// Parse textarea value back to ProfileField array (remove [L1]/[L2] prefix)
function parseFieldsWithLevel(value: string, defaultLevel: string = 'L2'): ProfileField[] {
  return value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const match = line.match(/^\[([Ll][12])\]\s*(.+)$/i)
      if (match) {
        return { value: match[2].trim(), evidence_level: match[1].toUpperCase(), evidences: [] }
      }
      return { value: line, evidence_level: defaultLevel, evidences: [] }
    })
}

function buildProfileSummary(profile: UnifiedProfile): string {
  const parts = [
    getFieldValue(profile.occupation),
    ...getFieldValues(profile.traits).slice(0, 2),
    ...getFieldValues(profile.interests).slice(0, 2),
    profile.social_attributes.current_status
  ]
    .map((item) => item?.trim?.() ?? '')
    .filter((item) => item && item !== 'unknown')
  return parts.length > 0 ? parts.join(' · ') : '暂无摘要'
}

function buildCurrentUserSummary(profile: UnifiedProfile | null): string {
  if (!profile) {
    return '当前长期记忆 owner，后端画像会按这个用户 ID 进行加载和更新。'
  }
  const parts = [
    getFieldValue(profile.occupation),
    profile.social_attributes.role,
    getFieldValues(profile.traits)[0] ?? '',
    getFieldValues(profile.interests)[0] ?? ''
  ]
    .map((item) => item?.trim?.() ?? '')
    .filter((item) => item && item !== 'unknown' && item !== 'self')
  return parts.length > 0
    ? parts.join(' · ')
    : '当前长期记忆 owner，后端画像会按这个用户 ID 进行加载和更新。'
}

function formatMessageLength(value?: string | null): string {
  switch (value) {
    case 'medium':
      return '中等'
    case 'long':
      return '较长'
    default:
      return '较短'
  }
}

function formatRiskLevel(value?: string | null): string {
  switch (value) {
    case 'medium':
      return '中'
    case 'high':
      return '高'
    default:
      return '低'
  }
}

function displayText(value?: string | null, fallback: string = '未设置'): string {
  const normalized = (value ?? '').trim()
  return normalized || fallback
}

function displayList(values: string[], fallback: string = '暂无'): string {
  const normalized = values.map((item) => item.trim()).filter(Boolean)
  return normalized.length > 0 ? normalized.join('、') : fallback
}

function formatBackfillResult(result: ProfileBackfillResult | null): string | null {
  if (!result) {
    return null
  }
  const base = `已扫描 ${result.scannedSessions} 个会话，处理 ${result.processedSessions} 个，更新 ${result.updatedProfiles} 个画像，跳过 ${result.skippedSessions} 个。`
  if (result.failedSessions > 0) {
    const failedNames = result.failedSessionNames.slice(0, 3).join('、')
    const failedReasons = result.failedReasons
      .map((reason) => reason.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join('；')
    return `${base} 失败 ${result.failedSessions} 个${failedNames ? `：${failedNames}` : ''}${failedReasons ? `。原因：${failedReasons}` : '。'}`
  }
  return base
}

function formatBackfillJobStatus(job: ProfileBackfillJobState | null): string | null {
  if (!job?.active) {
    return null
  }
  const chunkProgress = job.totalChunks > 0 ? `，分批 ${job.completedChunks}/${job.totalChunks}` : ''
  const currentSession = job.currentSessionName ? `，当前：${job.currentSessionName}` : ''
  return `正在回填旧聊天：会话 ${job.completedSessions}/${job.scannedSessions}${chunkProgress}${currentSession}。`
}

function deriveDefaultBackfillSelection(sessions: BackfillSessionSummary[]): string[] {
  const pendingSessions = sessions
    .filter((session) => session.pendingMessageCount > 0)
    .map((session) => session.sessionKey)
  if (pendingSessions.length > 0) {
    return pendingSessions
  }
  return sessions.map((session) => session.sessionKey)
}

function formatImportResult(result: ImportInitializeMemoryResult | null): string | null {
  if (!result) {
    return null
  }
  const base = `已导入 ${result.importedMessages} 条消息，写入 ${result.writtenSessions} 个会话，初始化 ${result.initializedSessions} 个会话，更新 ${result.updatedProfiles} 个画像。`
  const hint = '导入完成后可点击“回填旧聊天”基于 chat_records/微信 重新生成画像。'
  if (result.failedInitializationSessions > 0) {
    const failedNames = result.failedSessionNames.slice(0, 3).join('、')
    return `${base} 失败 ${result.failedInitializationSessions} 个${failedNames ? `：${failedNames}` : ''}。${hint}`
  }
  return `${base}${hint}`
}

function normalizeProfileDisplayName(profile: UnifiedProfile): UnifiedProfile {
  if (profile.profile_type !== 'user') {
    return {
      ...profile,
      aliases: profile.aliases.length > 0
        ? profile.aliases
        : profile.display_name
          ? [profile.display_name]
          : []
    }
  }
  if (profile.display_name === 'Me' && profile.aliases.includes('Me')) {
    return profile
  }
  return {
    ...profile,
    display_name: 'Me',
    aliases: Array.from(new Set(['Me', ...(profile.aliases || []), profile.display_name].filter(Boolean)))
  }
}

function getContactConversationId(profile: UnifiedProfile | null): string {
  if (!profile || profile.profile_type !== 'contact') {
    return ''
  }
  return normalizeText(profile.conversation_id)
}

function hasParticipantMatch(
  participants: string[] | undefined,
  values: string[]
): boolean {
  if (!participants || participants.length === 0) {
    return false
  }
  const normalizedParticipants = participants.map((item) => normalizeText(item)).filter(Boolean)
  const normalizedValues = values.map((item) => normalizeText(item)).filter(Boolean)
  return normalizedValues.some((value) => normalizedParticipants.includes(value))
}

function matchesContactMemoryRecord(
  profile: UnifiedProfile,
  record: {
    conversation_id?: string | null
    participants?: string[]
  }
): boolean {
  const conversationId = getContactConversationId(profile)
  const recordConversationId = normalizeText(record.conversation_id)
  if (conversationId && recordConversationId && recordConversationId === conversationId) {
    return true
  }

  return hasParticipantMatch(record.participants, [profile.target_user_id ?? ''])
}

function filterEpisodes(episodes: EpisodicMemoryItem[], profile: UnifiedProfile | null): EpisodicMemoryItem[] {
  if (!profile) {
    return []
  }
  if (profile.profile_type === 'user') {
    return episodes.filter((item) => normalizeText(item.user_id) === normalizeText(profile.owner_user_id))
  }
  const conversationId = getContactConversationId(profile)
  if (!conversationId && !profile.target_user_id) {
    return []
  }
  return episodes.filter((item) => matchesContactMemoryRecord(profile, item))
}

function filterForesights(foresights: ForesightItem[], profile: UnifiedProfile | null): ForesightItem[] {
  if (!profile) {
    return []
  }
  if (profile.profile_type === 'user') {
    return foresights.filter((item) => normalizeText(item.user_id) === normalizeText(profile.owner_user_id))
  }
  const conversationId = getContactConversationId(profile)
  if (!conversationId && !profile.target_user_id) {
    return []
  }
  return foresights.filter((item) => matchesContactMemoryRecord(profile, item))
}

function filterMemcells(memcells: MemCellItem[], profile: UnifiedProfile | null): MemCellItem[] {
  if (!profile) {
    return []
  }
  if (profile.profile_type === 'user') {
    return memcells.filter((item) => normalizeText(item.user_id) === normalizeText(profile.owner_user_id))
  }
  const conversationId = getContactConversationId(profile)
  if (!conversationId && !profile.target_user_id) {
    return []
  }
  return memcells.filter((item) => matchesContactMemoryRecord(profile, item))
}

function createLocalId(prefix: 'user' | 'contact'): string {
  return `local:${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
}

function isLocalDraft(profile: UnifiedProfile): boolean {
  return profile.profile_id.startsWith('local:')
}

function toPersistedProfile(profile: UnifiedProfile): UnifiedProfile {
  if (!isLocalDraft(profile)) {
    return profile
  }
  const next = deepClone(profile)
  if (next.profile_type === 'user') {
    next.profile_id = next.owner_user_id
  } else {
    next.profile_id = next.target_user_id || next.profile_id.replace(/^local:contact:/, 'contact_')
    if (!next.conversation_id) {
      next.conversation_id = next.target_user_id || next.profile_id
    }
  }
  return next
}

export function ProfileLibraryPanel({
  ownerUserId,
  ownerDisplayName,
  refreshToken,
  onRefresh
}: ProfileLibraryPanelProps): JSX.Element {
  const [profiles, setProfiles] = useState<UnifiedProfile[]>([])
  const [episodes, setEpisodes] = useState<EpisodicMemoryItem[]>([])
  const [memcells, setMemcells] = useState<MemCellItem[]>([])
  const [foresights, setForesights] = useState<ForesightItem[]>([])
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null)
  const [draft, setDraft] = useState<UnifiedProfile | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [backfilling, setBackfilling] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summaryMessage, setSummaryMessage] = useState<string | null>(null)
  const [importingHistory, setImportingHistory] = useState(false)
  const [importProgress, setImportProgress] = useState<ImportInitializeMemoryProgress | null>(null)
  const [importTargetLabel, setImportTargetLabel] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [backfillSessions, setBackfillSessions] = useState<BackfillSessionSummary[]>([])
  const [selectedBackfillSessionKeys, setSelectedBackfillSessionKeys] = useState<string[]>([])
  const [showBackfillPicker, setShowBackfillPicker] = useState(false)
  const [backfillJob, setBackfillJob] = useState<ProfileBackfillJobState | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [detailTab, setDetailTab] = useState<DetailTab>('profile')
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const liveRefreshTimerRef = useRef<number | null>(null)
  const backfillJobActiveRef = useRef(false)

  const loadData = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const [nextProfiles, nextEpisodes, nextMemcells, nextForesights] = await Promise.all([
        window.electronAPI.profileAdmin.list(),
        window.electronAPI.profileAdmin.listEpisodes(),
        window.electronAPI.profileAdmin.listMemcells(),
        window.electronAPI.profileAdmin.listForesights()
      ])
      setProfiles(nextProfiles.map(normalizeProfileDisplayName))
      setEpisodes(nextEpisodes)
      setMemcells(nextMemcells)
      setForesights(nextForesights)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '长期记忆加载失败')
      setProfiles([])
      setEpisodes([])
      setMemcells([])
      setForesights([])
    } finally {
      setLoading(false)
    }
  }

  const loadBackfillSessions = async (): Promise<void> => {
    try {
      const sessions = await window.electronAPI.profileAdmin.listBackfillSessions()
      const sortedSessions = [...sessions].sort((a, b) => {
        const timeA = new Date(a.updatedAt || 0).getTime()
        const timeB = new Date(b.updatedAt || 0).getTime()
        return timeB - timeA
      })
      setBackfillSessions(sortedSessions)
      setSelectedBackfillSessionKeys((current) => {
        const validCurrent = current.filter((sessionKey) =>
          sortedSessions.some((session) => session.sessionKey === sessionKey)
        )
        return validCurrent.length > 0 ? validCurrent : deriveDefaultBackfillSelection(sortedSessions)
      })
    } catch {
      setBackfillSessions([])
      setSelectedBackfillSessionKeys([])
    }
  }

  const syncBackfillJob = async (): Promise<void> => {
    try {
      const job = await window.electronAPI.profileAdmin.getBackfillJobState()
      setBackfillJob(job)
      setBackfilling(job.active)
      if (job.active) {
        backfillJobActiveRef.current = true
        setSummaryMessage(formatBackfillJobStatus(job))
        return
      }
      const finishedFromBackground = backfillJobActiveRef.current
      backfillJobActiveRef.current = false
      if (job.result) {
        setSummaryMessage(formatBackfillResult(job.result))
      }
      if (job.error) {
        setError(job.error)
      }
      if (finishedFromBackground) {
        void Promise.all([loadData(), loadBackfillSessions()])
      }
    } catch {
      setBackfillJob(null)
    }
  }

  const refreshMemoryView = async (): Promise<void> => {
    await onRefresh()
    await Promise.all([loadData(), loadBackfillSessions(), syncBackfillJob()])
  }

  const stopLiveRefresh = (): void => {
    if (liveRefreshTimerRef.current !== null) {
      window.clearInterval(liveRefreshTimerRef.current)
      liveRefreshTimerRef.current = null
    }
  }

  const startLiveRefresh = (): void => {
    if (liveRefreshTimerRef.current !== null) {
      return
    }
    liveRefreshTimerRef.current = window.setInterval(() => {
      void loadData()
      void onRefresh()
    }, 1500)
  }

  const handleImportProgress = (progress: ImportInitializeMemoryProgress): void => {
    setImportProgress(progress)
    if (progress.stage === 'backfilling') {
      setSummaryMessage('正在初始化旧聊天记录，长期记忆列表会自动刷新。完成后可再次点击“回填旧聊天”基于 chat_records/微信 重新生成画像。')
      startLiveRefresh()
      void refreshMemoryView()
      return
    }
    if (progress.stage === 'complete') {
      stopLiveRefresh()
      void refreshMemoryView()
      return
    }
    stopLiveRefresh()
  }

  const runImportFromPath = async (inputPath: string, sourceLabel: string): Promise<void> => {
    if (!window.electronAPI) {
      throw new Error('Electron API 不可用')
    }

    setError(null)
    setImportingHistory(true)
    setImportTargetLabel(sourceLabel)
    setImportProgress({
      stage: 'importing',
      progress: 0,
      message: '准备导入旧聊天记录...'
    })
    setSummaryMessage(null)

    window.electronAPI.import.onInitializeMemoryProgress(handleImportProgress)
    try {
      const result = await window.electronAPI.import.initializeMemoryFromPath(inputPath)
      if (!result.success) {
        setSummaryMessage(formatImportResult(result))
        setError(result.errors[0] ?? '导入旧聊天记录失败')
        return
      }
      setSummaryMessage(formatImportResult(result))
      setImportProgress({
        stage: 'complete',
        progress: 100,
        message: '导入与初始化完成'
      })
      stopLiveRefresh()
      await refreshMemoryView()
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : '导入旧聊天记录失败')
    } finally {
      stopLiveRefresh()
      setImportingHistory(false)
      window.electronAPI.import.offInitializeMemoryProgress()
    }
  }

  const handleFilesPicked = async (fileList: FileList | null | undefined): Promise<void> => {
    const inputPath = resolveImportPathFromFiles(Array.from(fileList ?? []))
    if (!inputPath) {
      setError('未能识别可导入的文件或文件夹')
      return
    }
    await runImportFromPath(inputPath, inputPath)
  }

  const handleDrop = async (event: ReactDragEvent<HTMLDivElement>): Promise<void> => {
    event.preventDefault()
    event.stopPropagation()
    setDragActive(false)
    await handleFilesPicked(event.dataTransfer.files)
  }

  const handleDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    setDragActive(true)
  }

  const handleDragLeave = (event: ReactDragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    setDragActive(false)
  }

  const openFilePicker = async (): Promise<void> => {
    if (!window.electronAPI) {
      setError('Electron API 不可用')
      return
    }
    const inputPath = await window.electronAPI.import.selectMemoryImportFilePath()
    if (!inputPath) {
      return
    }
    await runImportFromPath(inputPath, inputPath)
  }

  const openFolderPicker = async (): Promise<void> => {
    if (!window.electronAPI) {
      setError('Electron API 不可用')
      return
    }
    const inputPath = await window.electronAPI.import.selectMemoryImportFolderPath()
    if (!inputPath) {
      return
    }
    await runImportFromPath(inputPath, inputPath)
  }

  useEffect(() => {
    return () => {
      stopLiveRefresh()
      window.electronAPI.import.offInitializeMemoryProgress()
    }
  }, [])

  useEffect(() => {
    void Promise.all([loadData(), loadBackfillSessions(), syncBackfillJob()])
  }, [ownerUserId, refreshToken])

  useEffect(() => {
    if (!backfilling && !backfillJob?.active) {
      return undefined
    }
    const timerId = window.setInterval(() => {
      void syncBackfillJob()
    }, 1500)
    return () => {
      window.clearInterval(timerId)
    }
  }, [backfilling, backfillJob?.active])

  const filteredProfiles = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase()
    const sorted = [...profiles].sort((a, b) => {
      const aTime = new Date(a.metadata.last_updated || a.metadata.created_at || 0).getTime()
      const bTime = new Date(b.metadata.last_updated || b.metadata.created_at || 0).getTime()
      return bTime - aTime
    })
    if (!normalizedQuery) {
      return sorted
    }
    return sorted.filter((profile) =>
      [
        profile.display_name,
        profile.aliases.join(' '),
        getFieldValue(profile.occupation as ProfileField | string | null),
        profile.social_attributes.role,
        profile.social_attributes.current_status,
        getFieldValues(profile.traits as ProfileField[] | string[]).join(' '),
        getFieldValues(profile.interests as ProfileField[] | string[]).join(' '),
        getFieldValues(profile.communication_style as ProfileField[] | string[]).join(' '),
        profile.target_user_id ?? '',
        profile.conversation_id ?? ''
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery)
    )
  }, [profiles, searchQuery])

  const selfProfiles = useMemo(
    () => filteredProfiles.filter((profile) => profile.profile_type === 'user'),
    [filteredProfiles]
  )
  const contactProfiles = useMemo(
    () => filteredProfiles.filter((profile) => profile.profile_type === 'contact'),
    [filteredProfiles]
  )

  useEffect(() => {
    const allProfiles = [...selfProfiles, ...contactProfiles]
    if (allProfiles.length === 0) {
      setSelectedProfileId(null)
      setDraft(null)
      return
    }
    if (selectedProfileId && allProfiles.some((profile) => profile.profile_id === selectedProfileId)) {
      return
    }
    setSelectedProfileId(allProfiles[0].profile_id)
    setDraft(deepClone(normalizeProfileDisplayName(allProfiles[0])))
    setDetailTab('profile')
  }, [selfProfiles, contactProfiles, selectedProfileId])

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.profile_id === selectedProfileId) ?? null,
    [profiles, selectedProfileId]
  )

  useEffect(() => {
    if (!selectedProfile) {
      return
    }
    setDraft(deepClone(normalizeProfileDisplayName(selectedProfile)))
  }, [selectedProfile])

  useEffect(() => {
    if (!menu) {
      return undefined
    }
    const closeMenu = (): void => setMenu(null)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        closeMenu()
      }
    }
    window.addEventListener('click', closeMenu)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', closeMenu, true)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', closeMenu, true)
    }
  }, [menu])

  const currentUserProfile =
    selfProfiles.find((profile) => normalizeText(profile.owner_user_id) === normalizeText(ownerUserId)) ||
    selfProfiles[0] ||
    null

  const selectedEpisodes = useMemo(
    () => filterEpisodes(episodes, draft ?? selectedProfile),
    [draft, episodes, selectedProfile]
  )
  const selectedMemcells = useMemo(
    () => filterMemcells(memcells, draft ?? selectedProfile),
    [draft, memcells, selectedProfile]
  )
  const selectedForesights = useMemo(
    () => filterForesights(foresights, draft ?? selectedProfile),
    [draft, foresights, selectedProfile]
  )

  const counts = {
    total: profiles.length,
    self: profiles.filter((profile) => profile.profile_type === 'user').length,
    contacts: profiles.filter((profile) => profile.profile_type === 'contact').length,
    memcells: memcells.length,
    episodes: episodes.length,
    foresights: foresights.length
  }

  const openContextMenu = (
    event: Pick<MouseEvent, 'clientX' | 'clientY'> | ReactMouseEvent<HTMLButtonElement>,
    profile: UnifiedProfile
  ): void => {
    const normalizedProfile = normalizeProfileDisplayName(profile)
    setSelectedProfileId(normalizedProfile.profile_id)
    setDraft(deepClone(normalizedProfile))
    setMenu({ x: event.clientX, y: event.clientY, profile })
  }

  const deleteProfiles = async (items: UnifiedProfile[]): Promise<void> => {
    if (items.length === 0) {
      return
    }
    const label = items.length === 1 ? `“${items[0].display_name || '未命名画像'}”` : `${items.length} 条画像`
    if (!window.confirm(`确认删除 ${label} 吗？`)) {
      return
    }
    try {
      await Promise.all(
        items.map(async (profile) => {
          if (!isLocalDraft(profile)) {
            await window.electronAPI.profileAdmin.delete(profile.profile_id)
          }
        })
      )
      setProfiles((current) =>
        current.filter((profile) => !items.some((item) => item.profile_id === profile.profile_id))
      )
      setSelectedIds((current) =>
        current.filter((id) => !items.some((item) => item.profile_id === id))
      )
      if (items.some((item) => item.profile_id === selectedProfileId)) {
        setSelectedProfileId(null)
        setDraft(null)
      }
      setMenu(null)
      await onRefresh()
      await loadData()
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除画像失败')
    }
  }

  const handleSave = async (): Promise<void> => {
    if (!draft) {
      return
    }
    setSaving(true)
    setError(null)
    try {
      const saved = normalizeProfileDisplayName(
        await window.electronAPI.profileAdmin.save(toPersistedProfile(deepClone(draft)))
      )
      setProfiles((current) => {
        const filtered = current.filter(
          (profile) => profile.profile_id !== draft.profile_id && profile.profile_id !== saved.profile_id
        )
        return [saved, ...filtered]
      })
      setSelectedProfileId(saved.profile_id)
      setDraft(deepClone(saved))
      await onRefresh()
      await loadData()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存画像失败')
    } finally {
      setSaving(false)
    }
  }

  const handleBackfill = async (): Promise<void> => {
    setBackfilling(true)
    setError(null)
    try {
      const sessionKeys =
        selectedBackfillSessionKeys.length > 0
          ? selectedBackfillSessionKeys
          : deriveDefaultBackfillSelection(backfillSessions)
      const useSessionSelectionPipeline = showBackfillPicker && sessionKeys.length > 0
      const result = await window.electronAPI.profileAdmin.backfillHistory(
        useSessionSelectionPipeline ? false : true,
        sessionKeys
      )
      setSummaryMessage(formatBackfillResult(result))
      await onRefresh()
      await Promise.all([loadData(), loadBackfillSessions(), syncBackfillJob()])
    } catch (backfillError) {
      setError(backfillError instanceof Error ? backfillError.message : '回填旧聊天失败')
    } finally {
      setBackfilling(false)
    }
  }

  const handleRegenerate = async (): Promise<void> => {
    if (!window.confirm('确认要基于所有 MemCell 重新生成所有画像吗？此操作可能需要较长时间。')) {
      return
    }
    setRegenerating(true)
    setError(null)
    try {
      const result = await window.electronAPI.profileAdmin.regenerateProfiles()
      if (result.success) {
        setSummaryMessage(
          `重新生成完成：扫描 ${result.scanned_memcells} 个 MemCell，处理 ${result.processed_conversations} 个会话，更新 ${result.updated_profiles} 个画像。`
        )
      } else {
        setError(result.errors.length > 0 ? result.errors.join('; ') : '重新生成失败')
      }
      await onRefresh()
      await loadData()
    } catch (regenerateError) {
      setError(regenerateError instanceof Error ? regenerateError.message : '重新生成画像失败')
    } finally {
      setRegenerating(false)
    }
  }

  const handleClearProfiles = async (): Promise<void> => {
    if (!window.confirm('确认要清空所有画像内容吗？此操作将保留基础标识（ID、名字），但清空所有画像字段（特征、兴趣、风格等）。此操作不可恢复！')) {
      return
    }
    setClearing(true)
    setError(null)
    try {
      const result = await window.electronAPI.profileAdmin.clearProfiles()
      if (result.success) {
        setSummaryMessage(`清空完成：已清空 ${result.cleared_profiles} 个画像的字段内容。`)
      } else {
        setError('清空画像失败')
      }
      await onRefresh()
      await loadData()
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : '清空画像失败')
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="memory-library-shell">
      <section className="console-card">
        <div className="memory-section-head">
          <div>
            <h3>长期记忆</h3>
            <p>这里展示 EverMemOS 中的画像、情节与前瞻信息，可直接查看、检索和管理。</p>
            <div className="profile-current-user-card">
              <div className="profile-current-user-row">
                <strong>{currentUserProfile?.display_name || '未识别用户'}</strong>
                <span>{ownerDisplayName}</span>
              </div>
              <p>{buildCurrentUserSummary(currentUserProfile)}</p>
              <div className="profile-current-user-counts">
                <em>画像 {counts.total}</em>
                <em>自己 {counts.self}</em>
                <em>好友 {counts.contacts}</em>
                <em>情节 {counts.episodes}</em>
                <em>前瞻 {counts.foresights}</em>
              </div>
              {summaryMessage ? <p className="profile-backfill-summary">{summaryMessage}</p> : null}
            </div>
          </div>
          <div className="memory-section-actions">
            <div
              className={`memory-upload-panel ${dragActive ? 'drag-active' : ''}`}
              onDragEnter={handleDragOver}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={(event) => void handleDrop(event)}
            >
              <div className="memory-upload-copy">
                <strong>导入旧聊天记录</strong>
                <p>拖拽聊天记录文件或文件夹到这里，或者点击按钮选择 WeChatMsg、wechatDataBackup 或解密后的 SQLite 文件。导入完成后可点击“回填旧聊天”基于 chat_records/微信 重新生成画像。</p>
                {importTargetLabel ? <span className="memory-upload-target">已选：{importTargetLabel}</span> : null}
                {importProgress ? (
                  <span className="memory-upload-status-line">
                    {importProgress.progress}% · {importProgress.message}
                  </span>
                ) : null}
              </div>
              <div className="memory-upload-actions">
                <button
                  type="button"
                  className="memory-refresh-btn"
                  onClick={() => void openFilePicker()}
                  disabled={importingHistory || backfilling || regenerating || clearing}
                >
                  选择文件
                </button>
                <button
                  type="button"
                  className="memory-refresh-btn"
                  onClick={() => void openFolderPicker()}
                  disabled={importingHistory || backfilling || regenerating || clearing}
                >
                  选择文件夹
                </button>
              </div>
            </div>
            <label className="memory-search-field">
              <span>搜索长期记忆</span>
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="搜索好友、画像、情节、前瞻"
              />
            </label>
            <button
              type="button"
              className="memory-refresh-btn"
              onClick={() => void Promise.all([loadData(), loadBackfillSessions(), syncBackfillJob()])}
            >
              刷新列表
            </button>
            <button
              type="button"
              className="memory-refresh-btn"
              onClick={() => void handleBackfill()}
              disabled={backfilling || importingHistory}
            >
              {backfilling ? '回填中...' : '回填旧聊天'}
            </button>
            <button
              type="button"
              className={`memory-refresh-btn ${showBackfillPicker ? 'active' : ''}`}
              onClick={() => setShowBackfillPicker((current) => !current)}
              disabled={importingHistory}
            >
              {showBackfillPicker ? '收起回填会话' : '选择回填会话'}
            </button>
            <button
              type="button"
              className="memory-refresh-btn"
              onClick={() => void handleRegenerate()}
              disabled={regenerating || backfilling || clearing || importingHistory}
            >
              {regenerating ? '重新生成中...' : '重新生成画像'}
            </button>
            <button
              type="button"
              className="memory-refresh-btn"
              onClick={() => void handleClearProfiles()}
              disabled={regenerating || backfilling || clearing || importingHistory}
            >
              {clearing ? '清空中...' : '清空画像'}
            </button>
            <button
              type="button"
              className="memory-refresh-btn"
              onClick={() => {
                const profile = createDefaultUnifiedContactProfile(
                  ownerUserId,
                  createLocalId('contact'),
                  '未命名好友'
                )
                const normalizedProfile = normalizeProfileDisplayName(profile)
                setProfiles((current) => [normalizedProfile, ...current])
                setSelectedProfileId(normalizedProfile.profile_id)
                setDraft(deepClone(normalizedProfile))
                setDetailTab('profile')
              }}
            >
              新建好友
            </button>
            <button
              type="button"
              className="memory-refresh-btn"
              onClick={() => {
                const profile = createDefaultUnifiedUserProfile(ownerUserId, '我自己')
                profile.profile_id = createLocalId('user')
                setProfiles((current) => [profile, ...current])
                const normalizedProfile = normalizeProfileDisplayName(profile)
                setSelectedProfileId(normalizedProfile.profile_id)
                setDraft(deepClone(normalizedProfile))
                setDetailTab('profile')
              }}
            >
              新建自己
            </button>
            <button
              type="button"
              className={`memory-refresh-btn ${selectionMode ? 'active' : ''}`}
              onClick={() => {
                setSelectionMode((current) => !current)
                setSelectedIds([])
                setMenu(null)
              }}
            >
              {selectionMode ? '完成选择' : '批量选择'}
            </button>
            {selectionMode ? (
              <button
                type="button"
                className="memory-refresh-btn danger"
                disabled={selectedIds.length === 0}
                onClick={() =>
                  void deleteProfiles(
                    profiles.filter((profile) => selectedIds.includes(profile.profile_id))
                  )
                }
              >
                删除选中 ({selectedIds.length})
              </button>
            ) : null}
            {showBackfillPicker ? (
              <div className="profile-backfill-picker">
                <div className="profile-current-user-row">
                  <strong>回填会话</strong>
                  <span>
                    已选 {selectedBackfillSessionKeys.length} / {backfillSessions.length}
                  </span>
                </div>
                <div className="memory-tag-row">
                  <button
                    type="button"
                    className="memory-refresh-btn"
                    onClick={() => void loadBackfillSessions()}
                    disabled={backfilling || importingHistory}
                  >
                    刷新会话
                  </button>
                  <button
                    type="button"
                    className="memory-refresh-btn"
                    onClick={() =>
                      setSelectedBackfillSessionKeys(backfillSessions.map((session) => session.sessionKey))
                    }
                    disabled={backfillSessions.length === 0}
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    className="memory-refresh-btn"
                    onClick={() => setSelectedBackfillSessionKeys([])}
                    disabled={selectedBackfillSessionKeys.length === 0}
                  >
                    清空
                  </button>
                </div>
                {backfillSessions.length === 0 ? (
                  <p className="profile-list-empty">当前没有可回填的聊天会话。</p>
                ) : (
                  <div className="profile-backfill-session-list">
                    {backfillSessions.map((session) => {
                      const checked = selectedBackfillSessionKeys.includes(session.sessionKey)
                      return (
                        <label key={session.sessionKey} className="profile-backfill-session-item">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setSelectedBackfillSessionKeys((current) =>
                                current.includes(session.sessionKey)
                                  ? current.filter((item) => item !== session.sessionKey)
                                  : [...current, session.sessionKey]
                              )
                            }
                          />
                          <span>{session.sessionName}</span>
                          <em>待回填 {session.pendingMessageCount}</em>
                          <em>总消息 {session.messageCount}</em>
                          {session.lastProcessedTimestamp ? (
                            <em>上次进度 {formatTime(session.lastProcessedTimestamp)}</em>
                          ) : null}
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="console-card memory-browser-card profile-browser-card">
        <div className="memory-browser-layout profile-browser-layout">
          <div className="memory-item-list profile-item-list">
            {loading ? <p className="profile-list-empty">正在加载长期记忆...</p> : null}
            {!loading && error ? <p className="profile-list-empty">长期记忆加载失败：{error}</p> : null}
            {!loading && !error && filteredProfiles.length === 0 ? (
              <p className="profile-list-empty">当前筛选条件下没有匹配的长期记忆。</p>
            ) : null}

            <ProfileListSection
              title="自己"
              profiles={selfProfiles}
              selectedProfileId={selectedProfileId}
              selectionMode={selectionMode}
              selectedIds={selectedIds}
              onSelect={(profile) => {
                const normalizedProfile = normalizeProfileDisplayName(profile)
                setSelectedProfileId(normalizedProfile.profile_id)
                setDraft(deepClone(normalizedProfile))
                setDetailTab('profile')
              }}
              onToggleSelection={(profileId) =>
                setSelectedIds((current) =>
                  current.includes(profileId)
                    ? current.filter((item) => item !== profileId)
                    : [...current, profileId]
                )
              }
              onContextMenu={openContextMenu}
            />

            <ProfileListSection
              title="好友"
              profiles={contactProfiles}
              selectedProfileId={selectedProfileId}
              selectionMode={selectionMode}
              selectedIds={selectedIds}
              onSelect={(profile) => {
                const normalizedProfile = normalizeProfileDisplayName(profile)
                setSelectedProfileId(normalizedProfile.profile_id)
                setDraft(deepClone(normalizedProfile))
                setDetailTab('profile')
              }}
              onToggleSelection={(profileId) =>
                setSelectedIds((current) =>
                  current.includes(profileId)
                    ? current.filter((item) => item !== profileId)
                    : [...current, profileId]
                )
              }
              onContextMenu={openContextMenu}
            />
          </div>

          <div className="memory-detail-panel profile-detail-panel">
            {!draft ? (
              <p className="profile-empty-hint">请选择一条画像进行查看或编辑。</p>
            ) : (
              <>
                <div className="memory-detail-header">
                  <div>
                    <h3>
                      {draft.display_name || '未命名画像'}
                      <small>{formatProfileType(draft.profile_type)}</small>
                    </h3>
                    <span className="profile-detail-subtitle">
                      {draft.conversation_id || draft.target_user_id || draft.owner_user_id}
                    </span>
                  </div>
                  <div className="memory-detail-stats">
                    <span>{formatTime(draft.metadata.last_updated || draft.metadata.created_at)}</span>
                    <span>版本 {draft.metadata.version}</span>
                  </div>
                </div>

                <div className="longterm-tab-row">
                  <button
                    type="button"
                    className={`memory-refresh-btn ${detailTab === 'profile' ? 'active' : ''}`}
                    onClick={() => setDetailTab('profile')}
                  >
                    画像
                  </button>
                  <button
                    type="button"
                    className={`memory-refresh-btn ${detailTab === 'episodes' ? 'active' : ''}`}
                    onClick={() => setDetailTab('episodes')}
                  >
                    情节
                  </button>
                  <button
                    type="button"
                    className={`memory-refresh-btn ${detailTab === 'foresights' ? 'active' : ''}`}
                    onClick={() => setDetailTab('foresights')}
                  >
                    前瞻
                  </button>
                </div>

                <div className="longterm-tab-row">
                  <button
                    type="button"
                    className={`memory-refresh-btn ${detailTab === 'memcells' ? 'active' : ''}`}
                    onClick={() => setDetailTab('memcells')}
                  >
                    MemCell
                  </button>
                </div>

                {detailTab === 'profile' ? (
                  <>
                    <div className="profile-editor-actions">
                      <button
                        type="button"
                        className="memory-refresh-btn"
                        onClick={() => void handleSave()}
                        disabled={saving}
                      >
                        {saving ? '保存中...' : '保存'}
                      </button>
                      <button
                        type="button"
                        className="memory-refresh-btn danger"
                        onClick={() => void deleteProfiles([draft])}
                      >
                        删除
                      </button>
                    </div>
                    {draft.profile_type === 'user' ? (
                      <EditableUserProfileFields draft={draft} onChange={setDraft} />
                    ) : (
                      <EditableContactProfileFields draft={draft} onChange={setDraft} />
                    )}
                    <ProfileFactsSection draft={draft} />
                    <ProfileSystemSection draft={draft} />
                    <section className="profile-section">
                      <div className="profile-section-head">
                        <h4>原始 JSON</h4>
                      </div>
                      <details>
                        <summary>展开原始 JSON</summary>
                        <pre className="memory-detail-content">{JSON.stringify(draft, null, 2)}</pre>
                      </details>
                    </section>
                  </>
                ) : null}

                {detailTab === 'memcells' ? (
                  <LongTermListPanel
                    title="MemCell 对话切分"
                    emptyText="当前好友还没有 MemCell 记录。"
                    items={selectedMemcells}
                    renderItem={(item) => (
                      <MemCellItemCard key={item.memcell_id} item={item} />
                    )}
                  />
                ) : null}
                {detailTab === 'episodes' ? (
                  <LongTermListPanel
                    title="情节记录"
                    emptyText="当前好友还没有情节记录。"
                    items={selectedEpisodes}
                    renderItem={(item) => (
                      <article key={item.episode_id} className="longterm-inline-item episode-inline-item">
                        <div className="longterm-inline-item-head">
                          <strong>{item.subject || item.summary || '未命名情节'}</strong>
                          <span>{formatTime(item.updated_at || item.timestamp)}</span>
                        </div>
                        <p>{item.episode || item.summary || '暂无内容'}</p>
                        <div className="memory-tag-row">
                          {item.participants.slice(0, 4).map((participant) => (
                            <em key={participant}>{participant}</em>
                          ))}
                          {item.keywords.slice(0, 4).map((keyword) => (
                            <em key={keyword}>{keyword}</em>
                          ))}
                        </div>
                      </article>
                    )}
                  />
                ) : null}

                {detailTab === 'foresights' ? (
                  <LongTermListPanel
                    title="前瞻记录"
                    emptyText="当前好友还没有前瞻记录。"
                    items={selectedForesights}
                    renderItem={(item) => (
                      <article key={item.foresight_id} className="longterm-inline-item">
                        <div className="longterm-inline-item-head">
                          <strong>{item.content || '未命名前瞻'}</strong>
                          <span>{formatTime(item.updated_at || item.start_time)}</span>
                        </div>
                        <p>
                          {item.start_time ? `开始：${formatTime(item.start_time)}` : '未设置开始时间'}
                          {item.end_time ? ` · 结束：${formatTime(item.end_time)}` : ''}
                        </p>
                        <div className="memory-tag-row">
                          {item.participants.slice(0, 4).map((participant) => (
                            <em key={participant}>{participant}</em>
                          ))}
                          {item.duration_days != null ? <em>{item.duration_days} 天</em> : null}
                        </div>
                      </article>
                    )}
                  />
                ) : null}
              </>
            )}
          </div>
        </div>
      </section>

      {menu ? (
        <div className="memory-context-menu" style={{ left: menu.x, top: menu.y }}>
          <button
            type="button"
            className="memory-context-action danger"
            onClick={() => void deleteProfiles([menu.profile])}
          >
            删除
          </button>
        </div>
      ) : null}
    </div>
  )
}

function ProfileListSection({
  title,
  profiles,
  selectedProfileId,
  selectionMode,
  selectedIds,
  onSelect,
  onToggleSelection,
  onContextMenu
}: {
  title: string
  profiles: UnifiedProfile[]
  selectedProfileId: string | null
  selectionMode: boolean
  selectedIds: string[]
  onSelect: (profile: UnifiedProfile) => void
  onToggleSelection: (profileId: string) => void
  onContextMenu: (
    event: Pick<MouseEvent, 'clientX' | 'clientY'> | ReactMouseEvent<HTMLButtonElement>,
    profile: UnifiedProfile
  ) => void
}): JSX.Element {
  return (
    <section className="profile-list-section">
      <div className="profile-list-section-header">
        <strong>{title}</strong>
        <span>{profiles.length}</span>
      </div>
      {profiles.length === 0 ? (
        <p className="profile-list-empty">
          {title === '自己' ? '当前还没有自己的画像。' : '当前还没有好友画像。'}
        </p>
      ) : null}
      {profiles.map((profile) => {
        const active = selectedProfileId === profile.profile_id
        const checked = selectedIds.includes(profile.profile_id)
        return (
          <button
            key={profile.profile_id}
            type="button"
            className={`memory-item-button ${active ? 'active' : ''} ${checked ? 'selected' : ''}`}
            onClick={() => onSelect(profile)}
            onContextMenu={(event) => {
              event.preventDefault()
              onContextMenu(event, profile)
            }}
            onMouseDown={(event) => {
              if (event.button === 2) {
                event.preventDefault()
                onContextMenu(event, profile)
              }
            }}
          >
            {selectionMode ? (
              <label className="memory-item-floating-check" onClick={(event) => event.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleSelection(profile.profile_id)}
                />
              </label>
            ) : null}
            <div className="memory-item-title-row">
              <strong>{profile.display_name || '未命名画像'}</strong>
              <div className="memory-item-head-actions">
                <span>{formatTime(profile.metadata.last_updated || profile.metadata.created_at)}</span>
              </div>
            </div>
            <p>{buildProfileSummary(profile)}</p>
            <div className="memory-item-meta">
              <span>{formatRole(profile.social_attributes.role)}</span>
              <span>{formatIntimacy(profile.social_attributes.intimacy_level)}</span>
            </div>
            <div className="memory-tag-row">
              {getFieldValues(profile.traits as ProfileField[] | string[]).slice(0, 4).map((trait) => (
                <em key={trait}>{trait}</em>
              ))}
              {getFieldValues(profile.traits as ProfileField[] | string[]).length === 0
                ? getFieldValues(profile.interests as ProfileField[] | string[]).slice(0, 3).map((interest) => <em key={interest}>{interest}</em>)
                : null}
            </div>
          </button>
        )
      })}
    </section>
  )
}

function MemCellItemCard({ item }: { item: MemCellItem }): JSX.Element {
  const [expanded, setExpanded] = useState(false)

  return (
    <article className="longterm-inline-item memcell-item-card">
      <div className="longterm-inline-item-head">
        <strong>{item.summary || item.subject || '未命名 MemCell'}</strong>
        <span>{formatTime(item.updated_at || item.timestamp)}</span>
      </div>
      <p className="memcell-summary">{item.episode || item.subject || '暂无 MemCell 内容'}</p>
      <div className="memory-tag-row">
        {item.participants.slice(0, 4).map((participant) => (
          <em key={participant}>{participant}</em>
        ))}
        {item.keywords.slice(0, 4).map((keyword) => (
          <em key={keyword}>{keyword}</em>
        ))}
        {item.type ? <em>{item.type}</em> : null}
        <em>消息 {item.original_data_count}</em>
        <em>前瞻 {item.foresight_count}</em>
      </div>
      {item.original_data.length > 0 ? (
        <div className="memcell-messages-section">
          <button
            type="button"
            className="memory-refresh-btn memcell-toggle-btn"
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? '收起对话' : `展开对话 (${item.original_data.length} 条)`}
          </button>
          {expanded ? (
            <div className="memcell-messages-list">
              {item.original_data.map((msg, idx) => (
                <div key={`${idx}-${msg.timestamp || ''}`} className="memcell-message-item">
                  <span className="memcell-message-speaker">
                    {msg.speaker_name || msg.speaker_id || '未知'}
                  </span>
                  <span className="memcell-message-content">{msg.content}</span>
                  <span className="memcell-message-time">{formatTime(msg.timestamp)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function LongTermListPanel<T>({
  title,
  emptyText,
  items,
  renderItem
}: {
  title: string
  emptyText: string
  items: T[]
  renderItem: (item: T) => JSX.Element
}): JSX.Element {
  return (
    <section className="profile-section">
      <div className="profile-section-head">
        <h4>{title}</h4>
      </div>
      {items.length === 0 ? <p className="profile-empty-hint">{emptyText}</p> : null}
      {items.map(renderItem)}
    </section>
  )
}

export function UserProfileFields({
  draft,
  onChange
}: {
  draft: UnifiedProfile
  onChange: (profile: UnifiedProfile) => void
}): JSX.Element {
  return (
    <section className="profile-section">
      <div className="profile-section-head">
        <h4>自己画像</h4>
      </div>
      <div className="profile-editor-grid">
        <InputField label="显示名称" value={draft.display_name} onChange={(value) => onChange({ ...draft, display_name: value })} />
        <InputField
          label="职业"
          value={getFieldValue(draft.occupation as ProfileField | string | null)}
          onChange={(value) => onChange({ ...draft, occupation: value ? { value, evidences: [] } : null })}
        />
        <TextareaField
          label="特征标签"
          value={getFieldValues(draft.traits as ProfileField[] | string[]).join('，')}
          onChange={(value) => onChange({ ...draft, traits: splitList(value).map(v => ({ value: v, evidences: [] })) })}
        />
        <TextareaField
          label="兴趣偏好"
          value={getFieldValues(draft.interests as ProfileField[] | string[]).join('，')}
          onChange={(value) => onChange({ ...draft, interests: splitList(value).map(v => ({ value: v, evidences: [] })) })}
        />
      </div>
    </section>
  )
}

export function ContactProfileFields({
  draft,
  onChange
}: {
  draft: UnifiedProfile
  onChange: (profile: UnifiedProfile) => void
}): JSX.Element {
  const risk = draft.risk_assessment ?? {
    is_suspicious: false,
    risk_level: 'low' as const,
    warning_msg: '',
    risk_patterns: [],
    last_checked: null
  }

  return (
    <section className="profile-section">
      <div className="profile-section-head">
        <h4>好友画像</h4>
      </div>
      <div className="profile-editor-grid">
        <InputField label="显示名称" value={draft.display_name} onChange={(value) => onChange({ ...draft, display_name: value })} />
        <InputField label="目标用户 ID" value={draft.target_user_id ?? ''} onChange={(value) => onChange({ ...draft, target_user_id: value || null })} />
        <InputField label="会话 ID" value={draft.conversation_id ?? ''} onChange={(value) => onChange({ ...draft, conversation_id: value || null })} />
        <InputField
          label="职业"
          value={getFieldValue(draft.occupation as ProfileField | string | null)}
          onChange={(value) => onChange({ ...draft, occupation: value ? { value, evidences: [] } : null })}
        />
        <InputField
          label="关系角色"
          value={draft.social_attributes.role}
          onChange={(value) =>
            onChange({
              ...draft,
              social_attributes: { ...draft.social_attributes, role: value }
            })
          }
        />
        <InputField
          label="当前状态"
          value={draft.social_attributes.current_status}
          onChange={(value) =>
            onChange({
              ...draft,
              social_attributes: { ...draft.social_attributes, current_status: value }
            })
          }
        />
        <SelectField
          label="熟悉程度"
          value={draft.social_attributes.intimacy_level}
          options={[
            ['stranger', '陌生'],
            ['formal', '正式'],
            ['close', '熟悉'],
            ['intimate', '亲密']
          ]}
          onChange={(value) =>
            onChange({
              ...draft,
              social_attributes: {
                ...draft.social_attributes,
                intimacy_level: value as UnifiedProfile['social_attributes']['intimacy_level']
              }
            })
          }
        />
        <InputField
          label="年龄段"
          value={draft.social_attributes.age_group ?? ''}
          onChange={(value) =>
            onChange({
              ...draft,
              social_attributes: { ...draft.social_attributes, age_group: value || null }
            })
          }
        />
        <InputField
          label="中间人姓名"
          value={draft.social_attributes.intermediary.name ?? ''}
          onChange={(value) =>
            onChange({
              ...draft,
              social_attributes: {
                ...draft.social_attributes,
                intermediary: { ...draft.social_attributes.intermediary, name: value || null }
              }
            })
          }
        />
        <TextareaField
          label="中间人背景"
          value={draft.social_attributes.intermediary.context ?? ''}
          onChange={(value) =>
            onChange({
              ...draft,
              social_attributes: {
                ...draft.social_attributes,
                intermediary: { ...draft.social_attributes.intermediary, context: value || null }
              }
            })
          }
        />
        <TextareaField
          label="特征标签"
          value={getFieldValues(draft.traits as ProfileField[] | string[]).join('，')}
          onChange={(value) => onChange({ ...draft, traits: splitList(value).map(v => ({ value: v, evidences: [] })) })}
        />
        <TextareaField
          label="兴趣偏好"
          value={getFieldValues(draft.interests as ProfileField[] | string[]).join('，')}
          onChange={(value) => onChange({ ...draft, interests: splitList(value).map(v => ({ value: v, evidences: [] })) })}
        />
        <TextareaField
          label="沟通风格"
          value={getFieldValues(draft.communication_style as ProfileField[] | string[]).join('，')}
          onChange={(value) => onChange({ ...draft, communication_style: splitList(value).map(v => ({ value: v, evidences: [] })) })}
        />
        <TextareaField
          label="口头禅"
          value={getFieldValues(draft.catchphrase as ProfileField[] | string[]).join('，')}
          onChange={(value) => onChange({ ...draft, catchphrase: splitList(value).map(v => ({ value: v, evidences: [] })) })}
        />
      </div>
    </section>
  )
}

function ProfileFactsSection({
  draft
}: {
  draft: UnifiedProfile
}): JSX.Element {
  // No longer needed - evidence levels are shown inline in edit fields
  return null
}

function ProfileSystemSection({
  draft
}: {
  draft: UnifiedProfile
}): JSX.Element {
  const risk = draft.risk_assessment
  return (
    <section className="profile-section">
      <div className="profile-section-head">
        <h4>系统信息</h4>
      </div>
      <div className="profile-editor-grid">
        <ReadonlyField label="Profile ID" value={draft.profile_id} />
        <ReadonlyField label="Owner User ID" value={draft.owner_user_id} />
        <ReadonlyField label="Target User ID" value={draft.target_user_id ?? ''} />
        <ReadonlyField label="Conversation ID" value={draft.conversation_id ?? ''} />
        <ReadonlyField label="创建时间" value={draft.metadata.created_at} />
        <ReadonlyField label="最后更新" value={draft.metadata.last_updated} />
        <ReadonlyField label="版本" value={`${draft.metadata.version}`} />
        <ReadonlyField label="来源 MemCell 数" value={`${draft.metadata.source_memcell_count}`} />
        <ReadonlyField label="风险等级" value={risk ? formatRiskLevel(risk.risk_level) : '无'} />
        <ReadonlyField label="风险提示" value={risk?.warning_msg ?? ''} wide />
      </div>
    </section>
  )
}

function EditableUserProfileFields({
  draft,
  onChange
}: {
  draft: UnifiedProfile
  onChange: (profile: UnifiedProfile) => void
}): JSX.Element {
  return (
    <section className="profile-section">
      <div className="profile-section-head">
        <h4>画像编辑</h4>
      </div>
      <div className="profile-editor-grid">
        <InputField label="显示名称" value={draft.display_name} onChange={(value) => onChange({ ...draft, display_name: value })} />
        <TextareaField label="别名" value={draft.aliases.join('，')} onChange={(value) => onChange({ ...draft, aliases: splitList(value) })} />
        {/* 单值字段 */}
        <InputField
          label="性别"
          value={getFieldValue(draft.gender as ProfileField | string | null)}
          onChange={(value) => onChange({ ...draft, gender: value ? { value, evidence_level: 'L1', evidences: [] } : null })}
        />
        <InputField
          label="年龄"
          value={getFieldValue(draft.age as ProfileField | string | null)}
          onChange={(value) => onChange({ ...draft, age: value ? { value, evidence_level: 'L2', evidences: [] } : null })}
        />
        <InputField
          label="学历"
          value={getFieldValue(draft.education_level as ProfileField | string | null)}
          onChange={(value) => onChange({ ...draft, education_level: value ? { value, evidence_level: 'L2', evidences: [] } : null })}
        />
        {/* 列表字段 - 显示 [L1]/[L2] 前缀 */}
        <TextareaField
          label="职业"
          value={formatFieldsWithLevel(draft.occupation as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, occupation: parseFieldsWithLevel(value, 'L2') })}
        />
        <TextareaField
          label="性格特征（英文）"
          value={formatFieldsWithLevel(draft.traits as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, traits: parseFieldsWithLevel(value, 'L2') })}
        />
        <TextareaField
          label="人格描述（中文）"
          value={formatFieldsWithLevel(draft.personality as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, personality: parseFieldsWithLevel(value, 'L2') })}
        />
        <TextareaField
          label="兴趣偏好"
          value={formatFieldsWithLevel(draft.interests as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, interests: parseFieldsWithLevel(value, 'L1') })}
        />
        <TextareaField
          label="决策方式"
          value={formatFieldsWithLevel(draft.way_of_decision_making as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, way_of_decision_making: parseFieldsWithLevel(value, 'L2') })}
        />
        <TextareaField
          label="生活偏好"
          value={formatFieldsWithLevel(draft.life_habit_preference as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, life_habit_preference: parseFieldsWithLevel(value, 'L1') })}
        />
        <TextareaField
          label="沟通风格"
          value={formatFieldsWithLevel(draft.communication_style as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, communication_style: parseFieldsWithLevel(value, 'L2') })}
        />
        <TextareaField
          label="口头禅"
          value={formatFieldsWithLevel(draft.catchphrase as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, catchphrase: parseFieldsWithLevel(value, 'L1') })}
        />
        <TextareaField
          label="动机系统"
          value={formatFieldsWithLevel(draft.motivation_system as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, motivation_system: parseFieldsWithLevel(value, 'L2') })}
        />
        <TextareaField
          label="恐惧系统"
          value={formatFieldsWithLevel(draft.fear_system as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, fear_system: parseFieldsWithLevel(value, 'L2') })}
        />
        <TextareaField
          label="价值系统"
          value={formatFieldsWithLevel(draft.value_system as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, value_system: parseFieldsWithLevel(value, 'L2') })}
        />
        <TextareaField
          label="幽默风格"
          value={formatFieldsWithLevel(draft.humor_use as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, humor_use: parseFieldsWithLevel(value, 'L1') })}
        />
      </div>
    </section>
  )
}

function EditableContactProfileFields({
  draft,
  onChange
}: {
  draft: UnifiedProfile
  onChange: (profile: UnifiedProfile) => void
}): JSX.Element {
  const risk = draft.risk_assessment ?? {
    is_suspicious: false,
    risk_level: 'low' as const,
    warning_msg: '',
    risk_patterns: [],
    last_checked: null
  }

  return (
    <section className="profile-section">
      <div className="profile-section-head">
        <h4>画像编辑</h4>
      </div>
      <div className="profile-editor-grid">
        <InputField label="显示名称" value={draft.display_name} onChange={(value) => onChange({ ...draft, display_name: value })} />
        <TextareaField label="别名" value={draft.aliases.join('，')} onChange={(value) => onChange({ ...draft, aliases: splitList(value) })} />
        {/* 单值字段 */}
        <InputField
          label="性别"
          value={getFieldValue(draft.gender as ProfileField | string | null)}
          onChange={(value) => onChange({ ...draft, gender: value ? { value, evidence_level: 'L1', evidences: [] } : null })}
        />
        <InputField
          label="年龄"
          value={getFieldValue(draft.age as ProfileField | string | null)}
          onChange={(value) => onChange({ ...draft, age: value ? { value, evidence_level: 'L2', evidences: [] } : null })}
        />
        <InputField
          label="学历"
          value={getFieldValue(draft.education_level as ProfileField | string | null)}
          onChange={(value) => onChange({ ...draft, education_level: value ? { value, evidence_level: 'L2', evidences: [] } : null })}
        />
        <SelectField
          label="熟悉程度"
          value={getFieldValue(draft.intimacy_level as ProfileField | string | null) || 'stranger'}
          options={[
            ['stranger', '陌生'],
            ['formal', '正式'],
            ['close', '熟悉'],
            ['intimate', '亲密']
          ]}
          onChange={(value) =>
            onChange({ ...draft, intimacy_level: { value, evidence_level: 'L2', evidences: [] } })
          }
        />
        {/* 列表字段 - 显示 [L1]/[L2] 前缀 */}
        <TextareaField
          label="职业"
          value={formatFieldsWithLevel(draft.occupation as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, occupation: parseFieldsWithLevel(value, 'L2') })}
        />
        <TextareaField
          label="关系"
          value={formatFieldsWithLevel(draft.relationship as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, relationship: parseFieldsWithLevel(value, 'L2') })}
        />
        <TextareaField
          label="性格特征（英文）"
          value={formatFieldsWithLevel(draft.traits as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, traits: parseFieldsWithLevel(value, 'L2') })}
        />
        <TextareaField
          label="人格描述（中文）"
          value={formatFieldsWithLevel(draft.personality as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, personality: parseFieldsWithLevel(value, 'L2') })}
        />
        <TextareaField
          label="兴趣偏好"
          value={formatFieldsWithLevel(draft.interests as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, interests: parseFieldsWithLevel(value, 'L1') })}
        />
        <TextareaField
          label="决策方式"
          value={formatFieldsWithLevel(draft.way_of_decision_making as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, way_of_decision_making: parseFieldsWithLevel(value, 'L2') })}
        />
        <TextareaField
          label="生活偏好"
          value={formatFieldsWithLevel(draft.life_habit_preference as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, life_habit_preference: parseFieldsWithLevel(value, 'L1') })}
        />
        <TextareaField
          label="沟通风格"
          value={formatFieldsWithLevel(draft.communication_style as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, communication_style: parseFieldsWithLevel(value, 'L2') })}
        />
        <TextareaField
          label="口头禅"
          value={formatFieldsWithLevel(draft.catchphrase as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, catchphrase: parseFieldsWithLevel(value, 'L1') })}
        />
        <TextareaField
          label="对好友称呼"
          value={formatFieldsWithLevel(draft.user_to_friend_catchphrase as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, user_to_friend_catchphrase: parseFieldsWithLevel(value, 'L1') })}
        />
        <TextareaField
          label="对好友风格"
          value={formatFieldsWithLevel(draft.user_to_friend_chat_style as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, user_to_friend_chat_style: parseFieldsWithLevel(value, 'L2') })}
        />
        <TextareaField
          label="动机系统"
          value={formatFieldsWithLevel(draft.motivation_system as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, motivation_system: parseFieldsWithLevel(value, 'L2') })}
        />
        <TextareaField
          label="恐惧系统"
          value={formatFieldsWithLevel(draft.fear_system as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, fear_system: parseFieldsWithLevel(value, 'L2') })}
        />
        <TextareaField
          label="价值系统"
          value={formatFieldsWithLevel(draft.value_system as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, value_system: parseFieldsWithLevel(value, 'L2') })}
        />
        <TextareaField
          label="幽默风格"
          value={formatFieldsWithLevel(draft.humor_use as ProfileField[] | string[])}
          onChange={(value) => onChange({ ...draft, humor_use: parseFieldsWithLevel(value, 'L1') })}
        />
        {/* 中间人信息 */}
        <InputField
          label="中间人姓名"
          value={draft.social_attributes.intermediary.name ?? ''}
          onChange={(value) =>
            onChange({
              ...draft,
              social_attributes: {
                ...draft.social_attributes,
                intermediary: { ...draft.social_attributes.intermediary, name: value || null, has_intermediary: !!value }
              }
            })
          }
        />
        <TextareaField
          label="中间人背景"
          value={draft.social_attributes.intermediary.context ?? ''}
          onChange={(value) =>
            onChange({
              ...draft,
              social_attributes: {
                ...draft.social_attributes,
                intermediary: { ...draft.social_attributes.intermediary, context: value || null }
              }
            })
          }
        />
        {/* 风险评估 */}
        <SelectField
          label="风险等级"
          value={risk.risk_level}
          options={[
            ['low', '低'],
            ['medium', '中'],
            ['high', '高']
          ]}
          onChange={(value) =>
            onChange({
              ...draft,
              risk_assessment: {
                ...risk,
                risk_level: value as NonNullable<UnifiedProfile['risk_assessment']>['risk_level']
              }
            })
          }
        />
        <TextareaField
          label="风险提示"
          value={risk.warning_msg}
          onChange={(value) =>
            onChange({
              ...draft,
              risk_assessment: { ...risk, warning_msg: value }
            })
          }
        />
      </div>
    </section>
  )
}

export function FactsEditor({
  draft,
  onChange
}: {
  draft: UnifiedProfile
  onChange: (profile: UnifiedProfile) => void
}): JSX.Element {
  const addFact = (): void => {
    onChange({
      ...draft,
      facts: [
        ...draft.facts,
        {
          fact: '',
          category: 'other',
          evidence: [],
          confidence: 0.5,
          last_updated: new Date().toISOString()
        }
      ]
    })
  }

  const updateFact = (index: number, nextFact: UnifiedFact): void => {
    onChange({
      ...draft,
      facts: draft.facts.map((fact, factIndex) => (factIndex === index ? nextFact : fact))
    })
  }

  const removeFact = (index: number): void => {
    onChange({
      ...draft,
      facts: draft.facts.filter((_, factIndex) => factIndex !== index)
    })
  }

  return (
    <section className="profile-section">
      <div className="profile-section-head">
        <h4>事实记录</h4>
        <button type="button" className="memory-refresh-btn" onClick={addFact}>
          添加事实
        </button>
      </div>
      {draft.facts.length === 0 ? <p className="profile-empty-hint">当前还没有事实记录。</p> : null}
      {draft.facts.map((fact, index) => (
        <div key={`${fact.fact}-${index}`} className="profile-fact-card">
          <div className="profile-section-head">
            <h4>事实 {index + 1}</h4>
            <button
              type="button"
              className="memory-refresh-btn danger"
              onClick={() => removeFact(index)}
            >
              删除
            </button>
          </div>
          <div className="profile-editor-grid">
            <TextareaField
              label="事实内容"
              value={fact.fact}
              onChange={(value) => updateFact(index, { ...fact, fact: value })}
            />
            <SelectField
              label="分类"
              value={fact.category}
              options={[
                ['trait', '特征'],
                ['interest', '兴趣'],
                ['role', '角色'],
                ['style', '风格'],
                ['occupation', '职业'],
                ['other', '其他']
              ]}
              onChange={(value) =>
                updateFact(index, { ...fact, category: value as UnifiedFact['category'] })
              }
            />
            <InputField
              label="置信度"
              value={`${fact.confidence}`}
              onChange={(value) =>
                updateFact(index, {
                  ...fact,
                  confidence: Math.min(1, Math.max(0, Number(value) || 0))
                })
              }
            />
            <InputField
              label="最后更新时间"
              value={fact.last_updated}
              onChange={(value) => updateFact(index, { ...fact, last_updated: value })}
            />
          </div>
          <EvidenceEditor
            evidence={fact.evidence}
            onChange={(nextEvidence) => updateFact(index, { ...fact, evidence: nextEvidence })}
          />
        </div>
      ))}
    </section>
  )
}

function EvidenceEditor({
  evidence,
  onChange
}: {
  evidence: UnifiedEvidence[]
  onChange: (evidence: UnifiedEvidence[]) => void
}): JSX.Element {
  const addEvidence = (): void => {
    onChange([
      ...evidence,
      {
        source: '',
        timestamp: new Date().toISOString(),
        message_id: null
      }
    ])
  }

  const updateEvidence = (index: number, nextEvidence: UnifiedEvidence): void => {
    onChange(evidence.map((item, itemIndex) => (itemIndex === index ? nextEvidence : item)))
  }

  const removeEvidence = (index: number): void => {
    onChange(evidence.filter((_, itemIndex) => itemIndex !== index))
  }

  return (
    <section className="profile-section">
      <div className="profile-section-head">
        <h4>证据</h4>
        <button type="button" className="memory-refresh-btn" onClick={addEvidence}>
          添加证据
        </button>
      </div>
      {evidence.length === 0 ? <p className="profile-empty-hint">当前还没有证据。</p> : null}
      <div className="profile-evidence-list">
        {evidence.map((item, index) => (
          <div key={`${item.source}-${index}`} className="profile-evidence-card">
            <div className="profile-section-head">
              <h4>证据 {index + 1}</h4>
              <button
                type="button"
                className="memory-refresh-btn danger"
                onClick={() => removeEvidence(index)}
              >
                删除
              </button>
            </div>
            <div className="profile-editor-grid">
              <InputField
                label="来源"
                value={item.source}
                onChange={(value) => updateEvidence(index, { ...item, source: value })}
              />
              <InputField
                label="时间"
                value={item.timestamp}
                onChange={(value) => updateEvidence(index, { ...item, timestamp: value })}
              />
              <InputField
                label="消息 ID"
                value={item.message_id ?? ''}
                onChange={(value) => updateEvidence(index, { ...item, message_id: value || null })}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function InputField({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <label className="profile-editor-field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  )
}

function ReadonlyField({
  label,
  value,
  wide = false
}: {
  label: string
  value: string
  wide?: boolean
}): JSX.Element {
  return (
    <label className={`profile-editor-field ${wide ? 'profile-editor-field-wide' : ''}`}>
      <span>{label}</span>
      <div className="profile-readonly-value">{displayText(value)}</div>
    </label>
  )
}

function TextareaField({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <label className="profile-editor-field profile-editor-field-wide">
      <span>{label}</span>
      <textarea value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  )
}

function SelectField({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: string
  options: Array<[string, string]>
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <label className="profile-editor-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  )
}
