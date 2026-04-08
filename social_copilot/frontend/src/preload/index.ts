/**
 * Preload Script - Electron contextBridge API
 *
 * Exposes type-safe IPC communication to the renderer process
 * All methods are exposed via window.electronAPI
 *
 * Validates: Requirement 2.1
 *
 * IPC Channels:
 * - import:* - Data import handlers
 * - monitor:* - Chat monitor handlers
 * - suggestions:* - Suggestion handlers
 * - profile:* - Profile handlers
 * - settings:* - Settings handlers
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { AppSettings as SchemaAppSettings } from '../models/schemas'

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * OrchestrationResult - Result from chat submission
 */
export interface OrchestrationResult {
  suggestions: Suggestion[]
  intent: IntentAnalysis
}

/**
 * Suggestion - Reply suggestion from Coach Agent
 */
export interface Suggestion {
  content: string
  reason: string
}

/**
 * IntentAnalysis - Output from Intent Agent
 */
export interface IntentAnalysis {
  intent: string
  mood: string
  topic: string
}

/**
 * UserProfile - User's personal profile
 * Matches the schema in models/schemas.ts
 */
export interface UserProfile {
  user_id: string
  base_info: {
    gender: 'male' | 'female' | 'other'
    occupation: string
    tone_style: string
  }
  communication_habits: {
    frequent_phrases: string[]
    emoji_usage: string[]
    punctuation_style: string
    msg_avg_length: 'short' | 'medium' | 'long'
  }
  last_updated: number
}

/**
 * ContactProfile - Contact's profile with relationship information
 */
export interface ContactProfile {
  contact_id: string
  nickname: string
  profile: {
    role: string
    age_group: string
    personality_tags: string[]
    interests: string[]
    occupation?: string
  }
  relationship_graph: {
    current_status: string
    intimacy_level: 'stranger' | 'formal' | 'close' | 'intimate'
    intermediary: {
      has_intermediary: boolean
      name?: string
      context?: string
    }
  }
  chat_history_summary: string
  risk_assessment: {
    is_suspicious: boolean
    risk_level: 'low' | 'medium' | 'high'
    warning_msg: string
  }
  last_updated: number
}

/**
 * ProfileField - 鐢诲儚瀛楁缁熶竴鏍煎紡
 * LLM 杩斿洖鏍煎紡涓庡瓨鍌ㄦ牸寮忎竴鑷达細{"value": "瀛楁鍊?, "evidences": ["conversation_id"]}
 */
export interface ProfileField {
  value: string
  evidences: string[]
}

export interface UnifiedProfile {
  profile_id: string
  profile_type: 'user' | 'contact'
  owner_user_id: string
  target_user_id?: string | null
  conversation_id?: string | null
  display_name: string
  aliases: string[]
  // 鍗曞€煎瓧娈?
  occupation?: ProfileField | null
  relationship?: ProfileField | null
  // 鍒楄〃瀛楁锛堝叏閮ㄥ甫璇佹嵁锛?
  traits: ProfileField[]
  interests: ProfileField[]
  way_of_decision_making: ProfileField[]
  life_habit_preference: ProfileField[]
  communication_style: ProfileField[]
  catchphrase: ProfileField[]
  user_to_friend_catchphrase: ProfileField[]
  user_to_friend_chat_style: ProfileField[]
  motivation_system: ProfileField[]
  fear_system: ProfileField[]
  value_system: ProfileField[]
  humor_use: ProfileField[]
  // 绀句氦灞炴€?
  social_attributes: {
    role: string
    age_group?: string | null
    intimacy_level: 'stranger' | 'formal' | 'close' | 'intimate'
    current_status: string
    intermediary: {
      has_intermediary: boolean
      name?: string | null
      context?: string | null
    }
  }
  // 椋庨櫓璇勪及
  risk_assessment?: {
    is_suspicious: boolean
    risk_level: 'low' | 'medium' | 'high'
    warning_msg: string
    risk_patterns: string[]
    last_checked?: string | null
  } | null
  // 鍏冩暟鎹?
  metadata: {
    version: number
    created_at: string
    last_updated: string
    source_memcell_count: number
    last_cluster_id?: string | null
    update_count: number
  }
  // 鍚戦噺妫€绱?
  retrieval?: {
    vector?: number[] | null
    vector_model?: string | null
    keywords: string[]
  } | null
  extend: Record<string, unknown>
}

/**
 * AppSettings - Application settings
 * Re-exported from the shared schema so preload and renderer stay in sync.
 */
export type AppSettings = SchemaAppSettings

export interface RoiRect {
  x: number
  y: number
  w: number
  h: number
}

export interface RoiActionResult {
  success: boolean
  message: string
  roi?: RoiRect
}

