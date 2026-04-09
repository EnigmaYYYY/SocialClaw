import {
  useEffect,
  useLayoutEffect,
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
  evidences: Array<string | { event_id?: string; reasoning?: string }>
}

type EvidenceLevel = 'L1' | 'L2' | 'L3'
type ListFieldKey =
  | 'occupation'
  | 'relationship'
  | 'traits'
  | 'personality'
  | 'interests'
  | 'way_of_decision_making'
  | 'life_habit_preference'
  | 'communication_style'
  | 'catchphrase'
  | 'user_to_friend_catchphrase'
  | 'user_to_friend_chat_style'
  | 'motivation_system'
  | 'fear_system'
  | 'value_system'
  | 'humor_use'

const MANUAL_EVIDENCE_PREFIX = 'manual:'
const MANUAL_REASONING_TEXT = '用户手动设置'
const SINGLE_PROFILE_FIELD_KEYS = [
  'gender',
  'age',
  'education_level',
  'intimacy_level'
] as const
const LIST_PROFILE_FIELD_KEYS: ListFieldKey[] = [
  'occupation',
  'relationship',
  'traits',
  'personality',
  'interests',
  'way_of_decision_making',
  'life_habit_preference',
  'communication_style',
  'catchphrase',
  'user_to_friend_catchphrase',
  'user_to_friend_chat_style',
  'motivation_system',
  'fear_system',
  'value_system',
  'humor_use'
]

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

