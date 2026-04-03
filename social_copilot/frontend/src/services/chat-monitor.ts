/**
 * ChatMonitorService - Coordinates real-time monitoring of WeChat chat window
 *
 * This service provides functionality to:
 * - Initialize with Accessibility or OCR mode (Requirement 3.5)
 * - Detect window content changes via polling (Requirement 3.5)
 * - Implement message deduplication by msgId (Requirement 3.6)
 * - Emit events for message and contact changes (Requirement 3.7)
 */
import { EventEmitter } from 'events'
import { ParsedMessage } from '../models'
import { AccessibilityReader } from './accessibility-reader'
import { OCRReader, ScreenRegion } from './ocr-reader'

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Monitor mode - determines which reader to use
 */
export type MonitorMode = 'accessibility' | 'ocr' | 'unavailable'

/**
 * Status of the chat monitor service
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
 * Configuration options for the chat monitor
 */
export interface ChatMonitorConfig {
  /** Polling interval in milliseconds (default: 1000ms) */
  pollingIntervalMs: number
  /** Preferred monitor mode (default: 'accessibility') */
  preferredMode: 'accessibility' | 'ocr' | 'auto'
  /** OCR language for tesseract (default: 'chi_sim+eng') */
  ocrLanguage: string
}

/**
 * Event types emitted by ChatMonitorService
 */
export interface ChatMonitorEvents {
  messagesChanged: (messages: ParsedMessage[]) => void
  contactChanged: (contact: string) => void
  statusChanged: (status: ChatMonitorStatus) => void
  error: (error: Error) => void
}

// ============================================================================
// Error Types
// ============================================================================

export class ChatMonitorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatMonitorError'
  }
}

export class MonitorNotInitializedError extends ChatMonitorError {
  constructor() {
    super('Chat monitor not initialized. Call initialize() first.')
    this.name = 'MonitorNotInitializedError'
  }
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_CHAT_MONITOR_CONFIG: ChatMonitorConfig = {
  pollingIntervalMs: 1000,
  preferredMode: 'auto',
  ocrLanguage: 'chi_sim+eng'
}

export const LEGACY_CHAT_MONITOR_UNAVAILABLE_MESSAGE =
  'Legacy ChatMonitor (Accessibility/OCRReader) 当前仅支持 macOS。请使用 Visual Monitor API 实时链路。'

// ============================================================================
// ChatMonitorService Class
// ============================================================================

/**
 * ChatMonitorService - Coordinates monitoring of WeChat chat window
 *
 * Validates:
 * - Requirement 3.5: Detect window content changes
 * - Requirement 3.6: Message deduplication
 * - Requirement 3.7: Detect contact changes
 */
export class ChatMonitorService extends EventEmitter {
  private accessibilityReader: AccessibilityReader
  private ocrReader: OCRReader
  private config: ChatMonitorConfig

  private isInitialized: boolean = false
  private isMonitoring: boolean = false
  private currentMode: MonitorMode = 'unavailable'
  private currentContact: string | null = null
  private lastPollTime: number | null = null
  private unavailableReason: string | undefined

  // Message deduplication state
  private seenMessageIds: Set<string> = new Set()
  private lastMessages: ParsedMessage[] = []

  // Polling state
  private pollingTimer: ReturnType<typeof setInterval> | null = null