export interface RoiStatusEvent {
  type: 'manual_applied' | 'manual_reset' | 'overlay_cancelled' | 'error' | 'hint'
  message: string
  roi?: RoiRect
}

export interface AssistantWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export type MemorySectionId =
  | 'inbox'
  | 'today-clues'
  | 'long-term-memory'
  | 'relationship-clues'
  | 'wechat-chat-notes'
  | 'history-archive'

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

/**
 * AppInitResult - Result from application initialization
 */
export interface AppInitResult {
  ollamaConnected: boolean
  contacts: string[]
  isFirstRun: boolean
}

/**
 * DataFormat - Detected data format type
 */
export type DataFormat = 'wechatmsg_csv' | 'wechatdatabackup' | 'decrypted_db' | 'unknown'

/**
 * RawMessage - Raw message from data import
 */
export interface RawMessage {
  msgId: string
  msgType: number
  subType?: number
  content: string
  fromUser: string
  toUser: string
  createTime: number
  isSend: boolean
  speakerId?: string
  speakerName?: string
  conversationTitle?: string
}

/**
 * DataImportResult - Result from data import operation
 */
export interface DataImportResult {
  format: DataFormat
  messages: RawMessage[]
  contacts: string[]
  errors: string[]
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

/**
 * MonitorMode - Chat monitor mode
 */
export type MonitorMode = 'accessibility' | 'ocr' | 'unavailable'

/**
 * ChatMonitorStatus - Status of the chat monitor service
 */
export interface ChatMonitorStatus {
  mode: MonitorMode
  hasPermission: boolean
  isMonitoring: boolean
  targetWindow: string | null
  lastPollTime: number | null
  errorMessage?: string
}

/**
 * ColdStartProgress - Progress update during cold start
 */
export interface ColdStartProgress {
  stage: 'importing' | 'cleaning' | 'profiling_user' | 'profiling_contacts' | 'saving' | 'complete'
  progress: number
  message: string
  currentContact?: string
  totalContacts?: number
  processedContacts?: number
}

/**
 * ColdStartResult - Result from cold start execution
 */
export interface ColdStartResult {
  success: boolean
  userProfile: UserProfile | null
  contactProfiles: Map<string, ContactProfile>
  messageCount: number
  contactCount: number
  errors: string[]
}

/**
 * HotRunStatus - Status of the hot run service
 */
export interface HotRunStatus {
  isRunning: boolean
  monitorStatus: ChatMonitorStatus
  currentContact: string | null
  ollamaConnected: boolean
  lastSuggestionTime: number | null
  errorMessage?: string
}

/**
 * SuggestionUpdate - Update from hot run service with new suggestions
 */
export interface SuggestionUpdate {
  suggestions: Suggestion[]
  intent: IntentAnalysis
  contactId: string
  contactProfile: ContactProfile | null
  timestamp: number
}

// ============================================================================
// API Interface Definitions
// ============================================================================

/**
 * ImportAPI - Data import related methods
 */
export interface ImportAPI {
  /**
   * Opens a folder dialog and imports data from the selected folder
   * @returns DataImportResult with messages and metadata, or null if cancelled
   */
  folder: () => Promise<DataImportResult | null>

  /**
   * Opens a folder dialog and imports historical data into chat_records, then initializes EverMemOS memory.
   * @returns ImportInitializeMemoryResult with persisted/imported/backfill summary, or null if cancelled
   */
  initializeMemory: () => Promise<ImportInitializeMemoryResult | null>

  /**
   * Initializes EverMemOS memory from an explicit file or folder path.
   * @param inputPath - absolute file or folder path selected by the renderer
   */
  initializeMemoryFromPath: (inputPath: string) => Promise<ImportInitializeMemoryResult>

  /**
   * Opens a file dialog and returns the selected historical chat file path.
   * @returns Absolute file path or null if cancelled
   */
  selectMemoryImportFilePath: () => Promise<string | null>

  /**
   * Opens a folder dialog and returns the selected historical chat directory path.
   * @returns Absolute folder path or null if cancelled
   */
  selectMemoryImportFolderPath: () => Promise<string | null>

  /**
   * Subscribe to import-and-initialize progress events.
   */
  onInitializeMemoryProgress: (callback: (progress: ImportInitializeMemoryProgress) => void) => void

  /**
   * Remove import-and-initialize progress listeners.
   */
  offInitializeMemoryProgress: () => void

  /**
   * Opens a file dialog and reads the selected file
   * @returns File content as string, or null if cancelled
   */
  file: () => Promise<string | null>

  /**
   * Detects the data format of a given folder path
   * @param folderPath - Path to the data folder
   * @returns DataFormat string
   */
  detectFormat: (folderPath: string) => Promise<DataFormat>
}

/**
 * MonitorAPI - Chat monitor related methods
 */
export interface MonitorAPI {
  /**
   * Initializes and starts the chat monitor
   * @returns ChatMonitorStatus after starting
   */
  start: () => Promise<ChatMonitorStatus>

