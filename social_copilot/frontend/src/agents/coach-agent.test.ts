/**
 * Unit Tests for CoachAgent
 *
 * Tests:
 * - Prompt construction with different profiles
 * - Response parsing
 * - Suggestion count validation
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  CoachAgent,
  CoachContext,
  SuggestionParseError,
  buildCoachSystemPrompt
} from './coach-agent'
import { OllamaClient, OllamaConnectionError } from '../services/ollama-client'
import {
  IntentAnalysis,
  UserProfile,
  ContactProfile,
  DEFAULT_USER_PROFILE,
  createDefaultContactProfile
} from '../models/schemas'

// ============================================================================
// Test Fixtures
// ============================================================================

const createTestUserProfile = (overrides: Partial<UserProfile> = {}): UserProfile => ({
  ...DEFAULT_USER_PROFILE,
  base_info: {
    ...DEFAULT_USER_PROFILE.base_info,
    occupation: 'Software Engineer',
    tone_style: 'friendly, casual',
    ...overrides.base_info
  },
  communication_habits: {
    ...DEFAULT_USER_PROFILE.communication_habits,
    ...overrides.communication_habits
  },
  ...overrides
})

const createTestContactProfile = (
  intimacyLevel: 'stranger' | 'formal' | 'close' | 'intimate' = 'close'
): ContactProfile => {
  const profile = createDefaultContactProfile('test-contact', 'Test Contact')
  profile.relationship_graph.intimacy_level = intimacyLevel
  profile.profile.role = 'colleague'
  profile.profile.age_group = '25-35'
  profile.profile.personality_tags = ['friendly', 'helpful']
  profile.profile.interests = ['technology', 'music']
  return profile
}

const createTestIntent = (): IntentAnalysis => ({
  intent: 'requesting_help',
  mood: 'anxious',
  topic: 'project_deadline'
})

const createTestContext = (
  intimacyLevel: 'stranger' | 'formal' | 'close' | 'intimate' = 'close'
): CoachContext => ({
  intent: createTestIntent(),
  userProfile: createTestUserProfile(),
  contactProfile: createTestContactProfile(intimacyLevel)
})

const VALID_SUGGESTIONS_RESPONSE = JSON.stringify([
  { content: 'I understand your concern. Let me help you with that.', reason: 'Shows empathy and offers assistance' },
  { content: 'No worries, we can work through this together.', reason: 'Reassuring and collaborative tone' },
  { content: 'Let me check on that and get back to you shortly.', reason: 'Professional and action-oriented' }
])

// ============================================================================
// Mock OllamaClient
// ============================================================================

const createMockOllamaClient = (mockResponse?: string) => {
  return {
    generate: vi.fn().mockResolvedValue({
      model: 'qwen3:8b',
      response: mockResponse ?? VALID_SUGGESTIONS_RESPONSE,
      done: true
    }),
    checkHealth: vi.fn().mockResolvedValue(true),
    buildRequest: vi.fn(),
    buildIntentAgentRequest: vi.fn(),
    buildCoachAgentRequest: vi.fn(),
    getConfig: vi.fn()
  } as unknown as OllamaClient
}


// ============================================================================
// System Prompt Construction Tests
// ============================================================================

describe('CoachAgent - System Prompt Construction', () => {
  it('should include user profile information in system prompt', () => {
    const userProfile = createTestUserProfile({
      base_info: {
        gender: 'male',
        occupation: 'Product Manager',
        tone_style: 'professional, warm'
      }
    })
    const contactProfile = createTestContactProfile('formal')

    const prompt = buildCoachSystemPrompt(userProfile, contactProfile)

    expect(prompt).toContain('Gender: male')
    expect(prompt).toContain('Occupation: Product Manager')
    expect(prompt).toContain('Preferred tone style: professional, warm')
  })

  it('should include contact profile information in system prompt', () => {
    const userProfile = createTestUserProfile()
    const contactProfile = createTestContactProfile('close')
    contactProfile.nickname = 'Alice'
    contactProfile.profile.role = 'friend'
    contactProfile.profile.personality_tags = ['outgoing', 'creative']

    const prompt = buildCoachSystemPrompt(userProfile, contactProfile)

    expect(prompt).toContain('Nickname: Alice')
    expect(prompt).toContain('Role: friend')
    expect(prompt).toContain('outgoing, creative')
  })

  it('should adapt tone for stranger intimacy level (Requirement 3.4)', () => {
    const userProfile = createTestUserProfile()
    const contactProfile = createTestContactProfile('stranger')

    const prompt = buildCoachSystemPrompt(userProfile, contactProfile)

    expect(prompt).toContain('Intimacy level: stranger')
    expect(prompt).toContain('polite and reserved')
  })

  it('should adapt tone for formal intimacy level (Requirement 3.4)', () => {
    const userProfile = createTestUserProfile()
    const contactProfile = createTestContactProfile('formal')

    const prompt = buildCoachSystemPrompt(userProfile, contactProfile)

    expect(prompt).toContain('Intimacy level: formal')
    expect(prompt).toContain('professional and respectful')
    expect(prompt).toContain('formal language')
  })

  it('should adapt tone for close intimacy level (Requirement 3.5)', () => {
    const userProfile = createTestUserProfile()
    const contactProfile = createTestContactProfile('close')

    const prompt = buildCoachSystemPrompt(userProfile, contactProfile)

    expect(prompt).toContain('Intimacy level: close')
    expect(prompt).toContain('warm and friendly')
    expect(prompt).toContain('casual language')
  })

  it('should adapt tone for intimate intimacy level (Requirement 3.5)', () => {
    const userProfile = createTestUserProfile()
    const contactProfile = createTestContactProfile('intimate')

    const prompt = buildCoachSystemPrompt(userProfile, contactProfile)

    expect(prompt).toContain('Intimacy level: intimate')
    expect(prompt).toContain('very casual and affectionate')
  })

  it('should include chat history summary when available', () => {
    const userProfile = createTestUserProfile()
    const contactProfile = createTestContactProfile('close')
    contactProfile.chat_history_summary = 'Previously discussed project deadlines and weekend plans'

    const prompt = buildCoachSystemPrompt(userProfile, contactProfile)

    expect(prompt).toContain('Chat history summary: Previously discussed project deadlines')
  })

  it('should include frequent phrases when available', () => {
    const userProfile = createTestUserProfile({
      communication_habits: {
        frequent_phrases: ['sounds good', 'no problem'],
        emoji_usage: [],
        punctuation_style: '',
        msg_avg_length: 'short'
      }
    })
    const contactProfile = createTestContactProfile('close')

    const prompt = buildCoachSystemPrompt(userProfile, contactProfile)

    // Updated to match new format with Chinese annotation
    expect(prompt).toContain('Frequent phrases (口头禅): sounds good, no problem')
  })

  it('should request exactly 3 suggestions in prompt', () => {
    const userProfile = createTestUserProfile()
    const contactProfile = createTestContactProfile('close')

    const prompt = buildCoachSystemPrompt(userProfile, contactProfile)

    expect(prompt).toContain('exactly 3 reply suggestions')
    expect(prompt).toContain('exactly 3 suggestion objects')
  })
})

// ============================================================================
// Prompt Building Tests
// ============================================================================

describe('CoachAgent - Prompt Building', () => {
  let agent: CoachAgent
  let mockClient: OllamaClient

  beforeEach(() => {
    mockClient = createMockOllamaClient()
    agent = new CoachAgent(mockClient)
  })

  it('should build prompt with intent analysis', () => {
    const intent: IntentAnalysis = {
      intent: 'making_plans',
      mood: 'excited',
      topic: 'weekend_activities'
    }

    const prompt = agent.buildPrompt(intent)

    expect(prompt).toContain('Intent: making_plans')
    expect(prompt).toContain('Mood: excited')
    expect(prompt).toContain('Topic: weekend_activities')
    expect(prompt).toContain('generate 3 high-EQ reply suggestions')
  })
})


// ============================================================================
// Response Parsing Tests
// ============================================================================

describe('CoachAgent - Response Parsing', () => {
  let agent: CoachAgent
  let mockClient: OllamaClient

  beforeEach(() => {
    mockClient = createMockOllamaClient()
    agent = new CoachAgent(mockClient)
  })

  it('should parse valid JSON array response', () => {
    const response = JSON.stringify([
      { content: 'Reply 1', reason: 'Reason 1' },
      { content: 'Reply 2', reason: 'Reason 2' },
      { content: 'Reply 3', reason: 'Reason 3' }
    ])

    const result = agent.parseResponse(response)

    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ content: 'Reply 1', reason: 'Reason 1' })
    expect(result[1]).toEqual({ content: 'Reply 2', reason: 'Reason 2' })
    expect(result[2]).toEqual({ content: 'Reply 3', reason: 'Reason 3' })
  })

  it('should parse JSON wrapped in markdown code blocks', () => {
    const response = '```json\n' + JSON.stringify([
      { content: 'Reply 1', reason: 'Reason 1' },
      { content: 'Reply 2', reason: 'Reason 2' },
      { content: 'Reply 3', reason: 'Reason 3' }
    ]) + '\n```'

    const result = agent.parseResponse(response)

    expect(result).toHaveLength(3)
  })

  it('should parse JSON with surrounding text', () => {
    const response = 'Here are the suggestions:\n' + JSON.stringify([
      { content: 'Reply 1', reason: 'Reason 1' },
      { content: 'Reply 2', reason: 'Reason 2' },
      { content: 'Reply 3', reason: 'Reason 3' }
    ]) + '\nHope these help!'

    const result = agent.parseResponse(response)

    expect(result).toHaveLength(3)
  })

  it('should throw SuggestionParseError for response without JSON array', () => {
    const response = 'I cannot generate suggestions for this conversation.'

    expect(() => agent.parseResponse(response)).toThrow(SuggestionParseError)
    expect(() => agent.parseResponse(response)).toThrow('No JSON array found')
  })

  it('should throw SuggestionParseError for non-array JSON (Requirement 3.1)', () => {
    const response = '{"content": "Reply", "reason": "Reason"}'

    expect(() => agent.parseResponse(response)).toThrow(SuggestionParseError)
    expect(() => agent.parseResponse(response)).toThrow('No JSON array found')
  })

  it('should throw SuggestionParseError for wrong suggestion count (Requirement 3.1)', () => {
    const response = JSON.stringify([
      { content: 'Reply 1', reason: 'Reason 1' },
      { content: 'Reply 2', reason: 'Reason 2' }
    ])

    expect(() => agent.parseResponse(response)).toThrow(SuggestionParseError)
    expect(() => agent.parseResponse(response)).toThrow('Expected exactly 3 suggestions, got 2')
  })

  it('should throw SuggestionParseError for too many suggestions', () => {
    const response = JSON.stringify([
      { content: 'Reply 1', reason: 'Reason 1' },
      { content: 'Reply 2', reason: 'Reason 2' },
      { content: 'Reply 3', reason: 'Reason 3' },
      { content: 'Reply 4', reason: 'Reason 4' }
    ])

    expect(() => agent.parseResponse(response)).toThrow(SuggestionParseError)
    expect(() => agent.parseResponse(response)).toThrow('Expected exactly 3 suggestions, got 4')
  })

  it('should throw SuggestionParseError for empty content (Requirement 3.2)', () => {
    const response = JSON.stringify([
      { content: '', reason: 'Reason 1' },
      { content: 'Reply 2', reason: 'Reason 2' },
      { content: 'Reply 3', reason: 'Reason 3' }
    ])

    expect(() => agent.parseResponse(response)).toThrow(SuggestionParseError)
    expect(() => agent.parseResponse(response)).toThrow('Invalid suggestion at index 0')
  })

  it('should throw SuggestionParseError for empty reason (Requirement 3.2)', () => {
    const response = JSON.stringify([
      { content: 'Reply 1', reason: '' },
      { content: 'Reply 2', reason: 'Reason 2' },
      { content: 'Reply 3', reason: 'Reason 3' }
    ])

    expect(() => agent.parseResponse(response)).toThrow(SuggestionParseError)
    expect(() => agent.parseResponse(response)).toThrow('Invalid suggestion at index 0')
  })

  it('should throw SuggestionParseError for missing fields', () => {
    const response = JSON.stringify([
      { content: 'Reply 1' },
      { content: 'Reply 2', reason: 'Reason 2' },
      { content: 'Reply 3', reason: 'Reason 3' }
    ])

    expect(() => agent.parseResponse(response)).toThrow(SuggestionParseError)
  })

  it('should throw SuggestionParseError for malformed JSON', () => {
    const response = '[{content: "Reply 1", reason: "Reason 1"}]'

    expect(() => agent.parseResponse(response)).toThrow(SuggestionParseError)
    expect(() => agent.parseResponse(response)).toThrow('Failed to parse JSON')
  })

  it('should include raw response in SuggestionParseError', () => {
    const badResponse = 'This is not valid JSON at all'

    try {
      agent.parseResponse(badResponse)
      expect.fail('Should have thrown SuggestionParseError')
    } catch (error) {
      expect(error).toBeInstanceOf(SuggestionParseError)
      expect((error as SuggestionParseError).rawResponse).toBe(badResponse)
    }
  })
})


// ============================================================================
// Generate Suggestions Tests
// ============================================================================

describe('CoachAgent - Generate Suggestions', () => {
  it('should call Ollama with correct parameters', async () => {
    const mockClient = createMockOllamaClient()
    const agent = new CoachAgent(mockClient, 0.7)
    const context = createTestContext()

    await agent.generateSuggestions(context)

    expect(mockClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.7,
        system: expect.stringContaining('social communication coach')
      })
    )
  })

  it('should return parsed suggestions on success', async () => {
    const mockClient = createMockOllamaClient()
    const agent = new CoachAgent(mockClient)
    const context = createTestContext()

    const result = await agent.generateSuggestions(context)

    expect(result).toHaveLength(3)
    expect(result[0]).toHaveProperty('content')
    expect(result[0]).toHaveProperty('reason')
  })

  it('should throw CoachAgentError on parse error', async () => {
    const mockClient = createMockOllamaClient('Invalid response without JSON')
    const agent = new CoachAgent(mockClient)
    const context = createTestContext()

    await expect(agent.generateSuggestions(context)).rejects.toThrow('Failed to parse suggestions')
  })

  it('should re-throw connection errors', async () => {
    const mockClient = createMockOllamaClient()
    vi.mocked(mockClient.generate).mockRejectedValue(
      new OllamaConnectionError('Cannot connect to Ollama')
    )
    const agent = new CoachAgent(mockClient)
    const context = createTestContext()

    await expect(agent.generateSuggestions(context)).rejects.toThrow(OllamaConnectionError)
  })

  it('should use temperature 0.7 by default', () => {
    const mockClient = createMockOllamaClient()
    const agent = new CoachAgent(mockClient)

    expect(agent.getTemperature()).toBe(0.7)
  })

  it('should allow custom temperature', () => {
    const mockClient = createMockOllamaClient()
    const agent = new CoachAgent(mockClient, 0.9)

    expect(agent.getTemperature()).toBe(0.9)
  })

  it('should include intent in prompt', async () => {
    const mockClient = createMockOllamaClient()
    const agent = new CoachAgent(mockClient)
    const context = createTestContext()
    context.intent = {
      intent: 'expressing_gratitude',
      mood: 'happy',
      topic: 'help_received'
    }

    await agent.generateSuggestions(context)

    expect(mockClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('expressing_gratitude')
      })
    )
  })

  it('should adapt system prompt based on intimacy level', async () => {
    const mockClient = createMockOllamaClient()
    const agent = new CoachAgent(mockClient)

    // Test formal intimacy
    const formalContext = createTestContext('formal')
    await agent.generateSuggestions(formalContext)

    expect(mockClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('formal language')
      })
    )

    // Test close intimacy
    const closeContext = createTestContext('close')
    await agent.generateSuggestions(closeContext)

    expect(mockClient.generate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('casual language')
      })
    )
  })
})

// ============================================================================
// Integration with User Profile Tests
// ============================================================================

describe('CoachAgent - User Profile Integration', () => {
  it('should match user tone style in system prompt (Requirement 3.3)', async () => {
    const mockClient = createMockOllamaClient()
    const agent = new CoachAgent(mockClient)
    const context = createTestContext()
    context.userProfile.base_info.tone_style = 'humorous, witty'

    await agent.generateSuggestions(context)

    expect(mockClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('humorous, witty')
      })
    )
  })

  it('should include message length preference', async () => {
    const mockClient = createMockOllamaClient()
    const agent = new CoachAgent(mockClient)
    const context = createTestContext()
    context.userProfile.communication_habits.msg_avg_length = 'long'

    await agent.generateSuggestions(context)

    expect(mockClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('Message length preference: long')
      })
    )
  })
})
