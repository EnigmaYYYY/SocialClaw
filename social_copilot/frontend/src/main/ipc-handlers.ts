/**
 * IPC Handlers - Electron IPC bridge between main and renderer processes
 *
 * Registers handlers for:
 * - import:* - Data import handlers (import:folder, import:file)
 * - monitor:* - Chat monitor handlers (monitor:start, monitor:stop, monitor:status)
 * - suggestions:* - Suggestion handlers (suggestions:generate)
 * - profile:* - Profile handlers (profile:loadUser, profile:saveUser, profile:loadContact)
 * - settings:* - Settings handlers (settings:load, settings:save)
 * - chat:submit - Submit chat logs for analysis (legacy)
 * - contacts:list - List all contacts
 * - ollama:health - Check Ollama connectivity
 *
 * Validates: Requirement 2.1
 */
import { ipcMain, dialog, BrowserWindow, screen } from 'electron'
import { readFile, mkdir } from 'fs/promises'
import { MemoryManager } from '../services/memory-manager'
import { OllamaClient } from '../services/ollama-client'
import { ChatParser } from '../services/chat-parser'
import { DataImporter, DataFormat, DataImportResult } from '../services/data-importer'
import {
  ChatMonitorService,
  ChatMonitorStatus,
  LEGACY_CHAT_MONITOR_UNAVAILABLE_MESSAGE
} from '../services/chat-monitor'
import { ColdStartService, ColdStartResult, ColdStartProgress } from '../services/cold-start-service'
import { HotRunService, HotRunStatus, SuggestionUpdate } from '../services/hot-run-service'
import { IntentAgent } from '../agents/intent-agent'
import { CoachAgent } from '../agents/coach-agent'
import { ProfilerAgent } from '../agents/profiler-agent'
import { AgentOrchestrator, OrchestrationResult } from '../agents/orchestrator'
import { UnifiedProfile, AppSettings } from '../models/schemas'
import {
  deleteStoredChatRecordSession,
  ingestChatRecordsAndGetRecent,
  loadRecentChatRecordSession,
  loadStoredChatRecordSessions,
  repairStoredChatRecordSessions,
  type ChatRecordMaintenanceOptions,
  type ChatRecordEventRow,
  type ChatRecordIngestResult,
  type ChatRecordEntry
} from './chat-records'
import {
  loadMemorySectionOverview,
  loadMemorySection,
  readMemoryItem,
  deleteMemoryItem,
  type MemorySectionId,
  type MemorySectionOverview,
  type MemoryFileSection,
  type MemoryFileDetail,
  type MemoryFileListItem,
  SECTION_META
} from './memory-files'
import {
  chunkBackfillMessages,
  computeBackfillChunkTimeoutMs,
  mergeBackfillProgress,
  selectBackfillMessages,
  summarizeBackfillSession,
  type BackfillSessionSummary
} from './profile-backfill'
import {
  executeImportAndInitializeMemory,
  type ImportInitializeMemoryResult,
  type ImportInitializeMemoryProgress
} from './import-initialize-memory'
import { resolveFrameCacheRunDirState } from './visual-monitor-cache-run'
import { listProviderModels, probeProviderConnection } from './model-provider'
import { buildVisualMonitorConfigPatchPayload } from './visual-monitor-config-patch'
import { createDipToScreenPointMapper, dipRectToScreenRect } from './coordinate-utils'

// ============================================================================
// Service Instances
// ============================================================================

let memoryManager: MemoryManager
let ollamaClient: OllamaClient
let orchestrator: AgentOrchestrator
let dataImporter: DataImporter
let chatMonitor: ChatMonitorService
let coldStartService: ColdStartService
let hotRunService: HotRunService

const DEFAULT_VISUAL_MONITOR_API_BASE_URL = 'http://127.0.0.1:18777'
const VISUAL_MONITOR_START_COMMAND =
  'uvicorn social_copilot.visual_monitor.app:app --host 127.0.0.1 --port 18777 --reload'

let latestFrameCacheRunDir: string | null = null
let lastVisualMonitorRunning: boolean | null = null
let lastChatRecordRepairRoot: string | null = null
let lastChatRecordRepairOwner: string | null = null
let lastChatRecordRepairAt = 0
const CHAT_RECORD_REPAIR_COOLDOWN_MS = 60_000
const PROFILE_CACHE_TTL_MS = 30_000
const MEMORY_FILES_CACHE_TTL_MS = 30_000
const DEFAULT_PROFILE_BACKFILL_CHUNK_SIZE = 20

let cachedUserProfile: { ownerUserId: string; profile: UnifiedProfile; fetchedAt: number } | null = null
const cachedContactProfiles = new Map<string, { profile: UnifiedProfile | null; fetchedAt: number }>()

// Profile list cache for long-term memory panel
let cachedProfileList: { ownerUserId: string; profiles: UnifiedProfile[]; fetchedAt: number } | null = null
const dirtySessionKeys = new Set<string>() // Sessions with new messages that need refresh

// Memory files cache for inbox and other sections
let cachedMemorySections: { chatRecordsDir: string; ownerUserId: string; sections: Record<string, unknown[]>; fetchedAt: number } | null = null
const dirtyMemorySessions = new Set<string>() // Sessions with new messages needing memory files refresh

interface ProfileBackfillResult {
  scannedSessions: number
  processedSessions: number
  skippedSessions: number
  failedSessions: number
  updatedProfiles: number
  failedSessionNames: string[]
  failedReasons: string[]
}

interface ProfileBackfillJobState {
  active: boolean
  phase: 'idle' | 'running' | 'complete' | 'failed'
  startedAt: string | null
  updatedAt: string | null
  forceFullRebuild: boolean
  selectedSessionKeys: string[]
  scannedSessions: number
  completedSessions: number
  totalChunks: number
  completedChunks: number
  currentSessionName: string | null
  result: ProfileBackfillResult | null
  error: string | null
}

interface RegenerateProfilesResult {
  success: boolean
  scanned_memcells: number
  processed_conversations: number
  updated_profiles: number
  errors: string[]
}

let activeProfileBackfillJobState: ProfileBackfillJobState = createIdleBackfillJobState()

function createIdleBackfillJobState(): ProfileBackfillJobState {
  return {
    active: false,
    phase: 'idle',
    startedAt: null,
    updatedAt: null,
    forceFullRebuild: true,
    selectedSessionKeys: [],
    scannedSessions: 0,
    completedSessions: 0,
    totalChunks: 0,
    completedChunks: 0,
    currentSessionName: null,
    result: null,
    error: null
  }
}

interface ClearProfilesResult {
  success: boolean
  cleared_profiles: number
}

interface EpisodicMemoryItem {
  episode_id: string
  conversation_id: string | null
  user_id: string | null
  user_name: string | null
  timestamp: string | null
  summary: string
  subject: string | null
  episode: string
  type: string | null
  participants: string[]
  keywords: string[]
  linked_entities: string[]
  updated_at: string | null
}

interface ForesightItem {
  foresight_id: string
  conversation_id: string | null
  user_id: string | null
  user_name: string | null
  content: string
  parent_episode_id: string | null
  start_time: string | null
  end_time: string | null
  duration_days: number | null
  participants: string[]
  evidence: string | null
  updated_at: string | null
}

interface MemCellMessage {
  speaker_name: string
  speaker_id: string
  content: string
  timestamp: string | null
}

interface MemCellItem {
  memcell_id: string
  conversation_id: string | null
  user_id: string | null
  timestamp: string | null
  summary: string
  subject: string | null
  type: string | null
  participants: string[]
  keywords: string[]
  episode: string | null
  foresight_count: number
  original_data_count: number
  original_data: MemCellMessage[]
  updated_at: string | null
}

/**
 * Initializes all service instances
 * Called once during application startup
 */
function initializeServices(): void {
  memoryManager = new MemoryManager()
  ollamaClient = new OllamaClient()
  dataImporter = new DataImporter()
  chatMonitor = new ChatMonitorService()

  const intentAgent = new IntentAgent(ollamaClient)
  const coachAgent = new CoachAgent(ollamaClient)
  const profilerAgent = new ProfilerAgent(ollamaClient)

  orchestrator = new AgentOrchestrator(
    intentAgent,
    coachAgent,
    profilerAgent,
    memoryManager
  )

  // Initialize Cold Start service with shared instances
  coldStartService = new ColdStartService(
    dataImporter,
    undefined, // Use default DataCleanerAgent
    profilerAgent,
    memoryManager,
    ollamaClient
  )

  // Initialize Hot Run service with shared instances
  hotRunService = new HotRunService(
    chatMonitor,
    memoryManager,
    ollamaClient,
    orchestrator
  )
}

/**
 * Initializes the application data directory and default profiles
 * Creates ~/SocialCopilot/ directory structure on first run
 * Creates default user profile if it doesn't exist
 * Validates: Requirements 1.1, 4.1, 6.1
 */