  /**
   * Stops the chat monitor
   * @returns ChatMonitorStatus after stopping
   */
  stop: () => Promise<ChatMonitorStatus>

  /**
   * Gets the current status of the chat monitor
   * @returns ChatMonitorStatus
   */
  status: () => Promise<ChatMonitorStatus>
}

/**
 * SuggestionsAPI - Suggestion generation methods
 */
export interface SuggestionsAPI {
  /**
   * Generates reply suggestions for the given chat logs
   * @param logs - Array of chat log strings
   * @param contactId - The contact's unique identifier
   * @returns OrchestrationResult with suggestions and intent
   */
  generate: (logs: string[], contactId: string) => Promise<OrchestrationResult>
}

/**
 * ProfileAPI - Profile management methods
 */
export interface ProfileAPI {
  /**
   * Loads the user profile from disk
   * @returns UnifiedProfile
   */
  loadUser: () => Promise<UnifiedProfile>

  /**
   * Saves the user profile to disk
   * @param profile - UnifiedProfile to save
   */
  saveUser: (profile: UnifiedProfile) => Promise<void>

  /**
   * Loads a contact profile from disk
   * @param contactId - The contact's unique identifier
   * @returns UnifiedProfile or null if not found
   */
  loadContact: (contactId: string) => Promise<UnifiedProfile | null>
}

/**
 * SettingsAPI - Settings management methods
 */
export interface SettingsAPI {
  /**
   * Loads application settings from disk
   * @returns AppSettings
   */
  load: () => Promise<AppSettings>

  /**
   * Saves application settings to disk
   * @param settings - AppSettings to save
   */
  save: (settings: AppSettings) => Promise<void>

  /**
   * Lists available models from a model provider endpoint
   * @param baseUrl - Provider base URL
   * @param apiKey - Provider API key
   * @returns Available model IDs
   */
  listModels: (baseUrl: string, apiKey?: string) => Promise<string[]>

  /**
   * Tests connectivity for a model provider endpoint and optionally verifies a selected model
   * @param baseUrl - Provider base URL
   * @param apiKey - Provider API key
   * @param model - Optional selected model ID for smoke test
   * @param streamStrategy - Whether smoke test should use stream or non-stream mode
   * @returns Connectivity result message
   */
  testConnection: (
    baseUrl: string,
    apiKey?: string,
    model?: string,
    streamStrategy?: 'stream' | 'non_stream'
  ) => Promise<string>

  /**
   * Tests vision model connectivity AND sends a fixed test image to verify VLM image parsing
   * @param baseUrl - Provider base URL
   * @param apiKey - Provider API key
   * @param model - Model ID
   * @param maxTokens - Max tokens for VLM call
   * @param disableThinking - Whether to disable model thinking/reasoning
   * @returns Result message; throws if image parsing fails
   */
  testVisionConnection: (
    baseUrl: string,
    apiKey?: string,
    model?: string,
    maxTokens?: number,
    disableThinking?: boolean,
    streamStrategy?: 'stream' | 'non_stream'
  ) => Promise<string>

  /**
   * Marks onboarding as complete
   * Sets the onboardingComplete flag in settings
   */
  completeOnboarding: () => Promise<void>
}

/**
 * ColdStartAPI - Cold start flow methods
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8
 */
export interface ColdStartAPI {
  /**
   * Executes the complete cold start flow
   * Opens folder picker, imports data, cleans, generates profiles
   * @returns ColdStartResult with generated profiles and statistics
   */
  execute: () => Promise<ColdStartResult>

  /**
   * Creates minimal default profiles for users who skip import
   * @returns ColdStartResult with default profiles
   */
  createDefaults: () => Promise<ColdStartResult>

  /**
   * Registers a callback for progress updates during cold start
   * @param callback - Function to call with progress updates
   */
  onProgress: (callback: (progress: ColdStartProgress) => void) => void

  /**
   * Removes the progress callback
   */
  offProgress: () => void
}

/**
 * HotRunAPI - Hot run flow methods for real-time monitoring
 * Validates: Requirements 3.5, 4.1, 5.1, 6.1
 */
export interface HotRunAPI {
  /**
   * Starts the hot run service for real-time monitoring
   * @returns HotRunStatus after starting
   */
  start: () => Promise<HotRunStatus>

  /**
   * Stops the hot run service
   * @returns HotRunStatus after stopping
   */
  stop: () => Promise<HotRunStatus>

  /**
   * Gets the current status of the hot run service
   * @returns HotRunStatus
   */
  status: () => Promise<HotRunStatus>

