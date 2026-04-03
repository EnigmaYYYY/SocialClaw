/**
 * Hot Run Service - Orchestrates the real-time monitoring and suggestion flow
 *
 * Connects components for Hot Run:
 * Chat Monitor -> Memory Keeper -> Agent Orchestrator -> UI
 * Profile updates -> Memory Manager
 * Settings changes -> All services
 *
 * Validates: Requirements 3.5, 4.1, 5.1, 6.1
 */
import { EventEmitter } from 'events'
import { ChatMonitorService, ChatMonitorStatus } from './chat-monitor'
import { MemoryManager } from './memory-manager'
import { OllamaClient } from './ollama-client'
import { AgentOrchestrator, OrchestrationResult } from '../agents/orchestrator'
import { MemoryKeeperAgent } from '../agents/memory-keeper-agent'
import { IntentAgent } from '../agents/intent-agent'
import { CoachAgent } from '../agents/coach-agent'
import { ProfilerAgent } from '../agents/profiler-agent'
import { DataCleanerAgent } from '../agents/data-cleaner-agent'
import { ParsedMessage, AppSettings, ContactProfile } from '../models/schemas'

// ============================================================================
// Types
// ============================================================================

export interface HotRunStatus {
  isRunning: boolean
  monitorStatus: ChatMonitorStatus
  currentContact: string | null
  ollamaConnected: boolean
  lastSuggestionTime: number | null
  errorMessage?: string
}

export interface SuggestionUpdate {
  suggestions: OrchestrationResult['suggestions']
  intent: OrchestrationResult['intent']
  contactId: string
  contactProfile: ContactProfile | null
  timestamp: number
}

export type SuggestionCallback = (update: SuggestionUpdate) => void
export type ContactChangeCallback = (contactId: string, profile: ContactProfile | null) => void
export type StatusChangeCallback = (status: HotRunStatus) => void
export type ErrorCallback = (error: Error) => void

// ============================================================================
// HotRunService Class
// ============================================================================

/**
 * HotRunService orchestrates the real-time monitoring and suggestion flow
 *
 * Flow:
 * 1. Chat Monitor detects new messages
 * 2. Memory Keeper maintains context buffer
 * 3. Agent Orchestrator processes messages (Intent -> Coach)
 * 4. UI receives suggestions
 * 5. Profile updates are scheduled and saved
 */
export class HotRunService extends EventEmitter {
  private chatMonitor: ChatMonitorService
  private memoryManager: MemoryManager
  private ollamaClient: OllamaClient
  private orchestrator: AgentOrchestrator
  private memoryKeeperAgent: MemoryKeeperAgent

  private isRunning: boolean = false
  private currentContact: string | null = null
  private lastSuggestionTime: number | null = null
  private settings: AppSettings | null = null

  // Debounce for suggestion generation
  private suggestionDebounceTimer: NodeJS.Timeout | null = null
  private readonly SUGGESTION_DEBOUNCE_MS = 500

  constructor(
    chatMonitor?: ChatMonitorService,
    memoryManager?: MemoryManager,
    ollamaClient?: OllamaClient,
    orchestrator?: AgentOrchestrator
  ) {
    super()
    
    this.chatMonitor = chatMonitor ?? new ChatMonitorService()
    this.memoryManager = memoryManager ?? new MemoryManager()
    this.ollamaClient = ollamaClient ?? new OllamaClient()
    this.memoryKeeperAgent = new MemoryKeeperAgent()

    // Create orchestrator if not provided
    if (orchestrator) {
      this.orchestrator = orchestrator
    } else {
      const intentAgent = new IntentAgent(this.ollamaClient)
      const coachAgent = new CoachAgent(this.ollamaClient)
      const profilerAgent = new ProfilerAgent(this.ollamaClient)
      const dataCleanerAgent = new DataCleanerAgent()

      this.orchestrator = new AgentOrchestrator(
        intentAgent,
        coachAgent,
        profilerAgent,
        this.memoryManager,
        undefined,
        this.memoryKeeperAgent,
        dataCleanerAgent
      )
    }

    // Set up event listeners
    this.setupEventListeners()
  }

  /**
   * Sets up event listeners for chat monitor
   */
  private setupEventListeners(): void {
    // Listen for new messages from chat monitor
    this.chatMonitor.onMessagesChanged(this.handleMessagesChanged.bind(this))

    // Listen for contact changes
    this.chatMonitor.onContactChanged(this.handleContactChanged.bind(this))

    // Listen for monitor status changes
    this.chatMonitor.onStatusChanged(this.handleMonitorStatusChanged.bind(this))

    // Listen for monitor errors
    this.chatMonitor.onError(this.handleMonitorError.bind(this))
  }

