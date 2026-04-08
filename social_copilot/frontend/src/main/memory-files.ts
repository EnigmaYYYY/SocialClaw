import { access, readFile, readdir, rm, stat } from 'fs/promises'
import { constants } from 'fs'
import { homedir } from 'os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'path'
import type { AppSettings } from '../models/schemas'

export type MemorySectionId =
  | 'inbox'
  | 'today-clues'
  | 'long-term-memory'
  | 'relationship-clues'

export interface MemorySectionOverview {
  id: MemorySectionId
  title: string
  description: string
  count: number
}

export interface MemoryFileListItem {
  id: string
  path: string
  title: string
  summary: string
  titleMeta?: string | null
  relativePath: string
  updatedAt: string
  sizeLabel: string
  tags: string[]
}

export interface MemoryFileSection {
  id: MemorySectionId
  title: string
  description: string
  items: MemoryFileListItem[]
}

export interface ChatBubble {
  sender: 'user' | 'contact' | 'unknown'
  name: string
  text: string
  timestamp: string | null
}

export interface MemoryFileDetail {
  path: string
  title: string
  titleMeta?: string | null
  relativePath: string
  updatedAt: string
  sizeLabel: string
  tags: string[]
  content: string
  bubbles?: ChatBubble[]
}

interface RootDescriptor {
  rootPath: string
  source: 'chat_records' | 'memory_library' | 'profile'
}

interface CollectedFile {
  id: string
  path: string
  source: RootDescriptor['source']
  title: string
  summary: string
  titleMeta?: string | null
  relativePath: string
  updatedAt: string
  updatedAtMs: number
  sizeBytes: number
  sizeLabel: string
  tags: string[]
}

export const SECTION_META: Record<MemorySectionId, Omit<MemorySectionOverview, 'count'>> = {
  inbox: {
    id: 'inbox',
    title: '收件箱',
    description: '最近写入的聊天、画像与线索文件'
  },
  'today-clues': {
    id: 'today-clues',
    title: '今日线索',
    description: '今天新增或更新的线索文件'
  },
  'long-term-memory': {
    id: 'long-term-memory',
    title: '长期记忆',
    description: '联系人画像、自我画像与沉淀记忆'
  },
  'relationship-clues': {
    id: 'relationship-clues',
    title: '关系线索',
    description: '和关系、画像、联系人相关的文件'
  }
}

export async function loadMemorySectionOverview(
  settings: AppSettings,
  ownerUserId?: string
): Promise<MemorySectionOverview[]> {
  const grouped = await collectGroupedFiles(settings, ownerUserId)
  return (Object.keys(SECTION_META) as MemorySectionId[]).map((id) => ({
    ...SECTION_META[id],
    count: grouped[id].length
  }))
}

export async function loadMemorySection(
  settings: AppSettings,
  sectionId: MemorySectionId,
  searchQuery: string = '',
  ownerUserId?: string
): Promise<MemoryFileSection> {
  const grouped = await collectGroupedFiles(settings, ownerUserId)
  const normalizedQuery = normalizeSearchQuery(searchQuery)
  const items = normalizedQuery
    ? grouped[sectionId].filter((item) => matchesSearchQuery(item, normalizedQuery))
    : grouped[sectionId]
  return {
    ...SECTION_META[sectionId],
    items: items.map(toListItem)
  }
}

export async function readMemoryItem(
  settings: AppSettings,
  targetPath: string
): Promise<MemoryFileDetail> {
  const allowedRoots = getAllowedRoots(settings)
  const resolvedTargetPath = resolvePath(targetPath)
  const isAllowed = allowedRoots.some((rootPath) => isSubPathOf(resolvedTargetPath, rootPath))
  if (!isAllowed) {
    throw new Error('memory_file_access_denied')
  }

  const fileStat = await stat(resolvedTargetPath)
  const rawContent = await readFile(resolvedTargetPath, 'utf-8')
  const parsed = summarizeFileContent(resolvedTargetPath, rawContent)

  return {
    path: resolvedTargetPath,
    title: parsed.title,
    titleMeta: parsed.titleMeta,
    relativePath: makeRelativeLabel(resolvedTargetPath, allowedRoots),
    updatedAt: fileStat.mtime.toISOString(),
    sizeLabel: formatBytes(fileStat.size),
    tags: parsed.tags,
    content: parsed.content,
    bubbles: parsed.bubbles
  }
}