export async function initializeApplication(): Promise<{
  ollamaConnected: boolean
  contacts: string[]
  isFirstRun: boolean
}> {
  // Initialize services if not already done
  if (!memoryManager) {
    initializeServices()
  }

  // Initialize data directory structure (creates ~/SocialCopilot/ and subdirectories)
  await memoryManager.initialize()

  // Load settings to check if this is first run (Requirement 1.1)
  const settings = await memoryManager.loadSettings()
  const isFirstRun = !settings.onboardingComplete

  // Load user profile (creates default if doesn't exist - Requirement 4.1)
  await memoryManager.loadUserProfile()

  // Check Ollama connectivity (Requirement 6.1)
  const ollamaConnected = await ollamaClient.checkHealth()

  // Load contact list
  const contacts = await memoryManager.listContacts()

  return { ollamaConnected, contacts, isFirstRun }
}


// ============================================================================
// IPC Handler Registration
// ============================================================================

/**
 * Registers all IPC handlers for the application
 * Should be called after app.whenReady()
 */
export function registerIpcHandlers(): void {
  initializeServices()

  // App initialization handler
  ipcMain.handle('app:initialize', handleAppInitialize)

  // Import handlers (import:*)
  ipcMain.handle('import:folder', handleImportFolder)
  ipcMain.handle('import:initializeMemory', handleImportInitializeMemory)
  ipcMain.handle('import:initializeMemoryFromPath', handleImportInitializeMemoryFromPath)
  ipcMain.handle('import:selectMemoryImportFilePath', handleSelectMemoryImportFilePath)
  ipcMain.handle('import:selectMemoryImportFolderPath', handleSelectMemoryImportFolderPath)
  ipcMain.handle('import:file', handleFileImport)
  ipcMain.handle('import:detectFormat', handleDetectFormat)

  // Monitor handlers (monitor:*)
  ipcMain.handle('monitor:start', handleMonitorStart)
  ipcMain.handle('monitor:stop', handleMonitorStop)
  ipcMain.handle('monitor:status', handleMonitorStatus)

  // Suggestions handlers (suggestions:*)
  ipcMain.handle('suggestions:generate', handleSuggestionsGenerate)

  // Profile handlers (profile:*)
  ipcMain.handle('profile:loadUser', handleLoadUserProfile)
  ipcMain.handle('profile:saveUser', handleSaveUserProfile)
  ipcMain.handle('profile:loadContact', handleLoadContactProfile)
  ipcMain.handle('profileAdmin:list', handleProfileAdminList)
  ipcMain.handle('profileAdmin:save', handleProfileAdminSave)
  ipcMain.handle('profileAdmin:delete', handleProfileAdminDelete)
  ipcMain.handle(
    'profileAdmin:backfillHistory',
    (_event, forceFullRebuild?: boolean, selectedSessionKeys?: string[]) =>
      handleProfileAdminBackfillHistory(forceFullRebuild ?? true, selectedSessionKeys)
  )
  ipcMain.handle('profileAdmin:listBackfillSessions', handleProfileAdminListBackfillSessions)
  ipcMain.handle('profileAdmin:getBackfillJobState', handleProfileAdminGetBackfillJobState)
  ipcMain.handle('profileAdmin:regenerateProfiles', handleProfileAdminRegenerateProfiles)
  ipcMain.handle('profileAdmin:clearProfiles', handleProfileAdminClearProfiles)
  ipcMain.handle('profileAdmin:listEpisodes', handleProfileAdminListEpisodes)
  ipcMain.handle('profileAdmin:listMemcells', handleProfileAdminListMemcells)
  ipcMain.handle('profileAdmin:listForesights', handleProfileAdminListForesights)
  ipcMain.handle('profileAdmin:updateBackfillProgress', handleProfileAdminUpdateBackfillProgress)
  ipcMain.handle('profileAdmin:markSessionDirty', handleProfileAdminMarkSessionDirty)

  // Settings handlers (settings:*)
  ipcMain.handle('settings:load', handleLoadSettings)
  ipcMain.handle('settings:save', handleSaveSettings)
  ipcMain.handle('settings:listModels', handleListModels)
  ipcMain.handle('settings:testConnection', handleTestConnection)
  ipcMain.handle('settings:completeOnboarding', handleCompleteOnboarding)

  // Contacts handlers
  ipcMain.handle('contacts:list', handleListContacts)

  // Ollama handlers
  ipcMain.handle('ollama:health', handleOllamaHealth)

  // Legacy chat handler (for backward compatibility)
  ipcMain.handle('chat:submit', handleChatSubmit)

  // Cold Start handlers (coldstart:*)
  ipcMain.handle('coldstart:execute', handleColdStartExecute)
  ipcMain.handle('coldstart:createDefaults', handleColdStartCreateDefaults)

  // Hot Run handlers (hotrun:*)
  ipcMain.handle('hotrun:start', handleHotRunStart)
  ipcMain.handle('hotrun:stop', handleHotRunStop)
  ipcMain.handle('hotrun:status', handleHotRunStatus)
  ipcMain.handle('hotrun:refresh', handleHotRunRefresh)
  ipcMain.handle('hotrun:updateSettings', handleHotRunUpdateSettings)

  // Chat records handlers (chatrecords:*)
  ipcMain.handle('chatrecords:ingestAndGetRecent', handleChatRecordsIngestAndGetRecent)
  ipcMain.handle('chatrecords:getRecentSessionMessages', handleChatRecordsGetRecentSessionMessages)

  // Memory file handlers (memoryfiles:*)
  ipcMain.handle('memoryfiles:getOverview', handleMemoryFilesGetOverview)
  ipcMain.handle('memoryfiles:getSection', handleMemoryFilesGetSection)
  ipcMain.handle('memoryfiles:readItem', handleMemoryFilesReadItem)
  ipcMain.handle('memoryfiles:deleteItem', handleMemoryFilesDeleteItem)
  ipcMain.handle('memoryfiles:markSessionDirty', handleMemoryFilesMarkSessionDirty)
}

/**
 * Unregisters all IPC handlers
 * Useful for cleanup during testing or app shutdown
 */
export function unregisterIpcHandlers(): void {
  // App handlers
  ipcMain.removeHandler('app:initialize')

  // Import handlers
  ipcMain.removeHandler('import:folder')
  ipcMain.removeHandler('import:initializeMemory')
  ipcMain.removeHandler('import:initializeMemoryFromPath')
  ipcMain.removeHandler('import:selectMemoryImportFilePath')
  ipcMain.removeHandler('import:selectMemoryImportFolderPath')
  ipcMain.removeHandler('import:file')
  ipcMain.removeHandler('import:detectFormat')

  // Monitor handlers
  ipcMain.removeHandler('monitor:start')
  ipcMain.removeHandler('monitor:stop')
  ipcMain.removeHandler('monitor:status')

  // Suggestions handlers
  ipcMain.removeHandler('suggestions:generate')

  // Profile handlers
  ipcMain.removeHandler('profile:loadUser')
  ipcMain.removeHandler('profile:saveUser')
  ipcMain.removeHandler('profile:loadContact')
  ipcMain.removeHandler('profileAdmin:list')
  ipcMain.removeHandler('profileAdmin:save')
  ipcMain.removeHandler('profileAdmin:delete')
  ipcMain.removeHandler('profileAdmin:backfillHistory')
  ipcMain.removeHandler('profileAdmin:listBackfillSessions')
  ipcMain.removeHandler('profileAdmin:getBackfillJobState')
  ipcMain.removeHandler('profileAdmin:regenerateProfiles')
  ipcMain.removeHandler('profileAdmin:clearProfiles')
  ipcMain.removeHandler('profileAdmin:listEpisodes')
  ipcMain.removeHandler('profileAdmin:listMemcells')
  ipcMain.removeHandler('profileAdmin:listForesights')
  ipcMain.removeHandler('profileAdmin:updateBackfillProgress')
  ipcMain.removeHandler('profileAdmin:markSessionDirty')

  // Settings handlers
  ipcMain.removeHandler('settings:load')
  ipcMain.removeHandler('settings:save')
  ipcMain.removeHandler('settings:completeOnboarding')

  // Contacts handlers
  ipcMain.removeHandler('contacts:list')

  // Ollama handlers
  ipcMain.removeHandler('ollama:health')

  // Legacy handlers
  ipcMain.removeHandler('chat:submit')

  // Cold Start handlers
  ipcMain.removeHandler('coldstart:execute')
  ipcMain.removeHandler('coldstart:createDefaults')

  // Hot Run handlers
  ipcMain.removeHandler('hotrun:start')
  ipcMain.removeHandler('hotrun:stop')
  ipcMain.removeHandler('hotrun:status')
  ipcMain.removeHandler('hotrun:refresh')
  ipcMain.removeHandler('hotrun:updateSettings')
  ipcMain.removeHandler('chatrecords:ingestAndGetRecent')
  ipcMain.removeHandler('chatrecords:getRecentSessionMessages')
  ipcMain.removeHandler('memoryfiles:getOverview')
  ipcMain.removeHandler('memoryfiles:getSection')
  ipcMain.removeHandler('memoryfiles:readItem')
  ipcMain.removeHandler('memoryfiles:deleteItem')
  ipcMain.removeHandler('memoryfiles:markSessionDirty')

  // Stop hot run service if running
  if (hotRunService) {
    hotRunService.stop()
  }

  // Cancel any pending profile updates
  if (orchestrator) {
    orchestrator.cancelAllPendingUpdates()
  }

  // Stop chat monitor if running
  if (chatMonitor) {
    chatMonitor.stopMonitoring()
  }
}