  /**
   * Starts the hot run service
   * Initializes chat monitor and begins real-time processing
   *
   * @returns HotRunStatus after starting
   * Validates: Requirements 3.5, 4.1
   */
  async start(): Promise<HotRunStatus> {
    if (this.isRunning) {
      return this.getStatus()
    }

    try {
      // Load settings
      this.settings = await this.memoryManager.loadSettings()

      // Initialize chat monitor
      await this.chatMonitor.initialize()

      // Start monitoring
      this.chatMonitor.startMonitoring()

      this.isRunning = true
      this.emitStatusChange()

      return this.getStatus()
    } catch (error) {
      const errorMsg = `启动热运行服务失败: ${error instanceof Error ? error.message : '未知错误'}`
      this.emit('error', new Error(errorMsg))
      return this.getStatus()
    }
  }

  /**
   * Stops the hot run service
   *
   * @returns HotRunStatus after stopping
   */
  async stop(): Promise<HotRunStatus> {
    if (!this.isRunning) {
      return this.getStatus()
    }

    // Stop monitoring
    this.chatMonitor.stopMonitoring()

    // Cancel pending operations
    this.cancelPendingOperations()

    this.isRunning = false
    this.emitStatusChange()

    return this.getStatus()
  }

  /**
   * Handles new messages from chat monitor
   * Validates: Requirements 3.5, 4.1, 5.1, 6.1
   */
  private async handleMessagesChanged(messages: ParsedMessage[]): Promise<void> {
    if (!this.isRunning || messages.length === 0) {
      return
    }

    const contactId = this.currentContact
    if (!contactId) {
      return
    }

    // Debounce suggestion generation
    if (this.suggestionDebounceTimer) {
      clearTimeout(this.suggestionDebounceTimer)
    }

    this.suggestionDebounceTimer = setTimeout(async () => {
      await this.generateSuggestions(messages, contactId)
    }, this.SUGGESTION_DEBOUNCE_MS)
  }

  /**
   * Generates suggestions for new messages
   */
  private async generateSuggestions(messages: ParsedMessage[], contactId: string): Promise<void> {
    try {
      // Process through orchestrator (Hot Path)
      const result = await this.orchestrator.processNewMessages(messages, contactId)

      // Load contact profile for UI
      const contactProfile = await this.memoryManager.loadContactProfile(contactId)

      this.lastSuggestionTime = Date.now()

      // Emit suggestion update
      const update: SuggestionUpdate = {
        suggestions: result.suggestions,
        intent: result.intent,
        contactId,
        contactProfile,
        timestamp: this.lastSuggestionTime
      }

      this.emit('suggestions', update)
      this.emitStatusChange()
    } catch (error) {
      const errorMsg = `生成建议失败: ${error instanceof Error ? error.message : '未知错误'}`
      this.emit('error', new Error(errorMsg))
    }
  }

  /**
   * Handles contact change from chat monitor
   * Validates: Requirement 3.7
   */
  private async handleContactChanged(contactName: string): Promise<void> {
    const oldContact = this.currentContact
    this.currentContact = contactName

    // Clear context buffer for old contact if switching
    if (oldContact && oldContact !== contactName) {
      // Session will be managed by Memory Keeper's expiry logic
    }

    // Load or create contact profile
    let contactProfile = await this.memoryManager.loadContactProfile(contactName)

    if (!contactProfile) {
      // Contact profile will be created by backend on first process-chat.
      // Emit with null profile; the UI should handle gracefully.
      console.info(`[HotRunService] No profile for "${contactName}" yet; backend will create on first message.`)
    }

    // Emit contact change
    this.emit('contactChanged', contactName, contactProfile)
    this.emitStatusChange()
  }

  /**
   * Handles monitor status changes
   */
  private handleMonitorStatusChanged(_status: ChatMonitorStatus): void {
    this.emitStatusChange()
  }

  /**
   * Handles monitor errors
   */
  private handleMonitorError(error: Error): void {
    this.emit('error', error)
  }