function formatDate(value?: string | null): string {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getForesightStatus(item: {
  start_time?: string | null
  end_time?: string | null
}): 'expired' | 'upcoming' | 'active' {
  const now = new Date()
  const end = item.end_time ? new Date(item.end_time) : null
  const start = item.start_time ? new Date(item.start_time) : null
  if (end && now > end) return 'expired'
  if (start && now < start) return 'upcoming'
  return 'active'
}

function truncateParticipantId(id: string): string {
  if (id.startsWith('contact_')) return id.slice(0, 14)
  return id
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

function toReadableFieldLabel(fieldKey: ListFieldKey): string {
  const labelMap: Record<ListFieldKey, string> = {
    occupation: '职业',
    relationship: '关系',
    traits: '性格特征',
    personality: '人格描述',
    interests: '兴趣偏好',
    way_of_decision_making: '决策方式',
    life_habit_preference: '生活偏好',
    communication_style: '沟通风格',
    catchphrase: '口头禅',
    user_to_friend_catchphrase: '对好友称呼',
    user_to_friend_chat_style: '对好友沟通风格',
    motivation_system: '动机系统',
    fear_system: '恐惧系统',
    value_system: '价值观',
    humor_use: '幽默风格'
  }
  return labelMap[fieldKey]
}

function normalizeProfileFieldList(fields: unknown): ProfileField[] {
  if (!Array.isArray(fields)) return []
  return fields
    .map((item) => {
      if (typeof item === 'string') {
        const value = item.trim()
        if (!value) return null
        return { value, evidence_level: 'L2', evidences: [] } as ProfileField
      }
      if (!item || typeof item !== 'object' || !('value' in item)) return null
      const rawValue = (item as { value?: unknown }).value
      const value = typeof rawValue === 'string' ? rawValue.trim() : String(rawValue ?? '').trim()
      if (!value) return null
      const rawLevel = (item as { evidence_level?: unknown }).evidence_level
      const level: EvidenceLevel = rawLevel === 'L1' || rawLevel === 'L2' || rawLevel === 'L3' ? rawLevel : 'L2'
      const evidencesRaw = (item as { evidences?: unknown }).evidences
      const evidences = Array.isArray(evidencesRaw) ? evidencesRaw : []
      return { value, evidence_level: level, evidences } as ProfileField
    })
    .filter((item): item is ProfileField => Boolean(item))
}

function normalizeSingleProfileField(field: unknown): ProfileField | null {
  if (!field) return null
  if (typeof field === 'string') {
    const value = field.trim()
    return value ? { value, evidence_level: 'L2', evidences: [] } : null
  }
  if (typeof field !== 'object' || !('value' in field)) return null
  const rawValue = (field as { value?: unknown }).value
  const value = typeof rawValue === 'string' ? rawValue.trim() : String(rawValue ?? '').trim()
  if (!value) return null
  const rawLevel = (field as { evidence_level?: unknown }).evidence_level
  const level: EvidenceLevel = rawLevel === 'L1' || rawLevel === 'L2' || rawLevel === 'L3' ? rawLevel : 'L2'
  const evidencesRaw = (field as { evidences?: unknown }).evidences
  const evidences = Array.isArray(evidencesRaw) ? evidencesRaw : []
  return { value, evidence_level: level, evidences }
}

function normalizeEvidenceEntries(
  evidences: Array<string | { event_id?: string; reasoning?: string }>
): Array<{ event_id: string; reasoning: string }> {
  return evidences
    .map((item) => {
      if (typeof item === 'string') {
        const eventId = item.trim()
        return eventId ? { event_id: eventId, reasoning: '' } : null
      }
      if (!item || typeof item !== 'object') return null
      const eventId = typeof item.event_id === 'string' ? item.event_id.trim() : ''
      const reasoning = typeof item.reasoning === 'string' ? item.reasoning.trim() : ''
      return eventId ? { event_id: eventId, reasoning } : null
    })
    .filter((item): item is { event_id: string; reasoning: string } => Boolean(item))
}

function withManualEvidence(
  field: ProfileField,
  fieldKey: string,
  uniqueSuffix: string
): ProfileField {
  const normalizedEvidences = normalizeEvidenceEntries(field.evidences ?? [])
  let hasManualEvidence = false
  const patchedEvidences = normalizedEvidences.map((item) => {
    if (item.event_id.startsWith(MANUAL_EVIDENCE_PREFIX)) {
      hasManualEvidence = true
      return { event_id: item.event_id, reasoning: MANUAL_REASONING_TEXT }
    }
    return item
  })
  if (!hasManualEvidence) {
    patchedEvidences.push({
      event_id: `${MANUAL_EVIDENCE_PREFIX}${fieldKey}:${uniqueSuffix}`,
      reasoning: MANUAL_REASONING_TEXT
    })
  }
  return {
    ...field,
    evidence_level: 'L1',
    evidences: patchedEvidences
  }
}

function applyManualEditsToProfileFields(
  draft: UnifiedProfile,
  baseline: UnifiedProfile | null
): UnifiedProfile {
  const next = deepClone(draft)
  const nowToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  for (const key of SINGLE_PROFILE_FIELD_KEYS) {
    const currentField = normalizeSingleProfileField((next as Record<string, unknown>)[key])
    const baselineField = normalizeSingleProfileField(
      baseline ? (baseline as Record<string, unknown>)[key] : null
    )
    if (!currentField) {
      ;(next as Record<string, unknown>)[key] = null
      continue
    }
    const changed = !baselineField || baselineField.value !== currentField.value
    ;(next as Record<string, unknown>)[key] = changed
      ? withManualEvidence(currentField, key, `${nowToken}:single`)
      : currentField
  }

  for (const key of LIST_PROFILE_FIELD_KEYS) {
    const currentList = normalizeProfileFieldList((next as Record<string, unknown>)[key])
    const baselineList = normalizeProfileFieldList(
      baseline ? (baseline as Record<string, unknown>)[key] : null
    )
    const baselineValueCounts = new Map<string, number>()
    for (const item of baselineList) {
      const value = item.value.trim()
      baselineValueCounts.set(value, (baselineValueCounts.get(value) ?? 0) + 1)
    }

    const patched = currentList.map((item, index) => {
      const value = item.value.trim()
      const remaining = baselineValueCounts.get(value) ?? 0
      if (remaining > 0) {
        baselineValueCounts.set(value, remaining - 1)
        return item
      }
      return withManualEvidence(item, key, `${nowToken}:list:${index}`)
    })
    ;(next as Record<string, unknown>)[key] = patched
  }

  return next
}

function levelClass(level?: string): string {
  if (level === 'L1') return 'level-l1'
  if (level === 'L3') return 'level-l3'
  return 'level-l2'
}

export function shouldShowEvidenceForField(fieldKey: ListFieldKey): boolean {
  return fieldKey !== 'catchphrase'
}

export function buildRawJsonPreview(profile: UnifiedProfile): Record<string, unknown> {
  const preview = deepClone(profile) as Record<string, unknown>
  delete preview.retrieval
  return preview
}

function ProfileListFieldCard({
  fieldKey,
  value,
  onChange
}: {
  fieldKey: ListFieldKey
  value: unknown
  onChange: (next: ProfileField[]) => void
}): JSX.Element {
  const fields = normalizeProfileFieldList(value)
  const showEvidence = shouldShowEvidenceForField(fieldKey)
  const [newValue, setNewValue] = useState('')
  const [newLevel, setNewLevel] = useState<EvidenceLevel>('L1')
  const [manualSignatures, setManualSignatures] = useState<string[]>([])
  const [isEditing, setIsEditing] = useState(false)
  const cardRef = useRef<HTMLElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [activeEvidence, setActiveEvidence] = useState<null | {
    key: string
    evidences: Array<{ event_id: string; reasoning: string }>
    left: number
    top: number
    anchorTop: number
    anchorBottom: number
  }>(null)

  useEffect(() => {
    setManualSignatures((current) => {
      const signatures = new Set(fields.map((item) => `${item.value}::`))
      return current.filter((signature) => signatures.has(signature))
    })
  }, [fields])

  useEffect(() => {
    setActiveEvidence(null)
  }, [isEditing])

  useLayoutEffect(() => {
    if (!activeEvidence || !cardRef.current || !popoverRef.current) return
    const cardRect = cardRef.current.getBoundingClientRect()
    const popRect = popoverRef.current.getBoundingClientRect()
    const width = popRect.width
    const height = popRect.height
    const maxLeft = Math.max(8, cardRect.width - width - 8)
    const nextLeft = Math.min(Math.max(activeEvidence.left, 8), maxLeft)
    const bottomSpace = cardRect.height - activeEvidence.anchorBottom
    const showTop = bottomSpace < height + 10 && activeEvidence.anchorTop > height + 10
    const nextTop = showTop
      ? Math.max(8, activeEvidence.anchorTop - height - 6)
      : Math.min(activeEvidence.anchorBottom + 6, Math.max(8, cardRect.height - height - 8))
    if (nextLeft !== activeEvidence.left || nextTop !== activeEvidence.top) {
      setActiveEvidence((current) => (current ? { ...current, left: nextLeft, top: nextTop } : current))
    }
  }, [activeEvidence])

  const addItem = (): void => {
    const trimmed = newValue.trim()
    if (!trimmed) return
    const nextItem: ProfileField = { value: trimmed, evidence_level: newLevel, evidences: [] }
    onChange([...fields, nextItem])
    setManualSignatures((current) => [...current, `${trimmed}::`])
    setNewValue('')
    setNewLevel('L1')
  }

  const removeItem = (index: number): void => {
    const target = fields[index]
    onChange(fields.filter((_, i) => i !== index))
    if (!target) return
    const signature = `${target.value}::`
    setManualSignatures((current) => current.filter((item) => item !== signature))
  }

  const handleEvidenceMouseEnter = (
    event: ReactMouseEvent<HTMLElement>,
    key: string,
    evidences: Array<{ event_id: string; reasoning: string }>
  ): void => {
    if (!cardRef.current) return
    const anchorRect = event.currentTarget.getBoundingClientRect()
    const cardRect = cardRef.current.getBoundingClientRect()
    const estimatedWidth = 340
    const maxLeft = Math.max(8, cardRect.width - estimatedWidth - 8)
    const left = Math.min(Math.max(anchorRect.left - cardRect.left, 8), maxLeft)
    setActiveEvidence({
      key,
      evidences,
      left,
      top: anchorRect.bottom - cardRect.top + 6,
      anchorTop: anchorRect.top - cardRect.top,
      anchorBottom: anchorRect.bottom - cardRect.top
    })
  }

  const handleEvidenceMouseLeave = (event: ReactMouseEvent<HTMLElement>, key: string): void => {
    const related = event.relatedTarget as HTMLElement | null
    if (related?.closest(`[data-evidence-key="${key}"]`)) return
    setActiveEvidence((current) => (current?.key === key ? null : current))
  }

  return (
    <section ref={cardRef} className="profile-list-card profile-editor-field-wide">
      <div className="profile-list-card-head">
        <span className="profile-list-card-label">{toReadableFieldLabel(fieldKey)}</span>
        <div className="profile-list-card-head-actions">
          <span className="profile-list-card-count">{fields.length}</span>
          <button type="button" className="profile-edit-toggle" onClick={() => setIsEditing((current) => !current)}>
            {isEditing ? '完成' : '编辑'}
          </button>
        </div>
      </div>
      <div className="profile-list-items">
        {fields.length === 0 ? <p className="profile-empty-hint">暂无条目</p> : null}
        {fields.map((item, index) => {
          const level = item.evidence_level ?? 'L2'
          const evidences = normalizeEvidenceEntries(item.evidences ?? [])
          const signature = `${item.value}::`
          const isManual = manualSignatures.includes(signature)
          const evidenceKey = `${fieldKey}-${index}-${signature}`
          return (
            <article key={`${item.value}-${index}`} className={`profile-list-item ${levelClass(level)}`}>
              <div className="profile-list-dot" />
              <div className="profile-list-content">
                <div className="profile-list-topline">
                  <span className="profile-list-value">{item.value}</span>
                  <div className="profile-list-meta">
                    <span className={`profile-level-badge ${levelClass(level)}`}>{level}</span>
                    {showEvidence ? (
                      <span
                        className="profile-evidence-anchor"
                        data-evidence-key={evidenceKey}
                        onMouseEnter={(event) => handleEvidenceMouseEnter(event, evidenceKey, evidences)}
                        onMouseLeave={(event) => handleEvidenceMouseLeave(event, evidenceKey)}
                      >
                        <span className="profile-evidence-tag">证据 {evidences.length}</span>
                      </span>
                    ) : null}
                    {isManual ? <span className="profile-manual-badge">MANUAL</span> : null}
                  </div>
                </div>
                {isEditing ? (
                  <div className="profile-list-actions">
                    <button type="button" className="profile-list-delete" onClick={() => removeItem(index)} aria-label="删除条目">
                      ×
                    </button>
                  </div>
                ) : null}
              </div>
            </article>
          )
        })}
      </div>
      {isEditing ? (
        <div className="profile-list-addbar">
          <input
            value={newValue}
            placeholder="添加条目..."
            onChange={(event) => setNewValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addItem()
              }
            }}
          />
          <select value={newLevel} onChange={(event) => setNewLevel(event.target.value as EvidenceLevel)}>
            <option value="L1">L1</option>
            <option value="L2">L2</option>
            <option value="L3">L3</option>
          </select>
          <button type="button" className="memory-refresh-btn" onClick={addItem}>
            添加
          </button>
        </div>
      ) : null}
      {showEvidence && activeEvidence ? (
        <div className="profile-evidence-overlay-layer">
          <div
            ref={popoverRef}
            className="profile-evidence-popover profile-evidence-popover-overlay"
            data-evidence-key={activeEvidence.key}
            style={{ left: `${activeEvidence.left}px`, top: `${activeEvidence.top}px` }}
            onMouseLeave={(event) => handleEvidenceMouseLeave(event, activeEvidence.key)}
          >
            {activeEvidence.evidences.length === 0 ? (
              <span className="profile-evidence-empty">暂无证据</span>
            ) : (
              activeEvidence.evidences.map((evidence, evidenceIndex) => (
                <span key={`${evidence.event_id}-${evidenceIndex}`} className="profile-evidence-row">
                  <span>{evidence.event_id}</span>
                  {evidence.reasoning ? <span>{evidence.reasoning}</span> : null}
                </span>
              ))
            )}
          </div>
        </div>
      ) : null}
    </section>
  )
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
  return parts.join(' · ')
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
  const hint = '导入完成后可点击"回填旧聊天"基于 chat_records/微信 重新生成画像。'
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
      setSummaryMessage('正在初始化旧聊天记录，长期记忆列表会自动刷新。完成后可再次点击"回填旧聊天"基于 chat_records/微信 重新生成画像。')
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
    const label = items.length === 1 ? `"${items[0].display_name || '未命名画像'}"` : `${items.length} 条画像`
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
      const baselineProfile = profiles.find((profile) => profile.profile_id === draft.profile_id) ?? null
      const normalizedForSave = applyManualEditsToProfileFields(draft, baselineProfile)
      const saved = normalizeProfileDisplayName(
        await window.electronAPI.profileAdmin.save(toPersistedProfile(normalizedForSave))
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
    <div className="memory-library-shell memory-profile-view">
      {/* 卡片 1：导入区 */}
      <section className="console-card">
        <div className="memory-upload-header">
          <strong>导入旧聊天记录</strong>
          <p>支持 WeChatMsg · wechatDataBackup · SQLite 解密文件</p>
        </div>
        <div
          className={`memory-upload-panel ${dragActive ? 'drag-active' : ''}`}
          onDragEnter={handleDragOver}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={(event) => void handleDrop(event)}
        >
          <div className="memory-upload-copy">
            <p>拖拽文件或文件夹至此，或点击按钮选择 WeChatMsg、wechatDataBackup 或解密后的 SQLite 文件</p>
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
      </section>

      {/* 卡片 2：长期记忆管理区 */}
      <section className="console-card">
        <div className="profile-mgmt-section">
          {/* 行 1：标题 + 主操作按钮 */}
          <div className="profile-mgmt-header">
            <h3>长期记忆</h3>
            <div className="profile-mgmt-header-actions">
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
            </div>
          </div>

          {/* 行 2：Stat Cards */}
          <div className="profile-stat-cards">
            <div className="profile-stat-card">
              <span>画像</span>
              <strong>{counts.total}</strong>
            </div>
            <div className="profile-stat-card stat-blue">
              <span>好友</span>
              <strong>{counts.contacts}</strong>
            </div>
            <div className="profile-stat-card stat-green">
              <span>情节</span>
              <strong>{counts.episodes}</strong>
            </div>
            <div className="profile-stat-card stat-amber">
              <span>前瞻</span>
              <strong>{counts.foresights}</strong>
            </div>
          </div>

          {/* 行 3：搜索 + 批量选择 */}
          <div className="profile-mgmt-search-row">
            <label className="memory-search-field">
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="搜索好友、画像、情节、前瞻..."
              />
            </label>
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
          </div>

          {/* 行 4：语义分组按钮 */}
          <div className="profile-mgmt-action-groups">
            <div className="profile-action-group">
              <span className="profile-action-group-label">新建</span>
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
                好友
              </button>
            </div>
            <div className="profile-action-group">
              <span className="profile-action-group-label">画像</span>
              <button
                type="button"
                className={`memory-refresh-btn ${showBackfillPicker ? 'active' : ''}`}
                onClick={() => setShowBackfillPicker((current) => !current)}
                disabled={importingHistory}
              >
                {showBackfillPicker ? '收起回填' : '选择回填'}
              </button>
              <button
                type="button"
                className="memory-refresh-btn"
                onClick={() => void handleRegenerate()}
                disabled={regenerating || backfilling || clearing || importingHistory}
              >
                {regenerating ? '重新生成中...' : '重新生成'}
              </button>
              <button
                type="button"
                className="memory-refresh-btn danger"
                onClick={() => void handleClearProfiles()}
                disabled={regenerating || backfilling || clearing || importingHistory}
              >
                {clearing ? '清空中...' : '清空'}
              </button>
            </div>
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
          </div>

          {summaryMessage ? <p className="profile-backfill-summary">{summaryMessage}</p> : null}

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
                {/* ── 粘性顶栏 ── */}
                <div className="profile-sticky-header">
                  <div className="profile-sticky-top">
                    <div className="profile-sticky-identity">
                      <div className="profile-avatar-circle">
                        {(draft.display_name || '?').slice(0, 1)}
                      </div>
                      <div>
                        <div className="profile-sticky-name">
                          {draft.display_name || '未命名画像'}
                        </div>
                        <div className="profile-sticky-sub">
                          {draft.conversation_id || draft.target_user_id || draft.owner_user_id}
                        </div>
                      </div>
                    </div>
                    <div className="profile-sticky-actions">
                      <span className="profile-sticky-time">
                        {formatTime(draft.metadata.last_updated || draft.metadata.created_at)}
                      </span>
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
                  </div>
                  <div className="profile-sticky-tabs">
                    {(['profile', 'episodes', 'foresights', 'memcells'] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        className={`profile-tab-btn${detailTab === tab ? ' active' : ''}`}
                        onClick={() => setDetailTab(tab)}
                      >
                        {tab === 'profile' ? '画像' : tab === 'episodes' ? '情节' : tab === 'foresights' ? '前瞻' : 'MemCell'}
                      </button>
                    ))}
                  </div>
                </div>

                {detailTab === 'profile' ? (
                  <>
                    {draft.profile_type === 'user' ? (
                      <EditableUserProfileFields draft={draft} onChange={setDraft} />
                    ) : (
                      <EditableContactProfileFields draft={draft} onChange={setDraft} />
                    )}
                    <ProfileFactsSection draft={draft} />
                    <ProfileSystemSection draft={draft} />
                    <section className="profile-section">
                      <details>
                        <summary className="profile-json-summary">原始 JSON</summary>
                        <pre className="memory-detail-content">{JSON.stringify(buildRawJsonPreview(draft), null, 2)}</pre>
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
                      <MemCellItemCard key={item.memcell_id} item={item} profiles={profiles} />
                    )}
                  />
                ) : null}
                {detailTab === 'episodes' ? (
                  <LongTermListPanel
                    title="情节记录"
                    emptyText="当前好友还没有情节记录。"
                    items={selectedEpisodes}
                    renderItem={(item) => (
                      <EpisodeCard key={item.episode_id} item={item} profiles={profiles} />
                    )}
                  />
                ) : null}

                {detailTab === 'foresights' ? (
                  <LongTermListPanel
                    title="前瞻记录"
                    emptyText="当前好友还没有前瞻记录。"
                    items={selectedForesights}
                    renderItem={(item) => (
                      <ForesightCard key={item.foresight_id} item={item} profiles={profiles} />
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
        const summary = buildProfileSummary(profile)
        const summaryParts = summary ? summary.split(' · ').filter(Boolean) : []
        const isSelfProfile = profile.profile_type === 'user'
        const summaryTokens = summary
          .split(/[|,??\s]+/)
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean)
        const rawTags = getFieldValues(profile.traits as ProfileField[] | string[]).length > 0
          ? getFieldValues(profile.traits as ProfileField[] | string[])
          : getFieldValues(profile.interests as ProfileField[] | string[])
        const dedupedTags: string[] = []
        for (const tag of rawTags) {
          const normalized = tag.trim().toLowerCase()
          if (!normalized) continue
          if (summaryTokens.includes(normalized)) continue
          if (dedupedTags.some((existing) => existing.trim().toLowerCase() === normalized)) continue
          dedupedTags.push(tag)
        }

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
              <strong>{profile.display_name || '?????'}</strong>
              <div className="memory-item-head-actions">
                <span>{formatTime(profile.metadata.last_updated || profile.metadata.created_at)}</span>
              </div>
            </div>
            {!isSelfProfile ? (
              <div className="memory-tag-row">
                {profile.social_attributes.role && profile.social_attributes.role !== 'unknown' ? (
                  <em>{formatRole(profile.social_attributes.role)}</em>
                ) : null}
                <em>{formatIntimacy(profile.social_attributes.intimacy_level)}</em>
              </div>
            ) : null}
            {summaryParts.length > 0 || dedupedTags.length > 0 ? (
              <div className="memory-tag-row">
                {summaryParts.map((part) => (
                  <em key={part}>{part}</em>
                ))}
                {dedupedTags.slice(0, 3).map((tag) => (
                  <em key={tag}>{tag}</em>
                ))}
              </div>
            ) : null}
          </button>
        )
      })}
    </section>
  )
}

