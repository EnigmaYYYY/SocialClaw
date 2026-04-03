/**
 * MemoryKeeperAgent - Maintains conversation context and triggers profile updates
 *
 * Responsibilities:
 * - Maintain Context Buffer with sliding window (max 50 messages) - Requirement 4.1, 4.2
 * - Check session expiry (3 hours) - Requirement 4.3
 * - Provide context to Intent Analyst - Requirement 4.4
 * - Detect new information for profile updates - Requirement 4.5
 *
 * Reference: chatgpt-on-wechat Session implementation
 */

import { ParsedMessage } from '../models'

// ============================================================================
// Types
// ============================================================================

/**
 * Trigger for profile updates when new information is detected
 */
export interface ProfileUpdateTrigger {
  type: 'new_fact' | 'contradiction'
  field: string
  oldValue?: string
  newValue: string
}

/**
 * Context buffer for a single contact
 */
export interface ContextBuffer {
  contactId: string
  messages: ParsedMessage[]
  lastMessageTime: number
  maxSize: number
}

/**
 * Configuration for MemoryKeeperAgent
 */
export interface MemoryKeeperConfig {
  maxBufferSize: number // Default: 50
  sessionExpiryMs: number // Default: 3 hours in milliseconds
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_BUFFER_SIZE = 50
const DEFAULT_SESSION_EXPIRY_HOURS = 3
const DEFAULT_SESSION_EXPIRY_MS = DEFAULT_SESSION_EXPIRY_HOURS * 60 * 60 * 1000

// Patterns for detecting new information that should trigger profile updates
const NEW_INFO_PATTERNS = [
  // Job/occupation changes
  { pattern: /我换工作了|我跳槽了|我离职了|新工作|入职了/, field: 'occupation', type: 'new_fact' as const },
  { pattern: /我现在在(.+)工作|我在(.+)上班/, field: 'occupation', type: 'new_fact' as const },
  
  // Location changes
  { pattern: /我搬家了|我搬到(.+)了|我现在住在/, field: 'location', type: 'new_fact' as const },
  
  // Relationship status changes
  { pattern: /我结婚了|我订婚了|我分手了|我离婚了/, field: 'relationship_status', type: 'new_fact' as const },
  
  // Life events
  { pattern: /我生孩子了|我当爸爸了|我当妈妈了/, field: 'life_event', type: 'new_fact' as const },
  { pattern: /我毕业了|我考上了|我升职了/, field: 'life_event', type: 'new_fact' as const },
  
  // Contact information
  { pattern: /我换号了|我新号码是|我微信号换了/, field: 'contact_info', type: 'new_fact' as const },
  
  // Interests/hobbies
  { pattern: /我最近在学(.+)|我开始(.+)了|我迷上了/, field: 'interests', type: 'new_fact' as const },
]

// ============================================================================
// MemoryKeeperAgent Class
// ============================================================================

/**
 * MemoryKeeperAgent maintains conversation context buffers for each contact
 * and detects new information that should trigger profile updates.
 */
export class MemoryKeeperAgent {
  private buffers: Map<string, ContextBuffer> = new Map()
  private config: MemoryKeeperConfig

  constructor(config?: Partial<MemoryKeeperConfig>) {
    this.config = {
      maxBufferSize: config?.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE,
      sessionExpiryMs: config?.sessionExpiryMs ?? DEFAULT_SESSION_EXPIRY_MS
    }
  }

  /**
   * Gets the current context buffer for a contact
   * Returns empty array if no buffer exists or session has expired
   * Validates: Requirement 4.4
   *
   * @param contactId - The contact's unique identifier
   * @returns Array of ParsedMessage in chronological order
   */
  getContextBuffer(contactId: string): ParsedMessage[] {
    const buffer = this.buffers.get(contactId)
    if (!buffer) {
      return []
    }

    // Check session expiry before returning
    if (this.checkSessionExpiry(contactId)) {
      return []
    }

    return [...buffer.messages]
  }