  /**
   * Manually triggers suggestion generation for current contact
   * @returns SuggestionUpdate or null if no current contact
   */
  refresh: () => Promise<SuggestionUpdate | null>

  /**
   * Updates settings and applies changes to all services
   * @param settings - New AppSettings to apply
   */
  updateSettings: (settings: AppSettings) => Promise<void>

  /**
   * Registers a callback for suggestion updates
   * @param callback - Function to call with suggestion updates
   */
  onSuggestions: (callback: (update: SuggestionUpdate) => void) => void

  /**
   * Registers a callback for contact changes
   * @param callback - Function to call with contact changes
   */
  onContactChanged: (callback: (data: { contactId: string; profile: ContactProfile | null }) => void) => void

  /**
   * Registers a callback for status changes
   * @param callback - Function to call with status changes
   */
  onStatusChanged: (callback: (status: HotRunStatus) => void) => void

  /**
   * Registers a callback for errors
   * @param callback - Function to call with errors
   */
  onError: (callback: (error: { message: string }) => void) => void

  /**
   * Removes all hot run event listeners
   */
  removeAllListeners: () => void
}

export interface RoiAPI {
  openOverlay: () => Promise<void>
  applyManualSelection: (roi: RoiRect) => Promise<RoiActionResult>
  closeOverlay: () => Promise<void>
  resetManualRoi: () => Promise<RoiActionResult>
  onStatus: (callback: (event: RoiStatusEvent) => void) => void
  offStatus: () => void
}

export interface AssistantWindowAPI {
  getBounds: () => Promise<AssistantWindowBounds | null>
  setPosition: (position: { x: number; y: number }) => Promise<AssistantWindowBounds | null>
  setExpanded: (expanded: boolean) => Promise<AssistantWindowBounds | null>
  getFrontmostApp: () => Promise<string | null>
  syncExclusion: () => Promise<boolean>
}

export interface ChatRecordEventRow {
  sender: 'user' | 'contact' | 'unknown'
  text: string
  quoted_message?: {
    text: string
    sender_name?: string | null
  } | null
  contact_name?: string | null
  conversation_title?: string | null
  window_id?: string | null
  session_key?: string | null
  content_type?: string | null
  non_text_description?: string | null
  timestamp?: string
  event_id?: string
  frame_id?: string
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
    event_id: string | null
    frame_id: string | null
  }
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

export interface ChatRecordIngestResult {
  currentSession: ChatRecordCurrentSession
  latestUpdatedSession: ChatRecordCurrentSession | null
  updatedSessions: ChatRecordUpdatedSession[]
  pendingConfirmation: PendingChatRecordSession | null
}

export interface ChatRecordsAPI {
  ingestAndGetRecent: (events: ChatRecordEventRow[], limit?: number) => Promise<ChatRecordIngestResult>
  getRecentSessionMessages: (sessionKey: string, limit?: number) => Promise<ChatRecordCurrentSession | null>
  confirmPendingSession: (pendingId: string, confirmedSessionName: string, limit?: number) => Promise<ChatRecordCurrentSession>
}

export interface MemoryFilesAPI {
  getOverview: () => Promise<MemorySectionOverview[]>
  getSection: (sectionId: MemorySectionId, searchQuery?: string) => Promise<MemoryFileSection>
  readItem: (itemPath: string) => Promise<MemoryFileDetail>
  deleteItem: (itemPath: string) => Promise<void>
  // Mark a session as having new messages (needs refresh)
  markSessionDirty: (sessionKey: string) => Promise<void>
}

export interface ProfileAdminAPI {
  list: () => Promise<UnifiedProfile[]>
  save: (profile: UnifiedProfile) => Promise<UnifiedProfile>
  delete: (profileId: string) => Promise<void>
  backfillHistory: (forceFullRebuild?: boolean, selectedSessionKeys?: string[]) => Promise<ProfileBackfillResult>
  listBackfillSessions: () => Promise<BackfillSessionSummary[]>
  getBackfillJobState: () => Promise<ProfileBackfillJobState>
  regenerateProfiles: () => Promise<RegenerateProfilesResult>
  clearProfiles: () => Promise<ClearProfilesResult>
  listEpisodes: () => Promise<EpisodicMemoryItem[]>
  listMemcells: () => Promise<MemCellItem[]>
  listForesights: () => Promise<ForesightItem[]>
  // Update backfill progress after realtime processing
  updateBackfillProgress: (sessionKey: string, lastProcessedTimestamp: string) => Promise<void>
  // Mark a session as having new messages (needs refresh)
  markSessionDirty: (sessionKey: string) => Promise<void>
}

export interface CleanupLocalDataInput {
  olderThanHours: number
}

export interface CleanupLocalDataResult {
  cutoffIso: string
  chat: {
    scannedSessions: number
    deletedMessages: number
    deletedFiles: number
    errors: number
  }
  cache: {
    scannedFiles: number
    deletedFiles: number
    deletedDirs: number
    errors: number
    skippedActiveRunDir: boolean
  }
}

export interface MaintenanceAPI {
  cleanupLocalData: (input: CleanupLocalDataInput) => Promise<CleanupLocalDataResult>
}

export interface ClearProfilesResult {
  success: boolean
  cleared_profiles: number
}

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

export interface BackfillSessionSummary {
  sessionKey: string
  sessionName: string
  messageCount: number
  pendingMessageCount: number
  updatedAt: string
  lastProcessedTimestamp: string | null
}

export interface ProfileBackfillJobState {
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

export interface RegenerateProfilesResult {
  success: boolean
  scanned_memcells: number
  processed_conversations: number
  updated_profiles: number
  errors: string[]
}

export interface EpisodicMemoryItem {
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

export interface ForesightItem {
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

export interface MemCellMessage {
  speaker_name: string
  speaker_id: string
  content: string
  timestamp: string | null
}

export interface MemCellItem {
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
 * ElectronAPI - Complete type-safe API exposed to renderer process
 */
export interface ElectronAPI {
  /**
   * Initializes the application on startup
   * Creates data directory, default profiles, and checks Ollama connectivity
   * @returns AppInitResult with ollamaConnected status and contacts list
   */
  initialize: () => Promise<AppInitResult>

