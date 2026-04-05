import type { Dirent } from 'fs'
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'fs/promises'
import { dirname, extname, join, resolve, sep } from 'path'

export interface CleanupLocalDataInput {
  chatRecordsDir: string
  cacheDir: string
  ownerUserId: string
  cutoffIso: string
  activeCacheRunDir?: string | null
}

export interface CleanupChatResult {
  scannedSessions: number
  deletedMessages: number
  deletedFiles: number
  errors: number
}

export interface CleanupCacheResult {
  scannedFiles: number
  deletedFiles: number
  deletedDirs: number
  errors: number
  skippedActiveRunDir: boolean
}

export interface CleanupLocalDataResult {
  cutoffIso: string
  chat: CleanupChatResult
  cache: CleanupCacheResult
}

interface ChatRecordMessage {
  timestamp?: unknown
  metadata?: {
    capture_timestamp?: unknown
  } | null
}

interface ChatRecordFile {
  owner_user_id?: unknown
  updated_at?: unknown
  messages?: unknown
  [key: string]: unknown
}

export async function cleanupLocalData(input: CleanupLocalDataInput): Promise<CleanupLocalDataResult> {
  const cutoffMs = Date.parse(input.cutoffIso)
  if (!Number.isFinite(cutoffMs)) {
    throw new Error('invalid_cutoff_iso')
  }

  const chat = await cleanupChatRecords({
    chatRecordsDir: input.chatRecordsDir,
    ownerUserId: input.ownerUserId,
    cutoffMs
  })
  const cache = await cleanupCacheFiles({
    cacheDir: input.cacheDir,
    activeCacheRunDir: input.activeCacheRunDir ?? null,
    cutoffMs
  })

  return {
    cutoffIso: input.cutoffIso,
    chat,
    cache
  }
}

async function cleanupChatRecords(input: {
  chatRecordsDir: string
  ownerUserId: string
  cutoffMs: number
}): Promise<CleanupChatResult> {
  const result: CleanupChatResult = {
    scannedSessions: 0,
    deletedMessages: 0,
    deletedFiles: 0,
    errors: 0
  }

  const chatRecordsDir = resolve(input.chatRecordsDir)
  await mkdir(chatRecordsDir, { recursive: true })
  const filePaths = await collectFiles(chatRecordsDir, ['.json'])

  for (const filePath of filePaths) {
    result.scannedSessions += 1
    try {
      const raw = await readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as ChatRecordFile
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.messages)) {
        continue
      }

      const fileOwner = normalizeOptionalText(parsed.owner_user_id)
      if (fileOwner && fileOwner !== input.ownerUserId) {
        continue
      }

      const originalMessages = parsed.messages as ChatRecordMessage[]
      const nextMessages: ChatRecordMessage[] = []
      let deletedInFile = 0
      for (const message of originalMessages) {
        const timestampMs = resolveMessageTimestampMs(message)
        if (timestampMs !== null && timestampMs < input.cutoffMs) {
          deletedInFile += 1
          continue
        }
        nextMessages.push(message)
      }

      if (deletedInFile === 0) {
        continue
      }

      result.deletedMessages += deletedInFile
      if (nextMessages.length === 0) {
        await unlink(filePath)
        await pruneEmptyParents(dirname(filePath), chatRecordsDir)
        result.deletedFiles += 1
        continue
      }

      parsed.messages = nextMessages
      parsed.updated_at = new Date().toISOString()
      await writeFile(filePath, JSON.stringify(parsed, null, 2), 'utf-8')
    } catch {
      result.errors += 1
    }
  }

  return result
}

