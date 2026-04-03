/**
 * Unit Tests for ProfilerAgent
 *
 * Tests:
 * - Fact extraction parsing
 * - Risk assessment logic
 * - Profile merging
 *
 * Validates: Requirements 5.2, 5.3, 5.4, 8.1
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ProfilerAgent,
  FactExtractionParseError,
  ExtractedFacts,
  SCAM_PATTERNS,
  SUSPICIOUS_KEYWORDS
} from './profiler-agent'
import { OllamaClient, OllamaConnectionError } from '../services/ollama-client'
import { ContactProfile, createDefaultContactProfile, ParsedMessage } from '../models/schemas'

// ============================================================================
// Test Fixtures
// ============================================================================

const createTestContactProfile = (): ContactProfile => {
  const profile = createDefaultContactProfile('test-contact', 'Test Contact')
  profile.profile.role = 'colleague'
  profile.profile.age_group = '25-35'
  profile.profile.personality_tags = ['friendly']
  profile.profile.interests = ['technology']
  profile.relationship_graph.intimacy_level = 'formal'
  return profile
}

const VALID_EXTRACTION_RESPONSE = JSON.stringify({
  profile: {
    role: 'manager',
    age_group: '30s',
    personality_tags: ['professional', 'helpful'],
    interests: ['golf', 'reading']
  },
  relationship_graph: {
    current_status: 'colleague',
    intimacy_level: 'formal'
  },
  chat_history_summary: 'Discussed project deadlines and upcoming meeting',
  risk_assessment: {
    is_suspicious: false,
    warning_msg: ''
  }
})

// ============================================================================
// Mock OllamaClient
// ============================================================================

const createMockOllamaClient = (mockResponse?: string) => {
  return {
    generate: vi.fn().mockResolvedValue({
      model: 'qwen3:8b',
      response: mockResponse ?? VALID_EXTRACTION_RESPONSE,
      done: true
    }),
    checkHealth: vi.fn().mockResolvedValue(true),
    buildRequest: vi.fn(),
    getConfig: vi.fn()
  } as unknown as OllamaClient
}

// ============================================================================
// Prompt Construction Tests
// ============================================================================

describe('ProfilerAgent - Prompt Construction', () => {
  let agent: ProfilerAgent
  let mockClient: OllamaClient

  beforeEach(() => {
    mockClient = createMockOllamaClient()
    agent = new ProfilerAgent(mockClient)
  })

  it('should build prompt from string array', () => {
    const chatLogs = ['Hello!', 'How are you?', 'I am fine, thanks!']
    const profile = createTestContactProfile()
    const prompt = agent.buildPrompt(chatLogs, profile)

    expect(prompt).toContain('1. Hello!')
    expect(prompt).toContain('2. How are you?')
    expect(prompt).toContain('3. I am fine, thanks!')
    expect(prompt).toContain('Analyze the following conversation')
  })

  it('should build prompt from ParsedMessage array', () => {
    const chatLogs: ParsedMessage[] = [
      { sender: 'Alice', content: 'Hello!', timestamp: new Date('2024-01-01T10:00:00'), isFromUser: false },
      { sender: 'Bob', content: 'Hi there!', timestamp: new Date('2024-01-01T10:01:00'), isFromUser: true }
    ]
    const profile = createTestContactProfile()
    const prompt = agent.buildPrompt(chatLogs, profile)

    expect(prompt).toContain('Alice: Hello!')
    expect(prompt).toContain('Bob: Hi there!')
  })

  it('should include existing profile context', () => {
    const chatLogs = ['Hello!']
    const profile = createTestContactProfile()
    profile.nickname = 'Alice'
    profile.profile.role = 'friend'
    profile.profile.personality_tags = ['outgoing', 'creative']

    const prompt = agent.buildPrompt(chatLogs, profile)

    expect(prompt).toContain('Nickname: Alice')
    expect(prompt).toContain('Current Role: friend')
    expect(prompt).toContain('outgoing, creative')
  })

  it('should include chat history summary when available', () => {
    const chatLogs = ['Hello!']
    const profile = createTestContactProfile()
    profile.chat_history_summary = 'Previously discussed work projects'

    const prompt = agent.buildPrompt(chatLogs, profile)

    expect(prompt).toContain('Previous Chat Summary: Previously discussed work projects')
  })
})

// ============================================================================
// Response Parsing Tests
// ============================================================================

describe('ProfilerAgent - Response Parsing', () => {
  let agent: ProfilerAgent
  let mockClient: OllamaClient

  beforeEach(() => {
    mockClient = createMockOllamaClient()
    agent = new ProfilerAgent(mockClient)
  })

  it('should parse valid JSON response with all fields', () => {
    const response = JSON.stringify({
      profile: {
        role: 'manager',
        age_group: '30s',
        personality_tags: ['professional'],
        interests: ['golf']
      },
      relationship_graph: {
        current_status: 'colleague',
        intimacy_level: 'formal'
      },
      chat_history_summary: 'Discussed project',
      risk_assessment: {
        is_suspicious: false,
        warning_msg: ''
      }
    })

    const result = agent.parseResponse(response)

    expect(result.profile?.role).toBe('manager')
    expect(result.profile?.age_group).toBe('30s')
    expect(result.profile?.personality_tags).toEqual(['professional'])
    expect(result.relationshipGraph?.intimacy_level).toBe('formal')
    expect(result.chatHistorySummary).toBe('Discussed project')
    expect(result.riskAssessment?.is_suspicious).toBe(false)
  })

  it('should parse JSON wrapped in markdown code blocks', () => {
    const response = '```json\n' + JSON.stringify({
      profile: { role: 'friend' },
      chat_history_summary: 'Casual chat'
    }) + '\n```'

    const result = agent.parseResponse(response)

    expect(result.profile?.role).toBe('friend')
    expect(result.chatHistorySummary).toBe('Casual chat')
  })

  it('should parse JSON with surrounding text', () => {
    const response = 'Here is the analysis:\n' + JSON.stringify({
      profile: { role: 'client' }
    }) + '\nHope this helps!'

    const result = agent.parseResponse(response)

    expect(result.profile?.role).toBe('client')
  })

  it('should parse partial response with only some fields', () => {
    const response = JSON.stringify({
      profile: { interests: ['music', 'sports'] }
    })

    const result = agent.parseResponse(response)

    expect(result.profile?.interests).toEqual(['music', 'sports'])
    expect(result.profile?.role).toBeUndefined()
    expect(result.relationshipGraph).toBeUndefined()
  })

  it('should throw FactExtractionParseError for response without JSON', () => {
    const response = 'I cannot analyze this conversation.'

    expect(() => agent.parseResponse(response)).toThrow(FactExtractionParseError)
    expect(() => agent.parseResponse(response)).toThrow('No JSON object found')
  })

  it('should throw FactExtractionParseError for malformed JSON', () => {
    const response = '{profile: {role: "friend"}}'

    expect(() => agent.parseResponse(response)).toThrow(FactExtractionParseError)
    expect(() => agent.parseResponse(response)).toThrow('Failed to parse JSON')
  })

  it('should include raw response in FactExtractionParseError', () => {
    const badResponse = 'This is not valid JSON at all'

    try {
      agent.parseResponse(badResponse)
      expect.fail('Should have thrown FactExtractionParseError')
    } catch (error) {
      expect(error).toBeInstanceOf(FactExtractionParseError)
      expect((error as FactExtractionParseError).rawResponse).toBe(badResponse)
    }
  })
})


// ============================================================================
// Risk Assessment Tests (Requirement 8.1)
// ============================================================================

describe('ProfilerAgent - Risk Assessment', () => {
  let agent: ProfilerAgent
  let mockClient: OllamaClient

  beforeEach(() => {
    mockClient = createMockOllamaClient()
    agent = new ProfilerAgent(mockClient)
  })

  it('should detect scam patterns in messages', () => {
    const chatLogs = [
      'Hello, I have an urgent matter',
      'Please send money immediately via wire transfer',
      'This is a guaranteed investment opportunity'
    ]

    const result = agent.assessRisk(chatLogs, undefined)

    expect(result?.is_suspicious).toBe(true)
    expect(result?.warning_msg).toContain('scam patterns')
  })

  it('should detect suspicious keywords', () => {
    const chatLogs = [
      'This is urgent and confidential',
      'Please verify your account password',
      'Wire transfer needed immediately'
    ]

    const result = agent.assessRisk(chatLogs, undefined)

    expect(result?.is_suspicious).toBe(true)
    expect(result?.warning_msg).toContain('suspicious keywords')
  })

  it('should not flag normal conversations', () => {
    const chatLogs = [
      'Hey, how are you doing?',
      'Want to grab lunch tomorrow?',
      'Sure, sounds great!'
    ]

    const result = agent.assessRisk(chatLogs, undefined)

    expect(result).toBeUndefined()
  })

  it('should combine LLM assessment with pattern detection', () => {
    const chatLogs = ['This is urgent, I need money now via wire transfer']
    const llmAssessment = {
      is_suspicious: true,
      warning_msg: 'LLM detected suspicious behavior'
    }

    const result = agent.assessRisk(chatLogs, llmAssessment)

    expect(result?.is_suspicious).toBe(true)
    expect(result?.warning_msg).toContain('LLM detected suspicious behavior')
    expect(result?.warning_msg).toContain('scam patterns')
  })

  it('should flag if LLM detects suspicious even without patterns', () => {
    const chatLogs = ['Hello, nice to meet you']
    const llmAssessment = {
      is_suspicious: true,
      warning_msg: 'Unusual behavior detected'
    }

    const result = agent.assessRisk(chatLogs, llmAssessment)

    expect(result?.is_suspicious).toBe(true)
    expect(result?.warning_msg).toContain('Unusual behavior detected')
  })

  it('should return LLM assessment if not suspicious', () => {
    const chatLogs = ['Normal conversation']
    const llmAssessment = {
      is_suspicious: false,
      warning_msg: ''
    }

    const result = agent.assessRisk(chatLogs, llmAssessment)

    expect(result?.is_suspicious).toBe(false)
  })

  it('should handle ParsedMessage format', () => {
    const chatLogs: ParsedMessage[] = [
      { sender: 'Scammer', content: 'Send money via wire transfer urgently', timestamp: new Date(), isFromUser: false }
    ]

    const result = agent.assessRisk(chatLogs, undefined)

    expect(result?.is_suspicious).toBe(true)
  })

  it('should detect crypto investment scams', () => {
    const chatLogs = ['I have a great crypto investment opportunity with guaranteed returns']

    const result = agent.assessRisk(chatLogs, undefined)

    expect(result?.is_suspicious).toBe(true)
  })

  it('should detect lottery/prize scams', () => {
    const chatLogs = ['Congratulations! You have won the lottery! Claim your prize now!']

    const result = agent.assessRisk(chatLogs, undefined)

    expect(result?.is_suspicious).toBe(true)
  })
})

// ============================================================================
// Profile Merge Tests (Requirements 5.3, 5.4)
// ============================================================================

describe('ProfilerAgent - Profile Merging', () => {
  let agent: ProfilerAgent
  let mockClient: OllamaClient

  beforeEach(() => {
    mockClient = createMockOllamaClient()
    agent = new ProfilerAgent(mockClient)
  })

  it('should merge new profile info into existing profile', () => {
    const existing = createTestContactProfile()
    existing.profile.role = 'colleague'
    existing.profile.interests = ['technology']

    const facts: ExtractedFacts = {
      profile: {
        role: 'manager',
        interests: ['golf', 'reading']
      }
    }

    const result = agent.mergeFactsIntoProfile(existing, facts)

    expect(result.profile.role).toBe('manager') // Updated
    expect(result.profile.interests).toEqual(['golf', 'reading']) // Updated
    expect(result.profile.age_group).toBe('25-35') // Preserved
  })

  it('should preserve non-updated fields (Requirement 5.3)', () => {
    const existing = createTestContactProfile()
    existing.profile.personality_tags = ['friendly', 'helpful']
    existing.chat_history_summary = 'Previous summary'

    const facts: ExtractedFacts = {
      profile: {
        role: 'friend'
      }
    }

    const result = agent.mergeFactsIntoProfile(existing, facts)

    expect(result.profile.role).toBe('friend')
    expect(result.profile.personality_tags).toEqual(['friendly', 'helpful']) // Preserved
    expect(result.chat_history_summary).toBe('Previous summary') // Preserved
  })

  it('should overwrite old values with new values (Requirement 5.4)', () => {
    const existing = createTestContactProfile()
    existing.relationship_graph.intimacy_level = 'stranger'
    existing.relationship_graph.current_status = 'acquaintance'

    const facts: ExtractedFacts = {
      relationshipGraph: {
        intimacy_level: 'close',
        current_status: 'friend'
      }
    }

    const result = agent.mergeFactsIntoProfile(existing, facts)

    expect(result.relationship_graph.intimacy_level).toBe('close')
    expect(result.relationship_graph.current_status).toBe('friend')
  })

  it('should update chat history summary', () => {
    const existing = createTestContactProfile()
    existing.chat_history_summary = 'Old summary'

    const facts: ExtractedFacts = {
      chatHistorySummary: 'New summary about recent conversation'
    }

    const result = agent.mergeFactsIntoProfile(existing, facts)

    expect(result.chat_history_summary).toBe('New summary about recent conversation')
  })

  it('should update risk assessment', () => {
    const existing = createTestContactProfile()
    existing.risk_assessment.is_suspicious = false

    const facts: ExtractedFacts = {
      riskAssessment: {
        is_suspicious: true,
        warning_msg: 'Suspicious activity detected'
      }
    }

    const result = agent.mergeFactsIntoProfile(existing, facts)

    expect(result.risk_assessment.is_suspicious).toBe(true)
    expect(result.risk_assessment.warning_msg).toBe('Suspicious activity detected')
  })

  it('should handle empty facts gracefully', () => {
    const existing = createTestContactProfile()
    const facts: ExtractedFacts = {}

    const result = agent.mergeFactsIntoProfile(existing, facts)

    // All fields except last_updated should be preserved
    expect(result.contact_id).toEqual(existing.contact_id)
    expect(result.nickname).toEqual(existing.nickname)
    expect(result.profile).toEqual(existing.profile)
    expect(result.relationship_graph).toEqual(existing.relationship_graph)
    expect(result.chat_history_summary).toEqual(existing.chat_history_summary)
    expect(result.risk_assessment).toEqual(existing.risk_assessment)
    // last_updated is always updated by mergeFactsIntoProfile
    expect(result.last_updated).toBeGreaterThanOrEqual(existing.last_updated)
  })

  it('should update intermediary information', () => {
    const existing = createTestContactProfile()

    const facts: ExtractedFacts = {
      relationshipGraph: {
        intermediary: {
          has_intermediary: true,
          name: 'John',
          context: 'Introduced at conference'
        }
      }
    }

    const result = agent.mergeFactsIntoProfile(existing, facts)

    expect(result.relationship_graph.intermediary.has_intermediary).toBe(true)
    expect(result.relationship_graph.intermediary.name).toBe('John')
    expect(result.relationship_graph.intermediary.context).toBe('Introduced at conference')
  })
})

// ============================================================================
// Extract Facts Method Tests
// ============================================================================

describe('ProfilerAgent - Extract Facts Method', () => {
  it('should return empty facts for empty input', async () => {
    const mockClient = createMockOllamaClient()
    const agent = new ProfilerAgent(mockClient)
    const profile = createTestContactProfile()

    const result = await agent.extractFacts([], profile)

    expect(result).toEqual({})
    expect(mockClient.generate).not.toHaveBeenCalled()
  })

  it('should call Ollama with correct parameters', async () => {
    const mockClient = createMockOllamaClient()
    const agent = new ProfilerAgent(mockClient, 0.3)
    const profile = createTestContactProfile()

    await agent.extractFacts(['Hello!', 'Hi there!'], profile)

    expect(mockClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.3,
        system: expect.stringContaining('conversation analyst')
      })
    )
  })

  it('should return parsed facts on success', async () => {
    const mockClient = createMockOllamaClient()
    const agent = new ProfilerAgent(mockClient)
    const profile = createTestContactProfile()

    const result = await agent.extractFacts(['Let me tell you about my golf game'], profile)

    expect(result.profile?.role).toBe('manager')
    expect(result.profile?.interests).toContain('golf')
  })

  it('should return empty facts on parse error', async () => {
    const mockClient = createMockOllamaClient('Invalid response without JSON')
    const agent = new ProfilerAgent(mockClient)
    const profile = createTestContactProfile()

    const result = await agent.extractFacts(['Hello!'], profile)

    expect(result).toEqual({})
  })

  it('should re-throw connection errors', async () => {
    const mockClient = createMockOllamaClient()
    vi.mocked(mockClient.generate).mockRejectedValue(
      new OllamaConnectionError('Cannot connect to Ollama')
    )
    const agent = new ProfilerAgent(mockClient)
    const profile = createTestContactProfile()

    await expect(agent.extractFacts(['Hello!'], profile)).rejects.toThrow(OllamaConnectionError)
  })

  it('should use temperature 0.3 by default', () => {
    const mockClient = createMockOllamaClient()
    const agent = new ProfilerAgent(mockClient)

    expect(agent.getTemperature()).toBe(0.3)
  })

  it('should allow custom temperature', () => {
    const mockClient = createMockOllamaClient()
    const agent = new ProfilerAgent(mockClient, 0.5)

    expect(agent.getTemperature()).toBe(0.5)
  })

  it('should enhance risk assessment with pattern detection', async () => {
    const mockClient = createMockOllamaClient(JSON.stringify({
      profile: { role: 'stranger' },
      risk_assessment: { is_suspicious: false, warning_msg: '' }
    }))
    const agent = new ProfilerAgent(mockClient)
    const profile = createTestContactProfile()

    // Message contains scam pattern
    const result = await agent.extractFacts(
      ['Please send money via wire transfer urgently'],
      profile
    )

    // Pattern detection should override LLM assessment
    expect(result.riskAssessment?.is_suspicious).toBe(true)
  })
})

// ============================================================================
// Error Handling Tests
// ============================================================================

describe('ProfilerAgent - Error Handling', () => {
  it('should handle null/undefined input gracefully', async () => {
    const mockClient = createMockOllamaClient()
    const agent = new ProfilerAgent(mockClient)
    const profile = createTestContactProfile()

    // @ts-expect-error Testing null input
    const result1 = await agent.extractFacts(null, profile)
    expect(result1).toEqual({})

    // @ts-expect-error Testing undefined input
    const result2 = await agent.extractFacts(undefined, profile)
    expect(result2).toEqual({})
  })

  it('should provide system prompt for debugging', () => {
    const mockClient = createMockOllamaClient()
    const agent = new ProfilerAgent(mockClient)

    const systemPrompt = agent.getSystemPrompt()

    expect(systemPrompt).toContain('conversation analyst')
    expect(systemPrompt).toContain('profile')
    expect(systemPrompt).toContain('risk_assessment')
    expect(systemPrompt).toContain('JSON')
  })
})

// ============================================================================
// Scam Pattern Tests
// ============================================================================

describe('ProfilerAgent - Scam Patterns', () => {
  it('should have defined scam patterns', () => {
    expect(SCAM_PATTERNS.length).toBeGreaterThan(0)
  })

  it('should have defined suspicious keywords', () => {
    expect(SUSPICIOUS_KEYWORDS.length).toBeGreaterThan(0)
    expect(SUSPICIOUS_KEYWORDS).toContain('urgent')
    expect(SUSPICIOUS_KEYWORDS).toContain('wire')
    expect(SUSPICIOUS_KEYWORDS).toContain('transfer')
  })
})
