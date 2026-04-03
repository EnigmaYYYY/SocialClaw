/**
 * Unit Tests for AgentOrchestrator
 *
 * Tests:
 * - Hot Path flow (Intent -> Coach)
 * - Debounce behavior for Cold Path
 * - Error handling
 *
 * Validates: Requirements 2.1, 3.1
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  AgentOrchestrator,
  OrchestratorError,
  ProfileLoadError
} from './orchestrator'
import { IntentAgent, FALLBACK_INTENT } from './intent-agent'
import { CoachAgent, CoachAgentError } from './coach-agent'
import { ProfilerAgent, ExtractedFacts } from './profiler-agent'
import { MemoryManager } from '../services/memory-manager'
import {
  UserProfile,
  ContactProfile,
  IntentAnalysis,
  Suggestion,
  DEFAULT_USER_PROFILE,
  createDefaultContactProfile
} from '../models/schemas'

// ============================================================================
// Mock Factories
// ============================================================================

const createMockIntentAgent = (mockResult?: IntentAnalysis) => {
  return {
    analyze: vi.fn().mockResolvedValue(
      mockResult ?? { intent: 'greeting', mood: 'friendly', topic: 'general' }
    ),
    buildPrompt: vi.fn(),
    parseResponse: vi.fn(),
    getSystemPrompt: vi.fn(),
    getTemperature: vi.fn().mockReturnValue(0.1)
  } as unknown as IntentAgent
}

const createMockCoachAgent = (mockSuggestions?: Suggestion[]) => {
  return {
    generateSuggestions: vi.fn().mockResolvedValue(
      mockSuggestions ?? [
        { content: 'Reply 1', reason: 'Reason 1' },
        { content: 'Reply 2', reason: 'Reason 2' },
        { content: 'Reply 3', reason: 'Reason 3' }
      ]
    ),
    buildPrompt: vi.fn(),
    parseResponse: vi.fn(),
    getTemperature: vi.fn().mockReturnValue(0.7),
    getSystemPrompt: vi.fn()
  } as unknown as CoachAgent
}

const createMockProfilerAgent = (mockFacts?: ExtractedFacts) => {
  return {
    extractFacts: vi.fn().mockResolvedValue(mockFacts ?? {}),
    buildPrompt: vi.fn(),
    parseResponse: vi.fn(),
    assessRisk: vi.fn(),
    mergeFactsIntoProfile: vi.fn().mockImplementation(
      (profile: ContactProfile, facts: ExtractedFacts) => ({
        ...profile,
        ...(facts.chatHistorySummary && { chat_history_summary: facts.chatHistorySummary })
      })
    ),
    getSystemPrompt: vi.fn(),
    getTemperature: vi.fn().mockReturnValue(0.3)
  } as unknown as ProfilerAgent
}

const createMockMemoryManager = (
  userProfile?: UserProfile,
  contactProfile?: ContactProfile | null
) => {
  return {
    loadUserProfile: vi.fn().mockResolvedValue(userProfile ?? DEFAULT_USER_PROFILE),
    saveUserProfile: vi.fn().mockResolvedValue(undefined),
    loadContactProfile: vi.fn().mockResolvedValue(
      contactProfile ?? createDefaultContactProfile('test-contact', 'Test Contact')
    ),
    saveContactProfile: vi.fn().mockResolvedValue(undefined),
    createContactProfile: vi.fn().mockImplementation((id: string, nickname: string) =>
      Promise.resolve(createDefaultContactProfile(id, nickname))
    ),
    listContacts: vi.fn().mockResolvedValue([]),
    initialize: vi.fn().mockResolvedValue(undefined),
    getBaseDir: vi.fn().mockReturnValue('/mock/path'),
    getContactsDir: vi.fn().mockReturnValue('/mock/path/contacts'),
    updateContactProfile: vi.fn().mockResolvedValue(undefined)
  } as unknown as MemoryManager
}

// ============================================================================
// Hot Path Tests
// ============================================================================

describe('AgentOrchestrator - Hot Path (processChatLogs)', () => {
  let orchestrator: AgentOrchestrator
  let mockIntentAgent: IntentAgent
  let mockCoachAgent: CoachAgent
  let mockProfilerAgent: ProfilerAgent
  let mockMemoryManager: MemoryManager

  beforeEach(() => {
    mockIntentAgent = createMockIntentAgent()
    mockCoachAgent = createMockCoachAgent()
    mockProfilerAgent = createMockProfilerAgent()
    mockMemoryManager = createMockMemoryManager()

    orchestrator = new AgentOrchestrator(
      mockIntentAgent,
      mockCoachAgent,
      mockProfilerAgent,
      mockMemoryManager
    )
  })

  it('should load profiles and run Intent -> Coach flow', async () => {
    const chatLogs = ['Hello!', 'How are you?']
    const contactId = 'test-contact'

    const result = await orchestrator.processChatLogs(chatLogs, contactId)

    // Verify profiles were loaded
    expect(mockMemoryManager.loadUserProfile).toHaveBeenCalled()
    expect(mockMemoryManager.loadContactProfile).toHaveBeenCalledWith(contactId)

    // Verify Intent Agent was called
    expect(mockIntentAgent.analyze).toHaveBeenCalledWith(chatLogs)

    // Verify Coach Agent was called with correct context
    expect(mockCoachAgent.generateSuggestions).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({ intent: 'greeting' }),
        userProfile: expect.any(Object),
        contactProfile: expect.any(Object)
      })
    )

    // Verify result structure
    expect(result.suggestions).toHaveLength(3)
    expect(result.intent).toEqual({ intent: 'greeting', mood: 'friendly', topic: 'general' })
  })

  it('should continue with an ephemeral contact stub if local contact profile does not exist', async () => {
    const mockMM = createMockMemoryManager(DEFAULT_USER_PROFILE, null)
    vi.mocked(mockMM.loadContactProfile).mockResolvedValue(null)

    const newOrchestrator = new AgentOrchestrator(
      mockIntentAgent,
      mockCoachAgent,
      mockProfilerAgent,
      mockMM
    )

    const chatLogs = ['Hello!']
    const contactId = 'new-contact'

    await newOrchestrator.processChatLogs(chatLogs, contactId)

    expect(mockMM.createContactProfile).not.toHaveBeenCalled()
    expect(mockCoachAgent.generateSuggestions).toHaveBeenCalledWith(
      expect.objectContaining({
        contactProfile: expect.objectContaining({
          contact_id: contactId,
          nickname: contactId
        })
      })
    )
  })

  it('should use fallback intent when Intent Agent fails', async () => {
    vi.mocked(mockIntentAgent.analyze).mockRejectedValue(new Error('LLM error'))

    const chatLogs = ['Hello!']
    const contactId = 'test-contact'

    const result = await orchestrator.processChatLogs(chatLogs, contactId)

    // Should use fallback intent
    expect(result.intent).toEqual(FALLBACK_INTENT)

    // Coach Agent should still be called
    expect(mockCoachAgent.generateSuggestions).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: FALLBACK_INTENT
      })
    )
  })

  it('should throw OrchestratorError when Coach Agent fails', async () => {
    vi.mocked(mockCoachAgent.generateSuggestions).mockRejectedValue(
      new CoachAgentError('Failed to generate')
    )

    const chatLogs = ['Hello!']
    const contactId = 'test-contact'

    await expect(orchestrator.processChatLogs(chatLogs, contactId)).rejects.toThrow(
      OrchestratorError
    )
    await expect(orchestrator.processChatLogs(chatLogs, contactId)).rejects.toThrow(
      'Failed to generate suggestions'
    )
  })

  it('should return exactly 3 suggestions (Requirement 3.1)', async () => {
    const chatLogs = ['Hello!']
    const contactId = 'test-contact'

    const result = await orchestrator.processChatLogs(chatLogs, contactId)

    expect(result.suggestions).toHaveLength(3)
    result.suggestions.forEach((suggestion) => {
      expect(suggestion.content).toBeTruthy()
      expect(suggestion.reason).toBeTruthy()
    })
  })

  it('should pass user and contact profiles to Coach Agent', async () => {
    const customUserProfile: UserProfile = {
      ...DEFAULT_USER_PROFILE,
      base_info: { ...DEFAULT_USER_PROFILE.base_info, tone_style: 'professional' }
    }
    const customContactProfile = createDefaultContactProfile('custom', 'Custom Contact')
    customContactProfile.relationship_graph.intimacy_level = 'close'

    mockMemoryManager = createMockMemoryManager(customUserProfile, customContactProfile)
    orchestrator = new AgentOrchestrator(
      mockIntentAgent,
      mockCoachAgent,
      mockProfilerAgent,
      mockMemoryManager
    )

    await orchestrator.processChatLogs(['Hello!'], 'custom')

    expect(mockCoachAgent.generateSuggestions).toHaveBeenCalledWith(
      expect.objectContaining({
        userProfile: expect.objectContaining({
          base_info: expect.objectContaining({ tone_style: 'professional' })
        }),
        contactProfile: expect.objectContaining({
          relationship_graph: expect.objectContaining({ intimacy_level: 'close' })
        })
      })
    )
  })
})

// ============================================================================
// Cold Path / Debounce Tests
// ============================================================================

describe('AgentOrchestrator - Cold Path (scheduleProfileUpdate)', () => {
  let orchestrator: AgentOrchestrator
  let mockIntentAgent: IntentAgent
  let mockCoachAgent: CoachAgent
  let mockProfilerAgent: ProfilerAgent
  let mockMemoryManager: MemoryManager

  beforeEach(() => {
    vi.useFakeTimers()
    mockIntentAgent = createMockIntentAgent()
    mockCoachAgent = createMockCoachAgent()
    mockProfilerAgent = createMockProfilerAgent({
      chatHistorySummary: 'Updated summary'
    })
    mockMemoryManager = createMockMemoryManager()

    orchestrator = new AgentOrchestrator(
      mockIntentAgent,
      mockCoachAgent,
      mockProfilerAgent,
      mockMemoryManager,
      { debounceDelayMs: 1000 } // 1 second for faster tests
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    orchestrator.cancelAllPendingUpdates()
  })

  it('should debounce profile updates (Requirement 5.2)', async () => {
    const chatLogs = ['Hello!']
    const contactId = 'test-contact'

    // Schedule multiple updates
    orchestrator.scheduleProfileUpdate(chatLogs, contactId)
    orchestrator.scheduleProfileUpdate(chatLogs, contactId)
    orchestrator.scheduleProfileUpdate(chatLogs, contactId)

    // Profiler should not be called yet
    expect(mockProfilerAgent.extractFacts).not.toHaveBeenCalled()

    // Advance time past debounce delay
    await vi.advanceTimersByTimeAsync(1100)

    // Profiler should be called only once
    expect(mockProfilerAgent.extractFacts).toHaveBeenCalledTimes(1)
  })

  it('should reset debounce timer on new update', async () => {
    const chatLogs = ['Hello!']
    const contactId = 'test-contact'

    orchestrator.scheduleProfileUpdate(chatLogs, contactId)

    // Advance time partially
    await vi.advanceTimersByTimeAsync(500)

    // Schedule another update (should reset timer)
    orchestrator.scheduleProfileUpdate(['New message'], contactId)

    // Advance time past original debounce
    await vi.advanceTimersByTimeAsync(600)

    // Should not have been called yet
    expect(mockProfilerAgent.extractFacts).not.toHaveBeenCalled()

    // Advance past new debounce
    await vi.advanceTimersByTimeAsync(500)

    // Now it should be called
    expect(mockProfilerAgent.extractFacts).toHaveBeenCalledTimes(1)
  })

  it('should handle multiple contacts independently', async () => {
    orchestrator.scheduleProfileUpdate(['Hello!'], 'contact-1')
    orchestrator.scheduleProfileUpdate(['Hi!'], 'contact-2')

    await vi.advanceTimersByTimeAsync(1100)

    // Both should be processed
    expect(mockProfilerAgent.extractFacts).toHaveBeenCalledTimes(2)
  })

  it('should save updated profile after extraction', async () => {
    const contactProfile = createDefaultContactProfile('test', 'Test')
    mockMemoryManager = createMockMemoryManager(DEFAULT_USER_PROFILE, contactProfile)
    orchestrator = new AgentOrchestrator(
      mockIntentAgent,
      mockCoachAgent,
      mockProfilerAgent,
      mockMemoryManager,
      { debounceDelayMs: 1000 }
    )

    orchestrator.scheduleProfileUpdate(['Hello!'], 'test')
    await vi.advanceTimersByTimeAsync(1100)

    expect(mockMemoryManager.saveContactProfile).toHaveBeenCalled()
  })

  it('should not save profile if no facts extracted', async () => {
    mockProfilerAgent = createMockProfilerAgent({}) // Empty facts
    orchestrator = new AgentOrchestrator(
      mockIntentAgent,
      mockCoachAgent,
      mockProfilerAgent,
      mockMemoryManager,
      { debounceDelayMs: 1000 }
    )

    orchestrator.scheduleProfileUpdate(['Hello!'], 'test-contact')
    await vi.advanceTimersByTimeAsync(1100)

    expect(mockMemoryManager.saveContactProfile).not.toHaveBeenCalled()
  })

  it('should handle missing contact profile gracefully', async () => {
    // Create a new mock that returns null for contact profile
    const mockMM = createMockMemoryManager(DEFAULT_USER_PROFILE, null)
    vi.mocked(mockMM.loadContactProfile).mockResolvedValue(null)
    
    const newOrchestrator = new AgentOrchestrator(
      createMockIntentAgent(),
      createMockCoachAgent(),
      mockProfilerAgent,
      mockMM,
      { debounceDelayMs: 1000 }
    )

    newOrchestrator.scheduleProfileUpdate(['Hello!'], 'missing-contact')
    await vi.advanceTimersByTimeAsync(1100)

    // Should not throw, just skip - profiler should not be called
    expect(mockProfilerAgent.extractFacts).not.toHaveBeenCalled()
    
    // Cleanup
    newOrchestrator.cancelAllPendingUpdates()
  })

  it('should use default 10 second debounce delay', () => {
    const defaultOrchestrator = new AgentOrchestrator(
      mockIntentAgent,
      mockCoachAgent,
      mockProfilerAgent,
      mockMemoryManager
    )

    expect(defaultOrchestrator.getDebounceDelayMs()).toBe(10000)
  })

  it('should allow custom debounce delay', () => {
    const customOrchestrator = new AgentOrchestrator(
      mockIntentAgent,
      mockCoachAgent,
      mockProfilerAgent,
      mockMemoryManager,
      { debounceDelayMs: 5000 }
    )

    expect(customOrchestrator.getDebounceDelayMs()).toBe(5000)
  })
})

// ============================================================================
// Cancellation Tests
// ============================================================================

describe('AgentOrchestrator - Cancellation', () => {
  let orchestrator: AgentOrchestrator
  let mockProfilerAgent: ProfilerAgent
  let mockMemoryManager: MemoryManager

  beforeEach(() => {
    vi.useFakeTimers()
    mockProfilerAgent = createMockProfilerAgent()
    mockMemoryManager = createMockMemoryManager()

    orchestrator = new AgentOrchestrator(
      createMockIntentAgent(),
      createMockCoachAgent(),
      mockProfilerAgent,
      mockMemoryManager,
      { debounceDelayMs: 1000 }
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should cancel pending update for specific contact', async () => {
    orchestrator.scheduleProfileUpdate(['Hello!'], 'contact-1')
    expect(orchestrator.hasPendingUpdate('contact-1')).toBe(true)

    orchestrator.cancelPendingUpdate('contact-1')
    expect(orchestrator.hasPendingUpdate('contact-1')).toBe(false)

    await vi.advanceTimersByTimeAsync(1100)
    expect(mockProfilerAgent.extractFacts).not.toHaveBeenCalled()
  })

  it('should cancel all pending updates', async () => {
    orchestrator.scheduleProfileUpdate(['Hello!'], 'contact-1')
    orchestrator.scheduleProfileUpdate(['Hi!'], 'contact-2')
    expect(orchestrator.getPendingUpdateCount()).toBe(2)

    orchestrator.cancelAllPendingUpdates()
    expect(orchestrator.getPendingUpdateCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(1100)
    expect(mockProfilerAgent.extractFacts).not.toHaveBeenCalled()
  })
})

// ============================================================================
// Error Handling Tests
// ============================================================================

describe('AgentOrchestrator - Error Handling', () => {
  let orchestrator: AgentOrchestrator
  let mockIntentAgent: IntentAgent
  let mockCoachAgent: CoachAgent
  let mockProfilerAgent: ProfilerAgent
  let mockMemoryManager: MemoryManager

  beforeEach(() => {
    vi.useFakeTimers()
    mockIntentAgent = createMockIntentAgent()
    mockCoachAgent = createMockCoachAgent()
    mockProfilerAgent = createMockProfilerAgent()
    mockMemoryManager = createMockMemoryManager()

    orchestrator = new AgentOrchestrator(
      mockIntentAgent,
      mockCoachAgent,
      mockProfilerAgent,
      mockMemoryManager,
      { debounceDelayMs: 1000 }
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    orchestrator.cancelAllPendingUpdates()
  })

  it('should throw ProfileLoadError when profile loading fails', async () => {
    vi.mocked(mockMemoryManager.loadUserProfile).mockRejectedValue(
      new Error('File system error')
    )

    await expect(
      orchestrator.processChatLogs(['Hello!'], 'test-contact')
    ).rejects.toThrow(ProfileLoadError)
  })

  it('should handle Profiler Agent errors gracefully in Cold Path', async () => {
    vi.mocked(mockProfilerAgent.extractFacts).mockRejectedValue(
      new Error('LLM error')
    )

    // Should not throw
    orchestrator.scheduleProfileUpdate(['Hello!'], 'test-contact')
    await vi.advanceTimersByTimeAsync(1100)

    // Error should be logged but not thrown
    expect(mockMemoryManager.saveContactProfile).not.toHaveBeenCalled()
  })

  it('should re-throw non-CoachAgentError errors from Coach Agent', async () => {
    const customError = new Error('Unexpected error')
    vi.mocked(mockCoachAgent.generateSuggestions).mockRejectedValue(customError)

    await expect(
      orchestrator.processChatLogs(['Hello!'], 'test-contact')
    ).rejects.toThrow('Unexpected error')
  })
})

// ============================================================================
// processNewMessages Tests (Hot Path with Memory Keeper)
// ============================================================================

describe('AgentOrchestrator - processNewMessages (Hot Path)', () => {
  let orchestrator: AgentOrchestrator
  let mockIntentAgent: IntentAgent
  let mockCoachAgent: CoachAgent
  let mockProfilerAgent: ProfilerAgent
  let mockMemoryManager: MemoryManager

  beforeEach(() => {
    mockIntentAgent = createMockIntentAgent()
    mockCoachAgent = createMockCoachAgent()
    mockProfilerAgent = createMockProfilerAgent()
    mockMemoryManager = createMockMemoryManager()

    orchestrator = new AgentOrchestrator(
      mockIntentAgent,
      mockCoachAgent,
      mockProfilerAgent,
      mockMemoryManager
    )
  })

  afterEach(() => {
    orchestrator.cancelAllPendingUpdates()
    orchestrator.clearAllContextBuffers()
  })

  it('should append messages to context buffer and process through Intent -> Coach', async () => {
    const messages = [
      { timestamp: new Date(), sender: 'friend', content: 'Hello!', isFromUser: false },
      { timestamp: new Date(), sender: 'self', content: 'Hi there!', isFromUser: true }
    ]
    const contactId = 'test-contact'

    const result = await orchestrator.processNewMessages(messages, contactId)

    // Verify Intent Agent was called with context buffer
    expect(mockIntentAgent.analyze).toHaveBeenCalled()

    // Verify Coach Agent was called
    expect(mockCoachAgent.generateSuggestions).toHaveBeenCalled()

    // Verify result structure
    expect(result.suggestions).toHaveLength(3)
    expect(result.intent).toBeDefined()
  })

  it('should accumulate messages in context buffer across multiple calls', async () => {
    const contactId = 'test-contact'

    // First batch of messages
    await orchestrator.processNewMessages(
      [{ timestamp: new Date(), sender: 'friend', content: 'Hello!', isFromUser: false }],
      contactId
    )

    // Second batch of messages
    await orchestrator.processNewMessages(
      [{ timestamp: new Date(), sender: 'self', content: 'Hi!', isFromUser: true }],
      contactId
    )

    // Context buffer should have both messages
    const buffer = orchestrator.getContextBuffer(contactId)
    expect(buffer.length).toBe(2)
  })

  it('should use fallback intent when Intent Agent fails', async () => {
    vi.mocked(mockIntentAgent.analyze).mockRejectedValue(new Error('LLM error'))

    const messages = [
      { timestamp: new Date(), sender: 'friend', content: 'Hello!', isFromUser: false }
    ]

    const result = await orchestrator.processNewMessages(messages, 'test-contact')

    expect(result.intent).toEqual(FALLBACK_INTENT)
    expect(mockCoachAgent.generateSuggestions).toHaveBeenCalled()
  })

  it('should throw OrchestratorError when Coach Agent fails', async () => {
    vi.mocked(mockCoachAgent.generateSuggestions).mockRejectedValue(
      new CoachAgentError('Failed to generate')
    )

    const messages = [
      { timestamp: new Date(), sender: 'friend', content: 'Hello!', isFromUser: false }
    ]

    await expect(
      orchestrator.processNewMessages(messages, 'test-contact')
    ).rejects.toThrow(OrchestratorError)
  })

  it('should return exactly 3 suggestions (Requirement 6.1)', async () => {
    const messages = [
      { timestamp: new Date(), sender: 'friend', content: 'Hello!', isFromUser: false }
    ]

    const result = await orchestrator.processNewMessages(messages, 'test-contact')

    expect(result.suggestions).toHaveLength(3)
    result.suggestions.forEach((suggestion) => {
      expect(suggestion.content).toBeTruthy()
      expect(suggestion.reason).toBeTruthy()
    })
  })
})

// ============================================================================
// initializeProfiles Tests (Cold Start)
// ============================================================================

describe('AgentOrchestrator - initializeProfiles (Cold Start)', () => {
  let orchestrator: AgentOrchestrator
  let mockIntentAgent: IntentAgent
  let mockCoachAgent: CoachAgent
  let mockProfilerAgent: ProfilerAgent
  let mockMemoryManager: MemoryManager

  beforeEach(() => {
    mockIntentAgent = createMockIntentAgent()
    mockCoachAgent = createMockCoachAgent()
    mockProfilerAgent = {
      ...createMockProfilerAgent(),
      generateUserProfile: vi.fn().mockResolvedValue({
        user_id: 'self',
        base_info: { gender: 'other', occupation: '', tone_style: 'friendly' },
        communication_habits: {
          frequent_phrases: ['哈哈'],
          emoji_usage: ['😊'],
          punctuation_style: '常用感叹号',
          msg_avg_length: 'short'
        },
        last_updated: Date.now()
      }),
      generateContactProfiles: vi.fn().mockResolvedValue(
        new Map([
          ['friend1', createDefaultContactProfile('contact_1', 'friend1')],
          ['friend2', createDefaultContactProfile('contact_2', 'friend2')]
        ])
      )
    } as unknown as ProfilerAgent
    mockMemoryManager = createMockMemoryManager()

    orchestrator = new AgentOrchestrator(
      mockIntentAgent,
      mockCoachAgent,
      mockProfilerAgent,
      mockMemoryManager
    )
  })

  it('should return error when data path has no messages', async () => {
    // Mock the data importer to return empty messages
    const dataImporter = orchestrator.getDataImporter()
    vi.spyOn(dataImporter, 'importData').mockResolvedValue({
      format: 'unknown',
      messages: [],
      contacts: [],
      errors: ['Unable to detect data format']
    })

    const result = await orchestrator.initializeProfiles('/nonexistent/path')

    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.messageCount).toBe(0)
  })

  it('should return initialization result with user profile and contact profiles', async () => {
    // Mock the data importer to return some messages
    const dataImporter = orchestrator.getDataImporter()
    vi.spyOn(dataImporter, 'importData').mockResolvedValue({
      format: 'wechatmsg_csv',
      messages: [
        { msgId: '1', msgType: 1, content: 'Hello', fromUser: 'friend1', toUser: 'self', createTime: 1000, isSend: false },
        { msgId: '2', msgType: 1, content: 'Hi', fromUser: 'self', toUser: 'friend1', createTime: 1001, isSend: true }
      ],
      contacts: ['friend1'],
      errors: []
    })

    const result = await orchestrator.initializeProfiles('/mock/path')

    expect(result.userProfile).toBeDefined()
    expect(result.contactProfiles.size).toBe(2)
    expect(result.messageCount).toBe(2)
    expect(result.contactCount).toBe(2)
  })

  it('should save user profile to memory manager', async () => {
    const dataImporter = orchestrator.getDataImporter()
    vi.spyOn(dataImporter, 'importData').mockResolvedValue({
      format: 'wechatmsg_csv',
      messages: [
        { msgId: '1', msgType: 1, content: 'Hello', fromUser: 'friend1', toUser: 'self', createTime: 1000, isSend: false }
      ],
      contacts: ['friend1'],
      errors: []
    })

    await orchestrator.initializeProfiles('/mock/path')

    expect(mockMemoryManager.saveUserProfile).toHaveBeenCalled()
  })

  it('should save contact profiles to memory manager', async () => {
    const dataImporter = orchestrator.getDataImporter()
    vi.spyOn(dataImporter, 'importData').mockResolvedValue({
      format: 'wechatmsg_csv',
      messages: [
        { msgId: '1', msgType: 1, content: 'Hello', fromUser: 'friend1', toUser: 'self', createTime: 1000, isSend: false }
      ],
      contacts: ['friend1'],
      errors: []
    })

    await orchestrator.initializeProfiles('/mock/path')

    // Should save each contact profile
    expect(mockMemoryManager.saveContactProfile).toHaveBeenCalledTimes(2)
  })

  it('should handle profiler errors gracefully and continue', async () => {
    const dataImporter = orchestrator.getDataImporter()
    vi.spyOn(dataImporter, 'importData').mockResolvedValue({
      format: 'wechatmsg_csv',
      messages: [
        { msgId: '1', msgType: 1, content: 'Hello', fromUser: 'friend1', toUser: 'self', createTime: 1000, isSend: false }
      ],
      contacts: ['friend1'],
      errors: []
    })

    // Make generateUserProfile fail
    vi.mocked(mockProfilerAgent.generateUserProfile).mockRejectedValue(new Error('LLM error'))

    const result = await orchestrator.initializeProfiles('/mock/path')

    // Should have error but not throw
    expect(result.errors.some(e => e.includes('Failed to generate user profile'))).toBe(true)
  })
})