function ForesightCard({
  item,
  profiles,
}: {
  item: ForesightItem
  profiles: UnifiedProfile[]
}): JSX.Element {
  const status = getForesightStatus(item)
  const statusLabel = status === 'active' ? '进行中' : status === 'upcoming' ? '计划中' : '已过期'
  return (
    <article className={`unified-card foresight-${status}`}>
      <div className="unified-card-bar foresight-bar" />
      <div className="unified-card-body">
        <div className="unified-card-head">
          <strong className="unified-card-title">{item.content || '未命名前瞻'}</strong>
          <div className="foresight-head-right">
            <span className={`foresight-status-label foresight-label-${status}`}>{statusLabel}</span>
            <span className="unified-card-date">{formatDate(item.updated_at)}</span>
          </div>
        </div>
        {item.start_time || item.end_time || item.duration_days != null ? (
          <div className="foresight-time-row">
            {item.start_time ? (
              <span className="foresight-time-badge">{formatTime(item.start_time)}</span>
            ) : null}
            {item.start_time && item.end_time ? (
              <span className="foresight-arrow">→</span>
            ) : null}
            {item.end_time ? (
              <span className="foresight-time-badge">{formatTime(item.end_time)}</span>
            ) : null}
            {item.duration_days != null ? (
              <span className={`foresight-duration-pill foresight-pill-${status}`}>
                {status === 'active' ? <span className="foresight-dot" /> : null}
                {item.duration_days} 天
              </span>
            ) : null}
          </div>
        ) : null}
        {item.participants.length > 0 ? (
          <div className="unified-tag-row">
            {item.participants.slice(0, 4).map((participant) => {
              const matched = profiles.find(
                (p) => normalizeText(p.target_user_id) === normalizeText(participant)
              )
              const displayName = matched?.display_name
              const isResolved = displayName && displayName !== participant
              return isResolved ? (
                <span key={participant} className="unified-tag-name">{displayName}</span>
              ) : (
                <span key={participant} className="unified-tag">{truncateParticipantId(participant)}</span>
              )
            })}
          </div>
        ) : null}
      </div>
    </article>
  )
}