// ============================================================================
// App Initialization Handler
// ============================================================================

/**
 * Handles app:initialize IPC call
 * Initializes data directory, default profiles, and checks Ollama connectivity
 *
 * @returns Object with ollamaConnected status and contacts list
 * Validates: Requirements 4.1, 6.1
 */
async function handleAppInitialize(): Promise<{
  ollamaConnected: boolean
  contacts: string[]
}> {
  return initializeApplication()
}

// ============================================================================
// Chat Handlers
// ============================================================================

/**
 * Handles chat:submit IPC call
 * Processes chat logs through the orchestrator and returns suggestions
 *
 * @param _event - IPC event (unused)
 * @param logs - Array of chat log strings
 * @param contactId - The contact's unique identifier
 * @returns OrchestrationResult with suggestions and intent
 */
async function handleChatSubmit(
  _event: Electron.IpcMainInvokeEvent,
  logs: string[],
  contactId: string
): Promise<OrchestrationResult> {
  // Validate input
  if (!logs || !Array.isArray(logs) || logs.length === 0) {
    throw new Error('Chat logs cannot be empty')
  }
  if (!contactId || typeof contactId !== 'string') {
    throw new Error('Contact ID is required')
  }

  // Process through orchestrator (Hot Path)
  const result = await orchestrator.processChatLogs(logs, contactId)

  // Schedule profile update (Cold Path - 10s debounce)
  orchestrator.scheduleProfileUpdate(logs, contactId)

  return result
}

// ============================================================================
// Profile Handlers
// ============================================================================

/**
 * Handles profile:loadUser IPC call
 * Loads the user profile from disk
 *
 * @returns UserProfile
 */
async function handleLoadUserProfile(): Promise<UnifiedProfile> {
  const settings = await memoryManager.loadSettings()
  const ownerUserId = settings.evermemos.ownerUserId?.trim()

  if (!settings.evermemos.enabled || !ownerUserId) {
    return memoryManager.loadUnifiedUserProfile()
  }

  if (
    cachedUserProfile &&
    cachedUserProfile.ownerUserId === ownerUserId &&
    Date.now() - cachedUserProfile.fetchedAt < PROFILE_CACHE_TTL_MS
  ) {
    return cachedUserProfile.profile
  }

  try {
    const response = await fetchEverMemOSJson<{ success: boolean; data?: UnifiedProfile[] }>(
      settings,
      `/api/v1/copilot/profiles?owner_user_id=${encodeURIComponent(ownerUserId)}&profile_type=user&limit=1`
    )
    const remoteProfile = Array.isArray(response.data) ? response.data[0] : null
    if (remoteProfile) {
      const normalized = normalizeSelfProfileDisplayName(remoteProfile, ownerUserId)
      cachedUserProfile = { ownerUserId, profile: normalized, fetchedAt: Date.now() }
      return normalized
    }
  } catch {
    // Fall back to local cache when backend is unavailable.
  }

  const localProfile = await memoryManager.loadUnifiedUserProfile()
  const normalizedLocal = normalizeSelfProfileDisplayName(localProfile, ownerUserId)
  cachedUserProfile = { ownerUserId, profile: normalizedLocal, fetchedAt: Date.now() }
  return normalizedLocal
}

/**
 * Handles profile:saveUser IPC call
 * Saves the user profile to disk
 *
 * @param _event - IPC event (unused)
 * @param profile - UserProfile to save
 */
async function handleSaveUserProfile(
  _event: Electron.IpcMainInvokeEvent,
  profile: UnifiedProfile
): Promise<void> {
  await memoryManager.saveUnifiedUserProfile(profile)
  invalidateProfileCaches(profile.owner_user_id)
}

/**
 * Handles profile:loadContact IPC call
 * Loads a contact profile from disk
 *
 * @param _event - IPC event (unused)
 * @param contactId - The contact's unique identifier
 * @returns ContactProfile or null if not found
 */
async function handleLoadContactProfile(
  _event: Electron.IpcMainInvokeEvent,
  contactId: string
): Promise<UnifiedProfile | null> {
  if (!contactId || typeof contactId !== 'string') {
    throw new Error('Contact ID is required')
  }

  const normalizedContactId = normalizeLookupText(contactId) ?? contactId.trim()
  const settings = await memoryManager.loadSettings()
  const ownerUserId = settings.evermemos.ownerUserId?.trim()
  const cacheKey = ownerUserId ? `${ownerUserId}::${normalizedContactId}` : normalizedContactId
  const cached = cachedContactProfiles.get(cacheKey)

  if (cached && Date.now() - cached.fetchedAt < PROFILE_CACHE_TTL_MS) {
    return cached.profile
  }

  if (settings.evermemos.enabled && ownerUserId) {
    try {
      const response = await fetchEverMemOSJson<{ success: boolean; data?: UnifiedProfile[] }>(
        settings,
        `/api/v1/copilot/profiles?owner_user_id=${encodeURIComponent(ownerUserId)}&profile_type=contact&limit=500`
      )
      const profiles = Array.isArray(response.data) ? response.data : []

      const matchedProfile = profiles.find((profile) => {
        const candidates = [
          profile.profile_id,
          profile.target_user_id,
          profile.conversation_id,
          profile.display_name,
          ...(profile.aliases ?? [])
        ]
        return candidates.some((candidate) => {
          const normalizedCandidate = normalizeLookupText(candidate)
          return normalizedCandidate === normalizedContactId
        })
      })

      if (matchedProfile) {
        cachedContactProfiles.set(cacheKey, { profile: matchedProfile, fetchedAt: Date.now() })
        return matchedProfile
      }
    } catch {
      // Fall back to local cache when backend is unavailable.
    }
  }

  const localProfile = await memoryManager.loadUnifiedContactProfile(contactId)
  cachedContactProfiles.set(cacheKey, { profile: localProfile, fetchedAt: Date.now() })
  return localProfile
}

function invalidateProfileCaches(ownerUserId?: string | null, contactKey?: string | null): void {
  const normalizedOwnerUserId = normalizeLookupText(ownerUserId)
  if (normalizedOwnerUserId && cachedUserProfile?.ownerUserId === normalizedOwnerUserId) {
    cachedUserProfile = null
  }

  // Clear profile list cache when profiles change
  if (cachedProfileList && (!normalizedOwnerUserId || cachedProfileList.ownerUserId === normalizedOwnerUserId)) {
    cachedProfileList = null
  }

  if (!normalizedOwnerUserId && !contactKey) {
    cachedUserProfile = null
    cachedContactProfiles.clear()
    cachedProfileList = null
    return
  }

  if (normalizedOwnerUserId && !contactKey) {
    for (const key of Array.from(cachedContactProfiles.keys())) {
      if (key.startsWith(`${normalizedOwnerUserId}::`)) {
        cachedContactProfiles.delete(key)
      }
    }
    return
  }

  const normalizedContactKey = normalizeLookupText(contactKey)
  if (!normalizedContactKey) {
    return
  }

  if (normalizedOwnerUserId) {
    cachedContactProfiles.delete(`${normalizedOwnerUserId}::${normalizedContactKey}`)
    return
  }

  for (const key of Array.from(cachedContactProfiles.keys())) {
    const [, cachedContactKey = key] = key.split('::', 2)
    if (cachedContactKey === normalizedContactKey || key === normalizedContactKey) {
      cachedContactProfiles.delete(key)
    }
  }
}

// ============================================================================
// Contacts Handlers
// ============================================================================

/**
 * Handles contacts:list IPC call
 * Lists all contact IDs from the contacts directory
 *
 * @returns Array of contact IDs
 */
async function handleListContacts(): Promise<string[]> {
  return memoryManager.listContacts()
}

// ============================================================================
// Ollama Handlers
// ============================================================================

/**
 * Handles ollama:health IPC call
 * Checks if Ollama service is available
 *
 * @returns true if Ollama is healthy, false otherwise
 */
async function handleOllamaHealth(): Promise<boolean> {
  return ollamaClient.checkHealth()
}

// ============================================================================
// File Handlers
// ============================================================================

/**
 * Handles file:import IPC call
 * Opens a file dialog and reads the selected .txt file
 *
 * @param event - IPC event (used to get the sender window)
 * @returns File content as string, or null if cancelled
 */