  /**
   * Data import related methods (import:*)
   */
  import: ImportAPI

  /**
   * Chat monitor related methods (monitor:*)
   */
  monitor: MonitorAPI

  /**
   * Suggestion generation methods (suggestions:*)
   */
  suggestions: SuggestionsAPI

  /**
   * Profile management methods (profile:*)
   */
  profile: ProfileAPI

  /**
   * Settings management methods (settings:*)
   */
  settings: SettingsAPI

  /**
   * Cold start flow methods (coldstart:*)
   * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8
   */
  coldStart: ColdStartAPI

  /**
   * Hot run flow methods (hotrun:*)
   * Validates: Requirements 3.5, 4.1, 5.1, 6.1
   */
  hotRun: HotRunAPI
  roi: RoiAPI
  assistantWindow: AssistantWindowAPI
  chatRecords: ChatRecordsAPI
  memoryFiles: MemoryFilesAPI
  profileAdmin: ProfileAdminAPI
  maintenance: MaintenanceAPI

  /**
   * Lists all contact IDs
   * @returns Array of contact IDs
   */
  listContacts: () => Promise<string[]>

  /**
   * Checks if Ollama service is available
   * @returns true if Ollama is healthy, false otherwise
   */
  checkOllamaHealth: () => Promise<boolean>

  // ============================================================================
  // Legacy Methods (for backward compatibility)
  // ============================================================================

  /**
   * @deprecated Use suggestions.generate instead
   * Submits chat logs for analysis and returns suggestions
   * @param logs - Array of chat log strings
   * @param contactId - The contact's unique identifier
   * @returns OrchestrationResult with suggestions and intent
   */
  submitChat: (logs: string[], contactId: string) => Promise<OrchestrationResult>

  /**
   * @deprecated Use profile.loadUser instead
   * Loads the user profile from disk
   * @returns UserProfile
   */
  loadUserProfile: () => Promise<UserProfile>

  /**
   * @deprecated Use profile.saveUser instead
   * Saves the user profile to disk
   * @param profile - UserProfile to save
   */
  saveUserProfile: (profile: UserProfile) => Promise<void>

  /**
   * @deprecated Use profile.loadContact instead
   * Loads a contact profile from disk
   * @param contactId - The contact's unique identifier
   * @returns ContactProfile or null if not found
   */
  loadContactProfile: (contactId: string) => Promise<ContactProfile | null>