function EpisodeCard({
  item,
  profiles,
}: {
  item: EpisodicMemoryItem
  profiles: UnifiedProfile[]
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)

  // summary IS the episode narrative — use it as body, never as a title
  const bodyText = item.summary || item.episode || ''
  const isLong = bodyText.length > 120 || bodyText.split('\n').length > 3

  const people: Array<{ id: string; name: string }> = []
  const rawIds: string[] = []
  for (const participant of item.participants) {
    const matched = profiles.find(
      (p) => normalizeText(p.target_user_id) === normalizeText(participant)
    )
    const displayName = matched?.display_name
    if (displayName && displayName !== participant) {
      people.push({ id: participant, name: displayName })
    } else {
      rawIds.push(participant)
    }
  }

  return (
    <article
      className={`unified-card unified-card-green${isLong ? ' unified-card-clickable' : ''}`}
      onClick={() => { if (isLong) setExpanded((c) => !c) }}
    >
      <div className="unified-card-bar" />
      <div className="unified-card-body">
        {/* body text, collapsed by default */}
        <div className={expanded ? 'unified-summary-wrap' : 'unified-summary-wrap unified-summary-collapsed'}>
          <p className="unified-summary-text">{bodyText}</p>
        </div>
        {isLong ? (
          <div className="unified-expand-hint">
            <span className={`unified-expand-arrow${expanded ? ' up' : ''}`}>▾</span>
            {expanded ? '收起' : '展开全文'}
          </div>
        ) : null}
        {/* participants + keywords + date on the same bottom row */}
        <div className="episode-bottom-row">
          <div className="unified-tag-row">
            {people.map((p) => (
              <span key={p.id} className="unified-tag-name">{p.name}</span>
            ))}
            {rawIds.map((id) => (
              <span key={id} className="unified-tag">{truncateParticipantId(id)}</span>
            ))}
            {item.keywords.slice(0, 3).map((kw) => (
              <span key={kw} className="unified-tag">{kw}</span>
            ))}
          </div>
          <span className="unified-card-date">{formatDate(item.updated_at || item.timestamp)}</span>
        </div>
      </div>
    </article>
  )
}