  /**
   * Updates settings and applies changes to all services
   * Validates: Requirement 11.5
   */
  async updateSettings(newSettings: AppSettings): Promise<void> {
    const oldSettings = this.settings
    this.settings = newSettings

    // Save settings
    await this.memoryManager.saveSettings(newSettings)

    // Apply monitor mode change if needed
    if (oldSettings?.monitorMode !== newSettings.monitorMode) {
      // Restart monitor with new mode
      if (this.isRunning) {
        await this.stop()
        await this.start()
      }
    }

    // Apply session expiry change
    if (oldSettings?.sessionExpiryHours !== newSettings.sessionExpiryHours) {
      // Memory Keeper will use the new value on next check
    }

    this.emit('settingsChanged', newSettings)
  }

  /**
   * Manually triggers suggestion generation for current contact
   * Useful for refresh button in UI
   */
  async refreshSuggestions(): Promise<SuggestionUpdate | null> {
    if (!this.currentContact) {
      return null
    }

    const contextBuffer = this.orchestrator.getContextBuffer(this.currentContact)
    
    if (contextBuffer.length === 0) {
      return null
    }

    try {
      const result = await this.orchestrator.processChatLogs(
        contextBuffer,
        this.currentContact
      )

      const contactProfile = await this.memoryManager.loadContactProfile(this.currentContact)

      this.lastSuggestionTime = Date.now()

      const update: SuggestionUpdate = {
        suggestions: result.suggestions,
        intent: result.intent,
        contactId: this.currentContact,
        contactProfile,
        timestamp: this.lastSuggestionTime
      }

      this.emit('suggestions', update)
      return update
    } catch (error) {
      const errorMsg = `刷新建议失败: ${error instanceof Error ? error.message : '未知错误'}`
      this.emit('error', new Error(errorMsg))
      return null
    }
  }

  /**
   * Gets the current status of the hot run service
   */
  getStatus(): HotRunStatus {
    return {
      isRunning: this.isRunning,
      monitorStatus: this.chatMonitor.getStatus(),
      currentContact: this.currentContact,
      ollamaConnected: true, // Will be updated by health check
      lastSuggestionTime: this.lastSuggestionTime
    }
  }

  /**
   * Checks Ollama connectivity
   */
  async checkOllamaHealth(): Promise<boolean> {
    return this.ollamaClient.checkHealth()
  }

  /**
   * Cancels pending operations
   */
  private cancelPendingOperations(): void {
    if (this.suggestionDebounceTimer) {
      clearTimeout(this.suggestionDebounceTimer)
      this.suggestionDebounceTimer = null
    }

    this.orchestrator.cancelAllPendingUpdates()
  }

  /**
   * Emits status change event
   */
  private emitStatusChange(): void {
    this.emit('statusChanged', this.getStatus())
  }

  // ============================================================================
  // Event Registration Methods
  // ============================================================================

  /**
   * Registers a callback for suggestion updates
   */
  onSuggestions(callback: SuggestionCallback): void {
    this.on('suggestions', callback)
  }

  /**
   * Registers a callback for contact changes
   */
  onContactChanged(callback: ContactChangeCallback): void {
    this.on('contactChanged', callback)
  }

  /**
   * Registers a callback for status changes
   */
  onStatusChanged(callback: StatusChangeCallback): void {
    this.on('statusChanged', callback)
  }

  /**
   * Registers a callback for errors
   */
  onError(callback: ErrorCallback): void {
    this.on('error', callback)
  }

  /**
   * Removes a suggestion callback
   */
  offSuggestions(callback: SuggestionCallback): void {
    this.off('suggestions', callback)
  }

  /**
   * Removes a contact change callback
   */
  offContactChanged(callback: ContactChangeCallback): void {
    this.off('contactChanged', callback)
  }

  /**
   * Removes a status change callback
   */
  offStatusChanged(callback: StatusChangeCallback): void {
    this.off('statusChanged', callback)
  }

  /**
   * Removes an error callback
   */
  offError(callback: ErrorCallback): void {
    this.off('error', callback)
  }

  // ============================================================================
  // Getters for Testing
  // ============================================================================

  getChatMonitor(): ChatMonitorService {
    return this.chatMonitor
  }

  getOrchestrator(): AgentOrchestrator {
    return this.orchestrator
  }

  getMemoryManager(): MemoryManager {
    return this.memoryManager
  }

  getCurrentContact(): string | null {
    return this.currentContact
  }

  getSettings(): AppSettings | null {
    return this.settings
  }
}

// Export singleton instance
export const hotRunService = new HotRunService()