async function cleanupCacheFiles(input: {
  cacheDir: string
  activeCacheRunDir: string | null
  cutoffMs: number
}): Promise<CleanupCacheResult> {
  const result: CleanupCacheResult = {
    scannedFiles: 0,
    deletedFiles: 0,
    deletedDirs: 0,
    errors: 0,
    skippedActiveRunDir: false
  }

  const cacheRoot = resolve(input.cacheDir)
  await mkdir(cacheRoot, { recursive: true })

  let activeRunDir: string | null = null
  if (input.activeCacheRunDir) {
    const resolvedActiveRunDir = resolve(input.activeCacheRunDir)
    if (isSubPathOf(resolvedActiveRunDir, cacheRoot)) {
      activeRunDir = resolvedActiveRunDir
    }
  }

  const shouldSkipPath = (targetPath: string): boolean => {
    if (!activeRunDir) {
      return false
    }
    return targetPath === activeRunDir || targetPath.startsWith(`${activeRunDir}${sep}`)
  }

  const walkAndCleanup = async (currentDir: string, isRoot: boolean): Promise<void> => {
    if (shouldSkipPath(currentDir)) {
      result.skippedActiveRunDir = true
      return
    }

    let entries: Dirent[]
    try {
      entries = await readdir(currentDir, { withFileTypes: true })
    } catch {
      result.errors += 1
      return
    }

    for (const entry of entries) {
      const entryPath = join(currentDir, entry.name)
      if (shouldSkipPath(entryPath)) {
        result.skippedActiveRunDir = true
        continue
      }

      if (entry.isDirectory()) {
        await walkAndCleanup(entryPath, false)
        continue
      }

      if (!entry.isFile()) {
        continue
      }

      result.scannedFiles += 1
      try {
        const fileStat = await stat(entryPath)
        if (fileStat.mtimeMs < input.cutoffMs) {
          await rm(entryPath, { force: false })
          result.deletedFiles += 1
        }
      } catch {
        result.errors += 1
      }
    }

    if (isRoot || shouldSkipPath(currentDir)) {
      return
    }

    try {
      const remaining = await readdir(currentDir)
      if (remaining.length > 0) {
        return
      }
      const dirStat = await stat(currentDir)
      if (dirStat.mtimeMs < input.cutoffMs) {
        await rm(currentDir, { recursive: false, force: false })
        result.deletedDirs += 1
      }
    } catch {
      result.errors += 1
    }
  }

  await walkAndCleanup(cacheRoot, true)
  return result
}

function resolveMessageTimestampMs(message: ChatRecordMessage): number | null {
  if (!message || typeof message !== 'object') {
    return null
  }
  const primary = parseTimeMs(message.timestamp)
  if (primary !== null) {
    return primary
  }
  const fallback = parseTimeMs(message.metadata?.capture_timestamp)
  return fallback
}

function parseTimeMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) {
      return null
    }
    return value < 1e11 ? value * 1000 : value
  }
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  if (/^\d{9,16}$/.test(trimmed)) {
    const numeric = Number(trimmed)
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return null
    }
    return trimmed.length <= 10 ? numeric * 1000 : numeric
  }
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

async function collectFiles(rootPath: string, allowedExts: string[]): Promise<string[]> {
  const files: string[] = []

  const walk = async (dirPath: string): Promise<void> => {
    const entries = await readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        await walk(entryPath)
        continue
      }
      if (!entry.isFile()) {
        continue
      }
      if (!allowedExts.includes(extname(entry.name).toLowerCase())) {
        continue
      }
      files.push(entryPath)
    }
  }

  await walk(rootPath)
  return files
}

async function pruneEmptyParents(startPath: string, rootPath: string): Promise<void> {
  let currentPath = resolve(startPath)
  const resolvedRoot = resolve(rootPath)

  while (isSubPathOf(currentPath, resolvedRoot) && currentPath !== resolvedRoot) {
    const entries = await readdir(currentPath)
    if (entries.length > 0) {
      break
    }
    await rm(currentPath, { recursive: false, force: false })
    currentPath = dirname(currentPath)
  }
}

function isSubPathOf(targetPath: string, rootPath: string): boolean {
  const resolvedTarget = resolve(targetPath)
  const resolvedRoot = resolve(rootPath)
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${sep}`)
}



