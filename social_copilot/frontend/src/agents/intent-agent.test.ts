/**
 * Unit Tests for IntentAgent
 *
 * Tests:
 * - Prompt construction
 * - Response parsing
 * - Error handling
 *
 * Validates: Requirements 2.1, 2.2, 2.3
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  IntentAgent,
  IntentParseError,
  FALLBACK_INTENT
} from './intent-agent'
import { OllamaClient, OllamaConnectionError } from '../services/ollama-client'
import { ParsedMessage } from '../models/schemas'

// ============================================================================
// Mock OllamaClient
// ============================================================================

const createMockOllamaClient = (mockResponse?: string) => {
  return {
    generate: vi.fn().mockResolvedValue({
      model: 'qwen3:8b',
      response: mockResponse ?? '{"intent": "greeting", "mood": "friendly", "topic": "general"}',
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
// Prompt Construction Tests
// ============================================================================

describe('IntentAgent - Prompt Construction', () => {
  let agent: IntentAgent
  let mockClient: OllamaClient

  beforeEach(() => {
    mockClient = createMockOllamaClient()
    agent = new IntentAgent(mockClient)
  })

  it('should build prompt from string array', () => {
    const chatLogs = ['Hello!', 'How are you?', 'I am fine, thanks!']
    const prompt = agent.buildPrompt(chatLogs)

    expect(prompt).toContain('1. Hello!')
    expect(prompt).toContain('2. How are you?')
    expect(prompt).toContain('3. I am fine, thanks!')
    expect(prompt).toContain('Analyze the following conversation')
  })

  it('should build prompt from ParsedMessage array', () => {
    const chatLogs: ParsedMessage[] = [
      { sender: 'Alice', content: 'Hello!', timestamp: new Date('2024-01-01T10:00:00'), isFromUser: true },
      { sender: 'Bob', content: 'Hi there!', timestamp: new Date('2024-01-01T10:01:00'), isFromUser: false }
    ]
    const prompt = agent.buildPrompt(chatLogs)

    expect(prompt).toContain('Alice: Hello!')
    expect(prompt).toContain('Bob: Hi there!')
  })

  it('should add context note for fewer than 3 messages (Requirement 2.3)', () => {
    const chatLogs = ['Hello!', 'Hi!']
    const prompt = agent.buildPrompt(chatLogs)

    expect(prompt).toContain('only 2 message(s)')
    expect(prompt).toContain('best analysis based on the available context')
  })

  it('should not add context note for 3 or more messages', () => {
    const chatLogs = ['Hello!', 'Hi!', 'How are you?']
    const prompt = agent.buildPrompt(chatLogs)

    expect(prompt).not.toContain('only')
    expect(prompt).not.toContain('available context')
  })

  it('should handle single message (edge case)', () => {
    const chatLogs = ['Just one message']
    const prompt = agent.buildPrompt(chatLogs)

    expect(prompt).toContain('1. Just one message')
    expect(prompt).toContain('only 1 message(s)')
  })
})

// ============================================================================
// Response Parsing Tests
// ============================================================================

describe('IntentAgent - Response Parsing', () => {
  let agent: IntentAgent
  let mockClient: OllamaClient

  beforeEach(() => {
    mockClient = createMockOllamaClient()
    agent = new IntentAgent(mockClient)
  })

  it('should parse valid JSON response', () => {
    const response = '{"intent": "requesting_help", "mood": "anxious", "topic": "project_deadline"}'
    const result = agent.parseResponse(response)

    expect(result).toEqual({
      intent: 'requesting_help',
      mood: 'anxious',
      topic: 'project_deadline'
    })
  })

  it('should parse JSON wrapped in markdown code blocks', () => {
    const response = '```json\n{"intent": "greeting", "mood": "friendly", "topic": "general"}\n```'
    const result = agent.parseResponse(response)

    expect(result).toEqual({
      intent: 'greeting',
      mood: 'friendly',
      topic: 'general'
    })
  })

  it('should parse JSON with surrounding text', () => {
    const response = 'Here is the analysis:\n{"intent": "casual_chat", "mood": "neutral", "topic": "weather"}\nHope this helps!'
    const result = agent.parseResponse(response)

    expect(result).toEqual({
      intent: 'casual_chat',
      mood: 'neutral',
      topic: 'weather'
    })
  })

  it('should throw IntentParseError for response without JSON', () => {
    const response = 'I cannot analyze this conversation.'

    expect(() => agent.parseResponse(response)).toThrow(IntentParseError)
    expect(() => agent.parseResponse(response)).toThrow('No JSON object found')
  })

  it('should throw IntentParseError for invalid JSON structure', () => {
    const response = '{"intent": "", "mood": "happy", "topic": "work"}'

    expect(() => agent.parseResponse(response)).toThrow(IntentParseError)
    expect(() => agent.parseResponse(response)).toThrow('Invalid IntentAnalysis structure')
  })

  it('should throw IntentParseError for missing fields', () => {
    const response = '{"intent": "greeting", "mood": "happy"}'

    expect(() => agent.parseResponse(response)).toThrow(IntentParseError)
  })

  it('should throw IntentParseError for malformed JSON', () => {
    const response = '{"intent": "greeting", mood: "happy"}'

    expect(() => agent.parseResponse(response)).toThrow(IntentParseError)
    expect(() => agent.parseResponse(response)).toThrow('Failed to parse JSON')
  })
})

// ============================================================================
// Analyze Method Tests
// ============================================================================

describe('IntentAgent - Analyze Method', () => {
  it('should return fallback intent for empty input', async () => {
    const mockClient = createMockOllamaClient()
    const agent = new IntentAgent(mockClient)

    const result = await agent.analyze([])

    expect(result).toEqual(FALLBACK_INTENT)
    expect(mockClient.generate).not.toHaveBeenCalled()
  })

  it('should call Ollama with correct parameters', async () => {
    const mockClient = createMockOllamaClient()
    const agent = new IntentAgent(mockClient, 0.1)

    await agent.analyze(['Hello!', 'Hi there!'])

    expect(mockClient.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.1,
        system: expect.stringContaining('conversation analyst')
      })
    )
  })

  it('should return parsed IntentAnalysis on success', async () => {
    const mockClient = createMockOllamaClient(
      '{"intent": "making_plans", "mood": "excited", "topic": "weekend_plans"}'
    )
    const agent = new IntentAgent(mockClient)

    const result = await agent.analyze(['Want to hang out this weekend?'])

    expect(result).toEqual({
      intent: 'making_plans',
      mood: 'excited',
      topic: 'weekend_plans'
    })
  })

  it('should return fallback intent on parse error', async () => {
    const mockClient = createMockOllamaClient('Invalid response without JSON')
    const agent = new IntentAgent(mockClient)

    const result = await agent.analyze(['Hello!'])

    expect(result).toEqual(FALLBACK_INTENT)
  })

  it('should re-throw connection errors', async () => {
    const mockClient = createMockOllamaClient()
    vi.mocked(mockClient.generate).mockRejectedValue(
      new OllamaConnectionError('Cannot connect to Ollama')
    )
    const agent = new IntentAgent(mockClient)

    await expect(agent.analyze(['Hello!'])).rejects.toThrow(OllamaConnectionError)
  })

  it('should use temperature 0.1 by default (Requirement 6.4)', () => {
    const mockClient = createMockOllamaClient()
    const agent = new IntentAgent(mockClient)

    expect(agent.getTemperature()).toBe(0.1)
  })

  it('should allow custom temperature', () => {
    const mockClient = createMockOllamaClient()
    const agent = new IntentAgent(mockClient, 0.5)

    expect(agent.getTemperature()).toBe(0.5)
  })
})

// ============================================================================
// Error Handling Tests
// ============================================================================

describe('IntentAgent - Error Handling', () => {
  it('should handle null/undefined input gracefully', async () => {
    const mockClient = createMockOllamaClient()
    const agent = new IntentAgent(mockClient)

    // @ts-expect-error Testing null input
    const result1 = await agent.analyze(null)
    expect(result1).toEqual(FALLBACK_INTENT)

    // @ts-expect-error Testing undefined input
    const result2 = await agent.analyze(undefined)
    expect(result2).toEqual(FALLBACK_INTENT)
  })

  it('should provide system prompt for debugging', () => {
    const mockClient = createMockOllamaClient()
    const agent = new IntentAgent(mockClient)

    const systemPrompt = agent.getSystemPrompt()

    expect(systemPrompt).toContain('conversation analyst')
    expect(systemPrompt).toContain('intent')
    expect(systemPrompt).toContain('mood')
    expect(systemPrompt).toContain('topic')
    expect(systemPrompt).toContain('JSON')
  })

  it('should include raw response in IntentParseError', () => {
    const mockClient = createMockOllamaClient()
    const agent = new IntentAgent(mockClient)
    const badResponse = 'This is not valid JSON at all'

    try {
      agent.parseResponse(badResponse)
      expect.fail('Should have thrown IntentParseError')
    } catch (error) {
      expect(error).toBeInstanceOf(IntentParseError)
      expect((error as IntentParseError).rawResponse).toBe(badResponse)
    }
  })
})