export async function deleteMemoryItem(
  settings: AppSettings,
  targetPath: string
): Promise<void> {
  const allowedRoots = getAllowedRoots(settings)
  const resolvedTargetPath = resolvePath(targetPath)
  const owningRoot = allowedRoots.find((rootPath) => isSubPathOf(resolvedTargetPath, rootPath))
  if (!owningRoot) {
    throw new Error('memory_file_access_denied')
  }

  const fileStat = await stat(resolvedTargetPath)
  if (!fileStat.isFile()) {
    throw new Error('memory_file_not_found')
  }

  await rm(resolvedTargetPath, { force: false })
  await pruneEmptyParents(dirname(resolvedTargetPath), owningRoot)
}

async function collectGroupedFiles(
  settings: AppSettings,
  ownerUserId?: string
): Promise<Record<MemorySectionId, CollectedFile[]>> {
  const files = await collectFiles(settings, ownerUserId)
  const now = new Date()

  const grouped: Record<MemorySectionId, CollectedFile[]> = {
    inbox: files.filter((item) => item.source === 'chat_records'),
    'today-clues': files.filter(
      (item) => item.source === 'chat_records' && isSameLocalDate(item.updatedAtMs, now)
    ),
    'long-term-memory': files.filter((item) => item.source !== 'chat_records'),
    'relationship-clues': files.filter((item) => looksLikeRelationshipFile(item))
  }

  return grouped
}

async function collectFiles(settings: AppSettings, ownerUserId?: string): Promise<CollectedFile[]> {
  const roots = getRootDescriptors(settings)
  const files: CollectedFile[] = []

  for (const root of roots) {
    const entries = await walkFiles(root.rootPath)
    for (const entryPath of entries) {
      const fileStat = await stat(entryPath)
      const rawContent = await safeReadText(entryPath)
      const summary = summarizeFileContent(entryPath, rawContent, ownerUserId)
      // Skip files that don't belong to the current owner
      if (summary.skip) {
        continue
      }
      files.push({
        id: entryPath,
        path: entryPath,
        source: root.source,
        title: summary.title,
        summary: summary.summary,
        titleMeta: summary.titleMeta,
        relativePath: relative(root.rootPath, entryPath) || basename(entryPath),
        updatedAt: fileStat.mtime.toISOString(),
        updatedAtMs: fileStat.mtime.getTime(),
        sizeBytes: fileStat.size,
        sizeLabel: formatBytes(fileStat.size),
        tags: summary.tags
      })
    }
  }

  return files.sort((left, right) => right.updatedAtMs - left.updatedAtMs)
}

function getRootDescriptors(settings: AppSettings): RootDescriptor[] {
  const descriptors: RootDescriptor[] = []
  const addDescriptor = (rootPath: string, source: RootDescriptor['source']): void => {
    const resolvedPath = resolvePath(rootPath)
    descriptors.push({ rootPath: resolvedPath, source })
  }

  addDescriptor(settings.storagePaths.chatRecordsDir, 'chat_records')
  addDescriptor(settings.storagePaths.memoryLibraryDir, 'memory_library')

  const legacyRoot = join(homedir(), 'SocialCopilot')
  addDescriptor(join(legacyRoot, 'contacts'), 'profile')

  const userProfilePath = join(legacyRoot, 'user_profile.json')
  if (isAbsolute(userProfilePath)) {
    descriptors.push({ rootPath: userProfilePath, source: 'profile' })
  }

  return dedupeDescriptors(descriptors)
}

function getAllowedRoots(settings: AppSettings): string[] {
  return getRootDescriptors(settings).map((item) => item.rootPath)
}

function dedupeDescriptors(descriptors: RootDescriptor[]): RootDescriptor[] {
  const seen = new Set<string>()
  const result: RootDescriptor[] = []
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.rootPath)) {
      continue
    }
    seen.add(descriptor.rootPath)
    result.push(descriptor)
  }
  return result
}