  /**
   * @deprecated Use import.file instead
   * Opens a file dialog and reads the selected .txt file
   * @returns File content as string, or null if cancelled
   */
  importFile: () => Promise<string | null>
}

// ============================================================================
// API Implementation
// ============================================================================

/**
 * Import API implementation
 */
let importInitializeMemoryProgressCallback: ((progress: ImportInitializeMemoryProgress) => void) | null = null

const importAPI: ImportAPI = {
  folder: (): Promise<DataImportResult | null> =>
    ipcRenderer.invoke('import:folder'),

  initializeMemory: (): Promise<ImportInitializeMemoryResult | null> =>
    ipcRenderer.invoke('import:initializeMemory'),

  initializeMemoryFromPath: (inputPath: string): Promise<ImportInitializeMemoryResult> =>
    ipcRenderer.invoke('import:initializeMemoryFromPath', inputPath),

  selectMemoryImportFilePath: (): Promise<string | null> =>
    ipcRenderer.invoke('import:selectMemoryImportFilePath'),

  selectMemoryImportFolderPath: (): Promise<string | null> =>
    ipcRenderer.invoke('import:selectMemoryImportFolderPath'),

  onInitializeMemoryProgress: (callback: (progress: ImportInitializeMemoryProgress) => void): void => {
    importInitializeMemoryProgressCallback = callback
    ipcRenderer.on(
      'import:initializeMemoryProgress',
      (_event, progress: ImportInitializeMemoryProgress) => {
        if (importInitializeMemoryProgressCallback) {
          importInitializeMemoryProgressCallback(progress)
        }
      }
    )
  },

  offInitializeMemoryProgress: (): void => {
    importInitializeMemoryProgressCallback = null
    ipcRenderer.removeAllListeners('import:initializeMemoryProgress')
  },

  file: (): Promise<string | null> =>
    ipcRenderer.invoke('import:file'),

  detectFormat: (folderPath: string): Promise<DataFormat> =>
    ipcRenderer.invoke('import:detectFormat', folderPath)
}

/**
 * Monitor API implementation
 */
const monitorAPI: MonitorAPI = {
  start: (): Promise<ChatMonitorStatus> =>
    ipcRenderer.invoke('monitor:start'),

  stop: (): Promise<ChatMonitorStatus> =>
    ipcRenderer.invoke('monitor:stop'),

  status: (): Promise<ChatMonitorStatus> =>
    ipcRenderer.invoke('monitor:status')
}

/**
 * Suggestions API implementation
 */
const suggestionsAPI: SuggestionsAPI = {
  generate: (logs: string[], contactId: string): Promise<OrchestrationResult> =>
    ipcRenderer.invoke('suggestions:generate', logs, contactId)
}

/**
 * Profile API implementation
 */
const profileAPI: ProfileAPI = {
  loadUser: (): Promise<UnifiedProfile> =>
    ipcRenderer.invoke('profile:loadUser'),

  saveUser: (profile: UnifiedProfile): Promise<void> =>
    ipcRenderer.invoke('profile:saveUser', profile),

  loadContact: (contactId: string): Promise<UnifiedProfile | null> =>
    ipcRenderer.invoke('profile:loadContact', contactId)
}

/**
 * Settings API implementation
 */
const settingsAPI: SettingsAPI = {
  load: (): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:load'),

  save: (settings: AppSettings): Promise<void> =>
    ipcRenderer.invoke('settings:save', settings),

  listModels: (baseUrl: string, apiKey: string = ''): Promise<string[]> =>
    ipcRenderer.invoke('settings:listModels', baseUrl, apiKey),

  testConnection: (
    baseUrl: string,
    apiKey: string = '',
    model: string = '',
    streamStrategy: 'stream' | 'non_stream' = 'non_stream'
  ): Promise<string> =>
    ipcRenderer.invoke('settings:testConnection', baseUrl, apiKey, model, streamStrategy),

  testVisionConnection: (
    baseUrl: string,
    apiKey: string = '',
    model: string = '',
    maxTokens: number = 2000,
    disableThinking: boolean = true,
    streamStrategy: 'stream' | 'non_stream' = 'stream'
  ): Promise<string> =>
    ipcRenderer.invoke('settings:testVisionConnection', baseUrl, apiKey, model, maxTokens, disableThinking, streamStrategy),

  completeOnboarding: (): Promise<void> =>
    ipcRenderer.invoke('settings:completeOnboarding')
}

/**
 * Cold Start API implementation
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8
 */
let coldStartProgressCallback: ((progress: ColdStartProgress) => void) | null = null

const coldStartAPI: ColdStartAPI = {
  execute: (): Promise<ColdStartResult> =>
    ipcRenderer.invoke('coldstart:execute'),

  createDefaults: (): Promise<ColdStartResult> =>
    ipcRenderer.invoke('coldstart:createDefaults'),

  onProgress: (callback: (progress: ColdStartProgress) => void): void => {
    coldStartProgressCallback = callback
    ipcRenderer.on('coldstart:progress', (_event, progress: ColdStartProgress) => {
      if (coldStartProgressCallback) {
        coldStartProgressCallback(progress)
      }
    })
  },

  offProgress: (): void => {
    coldStartProgressCallback = null
    ipcRenderer.removeAllListeners('coldstart:progress')
  }
}

/**
 * Hot Run API implementation
 * Validates: Requirements 3.5, 4.1, 5.1, 6.1
 */
const hotRunAPI: HotRunAPI = {
  start: (): Promise<HotRunStatus> =>
    ipcRenderer.invoke('hotrun:start'),

  stop: (): Promise<HotRunStatus> =>
    ipcRenderer.invoke('hotrun:stop'),

  status: (): Promise<HotRunStatus> =>
    ipcRenderer.invoke('hotrun:status'),

  refresh: (): Promise<SuggestionUpdate | null> =>
    ipcRenderer.invoke('hotrun:refresh'),

  updateSettings: (settings: AppSettings): Promise<void> =>
    ipcRenderer.invoke('hotrun:updateSettings', settings),

  onSuggestions: (callback: (update: SuggestionUpdate) => void): void => {
    ipcRenderer.on('hotrun:suggestions', (_event, update: SuggestionUpdate) => {
      callback(update)
    })
  },

  onContactChanged: (callback: (data: { contactId: string; profile: ContactProfile | null }) => void): void => {
    ipcRenderer.on('hotrun:contactChanged', (_event, data) => {
      callback(data)
    })
  },

  onStatusChanged: (callback: (status: HotRunStatus) => void): void => {
    ipcRenderer.on('hotrun:statusChanged', (_event, status: HotRunStatus) => {
      callback(status)
    })
  },

  onError: (callback: (error: { message: string }) => void): void => {
    ipcRenderer.on('hotrun:error', (_event, error) => {
      callback(error)
    })
  },

  removeAllListeners: (): void => {
    ipcRenderer.removeAllListeners('hotrun:suggestions')
    ipcRenderer.removeAllListeners('hotrun:contactChanged')
    ipcRenderer.removeAllListeners('hotrun:statusChanged')
    ipcRenderer.removeAllListeners('hotrun:error')
  }
}

let roiStatusCallback: ((event: RoiStatusEvent) => void) | null = null

const roiAPI: RoiAPI = {
  openOverlay: (): Promise<void> =>
    ipcRenderer.invoke('roi:openOverlay'),

  applyManualSelection: (roi: RoiRect): Promise<RoiActionResult> =>
    ipcRenderer.invoke('roi:applyManualSelection', roi),

  closeOverlay: (): Promise<void> =>
    ipcRenderer.invoke('roi:closeOverlay'),

  resetManualRoi: (): Promise<RoiActionResult> =>
    ipcRenderer.invoke('roi:resetManualRoi'),

  onStatus: (callback: (event: RoiStatusEvent) => void): void => {
    roiStatusCallback = callback
    ipcRenderer.on('roi:status', (_event, event: RoiStatusEvent) => {
      if (roiStatusCallback) {
        roiStatusCallback(event)
      }
    })
  },

  offStatus: (): void => {
    roiStatusCallback = null
    ipcRenderer.removeAllListeners('roi:status')
  }
}

const assistantWindowAPI: AssistantWindowAPI = {
  getBounds: (): Promise<AssistantWindowBounds | null> =>
    ipcRenderer.invoke('assistant:getBounds'),

  setPosition: (position: { x: number; y: number }): Promise<AssistantWindowBounds | null> =>
    ipcRenderer.invoke('assistant:setPosition', position),

  setExpanded: (expanded: boolean): Promise<AssistantWindowBounds | null> =>
    ipcRenderer.invoke('assistant:setExpanded', expanded),

  getFrontmostApp: (): Promise<string | null> =>
    ipcRenderer.invoke('assistant:getFrontmostApp'),

  syncExclusion: (): Promise<boolean> =>
    ipcRenderer.invoke('assistant:syncExclusion')
}

const chatRecordsAPI: ChatRecordsAPI = {
  ingestAndGetRecent: (events: ChatRecordEventRow[], limit: number = 10): Promise<ChatRecordIngestResult> =>
    ipcRenderer.invoke('chatrecords:ingestAndGetRecent', events, limit),

  getRecentSessionMessages: (sessionKey: string, limit: number = 10): Promise<ChatRecordCurrentSession | null> =>
    ipcRenderer.invoke('chatrecords:getRecentSessionMessages', sessionKey, limit),

  confirmPendingSession: (
    pendingId: string,
    confirmedSessionName: string,
    limit: number = 10
  ): Promise<ChatRecordCurrentSession> =>
    ipcRenderer.invoke('chatrecords:confirmPendingSession', pendingId, confirmedSessionName, limit)
}

const memoryFilesAPI: MemoryFilesAPI = {
  getOverview: (): Promise<MemorySectionOverview[]> =>
    ipcRenderer.invoke('memoryfiles:getOverview'),

  getSection: (sectionId: MemorySectionId, searchQuery: string = ''): Promise<MemoryFileSection> =>
    ipcRenderer.invoke('memoryfiles:getSection', sectionId, searchQuery),

  readItem: (itemPath: string): Promise<MemoryFileDetail> =>
    ipcRenderer.invoke('memoryfiles:readItem', itemPath),

  deleteItem: (itemPath: string): Promise<void> =>
    ipcRenderer.invoke('memoryfiles:deleteItem', itemPath),

  markSessionDirty: (sessionKey: string): Promise<void> =>
    ipcRenderer.invoke('memoryfiles:markSessionDirty', sessionKey)
}

const profileAdminAPI: ProfileAdminAPI = {
  list: (): Promise<UnifiedProfile[]> =>
    ipcRenderer.invoke('profileAdmin:list'),

  save: (profile: UnifiedProfile): Promise<UnifiedProfile> =>
    ipcRenderer.invoke('profileAdmin:save', profile),

  delete: (profileId: string): Promise<void> =>
    ipcRenderer.invoke('profileAdmin:delete', profileId),

  backfillHistory: (
    forceFullRebuild: boolean = true,
    selectedSessionKeys: string[] = []
  ): Promise<ProfileBackfillResult> =>
    ipcRenderer.invoke('profileAdmin:backfillHistory', forceFullRebuild, selectedSessionKeys),

  listBackfillSessions: (): Promise<BackfillSessionSummary[]> =>
    ipcRenderer.invoke('profileAdmin:listBackfillSessions'),

  getBackfillJobState: (): Promise<ProfileBackfillJobState> =>
    ipcRenderer.invoke('profileAdmin:getBackfillJobState'),

  regenerateProfiles: (): Promise<RegenerateProfilesResult> =>
    ipcRenderer.invoke('profileAdmin:regenerateProfiles'),

  clearProfiles: (): Promise<ClearProfilesResult> =>
    ipcRenderer.invoke('profileAdmin:clearProfiles'),

  listEpisodes: (): Promise<EpisodicMemoryItem[]> =>
    ipcRenderer.invoke('profileAdmin:listEpisodes'),

  listMemcells: (): Promise<MemCellItem[]> =>
    ipcRenderer.invoke('profileAdmin:listMemcells'),

  listForesights: (): Promise<ForesightItem[]> =>
    ipcRenderer.invoke('profileAdmin:listForesights'),

  updateBackfillProgress: (sessionKey: string, lastProcessedTimestamp: string): Promise<void> =>
    ipcRenderer.invoke('profileAdmin:updateBackfillProgress', sessionKey, lastProcessedTimestamp),

  markSessionDirty: (sessionKey: string): Promise<void> =>
    ipcRenderer.invoke('profileAdmin:markSessionDirty', sessionKey)
}

const maintenanceAPI: MaintenanceAPI = {
  cleanupLocalData: (input: CleanupLocalDataInput): Promise<CleanupLocalDataResult> =>
    ipcRenderer.invoke('maintenance:cleanupLocalData', input)
}

/**
 * Electron API implementation using IPC invoke
 * All methods are type-safe and correspond to main process handlers
 */
const electronAPI: ElectronAPI = {
  // Core initialization
  initialize: (): Promise<AppInitResult> =>
    ipcRenderer.invoke('app:initialize'),

  // Grouped APIs
  import: importAPI,
  monitor: monitorAPI,
  suggestions: suggestionsAPI,
  profile: profileAPI,
  settings: settingsAPI,
  coldStart: coldStartAPI,
  hotRun: hotRunAPI,
  roi: roiAPI,
  assistantWindow: assistantWindowAPI,
  chatRecords: chatRecordsAPI,
  memoryFiles: memoryFilesAPI,
  profileAdmin: profileAdminAPI,
  maintenance: maintenanceAPI,

  // Direct methods
  listContacts: (): Promise<string[]> =>
    ipcRenderer.invoke('contacts:list'),

  checkOllamaHealth: (): Promise<boolean> =>
    ipcRenderer.invoke('ollama:health'),

  // Legacy methods (for backward compatibility)
  submitChat: (logs: string[], contactId: string): Promise<OrchestrationResult> =>
    ipcRenderer.invoke('chat:submit', logs, contactId),

  loadUserProfile: (): Promise<UserProfile> =>
    ipcRenderer.invoke('profile:loadUser'),

  saveUserProfile: (profile: UserProfile): Promise<void> =>
    ipcRenderer.invoke('profile:saveUser', profile),

  loadContactProfile: (contactId: string): Promise<ContactProfile | null> =>
    ipcRenderer.invoke('profile:loadContact', contactId),

  importFile: (): Promise<string | null> =>
    ipcRenderer.invoke('import:file')
}

// ============================================================================
// Expose API to Renderer
// ============================================================================

/**
 * Expose the electronAPI to the renderer process via contextBridge
 * This ensures secure communication between processes
 */
contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// ============================================================================
// Type Augmentation
// ============================================================================

/**
 * Augment the Window interface to include electronAPI
 * This allows TypeScript to recognize window.electronAPI in renderer code
 */
declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