function MemCellItemCard({ item, profiles }: { item: MemCellItem; profiles: UnifiedProfile[] }): JSX.Element {
  const [summaryExpanded, setSummaryExpanded] = useState(false)
  const [messagesExpanded, setMessagesExpanded] = useState(false)

  const rawTitle = item.summary || item.subject || '未命名 MemCell'
  const title = rawTitle.replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, '')
  const bodyText = item.episode && item.episode !== item.summary ? item.episode : (item.subject && item.subject !== item.summary ? item.subject : '')
  const isLong = bodyText.length > 120 || bodyText.split('\n').length > 3

  const people: Array<{ id: string; name: string }> = []
  const rawIds: string[] = []
  for (const participant of item.participants) {
    const matched = profiles.find(
      (p) => normalizeText(p.target_user_id) === normalizeText(participant)
    )
    const displayName = matched?.display_name
    if (displayName && displayName !== participant) {
      people.push({ id: participant, name: displayName })
    } else {
      rawIds.push(participant)
    }
  }

  return (
    <article
      className={`unified-card unified-card-blue${isLong ? ' unified-card-clickable' : ''}`}
      onClick={() => { if (isLong) setSummaryExpanded((c) => !c) }}
    >
      <div className="unified-card-bar" />
      <div className="unified-card-body">
        <div className="unified-card-head">
          <strong className="unified-card-title">{title}</strong>
          <span className="unified-card-date">{formatDate(item.updated_at || item.timestamp)}</span>
        </div>
        {bodyText ? (
          <div className={summaryExpanded ? 'unified-summary-wrap' : 'unified-summary-wrap unified-summary-collapsed'}>
            <p className="unified-summary-text">{bodyText}</p>
          </div>
        ) : null}
        <div className="unified-tag-row">
          {people.map((p) => (
            <span key={p.id} className="unified-tag-name">{p.name}</span>
          ))}
          {rawIds.slice(0, 4).map((id) => (
            <span key={id} className="unified-tag">{truncateParticipantId(id)}</span>
          ))}
          {item.keywords.slice(0, 3).map((kw) => (
            <span key={kw} className="unified-tag">{kw}</span>
          ))}
        </div>
        {item.original_data.length > 0 ? (
          <div
            className="unified-card-footer"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="unified-expand-btn"
              onClick={() => setMessagesExpanded((prev) => !prev)}
            >
              {messagesExpanded ? '收起对话' : `展开对话 (${item.original_data.length} 条)`}
              <span className={`unified-expand-arrow${messagesExpanded ? ' up' : ''}`}>▾</span>
            </button>
            {messagesExpanded ? (
              <div className="memcell-messages-list">
                {item.original_data.map((msg, idx) => (
                  <div key={`${idx}-${msg.timestamp ?? ''}`} className="memcell-message-item">
                    <span className="memcell-message-speaker">{msg.speaker_name || msg.speaker_id || '未知'}</span>
                    <span className="memcell-message-content">{msg.content}</span>
                    <span className="memcell-message-time">{formatTime(msg.timestamp)}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
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
      <dl className="profile-sys-grid">
        <div><dt>画像 ID</dt><dd>{draft.profile_id}</dd></div>
        <div><dt>OWNER 用户 ID</dt><dd>{draft.owner_user_id}</dd></div>
        <div><dt>目标用户 ID</dt><dd>{draft.target_user_id ?? '未设置'}</dd></div>
        <div><dt>会话 ID</dt><dd>{draft.conversation_id ?? '未设置'}</dd></div>
        <div><dt>创建时间</dt><dd>{formatTime(draft.metadata.created_at)}</dd></div>
        <div><dt>最后更新</dt><dd>{formatTime(draft.metadata.last_updated)}</dd></div>
        <div><dt>来源 MemCell 数</dt><dd>{String(draft.metadata.source_memcell_count)}</dd></div>
        <div><dt>风险等级</dt><dd>{risk ? formatRiskLevel(risk.risk_level) : '无'}</dd></div>
        {risk?.warning_msg ? (
          <div className="sys-wide"><dt>风险提示</dt><dd>{risk.warning_msg}</dd></div>
        ) : null}
      </dl>
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
  const attrKeys: ListFieldKey[] = [
    'occupation', 'traits', 'personality', 'interests',
    'way_of_decision_making', 'life_habit_preference', 'communication_style',
    'catchphrase', 'motivation_system', 'fear_system', 'value_system', 'humor_use'
  ]
  const nonEmptyKeys = attrKeys.filter((k) => normalizeProfileFieldList((draft as Record<string, unknown>)[k]).length > 0)
  const emptyKeys = attrKeys.filter((k) => normalizeProfileFieldList((draft as Record<string, unknown>)[k]).length === 0)

  return (
    <>
      <section className="profile-section">
        <div className="profile-section-head"><h4>基本信息</h4></div>
        <div className="profile-basic-table">
          <div className="profile-basic-row">
            <span className="profile-basic-label">显示名称</span>
            <input className="profile-basic-input" value={draft.display_name} onChange={(e) => onChange({ ...draft, display_name: e.target.value })} />
          </div>
          <div className="profile-basic-row">
            <span className="profile-basic-label">学历</span>
            <input className="profile-basic-input" placeholder="未填写" value={getFieldValue(draft.education_level as ProfileField | string | null)} onChange={(e) => onChange({ ...draft, education_level: e.target.value ? { value: e.target.value, evidence_level: 'L2', evidences: [] } : null })} />
          </div>
          <div className="profile-basic-row">
            <span className="profile-basic-label">性别</span>
            <input className="profile-basic-input" placeholder="未填写" value={getFieldValue(draft.gender as ProfileField | string | null)} onChange={(e) => onChange({ ...draft, gender: e.target.value ? { value: e.target.value, evidence_level: 'L1', evidences: [] } : null })} />
          </div>
          <div className="profile-basic-row">
            <span className="profile-basic-label">年龄</span>
            <input className="profile-basic-input" placeholder="未填写" value={getFieldValue(draft.age as ProfileField | string | null)} onChange={(e) => onChange({ ...draft, age: e.target.value ? { value: e.target.value, evidence_level: 'L2', evidences: [] } : null })} />
          </div>
          <div className="profile-basic-row full-width">
            <span className="profile-basic-label">别名</span>
            <input className="profile-basic-input" value={draft.aliases.join('，')} onChange={(e) => onChange({ ...draft, aliases: splitList(e.target.value) })} />
          </div>
        </div>
      </section>
      <section className="profile-section">
        <div className="profile-section-head"><h4>画像属性</h4></div>
        <div className="profile-editor-grid">
          {nonEmptyKeys.map((k) => (
            <ProfileListFieldCard key={k} fieldKey={k} value={(draft as Record<string, unknown>)[k]} onChange={(next) => onChange({ ...draft, [k]: next })} />
          ))}
          {emptyKeys.length > 0 ? (
            <details className="profile-empty-group profile-editor-field-wide">
              <summary>{emptyKeys.length} 个属性暂无条目</summary>
              <div className="profile-editor-grid" style={{ marginTop: 10 }}>
                {emptyKeys.map((k) => (
                  <ProfileListFieldCard key={k} fieldKey={k} value={(draft as Record<string, unknown>)[k]} onChange={(next) => onChange({ ...draft, [k]: next })} />
                ))}
              </div>
            </details>
          ) : null}
        </div>
      </section>
    </>
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

  const attrKeys: ListFieldKey[] = [
    'occupation', 'relationship', 'traits', 'personality', 'interests',
    'way_of_decision_making', 'life_habit_preference', 'communication_style',
    'catchphrase', 'user_to_friend_catchphrase', 'user_to_friend_chat_style',
    'motivation_system', 'fear_system', 'value_system', 'humor_use'
  ]
  const nonEmptyKeys = attrKeys.filter((k) => normalizeProfileFieldList((draft as Record<string, unknown>)[k]).length > 0)
  const emptyKeys = attrKeys.filter((k) => normalizeProfileFieldList((draft as Record<string, unknown>)[k]).length === 0)

  return (
    <>
      <section className="profile-section">
        <div className="profile-section-head"><h4>基本信息</h4></div>
        <div className="profile-basic-table">
          <div className="profile-basic-row">
            <span className="profile-basic-label">显示名称</span>
            <input className="profile-basic-input" value={draft.display_name} onChange={(e) => onChange({ ...draft, display_name: e.target.value })} />
          </div>
          <div className="profile-basic-row">
            <span className="profile-basic-label">熟悉程度</span>
            <select
              className="profile-basic-input"
              value={getFieldValue(draft.intimacy_level as ProfileField | string | null) || 'stranger'}
              onChange={(e) => onChange({ ...draft, intimacy_level: { value: e.target.value, evidence_level: 'L2', evidences: [] } })}
            >
              <option value="stranger">陌生</option>
              <option value="formal">正式</option>
              <option value="close">熟悉</option>
              <option value="intimate">亲密</option>
            </select>
          </div>
          <div className="profile-basic-row">
            <span className="profile-basic-label">性别</span>
            <input className="profile-basic-input" placeholder="未填写" value={getFieldValue(draft.gender as ProfileField | string | null)} onChange={(e) => onChange({ ...draft, gender: e.target.value ? { value: e.target.value, evidence_level: 'L1', evidences: [] } : null })} />
          </div>
          <div className="profile-basic-row">
            <span className="profile-basic-label">年龄</span>
            <input className="profile-basic-input" placeholder="未填写" value={getFieldValue(draft.age as ProfileField | string | null)} onChange={(e) => onChange({ ...draft, age: e.target.value ? { value: e.target.value, evidence_level: 'L2', evidences: [] } : null })} />
          </div>
          <div className="profile-basic-row">
            <span className="profile-basic-label">学历</span>
            <input className="profile-basic-input" placeholder="未填写" value={getFieldValue(draft.education_level as ProfileField | string | null)} onChange={(e) => onChange({ ...draft, education_level: e.target.value ? { value: e.target.value, evidence_level: 'L2', evidences: [] } : null })} />
          </div>
          <div className="profile-basic-row">
            <span className="profile-basic-label">风险等级</span>
            <select
              className="profile-basic-input"
              value={risk.risk_level}
              onChange={(e) => onChange({ ...draft, risk_assessment: { ...risk, risk_level: e.target.value as NonNullable<UnifiedProfile['risk_assessment']>['risk_level'] } })}
            >
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
          </div>
          <div className="profile-basic-row full-width">
            <span className="profile-basic-label">别名</span>
            <input className="profile-basic-input" value={draft.aliases.join('，')} onChange={(e) => onChange({ ...draft, aliases: splitList(e.target.value) })} />
          </div>
          <div className="profile-basic-row full-width">
            <span className="profile-basic-label">中间人姓名</span>
            <input
              className="profile-basic-input"
              placeholder="未填写"
              value={draft.social_attributes.intermediary.name ?? ''}
              onChange={(e) => onChange({ ...draft, social_attributes: { ...draft.social_attributes, intermediary: { ...draft.social_attributes.intermediary, name: e.target.value || null, has_intermediary: !!e.target.value } } })}
            />
          </div>
        </div>
      </section>
      <section className="profile-section">
        <div className="profile-section-head"><h4>画像属性</h4></div>
        <div className="profile-editor-grid">
          {nonEmptyKeys.map((k) => (
            <ProfileListFieldCard key={k} fieldKey={k} value={(draft as Record<string, unknown>)[k]} onChange={(next) => onChange({ ...draft, [k]: next })} />
          ))}
          {emptyKeys.length > 0 ? (
            <details className="profile-empty-group profile-editor-field-wide">
              <summary>{emptyKeys.length} 个属性暂无条目</summary>
              <div className="profile-editor-grid" style={{ marginTop: 10 }}>
                {emptyKeys.map((k) => (
                  <ProfileListFieldCard key={k} fieldKey={k} value={(draft as Record<string, unknown>)[k]} onChange={(next) => onChange({ ...draft, [k]: next })} />
                ))}
              </div>
            </details>
          ) : null}
        </div>
      </section>
    </>
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