async function walkFiles(rootPath: string): Promise<string[]> {
  if (!(await pathExists(rootPath))) {
    return []
  }

  const rootStat = await stat(rootPath)
  if (rootStat.isFile()) {
    return [rootPath]
  }

  const entries = await readdir(rootPath, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(entryPath)))
      continue
    }
    if (!entry.isFile()) {
      continue
    }
    if (looksLikeTextFile(entry.name)) {
      files.push(entryPath)
    }
  }
  return files
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function looksLikeTextFile(fileName: string): boolean {
  const extension = extname(fileName).toLowerCase()
  return ['.json', '.md', '.txt', '.log'].includes(extension)
}

async function safeReadText(targetPath: string): Promise<string> {
  try {
    return await readFile(targetPath, 'utf-8')
  } catch {
    return ''
  }
}

function summarizeFileContent(
  filePath: string,
  rawContent: string,
  ownerUserId?: string
): { title: string; summary: string; titleMeta?: string | null; tags: string[]; content: string; bubbles?: ChatBubble[]; skip: boolean } {
  const fileName = basename(filePath, extname(filePath))
  const trimmed = rawContent.trim()
  const tags = new Set<string>()

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown

      // Check owner_user_id for filtering
      // If ownerUserId is provided, only show files that:
      // 1. Have owner_user_id matching the current user, OR
      // 2. Don't have owner_user_id (legacy files - will be claimed by repair)
      if (ownerUserId && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>
        const fileOwnerId = record.owner_user_id
        // Skip if file has a different owner
        if (fileOwnerId && typeof fileOwnerId === 'string' && fileOwnerId !== ownerUserId) {
          return {
            title: fileName,
            summary: '',
            tags: [],
            content: '',
            skip: true
          }
        }
      }

      if (Array.isArray(parsed)) {
        return {
          title: fileName,
          summary: `JSON 数组，共 ${parsed.length} 项`,
          tags: ['json'],
          content: JSON.stringify(parsed, null, 2),
          skip: false
        }
      }

      if (typeof parsed === 'object' && parsed !== null) {
        if (isRecord(parsed) && typeof parsed.session_name === 'string' && Array.isArray(parsed.messages)) {
          const lastMessage = findLastMessageText(parsed.messages)
          tags.add('chat')
          if (typeof parsed.app_name === 'string' && parsed.app_name.trim().length > 0) {
            tags.add(parsed.app_name.trim())
          }
          return {
            title: parsed.session_name,
            summary: lastMessage || `Conversation messages: ${parsed.messages.length}`,
            titleMeta: formatCountLabel(parsed.messages.length),
            tags: Array.from(tags),
            content: buildChatTranscript(parsed),
            bubbles: buildChatBubbles(parsed),
            skip: false
          }
        }

        if (isRecord(parsed) && typeof parsed.display_name === 'string') {
          tags.add('profile')
          if (typeof parsed.profile_type === 'string') {
            tags.add(parsed.profile_type)
          }
          return {
            title: parsed.display_name,
            summary: buildProfileSummary(parsed) || 'Contact profile file',
            titleMeta: null,
            tags: Array.from(tags),
            content: buildProfileContent(parsed),
            skip: false
          }
        }

        if (isRecord(parsed) && typeof parsed.user_id === 'string') {
          tags.add('user-profile')
          return {
            title: 'My Profile',
            summary: buildUserProfileSummary(parsed) || 'User profile file',
            titleMeta: null,
            tags: Array.from(tags),
            content: buildUserProfileContent(parsed),
            skip: false
          }
        }

        if (isRecord(parsed) && typeof parsed.session_name === 'string' && Array.isArray(parsed.messages)) {
          const lastMessage = findLastMessageText(parsed.messages)
          tags.add('chat')
          if (typeof parsed.app_name === 'string' && parsed.app_name.trim().length > 0) {
            tags.add(parsed.app_name.trim())
          }
          return {
            title: parsed.session_name,
            summary: lastMessage || `会话消息 ${parsed.messages.length} 条`,
            tags: Array.from(tags),
            content: JSON.stringify(parsed, null, 2),
            skip: false
          }
        }

        if (isRecord(parsed) && typeof parsed.display_name === 'string') {
          tags.add('profile')
          if (typeof parsed.profile_type === 'string') {
            tags.add(parsed.profile_type)
          }
          return {
            title: parsed.display_name,
            summary: buildProfileSummary(parsed) || '联系人画像文件',
            tags: Array.from(tags),
            content: JSON.stringify(parsed, null, 2),
            skip: false
          }
        }

        if (isRecord(parsed) && typeof parsed.user_id === 'string') {
          tags.add('user-profile')
          return {
            title: '我的画像',
            summary: buildUserProfileSummary(parsed) || '用户画像文件',
            tags: Array.from(tags),
            content: JSON.stringify(parsed, null, 2),
            skip: false
          }
        }
      }
    } catch {
      // fall through to plain-text summary
    }
  }

  const summary = trimmed.split(/\r?\n/).find((line) => line.trim().length > 0) || '空文件'
  return {
    title: fileName,
    summary: summary.slice(0, 120),
    titleMeta: null,
    tags: [extname(filePath).replace('.', '') || 'text'],
    content: rawContent,
    skip: false
  }
}

