/**
 * Agent Orchestrator - Coordinates agent execution for chat analysis
 *
 * Responsible for:
 * - Hot Path: Memory Keeper -> Intent -> Coach flow for real-time suggestions (Requirements 5.1, 6.1)
 * - Cold Start: Importer -> Cleaner -> Profiler for profile initialization (Requirement 1.5)
 * - Profile updates with 10s debounce (Requirement 5.2)
 * - Parallel execution and error recovery
 *
 * Validates: Requirements 5.1, 6.1, 1.5
 */
import {
  IntentAnalysis,
  Suggestion,
  UserProfile,
  ContactProfile,
  ParsedMessage
} from '../models/schemas'
import { IntentAgent, FALLBACK_INTENT } from './intent-agent'
import { CoachAgent, CoachAgentError } from './coach-agent'
import { ProfilerAgent, ExtractedFacts } from './profiler-agent'
import { MemoryKeeperAgent } from './memory-keeper-agent'
import { DataCleanerAgent } from './data-cleaner-agent'
import { MemoryManager, ProfileNotFoundError } from '../services/memory-manager'
import { DataImporter, DataImportResult } from '../services/data-importer'

// ============================================================================
// Error Types
// ============================================================================

export class OrchestratorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrchestratorError'
  }
}

export class ProfileLoadError extends OrchestratorError {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileLoadError'
  }
}

// ============================================================================
// Types
// ============================================================================

export interface OrchestrationResult {
  suggestions: Suggestion[]
  intent: IntentAnalysis
}

export interface InitializationResult {
  userProfile: UserProfile
  contactProfiles: Map<string, ContactProfile>
  messageCount: number
  contactCount: number
  errors: string[]
}

export interface OrchestratorConfig {
  debounceDelayMs?: number // Default: 10000 (10 seconds)
}

// ============================================================================
// AgentOrchestrator Class
// ============================================================================

/**
 * AgentOrchestrator coordinates the execution of multiple agents
 * to process chat logs and generate suggestions.
 *
 * Hot Path (processChatLogs):
 * 1. Load user and contact profiles in parallel
 * 2. Run Intent Agent to analyze chat
 * 3. Run Coach Agent to generate suggestions
 *
 * Cold Path (scheduleProfileUpdate):
 * 1. Debounce for 10 seconds after last call
 * 2. Run Profiler Agent to extract facts
 * 3. Update contact profile with new facts
 */
export class AgentOrchestrator {
  private intentAgent: IntentAgent
  private coachAgent: CoachAgent
  private profilerAgent: ProfilerAgent
  private memoryKeeperAgent: MemoryKeeperAgent
  private dataCleanerAgent: DataCleanerAgent
  private dataImporter: DataImporter
  private memoryManager: MemoryManager
  private debounceDelayMs: number

  // Debounce state for Cold Path
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map()
  private pendingUpdates: Map<string, { chatLogs: string[] | ParsedMessage[] }> = new Map()

  constructor(
    intentAgent: IntentAgent,
    coachAgent: CoachAgent,
    profilerAgent: ProfilerAgent,
    memoryManager: MemoryManager,
    config?: OrchestratorConfig,
    memoryKeeperAgent?: MemoryKeeperAgent,
    dataCleanerAgent?: DataCleanerAgent,
    dataImporter?: DataImporter
  ) {
    this.intentAgent = intentAgent
    this.coachAgent = coachAgent
    this.profilerAgent = profilerAgent
    this.memoryManager = memoryManager
    this.debounceDelayMs = config?.debounceDelayMs ?? 10000 // 10 seconds default
    
    // Optional agents for extended functionality
    this.memoryKeeperAgent = memoryKeeperAgent ?? new MemoryKeeperAgent()
    this.dataCleanerAgent = dataCleanerAgent ?? new DataCleanerAgent()
    this.dataImporter = dataImporter ?? new DataImporter()
  }