  /**
   * Appends new messages to the context buffer
   * Maintains chronological order and enforces max size limit
   * Validates: Requirements 4.1, 4.2
   *
   * @param contactId - The contact's unique identifier
   * @param messages - New messages to append
   */
  appendMessages(contactId: string, messages: ParsedMessage[]): void {
    if (messages.length === 0) {
      return
    }

    let buffer = this.buffers.get(contactId)

    if (!buffer) {
      buffer = {
        contactId,
        messages: [],
        lastMessageTime: 0,
        maxSize: this.config.maxBufferSize
      }
      this.buffers.set(contactId, buffer)
    }

    // Check session expiry - if expired, start fresh
    if (this.isSessionExpired(buffer)) {
      buffer.messages = []
    }

    // Sort incoming messages by timestamp to ensure chronological order
    const sortedMessages = [...messages].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
    )

    // Append messages
    buffer.messages.push(...sortedMessages)

    // Update last message time
    const lastMessage = buffer.messages[buffer.messages.length - 1]
    buffer.lastMessageTime = lastMessage.timestamp.getTime()

    // Enforce max size limit by removing oldest messages
    while (buffer.messages.length > this.config.maxBufferSize) {
      buffer.messages.shift()
    }
  }

  /**
   * Checks if the session has expired and clears buffer if so
   * Session expires after 3 hours of inactivity
   * Validates: Requirement 4.3
   *
   * @param contactId - The contact's unique identifier
   * @returns true if session was expired and cleared, false otherwise
   */
  checkSessionExpiry(contactId: string): boolean {
    const buffer = this.buffers.get(contactId)
    if (!buffer) {
      return false
    }

    if (this.isSessionExpired(buffer)) {
      this.clearBuffer(contactId)
      return true
    }

    return false
  }

  /**
   * Clears the context buffer for a specific contact
   *
   * @param contactId - The contact's unique identifier
   */
  clearBuffer(contactId: string): void {
    this.buffers.delete(contactId)
  }

  /**
   * Clears all context buffers
   */
  clearAllBuffers(): void {
    this.buffers.clear()
  }

  /**
   * Detects new information in messages that should trigger profile updates
   * Validates: Requirement 4.5
   *
   * @param _contactId - The contact's unique identifier (reserved for future use)
   * @param messages - Messages to analyze for new information
   * @returns ProfileUpdateTrigger if new information detected, null otherwise
   */
  detectProfileUpdates(
    _contactId: string,
    messages: ParsedMessage[]
  ): ProfileUpdateTrigger | null {
    // Only analyze messages from the contact (not from user)
    const contactMessages = messages.filter((m) => !m.isFromUser)

    for (const message of contactMessages) {
      const content = message.content

      for (const { pattern, field, type } of NEW_INFO_PATTERNS) {
        const match = content.match(pattern)
        if (match) {
          // Extract the new value if there's a capture group
          const newValue = match[1] || match[0]
          return {
            type,
            field,
            newValue: newValue.trim()
          }
        }
      }
    }

    return null
  }

  /**
   * Gets the buffer size for a contact
   *
   * @param contactId - The contact's unique identifier
   * @returns Number of messages in the buffer
   */
  getBufferSize(contactId: string): number {
    const buffer = this.buffers.get(contactId)
    return buffer?.messages.length ?? 0
  }

  /**
   * Gets the last message time for a contact
   *
   * @param contactId - The contact's unique identifier
   * @returns Timestamp of last message, or 0 if no messages
   */
  getLastMessageTime(contactId: string): number {
    const buffer = this.buffers.get(contactId)
    return buffer?.lastMessageTime ?? 0
  }

  /**
   * Gets the configured max buffer size
   */
  getMaxBufferSize(): number {
    return this.config.maxBufferSize
  }

  /**
   * Gets the configured session expiry time in milliseconds
   */
  getSessionExpiryMs(): number {
    return this.config.sessionExpiryMs
  }

  /**
   * Checks if a buffer's session has expired
   * @private
   */
  private isSessionExpired(buffer: ContextBuffer): boolean {
    if (buffer.messages.length === 0) {
      return false
    }

    const now = Date.now()
    const timeSinceLastMessage = now - buffer.lastMessageTime
    return timeSinceLastMessage > this.config.sessionExpiryMs
  }
}