async function handleFileImport(
  event: Electron.IpcMainInvokeEvent
): Promise<string | null> {
  const window = BrowserWindow.fromWebContents(event.sender)

  const result = await dialog.showOpenDialog(window!, {
    title: 'Import Chat Log',
    filters: [
      { name: 'Text Files', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  const filePath = result.filePaths[0]
  const content = await readFile(filePath, 'utf-8')

  // Validate content is not empty
  if (ChatParser.isWhitespaceOnly(content)) {
    throw new Error('Selected file is empty or contains only whitespace')
  }

  return content
}

// ============================================================================
// Import Handlers (import:*)
// ============================================================================

/**
 * Handles import:folder IPC call
 * Opens a folder dialog and imports data from the selected folder
 *
 * @param event - IPC event (used to get the sender window)
 * @returns DataImportResult with messages and metadata, or null if cancelled
 */
async function handleImportFolder(
  event: Electron.IpcMainInvokeEvent
): Promise<DataImportResult | null> {
  const window = BrowserWindow.fromWebContents(event.sender)

  const result = await dialog.showOpenDialog(window!, {
    title: 'Import Chat Data Folder',
    properties: ['openDirectory']
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  const folderPath = result.filePaths[0]
  return dataImporter.importData(folderPath)
}

async function handleImportInitializeMemory(
  event: Electron.IpcMainInvokeEvent
): Promise<ImportInitializeMemoryResult | null> {
  const window = BrowserWindow.fromWebContents(event.sender)

  const dialogResult = await dialog.showOpenDialog(window!, {
    title: '选择历史微信聊天导出目录',
    properties: ['openDirectory'],
    message: '请选择联系人/群聊聊天记录文件夹'
  })

  if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
    return null
  }

  return handleImportInitializeMemoryFromPath(event, dialogResult.filePaths[0], window)
}

async function handleImportInitializeMemoryFromPath(
  _event: Electron.IpcMainInvokeEvent,
  inputPath: string,
  windowOverride?: BrowserWindow | null
): Promise<ImportInitializeMemoryResult> {
  if (!inputPath || typeof inputPath !== 'string' || inputPath.trim().length === 0) {
    throw new Error('Import path is required')
  }

  return runImportInitializationFromPath(inputPath.trim(), windowOverride ?? null)
}

async function handleSelectMemoryImportFilePath(
  event: Electron.IpcMainInvokeEvent
): Promise<string | null> {
  const window = BrowserWindow.fromWebContents(event.sender)
  const dialogResult = await dialog.showOpenDialog(window!, {
    title: '选择历史聊天 CSV 或 SQLite 文件',
    properties: ['openFile'],
    filters: [
      { name: '聊天导出文件', extensions: ['csv', 'db', 'sqlite', 'sqlite3'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  })

  if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
    return null
  }

  return dialogResult.filePaths[0]
}

async function handleSelectMemoryImportFolderPath(
  event: Electron.IpcMainInvokeEvent
): Promise<string | null> {
  const window = BrowserWindow.fromWebContents(event.sender)
  const dialogResult = await dialog.showOpenDialog(window!, {
    title: '选择历史聊天导出目录',
    properties: ['openDirectory']
  })

  if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
    return null
  }

  return dialogResult.filePaths[0]
}

async function runImportInitializationFromPath(
  inputPath: string,
  windowOverride: BrowserWindow | null
): Promise<ImportInitializeMemoryResult> {
  const settings = await memoryManager.loadSettings()
  return executeImportAndInitializeMemory({
    folderPath: inputPath,
    ownerUserId: settings.evermemos.ownerUserId,
    ownerDisplayName: getOwnerDisplayName(settings),
    recordsDir: settings.storagePaths.chatRecordsDir,
    maintenanceOptions: getChatRecordMaintenanceOptions(settings),
    importData: (folderPath, ownerUserId, ownerDisplayName) =>
      dataImporter.importData(folderPath, ownerUserId, ownerDisplayName),
    ingestChatRecords: (recordsDir, events, ownerUserId, ownerDisplayName, limit, options) =>
      ingestChatRecordsAndGetRecent(
        recordsDir,
        events,
        ownerUserId,
        ownerDisplayName,
        limit,
        options
      ),
    backfillHistory: () => handleProfileAdminBackfillHistory(),
    onProgress: (progress: ImportInitializeMemoryProgress) => {
      if (windowOverride && !windowOverride.isDestroyed()) {
        windowOverride.webContents.send('import:initializeMemoryProgress', progress)
      }
    }
  })
}

/**
 * Handles import:detectFormat IPC call
 * Detects the data format of a given folder path
 *
 * @param _event - IPC event (unused)
 * @param folderPath - Path to the data folder
 * @returns DataFormat string
 */
async function handleDetectFormat(
  _event: Electron.IpcMainInvokeEvent,
  folderPath: string
): Promise<DataFormat> {
  if (!folderPath || typeof folderPath !== 'string') {
    throw new Error('Folder path is required')
  }
  return dataImporter.detectFormat(folderPath)
}

// ============================================================================
// Monitor Handlers (monitor:*)
// ============================================================================

/**
 * Handles monitor:start IPC call
 * Initializes and starts the chat monitor
 *
 * @returns ChatMonitorStatus after starting
 */
async function handleMonitorStart(): Promise<ChatMonitorStatus> {
  const status = await chatMonitor.initialize()
  if (process.platform !== 'darwin') {
    return {
      ...status,
      isMonitoring: false,
      errorMessage: LEGACY_CHAT_MONITOR_UNAVAILABLE_MESSAGE
    }
  }
  if (status.mode === 'unavailable') {
    return status
  }
  chatMonitor.startMonitoring()
  return chatMonitor.getStatus()
}

/**
 * Handles monitor:stop IPC call
 * Stops the chat monitor
 *
 * @returns ChatMonitorStatus after stopping
 */
async function handleMonitorStop(): Promise<ChatMonitorStatus> {
  chatMonitor.stopMonitoring()
  return chatMonitor.getStatus()
}

/**
 * Handles monitor:status IPC call
 * Gets the current status of the chat monitor
 *
 * @returns ChatMonitorStatus
 */
async function handleMonitorStatus(): Promise<ChatMonitorStatus> {
  return chatMonitor.getStatus()
}

// ============================================================================
// Suggestions Handlers (suggestions:*)
// ============================================================================

/**
 * Handles suggestions:generate IPC call
 * Generates reply suggestions for the given chat logs
 *
 * @param _event - IPC event (unused)
 * @param logs - Array of chat log strings
 * @param contactId - The contact's unique identifier
 * @returns OrchestrationResult with suggestions and intent
 */
async function handleSuggestionsGenerate(
  _event: Electron.IpcMainInvokeEvent,
  logs: string[],
  contactId: string
): Promise<OrchestrationResult> {
  // Validate input
  if (!logs || !Array.isArray(logs) || logs.length === 0) {
    throw new Error('Chat logs cannot be empty')
  }
  if (!contactId || typeof contactId !== 'string') {
    throw new Error('Contact ID is required')
  }

  // Process through orchestrator (Hot Path)
  return orchestrator.processChatLogs(logs, contactId)
}

function normalizeSelfProfileDisplayName(
  profile: UnifiedProfile,
  _ownerUserId: string
): UnifiedProfile {
  if (profile.profile_type !== 'user') {
    return profile
  }
  if (profile.display_name === 'Me') {
    return profile
  }
  return {
    ...profile,
    display_name: 'Me'
  }
}

async function handleProfileAdminList(): Promise<UnifiedProfile[]> {
  const settings = await memoryManager.loadSettings()
  const ownerUserId = settings.evermemos.ownerUserId

  // Return cached list if no dirty sessions and cache is fresh
  if (
    cachedProfileList &&
    cachedProfileList.ownerUserId === ownerUserId &&
    dirtySessionKeys.size === 0 &&
    Date.now() - cachedProfileList.fetchedAt < PROFILE_CACHE_TTL_MS
  ) {
    return cachedProfileList.profiles
  }

  // Fetch from backend
  const response = await fetchEverMemOSJson<{ success: boolean; data?: UnifiedProfile[] }>(
    settings,
    `/api/v1/copilot/profiles?owner_user_id=${encodeURIComponent(ownerUserId)}&profile_type=all&limit=200`
  )
  const profiles = Array.isArray(response.data)
    ? response.data.map((profile) => normalizeSelfProfileDisplayName(profile, ownerUserId))
    : []

  // Update cache and clear dirty flags
  cachedProfileList = { ownerUserId, profiles, fetchedAt: Date.now() }
  dirtySessionKeys.clear()

  return profiles
}

async function handleProfileAdminSave(
  _event: Electron.IpcMainInvokeEvent,
  profile: UnifiedProfile
): Promise<UnifiedProfile> {
  const settings = await memoryManager.loadSettings()
  const normalizedProfile = normalizeSelfProfileDisplayName(profile, settings.evermemos.ownerUserId)
  const response = await fetchEverMemOSJson<{ success: boolean; data?: UnifiedProfile }>(
    settings,
    `/api/v1/copilot/profiles/${encodeURIComponent(normalizedProfile.profile_id)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ profile: normalizedProfile })
    }
  )
  if (!response.data) {
    throw new Error('evermemos_profile_save_failed')
  }
  return normalizeSelfProfileDisplayName(response.data, settings.evermemos.ownerUserId)
}

async function handleProfileAdminDelete(
  _event: Electron.IpcMainInvokeEvent,
  profileId: string
): Promise<void> {
  if (!profileId || typeof profileId !== 'string') {
    throw new Error('Profile ID is required')
  }
  const settings = await memoryManager.loadSettings()
  const response = await fetchEverMemOSJson<{
    success: boolean
    profile_type?: string | null
    owner_user_id?: string | null
    target_user_id?: string | null
    conversation_id?: string | null
    display_name?: string | null
    aliases?: string[]
  }>(
    settings,
    `/api/v1/copilot/profiles/${encodeURIComponent(profileId)}`,
    { method: 'DELETE' }
  )

  if (response.profile_type === 'contact') {
    await memoryManager.deleteUnifiedContactProfilesByIdentity({
      profile_id: profileId,
      target_user_id: response.target_user_id ?? null,
      conversation_id: response.conversation_id ?? null,
      display_name: response.display_name ?? null,
      aliases: response.aliases ?? []
    })
    if (response.conversation_id?.trim()) {
      await deleteStoredChatRecordSession(
        settings.storagePaths.chatRecordsDir,
        response.conversation_id.trim()
      )
    }

    // Add to blacklist to prevent auto-recreation on next sync
    const normalizedConversationId = normalizeLookupText(response.conversation_id)
    if (normalizedConversationId) {
      const currentBlacklist = settings.evermemos.deletedProfileSessionKeys ?? []
      if (!currentBlacklist.includes(normalizedConversationId)) {
        settings.evermemos.deletedProfileSessionKeys = [...currentBlacklist, normalizedConversationId]
        await memoryManager.saveSettings(settings)
      }
    }
  }

  invalidateProfileCaches(response.owner_user_id ?? settings.evermemos.ownerUserId)
}

async function handleProfileAdminListBackfillSessions(): Promise<BackfillSessionSummary[]> {
  const settings = await memoryManager.loadSettings()
  const ownerUserId = settings.evermemos.ownerUserId
  await ensureStoredChatRecordsRepaired(settings)
  const sessions = await loadStoredChatRecordSessions(
    settings.storagePaths.chatRecordsDir,
    ownerUserId,
    0,
    getChatRecordMaintenanceOptions(settings)
  )

  const deletedSessionKeys = new Set(
    (settings.evermemos.deletedProfileSessionKeys ?? [])
      .map((key) => normalizeLookupText(key))
      .filter((value): value is string => Boolean(value))
  )
  const sessionBackfillProgress = settings.evermemos.sessionBackfillProgress ?? {}

  return sessions.map((session) =>
    summarizeBackfillSession(session, {
      forceFullRebuild: false,
      deletedSessionKeys,
      sessionBackfillProgress
    })
  )
}

async function handleProfileAdminGetBackfillJobState(): Promise<ProfileBackfillJobState> {
  return {
    ...activeProfileBackfillJobState,
    selectedSessionKeys: [...activeProfileBackfillJobState.selectedSessionKeys],
    result: activeProfileBackfillJobState.result
      ? {
        ...activeProfileBackfillJobState.result,
        failedSessionNames: [...activeProfileBackfillJobState.result.failedSessionNames],
        failedReasons: [...activeProfileBackfillJobState.result.failedReasons]
      }
      : null
  }
}

async function handleProfileAdminBackfillHistory(
  forceFullRebuild = true,
  selectedSessionKeys?: string[]
): Promise<ProfileBackfillResult> {
  const settings = await memoryManager.loadSettings()
  const ownerUserId = settings.evermemos.ownerUserId
  const backfillChunkSize = getProfileBackfillChunkSize(settings)
  await ensureStoredChatRecordsRepaired(settings)
  const allSessions = await loadStoredChatRecordSessions(
    settings.storagePaths.chatRecordsDir,
    ownerUserId,
    0,
    getChatRecordMaintenanceOptions(settings)
  )
  const normalizedSelectedSessionKeys = new Set(
    (selectedSessionKeys ?? [])
      .map((key) => normalizeLookupText(key))
      .filter((value): value is string => Boolean(value))
  )
  const sessions = normalizedSelectedSessionKeys.size > 0
    ? allSessions.filter((session) => normalizedSelectedSessionKeys.has(normalizeLookupText(session.sessionKey)))
    : allSessions

  const result: ProfileBackfillResult = {
    scannedSessions: sessions.length,
    processedSessions: 0,
    skippedSessions: 0,
    failedSessions: 0,
    updatedProfiles: 0,
    failedSessionNames: [],
    failedReasons: []
  }

  const updatedProgress: Record<string, string> = {}
  const deletedSessionKeys = new Set(
    (settings.evermemos.deletedProfileSessionKeys ?? [])
      .map((key) => normalizeLookupText(key))
      .filter((value): value is string => Boolean(value))
  )
  const sessionBackfillProgress = settings.evermemos.sessionBackfillProgress ?? {}
  const selectedKeysForState = sessions.map((session) => session.sessionKey)
  const pendingChunkCount = sessions.reduce((sum, session) => {
    const messages = selectBackfillMessages(session, {
      forceFullRebuild,
      deletedSessionKeys,
      sessionBackfillProgress
    }).filter((message) => shouldBackfillMessage(message))
    return sum + chunkBackfillMessages(messages, backfillChunkSize).length
  }, 0)

  activeProfileBackfillJobState = {
    active: true,
    phase: 'running',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    forceFullRebuild,
    selectedSessionKeys: selectedKeysForState,
    scannedSessions: sessions.length,
    completedSessions: 0,
    totalChunks: pendingChunkCount,
    completedChunks: 0,
    currentSessionName: sessions[0]?.sessionName ?? null,
    result: null,
    error: null
  }

  for (const session of sessions) {
    const normalizedSessionKey = normalizeLookupText(session.sessionKey)
    const messages = selectBackfillMessages(session, {
      forceFullRebuild,
      deletedSessionKeys,
      sessionBackfillProgress
    }).filter((message) => shouldBackfillMessage(message))

    if (messages.length === 0) {
      result.skippedSessions += 1
      activeProfileBackfillJobState = {
        ...activeProfileBackfillJobState,
        completedSessions: activeProfileBackfillJobState.completedSessions + 1,
        currentSessionName: session.sessionName,
        updatedAt: new Date().toISOString()
      }
      continue
    }

    const displayName = deriveBackfillDisplayName(session, messages)
    const chunks = chunkBackfillMessages(messages, backfillChunkSize)
    let sessionUpdatedProfile = false

    try {
      try {
        await resetEverMemOSConversationRuntimeState(settings, session.sessionKey)
      } catch (resetError) {
        console.warn(
          `[profile-backfill] failed to reset runtime state for ${session.sessionKey}:`,
          resetError
        )
      }

      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        const chunk = chunks[chunkIndex]
        const outboundMessages = chunk.map((message) => sanitizeBackfillMessage(message))
        const isFinalChunk = chunkIndex === chunks.length - 1
        const chunkTimeoutMs = computeBackfillChunkTimeoutMs(
          settings.evermemos.requestTimeoutMs,
          outboundMessages.length,
          settings.evermemos.backfillChunkMessageBudgetSeconds
        )
        let response: {
          success?: boolean
          is_new_friend?: boolean
          profile_updated?: boolean
          contact_profile?: UnifiedProfile | null
        }
        try {
          response = await fetchEverMemOSJson<{
            success?: boolean
            is_new_friend?: boolean
            profile_updated?: boolean
            contact_profile?: UnifiedProfile | null
          }>(
            settings,
            '/api/v1/copilot/process-chat',
            {
              method: 'POST',
              body: JSON.stringify({
                owner_user_id: settings.evermemos.ownerUserId,
                session_key: session.sessionKey,
                display_name: displayName,
                messages: outboundMessages,
                incoming_message: null,
                force_profile_update: isFinalChunk,
                force_memory_backfill: true,
                is_historical_import: true
              })
            },
            chunkTimeoutMs
          )
        } catch (error) {
          const rawMessage = error instanceof Error ? error.message : String(error)
          const isAbortError =
            (error instanceof Error && error.name === 'AbortError') ||
            rawMessage.toLowerCase().includes('aborted')
          const detail = isAbortError
            ? `chunk ${chunkIndex + 1}/${chunks.length} (${outboundMessages.length} 条) 超时，中止于 ${Math.round(chunkTimeoutMs / 1000)}s`
            : `chunk ${chunkIndex + 1}/${chunks.length} (${outboundMessages.length} 条) 失败: ${rawMessage}`
          throw new Error(detail)
        }
        if (isFinalChunk && (response.is_new_friend || response.profile_updated || response.contact_profile)) {
          sessionUpdatedProfile = true
        }
        if (normalizedSessionKey) {
          const latestChunkTimestamp = outboundMessages
            .map((message) => message.timestamp)
            .filter((timestamp): timestamp is string => Boolean(timestamp))
            .sort()
            .pop()
          if (latestChunkTimestamp) {
            updatedProgress[normalizedSessionKey] = latestChunkTimestamp
            settings.evermemos.sessionBackfillProgress = {
              ...mergeBackfillProgress(settings.evermemos.sessionBackfillProgress ?? {}, {
                [normalizedSessionKey]: latestChunkTimestamp
              })
            }
            sessionBackfillProgress[normalizedSessionKey] = latestChunkTimestamp
            await memoryManager.saveSettings(settings)
          }
        }
        activeProfileBackfillJobState = {
          ...activeProfileBackfillJobState,
          currentSessionName: session.sessionName,
          completedChunks: activeProfileBackfillJobState.completedChunks + 1,
          updatedAt: new Date().toISOString()
        }
      }

      result.processedSessions += 1
      if (sessionUpdatedProfile) {
        result.updatedProfiles += 1
      }
      if (normalizedSessionKey) {
        const latestTimestamp = messages
          .map((m) => m.timestamp)
          .filter((t): t is string => Boolean(t))
          .sort()
          .pop()
        if (latestTimestamp) {
          updatedProgress[normalizedSessionKey] = latestTimestamp
        }
      }
      activeProfileBackfillJobState = {
        ...activeProfileBackfillJobState,
        completedSessions: activeProfileBackfillJobState.completedSessions + 1,
        currentSessionName: session.sessionName,
        updatedAt: new Date().toISOString()
      }
    } catch (error) {
      result.failedSessions += 1
      result.failedSessionNames.push(session.sessionName)
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (result.failedReasons.length < 5) {
        result.failedReasons.push(`${session.sessionName}: ${errorMessage}`)
      }
      activeProfileBackfillJobState = {
        ...activeProfileBackfillJobState,
        completedSessions: activeProfileBackfillJobState.completedSessions + 1,
        currentSessionName: session.sessionName,
        updatedAt: new Date().toISOString(),
        error: errorMessage
      }
    }
  }

  // Save updated progress to settings
  if (Object.keys(updatedProgress).length > 0) {
    settings.evermemos.sessionBackfillProgress = {
      ...mergeBackfillProgress(settings.evermemos.sessionBackfillProgress ?? {}, updatedProgress)
    }
    await memoryManager.saveSettings(settings)
  }

  activeProfileBackfillJobState = {
    ...activeProfileBackfillJobState,
    active: false,
    phase: result.failedSessions > 0 ? 'failed' : 'complete',
    updatedAt: new Date().toISOString(),
    currentSessionName: null,
    result,
    error: result.failedReasons[0] ?? null
  }

  return result
}

async function handleProfileAdminRegenerateProfiles(): Promise<RegenerateProfilesResult> {
  const settings = await memoryManager.loadSettings()
  const ownerUserId = settings.evermemos.ownerUserId

  // Use 5 minute timeout for regenerate operation (LLM calls are slow)
  const response = await fetchEverMemOSJson<RegenerateProfilesResult>(
    settings,
    '/api/v1/copilot/profiles/regenerate',
    {
      method: 'POST',
      body: JSON.stringify({ owner_user_id: ownerUserId }),
    },
    5 * 60 * 1000 // 5 minutes
  )

  return response
}

async function handleProfileAdminClearProfiles(): Promise<ClearProfilesResult> {
  const settings = await memoryManager.loadSettings()
  const ownerUserId = settings.evermemos.ownerUserId

  const response = await fetchEverMemOSJson<ClearProfilesResult>(
    settings,
    '/api/v1/copilot/profiles/clear',
    {
      method: 'POST',
      body: JSON.stringify({ owner_user_id: ownerUserId }),
    }
  )

  return response
}

async function handleProfileAdminListEpisodes(): Promise<EpisodicMemoryItem[]> {
  const settings = await memoryManager.loadSettings()
  const response = await fetchEverMemOSJson<{ success: boolean; data?: EpisodicMemoryItem[] }>(
    settings,
    `/api/v1/copilot/episodes?owner_user_id=${encodeURIComponent(settings.evermemos.ownerUserId)}&limit=120`
  )
  return Array.isArray(response.data) ? response.data : []
}

async function handleProfileAdminListMemcells(): Promise<MemCellItem[]> {
  const settings = await memoryManager.loadSettings()
  const response = await fetchEverMemOSJson<{ success: boolean; data?: MemCellItem[] }>(
    settings,
    `/api/v1/copilot/memcells?owner_user_id=${encodeURIComponent(settings.evermemos.ownerUserId)}&limit=160`
  )
  return Array.isArray(response.data) ? response.data : []
}

async function handleProfileAdminListForesights(): Promise<ForesightItem[]> {
  const settings = await memoryManager.loadSettings()
  const response = await fetchEverMemOSJson<{ success: boolean; data?: ForesightItem[] }>(
    settings,
    `/api/v1/copilot/foresights?owner_user_id=${encodeURIComponent(settings.evermemos.ownerUserId)}&limit=120`
  )
  return Array.isArray(response.data) ? response.data : []
}

async function handleProfileAdminUpdateBackfillProgress(
  _event: Electron.IpcMainInvokeEvent,
  sessionKey: string,
  lastProcessedTimestamp: string
): Promise<void> {
  if (!sessionKey || typeof sessionKey !== 'string') {
    return
  }
  if (!lastProcessedTimestamp || typeof lastProcessedTimestamp !== 'string') {
    return
  }

  const normalizedSessionKey = normalizeLookupText(sessionKey)
  if (!normalizedSessionKey) {
    return
  }

  const settings = await memoryManager.loadSettings()
  const currentProgress = settings.evermemos.sessionBackfillProgress ?? {}

  // Only update if the new timestamp is newer
  const existingTimestamp = currentProgress[normalizedSessionKey]
  if (existingTimestamp && lastProcessedTimestamp <= existingTimestamp) {
    return
  }

  settings.evermemos.sessionBackfillProgress = {
    ...currentProgress,
    [normalizedSessionKey]: lastProcessedTimestamp
  }
  await memoryManager.saveSettings(settings)

  // Mark session as dirty so profile list will be refreshed
  dirtySessionKeys.add(normalizedSessionKey)
}

async function handleProfileAdminMarkSessionDirty(
  _event: Electron.IpcMainInvokeEvent,
  sessionKey: string
): Promise<void> {
  if (!sessionKey || typeof sessionKey !== 'string') {
    return
  }
  const normalizedSessionKey = normalizeLookupText(sessionKey)
  if (normalizedSessionKey) {
    dirtySessionKeys.add(normalizedSessionKey)
  }
}

// ============================================================================
// Settings Handlers (settings:*)
// ============================================================================

/**
 * Handles settings:load IPC call
 * Loads application settings from disk
 *
 * @returns AppSettings
 */
async function handleLoadSettings(): Promise<AppSettings> {
  return memoryManager.loadSettings()
}

/**
 * Handles settings:save IPC call
 * Saves application settings to disk
 *
 * @param _event - IPC event (unused)
 * @param settings - AppSettings to save
 */
async function handleSaveSettings(
  _event: Electron.IpcMainInvokeEvent,
  settings: AppSettings
): Promise<void> {
  // Check if ownerUserId changed - clear all caches if so
  const currentSettings = await memoryManager.loadSettings()
  if (currentSettings.evermemos.ownerUserId !== settings.evermemos.ownerUserId) {
    cachedProfileList = null
    cachedUserProfile = null
    cachedContactProfiles.clear()
    cachedMemorySections = null
    lastChatRecordRepairOwner = null // Reset repair cache to trigger owner_user_id migration
    dirtySessionKeys.clear()
    dirtyMemorySessions.clear()
  }

  await memoryManager.saveSettings(settings)
  await ensureStorageDirectories(settings)
  await hotRunService.updateSettings(settings)
  await syncSettingsToVisualMonitorBackend(settings)
  await syncSettingsToEverMemOSBackend(settings)
}

async function handleListModels(
  _event: Electron.IpcMainInvokeEvent,
  baseUrl: string,
  apiKey: string = ''
): Promise<string[]> {
  return listProviderModels(fetch as typeof globalThis.fetch, baseUrl, apiKey)
}

async function handleTestConnection(
  _event: Electron.IpcMainInvokeEvent,
  baseUrl: string,
  apiKey: string = '',
  model: string = ''
): Promise<string> {
  return probeProviderConnection(fetch as typeof globalThis.fetch, baseUrl, apiKey, model)
}

/**
 * Handles settings:completeOnboarding IPC call
 * Marks onboarding as complete in settings
 * Validates: Requirement 1.1
 */
async function handleCompleteOnboarding(): Promise<void> {
  const settings = await memoryManager.loadSettings()
  settings.onboardingComplete = true
  await memoryManager.saveSettings(settings)
}

// ============================================================================
// Exports for Testing
// ============================================================================

/**
 * Gets the memory manager instance (for testing)
 */
export function getMemoryManager(): MemoryManager {
  return memoryManager
}

/**
 * Gets the ollama client instance (for testing)
 */
export function getOllamaClient(): OllamaClient {
  return ollamaClient
}

/**
 * Gets the orchestrator instance (for testing)
 */
export function getOrchestrator(): AgentOrchestrator {
  return orchestrator
}

/**
 * Gets the data importer instance (for testing)
 */
export function getDataImporter(): DataImporter {
  return dataImporter
}

/**
 * Gets the chat monitor instance (for testing)
 */
export function getChatMonitor(): ChatMonitorService {
  return chatMonitor
}

/**
 * Gets the cold start service instance (for testing)
 */
export function getColdStartService(): ColdStartService {
  return coldStartService
}

// ============================================================================
// Cold Start Handlers (coldstart:*)
// ============================================================================

/**
 * Handles coldstart:execute IPC call
 * Executes the complete cold start flow: Import -> Clean -> Profile -> Save
 *
 * @param event - IPC event (used to get the sender window for dialog)
 * @returns ColdStartResult with generated profiles and statistics
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
 */
async function handleColdStartExecute(
  event: Electron.IpcMainInvokeEvent
): Promise<ColdStartResult> {
  const window = BrowserWindow.fromWebContents(event.sender)

  // Open folder picker dialog
  const dialogResult = await dialog.showOpenDialog(window!, {
    title: '选择聊天数据文件夹',
    properties: ['openDirectory'],
    message: '请选择联系人/群聊聊天记录文件夹'
  })

  if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
    return {
      success: false,
      userProfile: null,
      contactProfiles: new Map(),
      messageCount: 0,
      contactCount: 0,
      errors: ['用户取消了文件夹选择']
    }
  }

  const folderPath = dialogResult.filePaths[0]

  // Execute cold start flow
  const result = await coldStartService.execute(folderPath, 'self', (progress: ColdStartProgress) => {
    // Send progress updates to renderer
    if (window && !window.isDestroyed()) {
      window.webContents.send('coldstart:progress', progress)
    }
  })

  return result
}

/**
 * Handles coldstart:createDefaults IPC call
 * Creates minimal default profiles for users who skip import
 *
 * @returns ColdStartResult with default profiles
 * Validates: Requirement 1.8
 */
async function handleColdStartCreateDefaults(): Promise<ColdStartResult> {
  return coldStartService.createDefaultProfiles()
}


// ============================================================================
// Hot Run Handlers (hotrun:*)
// ============================================================================

/**
 * Handles hotrun:start IPC call
 * Starts the hot run service for real-time monitoring
 *
 * @param event - IPC event (used to set up event forwarding)
 * @returns HotRunStatus after starting
 * Validates: Requirements 3.5, 4.1, 5.1, 6.1
 */
async function handleHotRunStart(
  event: Electron.IpcMainInvokeEvent
): Promise<HotRunStatus> {
  const window = BrowserWindow.fromWebContents(event.sender)

  // Set up event forwarding to renderer
  hotRunService.onSuggestions((update: SuggestionUpdate) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send('hotrun:suggestions', update)
    }
  })

  hotRunService.onContactChanged((contactId: string, profile) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send('hotrun:contactChanged', { contactId, profile })
    }
  })

  hotRunService.onStatusChanged((status: HotRunStatus) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send('hotrun:statusChanged', status)
    }
  })

  hotRunService.onError((error: Error) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send('hotrun:error', { message: error.message })
    }
  })

  return hotRunService.start()
}

/**
 * Handles hotrun:stop IPC call
 * Stops the hot run service
 *
 * @returns HotRunStatus after stopping
 */
async function handleHotRunStop(): Promise<HotRunStatus> {
  return hotRunService.stop()
}

/**
 * Handles hotrun:status IPC call
 * Gets the current status of the hot run service
 *
 * @returns HotRunStatus
 */
async function handleHotRunStatus(): Promise<HotRunStatus> {
  return hotRunService.getStatus()
}

/**
 * Handles hotrun:refresh IPC call
 * Manually triggers suggestion generation for current contact
 *
 * @returns SuggestionUpdate or null if no current contact
 */
async function handleHotRunRefresh(): Promise<SuggestionUpdate | null> {
  return hotRunService.refreshSuggestions()
}

/**
 * Handles hotrun:updateSettings IPC call
 * Updates settings and applies changes to all services
 *
 * @param _event - IPC event (unused)
 * @param settings - New AppSettings to apply
 * Validates: Requirement 11.5
 */
async function handleHotRunUpdateSettings(
  _event: Electron.IpcMainInvokeEvent,
  settings: AppSettings
): Promise<void> {
  await ensureStorageDirectories(settings)
  await hotRunService.updateSettings(settings)
  await syncSettingsToVisualMonitorBackend(settings)
}

/**
 * Gets the hot run service instance (for testing)
 */
export function getHotRunService(): HotRunService {
  return hotRunService
}

async function handleChatRecordsIngestAndGetRecent(
  _event: Electron.IpcMainInvokeEvent,
  events: ChatRecordEventRow[],
  limit: number = 10
): Promise<ChatRecordIngestResult> {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('events cannot be empty')
  }

  const settings = await memoryManager.loadSettings()
  const ownerUserId = settings.evermemos.ownerUserId
  const ownerDisplayName = getOwnerDisplayName(settings)
  const result = await ingestChatRecordsAndGetRecent(
    settings.storagePaths.chatRecordsDir,
    events,
    ownerUserId,
    ownerDisplayName,
    limit,
    getChatRecordMaintenanceOptions(settings)
  )

  // Mark updated sessions as dirty for memory files refresh
  for (const session of result.updatedSessions) {
    const normalizedSessionKey = normalizeLookupText(session.sessionKey)
    if (normalizedSessionKey) {
      dirtyMemorySessions.add(normalizedSessionKey)
    }
  }

  return result
}

async function handleChatRecordsGetRecentSessionMessages(
  _event: Electron.IpcMainInvokeEvent,
  sessionKey: string,
  limit: number = 10
): Promise<{ sessionKey: string; sessionName: string; filePath: string; recentMessages: ChatRecordEntry[] } | null> {
  const settings = await memoryManager.loadSettings()
  const ownerUserId = settings.evermemos.ownerUserId
  return loadRecentChatRecordSession(
    settings.storagePaths.chatRecordsDir,
    ownerUserId,
    sessionKey,
    limit,
    getChatRecordMaintenanceOptions(settings)
  )
}

/**
 * Gets the display name for the current owner user
 */
function getOwnerDisplayName(settings: AppSettings): string {
  const accounts = settings.evermemos.availableAccounts ?? []
  const account = accounts.find(a => a.userId === settings.evermemos.ownerUserId)
  return account?.displayName ?? settings.evermemos.ownerUserId ?? 'Me'
}

async function handleMemoryFilesGetOverview(): Promise<MemorySectionOverview[]> {
  const settings = await memoryManager.loadSettings()
  const chatRecordsDir = settings.storagePaths.chatRecordsDir
  const ownerUserId = settings.evermemos.ownerUserId

  // Return cache if no dirty sessions and cache is fresh
  if (
    cachedMemorySections &&
    cachedMemorySections.chatRecordsDir === chatRecordsDir &&
    cachedMemorySections.ownerUserId === ownerUserId &&
    dirtyMemorySessions.size === 0 &&
    Date.now() - cachedMemorySections.fetchedAt < MEMORY_FILES_CACHE_TTL_MS
  ) {
    return (Object.keys(SECTION_META) as MemorySectionId[]).map((id) => ({
      ...SECTION_META[id],
      count: (cachedMemorySections!.sections[id] as unknown[])?.length ?? 0
    }))
  }

  // Fetch fresh data
  await ensureStoredChatRecordsRepaired(settings)
  const grouped = await loadMemorySectionOverview(settings, ownerUserId)

  // Update cache and clear dirty flags
  cachedMemorySections = {
    chatRecordsDir,
    ownerUserId,
    sections: {},
    fetchedAt: Date.now()
  }
  dirtyMemorySessions.clear()

  return grouped
}

async function handleMemoryFilesGetSection(
  _event: Electron.IpcMainInvokeEvent,
  sectionId: MemorySectionId,
  searchQuery?: string
): Promise<MemoryFileSection> {
  const settings = await memoryManager.loadSettings()
  const chatRecordsDir = settings.storagePaths.chatRecordsDir
  const ownerUserId = settings.evermemos.ownerUserId

  // If no search query and cache is fresh, try to return cached section
  if (
    !searchQuery &&
    cachedMemorySections &&
    cachedMemorySections.chatRecordsDir === chatRecordsDir &&
    cachedMemorySections.ownerUserId === ownerUserId &&
    dirtyMemorySessions.size === 0 &&
    Date.now() - cachedMemorySections.fetchedAt < MEMORY_FILES_CACHE_TTL_MS
  ) {
    const cachedItems = cachedMemorySections.sections[sectionId]
    if (cachedItems) {
      return {
        ...SECTION_META[sectionId],
        items: cachedItems as MemoryFileListItem[]
      }
    }
  }

  // Fetch fresh data
  await ensureStoredChatRecordsRepaired(settings)
  const section = await loadMemorySection(settings, sectionId, searchQuery ?? '', ownerUserId)

  // Update cache if no search query
  if (!searchQuery) {
    if (!cachedMemorySections || cachedMemorySections.chatRecordsDir !== chatRecordsDir || cachedMemorySections.ownerUserId !== ownerUserId) {
      cachedMemorySections = {
        chatRecordsDir,
        ownerUserId,
        sections: {},
        fetchedAt: Date.now()
      }
    }
    cachedMemorySections.sections[sectionId] = section.items
  }

  return section
}

async function handleMemoryFilesReadItem(
  _event: Electron.IpcMainInvokeEvent,
  itemPath: string
): Promise<MemoryFileDetail> {
  const settings = await memoryManager.loadSettings()
  await ensureStoredChatRecordsRepaired(settings)
  return readMemoryItem(settings, itemPath)
}

async function handleMemoryFilesDeleteItem(
  _event: Electron.IpcMainInvokeEvent,
  itemPath: string
): Promise<void> {
  const settings = await memoryManager.loadSettings()
  await deleteMemoryItem(settings, itemPath)
  // Clear cache after deletion
  cachedMemorySections = null
}

async function handleMemoryFilesMarkSessionDirty(
  _event: Electron.IpcMainInvokeEvent,
  sessionKey: string
): Promise<void> {
  if (!sessionKey || typeof sessionKey !== 'string') {
    return
  }
  const normalizedSessionKey = normalizeLookupText(sessionKey)
  if (normalizedSessionKey) {
    dirtyMemorySessions.add(normalizedSessionKey)
  }
}

async function ensureStorageDirectories(settings: AppSettings): Promise<void> {
  const paths = [
    settings.storagePaths.rootDir,
    settings.storagePaths.cacheDir,
    settings.storagePaths.chatRecordsDir,
    settings.storagePaths.memoryLibraryDir
  ]

  for (const dirPath of paths) {
    if (!dirPath || typeof dirPath !== 'string') {
      continue
    }
    try {
      await mkdir(dirPath, { recursive: true })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`无法创建存储目录: ${dirPath} (${reason})`)
    }
  }
}

async function ensureStoredChatRecordsRepaired(settings: AppSettings): Promise<void> {
  const recordsDir = settings.storagePaths.chatRecordsDir
  const ownerUserId = settings.evermemos.ownerUserId
  const now = Date.now()

  // Check if we need to run repair (different directory or owner, or cooldown expired)
  if (
    lastChatRecordRepairRoot === recordsDir &&
    lastChatRecordRepairOwner === ownerUserId &&
    now - lastChatRecordRepairAt < CHAT_RECORD_REPAIR_COOLDOWN_MS
  ) {
    return
  }

  await repairStoredChatRecordSessions(recordsDir, ownerUserId, getChatRecordMaintenanceOptions(settings))
  lastChatRecordRepairRoot = recordsDir
  lastChatRecordRepairOwner = ownerUserId
  lastChatRecordRepairAt = now
}

function getChatRecordMaintenanceOptions(settings: AppSettings): ChatRecordMaintenanceOptions {
  return {
    captureDedupWindowMs: settings.visualMonitor.captureTuning.chatRecordCaptureDedupWindowMs
  }
}

function getProfileBackfillChunkSize(settings: AppSettings): number {
  const rawValue = settings.evermemos.backfillChunkSize
  if (!Number.isFinite(rawValue)) {
    return DEFAULT_PROFILE_BACKFILL_CHUNK_SIZE
  }
  return Math.max(1, Math.min(200, Math.floor(rawValue)))
}

async function syncSettingsToVisualMonitorBackend(settings: AppSettings): Promise<void> {
  const baseUrl = settings.visualMonitor.apiBaseUrl?.trim() || DEFAULT_VISUAL_MONITOR_API_BASE_URL
  const monitorRunning = await fetchVisualMonitorRunning(baseUrl)
  const frameCacheRunState = resolveFrameCacheRunDirState({
    currentRunDir: latestFrameCacheRunDir,
    previousMonitorRunning: lastVisualMonitorRunning,
    monitorRunning,
    cacheDir: settings.storagePaths.cacheDir,
    now: new Date()
  })
  latestFrameCacheRunDir = frameCacheRunState.runDir
  lastVisualMonitorRunning = frameCacheRunState.monitorRunning
  await mkdir(latestFrameCacheRunDir, { recursive: true })

  const patchPayload = buildVisualMonitorConfigPatchPayload({
    settings,
    runDir: latestFrameCacheRunDir
  })
  if (
    settings.visualMonitor.captureScope === 'roi'
    && settings.visualMonitor.roiStrategy === 'manual'
    && settings.visualMonitor.manualRoi
  ) {
    ;(patchPayload.monitor as Record<string, unknown>).roi = dipRectToScreenRect(
      settings.visualMonitor.manualRoi,
      createDipToScreenPointMapper(screen)
    )
  }

  try {
    const response = await fetch(`${baseUrl}/monitor/config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(patchPayload)
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`服务返回 ${response.status}: ${body}`)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `设置已保存，但同步视觉监测后端失败（${baseUrl}）。请先启动后端：${VISUAL_MONITOR_START_COMMAND}。原始错误: ${reason}`
    )
  }
}

async function syncSettingsToEverMemOSBackend(settings: AppSettings): Promise<void> {
  if (!settings.evermemos.enabled) {
    return
  }

  const baseUrl = settings.evermemos.apiBaseUrl?.trim().replace(/\/+$/, '')
  if (!baseUrl) {
    return
  }

  try {
    const response = await fetch(`${baseUrl}/api/v1/copilot/config/llm`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        base_url: settings.evermemos.llm.baseUrl,
        api_key: settings.evermemos.llm.apiKey,
        model: settings.evermemos.llm.model,
        temperature: settings.evermemos.llm.temperature,
        max_tokens: settings.evermemos.llm.maxTokens
      })
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`服务返回 ${response.status}: ${body}`)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `设置已保存，但同步 EverMemOS LLM 配置失败（${baseUrl}）。原始错误: ${reason}`
    )
  }
}

async function fetchVisualMonitorRunning(baseUrl: string): Promise<boolean> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 800)
  try {
    const response = await fetch(`${baseUrl}/monitor/status`, { signal: controller.signal })
    if (!response.ok) {
      return false
    }
    const payload = (await response.json()) as { running?: unknown }
    return payload.running === true
  } catch {
    return false
  } finally {
    clearTimeout(timeoutId)
  }
}