  /**
   * Processes chat logs through the Hot Path
   * Intent Agent -> Coach Agent flow for real-time suggestions
   *
   * @param chatLogs - Array of chat messages (strings or ParsedMessage objects)
   * @param contactId - The contact's unique identifier
   * @returns OrchestrationResult with suggestions and intent analysis
   * @throws OrchestratorError if processing fails
   *
   * Validates: Requirements 2.1, 3.1
   */
  async processChatLogs(
    chatLogs: string[] | ParsedMessage[],
    contactId: string
  ): Promise<OrchestrationResult> {
    // Step 1: Load profiles in parallel
    const [userProfile, contactProfile] = await this.loadProfiles(contactId)

    // Step 2: Run Intent Agent
    let intent: IntentAnalysis
    try {
      intent = await this.intentAgent.analyze(chatLogs)
    } catch (error) {
      // Use fallback intent on error (as per design doc error handling)
      console.error('Intent analysis failed, using fallback:', error)
      intent = FALLBACK_INTENT
    }

    // Step 3: Run Coach Agent
    let suggestions: Suggestion[]
    try {
      suggestions = await this.coachAgent.generateSuggestions({
        intent,
        userProfile,
        contactProfile
      })
    } catch (error) {
      if (error instanceof CoachAgentError) {
        throw new OrchestratorError(`Failed to generate suggestions: ${error.message}`)
      }
      throw error
    }

    return { suggestions, intent }
  }

  /**
   * Processes new messages through the Hot Path
   * Memory Keeper -> Intent Agent -> Coach Agent flow for real-time suggestions
   *
   * This method:
   * 1. Appends new messages to the Memory Keeper's context buffer
   * 2. Checks for session expiry and handles accordingly
   * 3. Gets the full context buffer for analysis
   * 4. Runs Intent Agent to analyze the conversation
   * 5. Runs Coach Agent to generate suggestions
   * 6. Detects profile updates and schedules them
   *
   * @param messages - Array of new ParsedMessage objects
   * @param contactId - The contact's unique identifier
   * @returns OrchestrationResult with suggestions and intent analysis
   * @throws OrchestratorError if processing fails
   *
   * Validates: Requirements 5.1, 6.1
   */
  async processNewMessages(
    messages: ParsedMessage[],
    contactId: string
  ): Promise<OrchestrationResult> {
    // Step 1: Check session expiry - if expired, buffer will be cleared
    const sessionExpired = this.memoryKeeperAgent.checkSessionExpiry(contactId)
    if (sessionExpired) {
      console.log(`Session expired for ${contactId}, starting new session`)
    }

    // Step 2: Append new messages to context buffer
    this.memoryKeeperAgent.appendMessages(contactId, messages)

    // Step 3: Get full context buffer for analysis
    const contextBuffer = this.memoryKeeperAgent.getContextBuffer(contactId)

    // Step 4: Detect profile updates and schedule them
    const profileUpdate = this.memoryKeeperAgent.detectProfileUpdates(contactId, messages)
    if (profileUpdate) {
      this.scheduleProfileUpdate(contextBuffer, contactId)
    }

    // Step 5: Load profiles in parallel
    const [userProfile, contactProfile] = await this.loadProfiles(contactId)

    // Step 6: Run Intent Agent on the full context
    let intent: IntentAnalysis
    try {
      intent = await this.intentAgent.analyze(contextBuffer)
    } catch (error) {
      // Use fallback intent on error (as per design doc error handling)
      console.error('Intent analysis failed, using fallback:', error)
      intent = FALLBACK_INTENT
    }

    // Step 7: Run Coach Agent to generate suggestions
    let suggestions: Suggestion[]
    try {
      suggestions = await this.coachAgent.generateSuggestions({
        intent,
        userProfile,
        contactProfile
      })
    } catch (error) {
      if (error instanceof CoachAgentError) {
        throw new OrchestratorError(`Failed to generate suggestions: ${error.message}`)
      }
      throw error
    }

    return { suggestions, intent }
  }