  constructor(config: Partial<ChatMonitorConfig> = {}) {
    super()
    this.config = { ...DEFAULT_CHAT_MONITOR_CONFIG, ...config }
    this.accessibilityReader = new AccessibilityReader()
    this.ocrReader = new OCRReader()
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  /**
   * Initializes the chat monitor service
   * Determines the best available mode (Accessibility or OCR)
   * Validates: Requirement 3.5
   * @returns MonitorStatus indicating the initialization result
   */
  async initialize(): Promise<ChatMonitorStatus> {
    if (this.isInitialized) {
      return this.getStatus()
    }

    if (process.platform !== 'darwin') {
      this.currentMode = 'unavailable'
      this.isInitialized = false
      this.unavailableReason = LEGACY_CHAT_MONITOR_UNAVAILABLE_MESSAGE
      return this.getStatus()
    }

    try {
      // Determine which mode to use based on preference and availability
      if (this.config.preferredMode === 'accessibility' || this.config.preferredMode === 'auto') {
        // Try accessibility first
        const hasPermission = await this.accessibilityReader.checkPermission()
        if (hasPermission) {
          this.currentMode = 'accessibility'
          this.isInitialized = true
          this.unavailableReason = undefined
          return this.getStatus()
        }
      }

      if (this.config.preferredMode === 'ocr' || this.config.preferredMode === 'auto') {
        // Fall back to OCR
        await this.ocrReader.initialize(this.config.ocrLanguage)
        this.currentMode = 'ocr'
        this.isInitialized = true
        this.unavailableReason = undefined
        return this.getStatus()
      }

      // Neither mode available
      this.currentMode = 'unavailable'
      this.isInitialized = false
      this.unavailableReason =
        'No monitoring mode available. Please grant accessibility permission or enable OCR.'
      return this.getStatus()
    } catch (error) {
      this.currentMode = 'unavailable'
      this.isInitialized = false
      this.unavailableReason = error instanceof Error ? error.message : String(error)
      throw new ChatMonitorError(
        `Failed to initialize chat monitor: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * Terminates the chat monitor and cleans up resources
   */
  async terminate(): Promise<void> {
    this.stopMonitoring()

    if (this.ocrReader) {
      await this.ocrReader.terminate()
    }

    this.isInitialized = false
    this.currentMode = 'unavailable'
    this.unavailableReason = undefined
    this.seenMessageIds.clear()
    this.lastMessages = []
    this.currentContact = null
  }

  // ============================================================================
  // Monitoring Control
  // ============================================================================

  /**
   * Starts monitoring the WeChat window
   * Validates: Requirement 3.5
   */
  startMonitoring(): void {
    if (!this.isInitialized) {
      throw new MonitorNotInitializedError()
    }

    if (this.isMonitoring) {
      return // Already monitoring
    }

    this.isMonitoring = true
    this.pollingTimer = setInterval(() => {
      this.pollForChanges().catch((error) => {
        this.emit('error', error instanceof Error ? error : new Error(String(error)))
      })
    }, this.config.pollingIntervalMs)

    // Emit initial status
    this.emit('statusChanged', this.getStatus())
  }

  /**
   * Stops monitoring the WeChat window
   */
  stopMonitoring(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer)
      this.pollingTimer = null
    }
    this.isMonitoring = false
    this.emit('statusChanged', this.getStatus())
  }

  // ============================================================================
  // Polling and Change Detection
  // ============================================================================

  /**
   * Polls for changes in the WeChat window
   * Detects new messages and contact changes
   * Validates: Requirements 3.5, 3.6, 3.7
   */
  private async pollForChanges(): Promise<void> {
    if (!this.isInitialized || !this.isMonitoring) {
      return
    }

    try {
      this.lastPollTime = Date.now()

      // Get current contact name
      const newContact = await this.getCurrentContact()
      if (newContact !== this.currentContact) {
        const oldContact = this.currentContact
        this.currentContact = newContact

        // Clear message history when contact changes
        if (oldContact !== null && newContact !== null) {
          this.seenMessageIds.clear()
          this.lastMessages = []
        }

        if (newContact) {
          this.emit('contactChanged', newContact)
        }
      }

      // Get current messages
      const messages = await this.readMessages()

      // Deduplicate and find new messages
      const newMessages = this.deduplicateMessages(messages)

      if (newMessages.length > 0) {
        this.lastMessages = messages
        this.emit('messagesChanged', newMessages)
      }
    } catch (error) {
      // Don't stop monitoring on transient errors
      this.emit('error', error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Reads messages using the current mode (Accessibility or OCR)
   * @returns Array of ParsedMessage objects
   */
  private async readMessages(): Promise<ParsedMessage[]> {
    if (this.currentMode === 'accessibility') {
      return this.accessibilityReader.readChatMessages()
    } else if (this.currentMode === 'ocr') {
      // Get WeChat window bounds for OCR
      const windowInfo = await this.accessibilityReader.findWeChatWindow()
      if (!windowInfo) {
        return []
      }

      const region: ScreenRegion = {
        x: windowInfo.bounds.x,
        y: windowInfo.bounds.y,
        width: windowInfo.bounds.width,
        height: windowInfo.bounds.height
      }

      return this.ocrReader.readChatMessagesFromWindow(region)
    }

    return []
  }

  /**
   * Gets the current contact name
   * @returns Contact name or null
   */
  private async getCurrentContact(): Promise<string | null> {
    if (this.currentMode === 'accessibility') {
      return this.accessibilityReader.getCurrentContactName()
    } else if (this.currentMode === 'ocr') {
      // For OCR mode, we still use accessibility to get window title
      // since OCR can't reliably extract the contact name
      try {
        return await this.accessibilityReader.getCurrentContactName()
      } catch {
        return null
      }
    }
    return null
  }

  // ============================================================================
  // Message Deduplication (Property 10)
  // ============================================================================

  /**
   * Deduplicates messages by generating unique IDs and tracking seen messages
   * Validates: Requirement 3.6
   *
   * @param messages - Array of messages to deduplicate
   * @returns Array of new (unseen) messages only
   */
  deduplicateMessages(messages: ParsedMessage[]): ParsedMessage[] {
    const newMessages: ParsedMessage[] = []

    for (const message of messages) {
      const msgId = this.generateMessageId(message)

      if (!this.seenMessageIds.has(msgId)) {
        this.seenMessageIds.add(msgId)
        newMessages.push(message)
      }
    }

    // Limit the size of seenMessageIds to prevent memory growth
    // Keep only the last 1000 message IDs
    if (this.seenMessageIds.size > 1000) {
      const idsArray = Array.from(this.seenMessageIds)
      this.seenMessageIds = new Set(idsArray.slice(-500))
    }

    return newMessages
  }

  /**
   * Generates a unique ID for a message based on its content
   * Uses a combination of timestamp, sender, and content hash
   *
   * @param message - Message to generate ID for
   * @returns Unique message ID string
   */
  generateMessageId(message: ParsedMessage): string {
    // Create a deterministic ID from message properties
    // Format: timestamp_sender_contentHash
    const timestamp = message.timestamp.getTime()
    const sender = message.sender
    const contentHash = this.hashString(message.content)

    return `${timestamp}_${sender}_${contentHash}`
  }

  /**
   * Simple string hash function for content deduplication
   * @param str - String to hash
   * @returns Hash string
   */
  private hashString(str: string): string {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash = hash & hash // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36)
  }

  /**
   * Clears the deduplication state
   * Useful when switching contacts or resetting the monitor
   */
  clearDeduplicationState(): void {
    this.seenMessageIds.clear()
    this.lastMessages = []
  }

  /**
   * Gets the set of seen message IDs (for testing purposes)
   * @returns Set of seen message IDs
   */
  getSeenMessageIds(): Set<string> {
    return new Set(this.seenMessageIds)
  }

  // ============================================================================
  // Public Getters
  // ============================================================================

  /**
   * Gets the current status of the chat monitor
   * @returns ChatMonitorStatus object
   */
  getStatus(): ChatMonitorStatus {
    return {
      mode: this.currentMode,
      hasPermission: this.currentMode !== 'unavailable',
      isMonitoring: this.isMonitoring,
      targetWindow: this.currentContact,
      lastPollTime: this.lastPollTime,
      errorMessage:
        this.currentMode === 'unavailable'
          ? this.unavailableReason ??
            'No monitoring mode available. Please grant accessibility permission or enable OCR.'
          : undefined
    }
  }

  /**
   * Gets the current contact name
   * @returns Current contact name or null
   */
  getCurrentContactName(): string | null {
    return this.currentContact
  }

  /**
   * Gets the last detected messages
   * @returns Array of last detected messages
   */
  getLastMessages(): ParsedMessage[] {
    return [...this.lastMessages]
  }

  /**
   * Gets new messages (deduplicated) from the current view
   * Validates: Requirement 3.6
   * @returns Array of new messages only
   */
  async getNewMessages(): Promise<ParsedMessage[]> {
    if (!this.isInitialized) {
      throw new MonitorNotInitializedError()
    }

    const messages = await this.readMessages()
    return this.deduplicateMessages(messages)
  }

  /**
   * Checks if the monitor is currently active
   * @returns true if monitoring is active
   */
  isActive(): boolean {
    return this.isMonitoring
  }

  /**
   * Gets the current monitor mode
   * @returns Current MonitorMode
   */
  getMode(): MonitorMode {
    return this.currentMode
  }

  // ============================================================================
  // Event Listener Type-Safe Methods
  // ============================================================================

  /**
   * Registers a listener for message changes
   * Validates: Requirement 3.5
   * @param callback - Callback function for new messages
   */
  onMessagesChanged(callback: (messages: ParsedMessage[]) => void): void {
    this.on('messagesChanged', callback)
  }

  /**
   * Registers a listener for contact changes
   * Validates: Requirement 3.7
   * @param callback - Callback function for contact changes
   */
  onContactChanged(callback: (contact: string) => void): void {
    this.on('contactChanged', callback)
  }

  /**
   * Registers a listener for status changes
   * @param callback - Callback function for status changes
   */
  onStatusChanged(callback: (status: ChatMonitorStatus) => void): void {
    this.on('statusChanged', callback)
  }

  /**
   * Registers a listener for errors
   * @param callback - Callback function for errors
   */
  onError(callback: (error: Error) => void): void {
    this.on('error', callback)
  }

  /**
   * Removes a listener for message changes
   * @param callback - Callback function to remove
   */
  offMessagesChanged(callback: (messages: ParsedMessage[]) => void): void {
    this.off('messagesChanged', callback)
  }

  /**
   * Removes a listener for contact changes
   * @param callback - Callback function to remove
   */
  offContactChanged(callback: (contact: string) => void): void {
    this.off('contactChanged', callback)
  }
}