async function fetchEverMemOSJson<T>(
  settings: AppSettings,
  path: string,
  init: RequestInit = {},
  timeoutOverrideMs?: number
): Promise<T> {
  if (!settings.evermemos.enabled) {
    throw new Error('evermemos_disabled')
  }
  const baseUrl = settings.evermemos.apiBaseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl) {
    throw new Error('evermemos_api_base_url_missing')
  }

  const controller = new AbortController()
  const defaultTimeout = Math.max(settings.evermemos.requestTimeoutMs || 15000, 1000)
  const timeoutMs = timeoutOverrideMs ?? defaultTimeout
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers || {})
      },
      signal: controller.signal
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`evermemos_request_failed:${response.status}:${body}`)
    }

    return (await response.json()) as T
  } finally {
    clearTimeout(timeoutId)
  }
}

async function resetEverMemOSConversationRuntimeState(
  settings: AppSettings,
  sessionKey: string,
  clearCache = false
): Promise<void> {
  await fetchEverMemOSJson(
    settings,
    '/api/v1/copilot/conversation-runtime/reset',
    {
      method: 'POST',
      body: JSON.stringify({
        session_key: sessionKey,
        clear_cache: clearCache
      })
    },
    Math.max(settings.evermemos.requestTimeoutMs || 15000, 5000)
  )
}