  /**
   * Initializes profiles from imported data (Cold Start)
   * Importer -> Cleaner -> Profiler flow for profile generation
   *
   * This method:
   * 1. Imports data from the specified path (auto-detects format)
   * 2. Cleans and merges messages using Data Cleaner Agent
   * 3. Generates User Profile from user's messages
   * 4. Generates Contact Profiles for each unique contact
   * 5. Saves all profiles to disk
   *
   * @param dataPath - Path to the data folder or file to import
   * @param selfUserId - The user's own ID (for identifying user's messages)
   * @returns InitializationResult with generated profiles and statistics
   *
   * Validates: Requirements 1.5, 1.6
   */
  async initializeProfiles(
    dataPath: string,
    selfUserId: string = 'self'
  ): Promise<InitializationResult> {
    const result: InitializationResult = {
      userProfile: (await this.memoryManager.loadUserProfile().catch(() => null)) || {
        user_id: selfUserId,
        base_info: { gender: 'other', occupation: '', tone_style: 'friendly' },
        communication_habits: {
          frequent_phrases: [],
          emoji_usage: [],
          punctuation_style: '',
          msg_avg_length: 'short'
        },
        last_updated: Date.now()
      },
      contactProfiles: new Map(),
      messageCount: 0,
      contactCount: 0,
      errors: []
    }

    try {
      // Step 1: Import data
      const importResult: DataImportResult = await this.dataImporter.importData(dataPath, selfUserId)
      
      if (importResult.errors.length > 0) {
        result.errors.push(...importResult.errors)
      }

      if (importResult.messages.length === 0) {
        result.errors.push('No messages found in imported data')
        return result
      }

      result.messageCount = importResult.messages.length

      // Step 2: Clean and merge messages
      const messageBlocks = this.dataCleanerAgent.processMessages(importResult.messages)

      if (messageBlocks.length === 0) {
        result.errors.push('No valid message blocks after cleaning')
        return result
      }

      // Step 3: Generate User Profile
      try {
        const userProfile = await this.profilerAgent.generateUserProfile(messageBlocks)
        result.userProfile = userProfile
        await this.memoryManager.saveUserProfile(userProfile)
      } catch (error) {
        const errorMsg = `Failed to generate user profile: ${error instanceof Error ? error.message : 'Unknown error'}`
        result.errors.push(errorMsg)
        console.error(errorMsg, error)
      }

      // Step 4: Generate Contact Profiles
      try {
        const contactProfiles = await this.profilerAgent.generateContactProfiles(messageBlocks)
        result.contactProfiles = contactProfiles
        result.contactCount = contactProfiles.size

        // Step 5: Save all contact profiles
        for (const [contactName, profile] of contactProfiles) {
          try {
            await this.memoryManager.saveContactProfile(profile.contact_id, profile)
          } catch (error) {
            const errorMsg = `Failed to save profile for ${contactName}: ${error instanceof Error ? error.message : 'Unknown error'}`
            result.errors.push(errorMsg)
            console.error(errorMsg, error)
          }
        }
      } catch (error) {
        const errorMsg = `Failed to generate contact profiles: ${error instanceof Error ? error.message : 'Unknown error'}`
        result.errors.push(errorMsg)
        console.error(errorMsg, error)
      }

    } catch (error) {
      const errorMsg = `Initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      result.errors.push(errorMsg)
      console.error(errorMsg, error)
    }

    return result
  }

  /**
   * Schedules a profile update with debouncing
   * Waits for 10 seconds of idle time before executing (Requirement 5.2)
   *
   * @param chatLogs - Array of chat messages to analyze
   * @param contactId - The contact's unique identifier
   *
   * Validates: Requirement 5.2
   */
  scheduleProfileUpdate(
    chatLogs: string[] | ParsedMessage[],
    contactId: string
  ): void {
    // Cancel any existing timer for this contact
    const existingTimer = this.debounceTimers.get(contactId)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    // Store the pending update
    this.pendingUpdates.set(contactId, { chatLogs })

    // Schedule new timer
    const timer = setTimeout(async () => {
      await this.executeProfileUpdate(contactId)
    }, this.debounceDelayMs)

    this.debounceTimers.set(contactId, timer)
  }

  /**
   * Executes the profile update after debounce period
   * @param contactId - The contact's unique identifier
   */
  private async executeProfileUpdate(contactId: string): Promise<void> {
    // Clean up timer reference
    this.debounceTimers.delete(contactId)

    // Get pending update data
    const pendingUpdate = this.pendingUpdates.get(contactId)
    if (!pendingUpdate) {
      return
    }
    this.pendingUpdates.delete(contactId)

    try {
      // Load existing contact profile
      const contactProfile = await this.memoryManager.loadContactProfile(contactId)
      if (!contactProfile) {
        console.warn(`Contact profile not found for ${contactId}, skipping update`)
        return
      }

      // Run Profiler Agent to extract facts
      const extractedFacts = await this.profilerAgent.extractFacts(
        pendingUpdate.chatLogs,
        contactProfile
      )

      // Update profile if facts were extracted
      if (this.hasExtractedFacts(extractedFacts)) {
        await this.updateContactProfile(contactId, contactProfile, extractedFacts)
      }
    } catch (error) {
      // Log error but don't throw - Cold Path failures shouldn't affect user
      console.error(`Profile update failed for ${contactId}:`, error)
    }
  }

  /**
   * Checks if extracted facts contain any updates
   */
  private hasExtractedFacts(facts: ExtractedFacts): boolean {
    return !!(
      facts.profile ||
      facts.relationshipGraph ||
      facts.chatHistorySummary ||
      facts.riskAssessment
    )
  }

  /**
   * Updates the contact profile with extracted facts.
   * NOTE: In the unified architecture, profile updates are handled by the backend
   * (EverMemOS unified_profiles). This local save is kept only as a stale cache
   * for offline fallback. The backend is the single source of truth.
   */
  private async updateContactProfile(
    contactId: string,
    existingProfile: ContactProfile,
    facts: ExtractedFacts
  ): Promise<void> {
    const updatedProfile = this.profilerAgent.mergeFactsIntoProfile(existingProfile, facts)
    // Save locally as cache only; backend is the authority.
    await this.memoryManager.saveContactProfile(contactId, updatedProfile)
  }

  /**
   * Loads user and contact profiles in parallel
   * Creates contact profile if it doesn't exist
   *
   * @param contactId - The contact's unique identifier
   * @returns Tuple of [UserProfile, ContactProfile]
   * @throws ProfileLoadError if profiles cannot be loaded
   */
  private async loadProfiles(contactId: string): Promise<[UserProfile, ContactProfile]> {
    try {
      const [userProfile, contactProfile] = await Promise.all([
        this.memoryManager.loadUserProfile(),
        this.memoryManager.loadContactProfile(contactId)
      ])

      // If no contact profile exists, the backend will create one on first process-chat.
      // Return a minimal stub so the orchestrator can proceed.
      let finalContactProfile = contactProfile
      if (!finalContactProfile) {
        finalContactProfile = {
          contact_id: contactId,
          nickname: contactId,
          profile: {
            role: '',
            age_group: '',
            personality_tags: [],
            interests: []
          },
          relationship_graph: {
            current_status: '',
            intimacy_level: 'stranger' as const,
            intermediary: { has_intermediary: false }
          },
          chat_history_summary: '',
          risk_assessment: { is_suspicious: false, risk_level: 'low' as const, warning_msg: '' },
          last_updated: Date.now()
        }
      }

      return [userProfile, finalContactProfile]
    } catch (error) {
      if (error instanceof ProfileNotFoundError) {
        throw new ProfileLoadError(error.message)
      }
      throw new ProfileLoadError(
        `Failed to load profiles: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  /**
   * Cancels any pending profile update for a contact
   * Useful for cleanup or when user switches contacts
   *
   * @param contactId - The contact's unique identifier
   */
  cancelPendingUpdate(contactId: string): void {
    const timer = this.debounceTimers.get(contactId)
    if (timer) {
      clearTimeout(timer)
      this.debounceTimers.delete(contactId)
    }
    this.pendingUpdates.delete(contactId)
  }

  /**
   * Cancels all pending profile updates
   * Useful for cleanup on application shutdown
   */
  cancelAllPendingUpdates(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()
    this.pendingUpdates.clear()
  }

  /**
   * Gets the debounce delay in milliseconds
   * Useful for testing
   */
  getDebounceDelayMs(): number {
    return this.debounceDelayMs
  }

  /**
   * Checks if there's a pending update for a contact
   * Useful for testing
   */
  hasPendingUpdate(contactId: string): boolean {
    return this.pendingUpdates.has(contactId)
  }

  /**
   * Gets the number of pending updates
   * Useful for testing
   */
  getPendingUpdateCount(): number {
    return this.pendingUpdates.size
  }

  /**
   * Gets the Memory Keeper Agent instance
   * Useful for testing and direct context buffer access
   */
  getMemoryKeeperAgent(): MemoryKeeperAgent {
    return this.memoryKeeperAgent
  }

  /**
   * Gets the Data Cleaner Agent instance
   * Useful for testing
   */
  getDataCleanerAgent(): DataCleanerAgent {
    return this.dataCleanerAgent
  }

  /**
   * Gets the Data Importer instance
   * Useful for testing
   */
  getDataImporter(): DataImporter {
    return this.dataImporter
  }

  /**
   * Clears all context buffers in the Memory Keeper
   * Useful for cleanup or testing
   */
  clearAllContextBuffers(): void {
    this.memoryKeeperAgent.clearAllBuffers()
  }

  /**
   * Gets the context buffer for a specific contact
   * @param contactId - The contact's unique identifier
   * @returns Array of ParsedMessage in the buffer
   */
  getContextBuffer(contactId: string): ParsedMessage[] {
    return this.memoryKeeperAgent.getContextBuffer(contactId)
  }
}