function buildProfileSummary(parsed: Record<string, unknown>): string {
  const traits = Array.isArray(parsed.traits) ? parsed.traits.filter(isNonEmptyString) : []
  const interests = Array.isArray(parsed.interests) ? parsed.interests.filter(isNonEmptyString) : []
  const socialAttributes =
    parsed.social_attributes && typeof parsed.social_attributes === 'object'
      ? (parsed.social_attributes as Record<string, unknown>)
      : null
  const currentStatus = socialAttributes && typeof socialAttributes.current_status === 'string'
    ? socialAttributes.current_status
    : null
  return [traits.slice(0, 3).join(' / '), interests.slice(0, 2).join(' / '), currentStatus]
    .filter((item) => typeof item === 'string' && item.length > 0)
    .join(' · ')
}

function buildUserProfileSummary(parsed: Record<string, unknown>): string {
  const baseInfo =
    parsed.base_info && typeof parsed.base_info === 'object'
      ? (parsed.base_info as Record<string, unknown>)
      : null
  const occupation = baseInfo && typeof baseInfo.occupation === 'string' ? baseInfo.occupation : null
  const toneStyle = baseInfo && typeof baseInfo.tone_style === 'string' ? baseInfo.tone_style : null
  return [occupation, toneStyle].filter((item): item is string => !!item && item.length > 0).join(' · ')
}

function buildChatTranscript(parsed: Record<string, unknown>): string {
  const sessionName = typeof parsed.session_name === 'string' ? parsed.session_name : 'Untitled Session'
  const messages = Array.isArray(parsed.messages) ? parsed.messages : []
  const renderedMessages = messages
    .map((message) => (isRecord(message) ? formatChatLine(message, sessionName) : null))
    .filter((value): value is string => value !== null)
  const visibleMessages = renderedMessages.slice(-30)
  const lines: string[] = []

  if (renderedMessages.length === 0) {
    lines.push('No readable messages.')
  } else {
    lines.push(...visibleMessages)
  }

  return lines.join('\n')
}

function buildChatBubbles(parsed: Record<string, unknown>): ChatBubble[] {
  const sessionName = typeof parsed.session_name === 'string' ? parsed.session_name : 'Contact'
  const messages = Array.isArray(parsed.messages) ? parsed.messages : []
  return messages
    .filter(isRecord)
    .map((msg): ChatBubble | null => {
      const metadata = isRecord(msg.metadata) ? msg.metadata : null
      const rawText = typeof msg.content === 'string' ? msg.content.trim()
        : typeof msg.text === 'string' ? msg.text.trim() : ''
      const nonText = (metadata && typeof metadata.non_text_description === 'string')
        ? metadata.non_text_description.trim()
        : typeof msg.non_text_description === 'string' ? msg.non_text_description.trim() : ''
      const text = rawText || (nonText ? `[${nonText}]` : '')
      if (!text) return null

      const sender = (typeof msg.sender_type === 'string' ? msg.sender_type
        : typeof msg.sender === 'string' ? msg.sender : 'unknown') as ChatBubble['sender']
      const senderName = typeof msg.sender_name === 'string' ? msg.sender_name.trim() : ''
      const contactName = senderName || (metadata && typeof metadata.contact_name === 'string'
        ? metadata.contact_name.trim() : '')
      const name = sender === 'user' ? (senderName || 'Me') : (contactName || sessionName)
      const timestamp = typeof msg.timestamp === 'string' ? msg.timestamp : null
      return { sender, name, text, timestamp }
    })
    .filter((b): b is ChatBubble => b !== null)
}