function shouldBackfillMessage(message: ChatRecordEntry): boolean {
  const content = message.content.trim()
  const nonTextDescription = message.metadata.non_text_description?.trim() ?? ''
  return content.length > 0 || nonTextDescription.length > 0
}

function sanitizeBackfillMessage(message: ChatRecordEntry): ChatRecordEntry {
  const fallbackContent = message.metadata.non_text_description?.trim() ?? ''
  const normalizedTimestamp =
    normalizeBackfillTimestamp(message.metadata.capture_timestamp)
    ?? normalizeBackfillTimestamp(message.timestamp)

  return {
    ...message,
    content: message.content.trim() || fallbackContent,
    timestamp: normalizedTimestamp
  }
}

function normalizeBackfillTimestamp(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) {
    return null
  }
  const parsed = Date.parse(normalized)
  if (!Number.isFinite(parsed)) {
    return null
  }
  const iso = new Date(parsed).toISOString()
  const year = Number(iso.slice(0, 4))
  if (Number.isFinite(year) && year < 2011) {
    return null
  }
  return iso
}

function pickBackfillIncomingMessage(messages: ChatRecordEntry[]): ChatRecordEntry | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.sender_type === 'contact') {
      return message
    }
  }
  return messages[messages.length - 1] ?? null
}

function deriveBackfillDisplayName(
  session: { sessionName: string },
  messages: ChatRecordEntry[]
): string {
  const sessionName = session.sessionName.trim()
  if (sessionName.length > 0) {
    return sessionName
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.sender_type === 'contact' && message.sender_name.trim().length > 0) {
      return message.sender_name.trim()
    }
  }
  return session.sessionName
}

function normalizeLookupText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}