function buildProfileContent(parsed: Record<string, unknown>): string {
  const traits = Array.isArray(parsed.traits) ? parsed.traits.filter(isNonEmptyString) : []
  const interests = Array.isArray(parsed.interests) ? parsed.interests.filter(isNonEmptyString) : []
  const notes = Array.isArray(parsed.notes) ? parsed.notes.filter(isNonEmptyString) : []
  const socialAttributes = isRecord(parsed.social_attributes) ? parsed.social_attributes : null
  const relationship = isRecord(parsed.relationship) ? parsed.relationship : null

  return [
    `Name: ${String(parsed.display_name)}`,
    typeof parsed.profile_type === 'string' ? `Profile Type: ${parsed.profile_type}` : null,
    typeof parsed.target_user_id === 'string' ? `Target User ID: ${parsed.target_user_id}` : null,
    typeof parsed.conversation_id === 'string' ? `Conversation ID: ${parsed.conversation_id}` : null,
    '',
    buildSection('Traits', traits),
    buildSection('Interests', interests),
    socialAttributes ? buildKeyValueSection('Social Attributes', socialAttributes) : null,
    relationship ? buildKeyValueSection('Relationship', relationship) : null,
    buildSection('Notes', notes),
    '',
    'Raw Summary',
    buildProfileSummary(parsed) || 'No compact summary available.'
  ]
    .filter((value): value is string => value !== null && value.length > 0)
    .join('\n')
}

function buildUserProfileContent(parsed: Record<string, unknown>): string {
  const baseInfo = isRecord(parsed.base_info) ? parsed.base_info : null
  const preferences = isRecord(parsed.preferences) ? parsed.preferences : null
  const personaAnchors = Array.isArray(parsed.persona_anchors) ? parsed.persona_anchors.filter(isNonEmptyString) : []

  return [
    'Owner Profile',
    `User ID: ${String(parsed.user_id)}`,
    '',
    baseInfo ? buildKeyValueSection('Base Info', baseInfo) : null,
    preferences ? buildKeyValueSection('Preferences', preferences) : null,
    buildSection('Persona Anchors', personaAnchors),
    '',
    'Raw Summary',
    buildUserProfileSummary(parsed) || 'No compact summary available.'
  ]
    .filter((value): value is string => value !== null && value.length > 0)
    .join('\n')
}

function buildSection(title: string, items: string[]): string | null {
  if (items.length === 0) {
    return null
  }
  return [title, ...items.map((item) => `- ${item}`)].join('\n')
}

function buildKeyValueSection(title: string, value: Record<string, unknown>): string | null {
  const lines = Object.entries(value)
    .map(([key, item]) => {
      if (typeof item === 'string' && item.trim().length > 0) {
        return `- ${startCase(key)}: ${item.trim()}`
      }
      if (typeof item === 'number' || typeof item === 'boolean') {
        return `- ${startCase(key)}: ${String(item)}`
      }
      if (Array.isArray(item)) {
        const values = item.filter(isNonEmptyString)
        if (values.length > 0) {
          return `- ${startCase(key)}: ${values.join(', ')}`
        }
      }
      return null
    })
    .filter((line): line is string => line !== null)

  if (lines.length === 0) {
    return null
  }
  return [title, ...lines].join('\n')
}

function formatChatLine(message: Record<string, unknown>, sessionName: string): string | null {
  const metadata = isRecord(message.metadata) ? message.metadata : null
  const text =
    typeof message.content === 'string'
      ? message.content.trim()
      : typeof message.text === 'string'
        ? message.text.trim()
        : ''
  const nonText =
    metadata && typeof metadata.non_text_description === 'string'
      ? metadata.non_text_description.trim()
      : typeof message.non_text_description === 'string'
        ? message.non_text_description.trim()
        : ''
  const body = text || (nonText ? `[${nonText}]` : '')
  if (!body) {
    return null
  }

  const sender =
    typeof message.sender_type === 'string'
      ? message.sender_type
      : typeof message.sender === 'string'
        ? message.sender
        : 'unknown'
  const contactName =
    typeof message.sender_name === 'string' && message.sender_name.trim().length > 0
      ? message.sender_name.trim()
      : metadata && typeof metadata.contact_name === 'string' && metadata.contact_name.trim().length > 0
        ? metadata.contact_name.trim()
        : typeof message.contact_name === 'string' && message.contact_name.trim().length > 0
          ? message.contact_name.trim()
          : null
  const senderName =
    typeof message.sender_name === 'string' && message.sender_name.trim().length > 0
      ? message.sender_name.trim()
      : null
  const label =
    sender === 'user'
      ? (senderName || 'Me')
      : contactName
        ? contactName
        : senderName
          ? senderName
        : sender === 'contact'
          ? sessionName
          : 'Unknown'
  const timestamp = typeof message.timestamp === 'string' ? formatTimeLabel(message.timestamp) : null
  return `${timestamp ? `[${timestamp}] ` : ''}${label}: ${body}`
}

function formatTimeLabel(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function formatCountLabel(count: number): string {
  return `${count}条消息`
}

function startCase(value: string): string {
  return value
    .split(/[_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function findLastMessageText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || typeof message !== 'object') {
      continue
    }
    const row = message as Record<string, unknown>
    if (typeof row.content === 'string' && row.content.trim().length > 0) {
      return row.content.trim().slice(0, 120)
    }
    if (typeof row.text === 'string' && row.text.trim().length > 0) {
      return row.text.trim().slice(0, 120)
    }
    const metadata = isRecord(row.metadata) ? row.metadata : null
    if (metadata && typeof metadata.non_text_description === 'string' && metadata.non_text_description.trim().length > 0) {
      return metadata.non_text_description.trim().slice(0, 120)
    }
    if (typeof row.non_text_description === 'string' && row.non_text_description.trim().length > 0) {
      return row.non_text_description.trim().slice(0, 120)
    }
  }
  return ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function looksLikeRelationshipFile(item: CollectedFile): boolean {
  const haystack = `${item.relativePath} ${item.title} ${item.summary} ${item.tags.join(' ')}`.toLowerCase()
  return /(relationship|profile|contact|friend|关系|联系人|画像)/i.test(haystack)
}

function isSameLocalDate(timestampMs: number, now: Date): boolean {
  const value = new Date(timestampMs)
  return (
    value.getFullYear() === now.getFullYear() &&
    value.getMonth() === now.getMonth() &&
    value.getDate() === now.getDate()
  )
}

function toListItem(item: CollectedFile): MemoryFileListItem {
  return {
    id: item.id,
    path: item.path,
    title: item.title,
    summary: item.summary,
    titleMeta: item.titleMeta ?? null,
    relativePath: item.relativePath,
    updatedAt: item.updatedAt,
    sizeLabel: item.sizeLabel,
    tags: item.tags
  }
}

function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase()
}

function matchesSearchQuery(item: CollectedFile, query: string): boolean {
  const haystack = [
    item.title,
    item.summary,
    item.titleMeta ?? '',
    item.relativePath,
    item.tags.join(' ')
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(query)
}

function resolvePath(targetPath: string): string {
  return isAbsolute(targetPath) ? targetPath : resolve(process.cwd(), targetPath)
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
}

function makeRelativeLabel(targetPath: string, allowedRoots: string[]): string {
  for (const rootPath of allowedRoots) {
    if (isSubPathOf(targetPath, rootPath)) {
      if (targetPath === rootPath) {
        return basename(targetPath)
      }
      return relative(rootPath, targetPath) || basename(targetPath)
    }
  }
  return basename(targetPath)
}

function isSubPathOf(candidatePath: string, rootPath: string): boolean {
  if (candidatePath === rootPath) {
    return true
  }
  const relativePath = relative(rootPath, candidatePath)
  return relativePath.length > 0 && !relativePath.startsWith('..') && !isAbsolute(relativePath)
}

async function pruneEmptyParents(startPath: string, rootPath: string): Promise<void> {
  let currentPath = startPath
  while (isSubPathOf(currentPath, rootPath)) {
    let entries
    try {
      entries = await readdir(currentPath)
    } catch {
      return
    }
    if (entries.length > 0) {
      return
    }
    await rm(currentPath, { recursive: false, force: false })
    currentPath = dirname(currentPath)
  }
}
