/**
 * Property-Based Tests for IntentAnalysis
 *
 * **Feature: social-copilot-v2, Property 14: Intent Analysis Output Structure**
 * **Validates: Requirements 5.2, 5.4**
 *
 * Property 14: Intent Analysis Output Structure
 * *For any* valid Context Buffer, the Intent Analyst output should contain
 * non-empty intent, mood, and topic fields, and serializing then deserializing
 * should produce an equivalent object.
 */
import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  IntentAnalysis,
  IntentAnalysisSchema,
  serializeIntentAnalysis,
  deserializeIntentAnalysis,
  validateIntentAnalysis
} from '../../models/schemas'
import { IntentAgent, FALLBACK_INTENT } from '../../agents/intent-agent'

// ============================================================================
// Arbitrary Generators
// ============================================================================

/**
 * Generator for valid IntentAnalysis objects
 * All fields must be non-empty strings as per Requirements 5.2
 */
const intentAnalysisArbitrary = fc.record({
  intent: fc.string({ minLength: 1 }),
  mood: fc.string({ minLength: 1 }),
  topic: fc.string({ minLength: 1 })
})

/**
 * Generator for realistic intent values
 */
const realisticIntentArbitrary = fc.oneof(
  fc.constant('requesting_help'),
  fc.constant('casual_greeting'),
  fc.constant('urging_for_update'),
  fc.constant('expressing_concern'),
  fc.constant('making_plans'),
  fc.constant('sharing_news'),
  fc.constant('asking_question'),
  fc.constant('providing_information')
)

/**
 * Generator for realistic mood values
 */
const realisticMoodArbitrary = fc.oneof(
  fc.constant('anxious'),
  fc.constant('friendly'),
  fc.constant('neutral'),
  fc.constant('frustrated'),
  fc.constant('excited'),
  fc.constant('formal'),
  fc.constant('happy'),
  fc.constant('concerned')
)

/**
 * Generator for realistic topic values
 */
const realisticTopicArbitrary = fc.oneof(
  fc.constant('project_deadline'),
  fc.constant('weekend_plans'),
  fc.constant('work_issues'),
  fc.constant('personal_matters'),
  fc.constant('general_chat'),
  fc.constant('meeting_schedule'),
  fc.constant('technical_problem')
)

/**
 * Generator for realistic IntentAnalysis objects
 */
const realisticIntentAnalysisArbitrary = fc.record({
  intent: realisticIntentArbitrary,
  mood: realisticMoodArbitrary,
  topic: realisticTopicArbitrary
})

// ============================================================================
// Property 14: Intent Analysis Output Structure
// ============================================================================

describe('Property 14: Intent Analysis Output Structure', () => {
  /**
   * **Feature: social-copilot-v2, Property 14: Intent Analysis Output Structure**
   * **Validates: Requirements 5.2, 5.4**
   *
   * *For any* IntentAnalysis object, it SHALL contain non-empty string values
   * for intent, mood, and topic fields.
   */
  it('should have non-empty intent, mood, and topic fields for all valid IntentAnalysis', () => {
    fc.assert(
      fc.property(intentAnalysisArbitrary, (analysis: IntentAnalysis) => {
        // Requirement 5.2: output SHALL contain intent, mood, and topic fields
        expect(analysis.intent.length).toBeGreaterThan(0)
        expect(analysis.mood.length).toBeGreaterThan(0)
        expect(analysis.topic.length).toBeGreaterThan(0)

        // Verify all fields are strings
        expect(typeof analysis.intent).toBe('string')
        expect(typeof analysis.mood).toBe('string')
        expect(typeof analysis.topic).toBe('string')
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 14: Intent Analysis Output Structure**
   * **Validates: Requirements 5.2, 5.4**
   *
   * *For any* IntentAnalysis object, serializing then deserializing
   * SHALL produce an equivalent object (round-trip consistency).
   */
  it('should preserve IntentAnalysis through JSON serialization round-trip', () => {
    fc.assert(
      fc.property(intentAnalysisArbitrary, (analysis: IntentAnalysis) => {
        // Requirement 5.4: round-trip consistency
        const serialized = serializeIntentAnalysis(analysis)
        const deserialized = deserializeIntentAnalysis(serialized)

        expect(deserialized).toEqual(analysis)
        expect(deserialized.intent).toBe(analysis.intent)
        expect(deserialized.mood).toBe(analysis.mood)
        expect(deserialized.topic).toBe(analysis.topic)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 14: Intent Analysis Output Structure**
   * **Validates: Requirements 5.2, 5.4**
   *
   * *For any* valid IntentAnalysis, the validation function SHALL accept it.
   */
  it('should validate all valid IntentAnalysis objects', () => {
    fc.assert(
      fc.property(intentAnalysisArbitrary, (analysis: IntentAnalysis) => {
        const result = validateIntentAnalysis(analysis)

        expect(result.success).toBe(true)
        if (result.success) {
          expect(result.data).toEqual(analysis)
        }
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 14: Intent Analysis Output Structure**
   * **Validates: Requirements 5.2, 5.4**
   *
   * *For any* realistic IntentAnalysis values, round-trip serialization
   * SHALL preserve the exact values.
   */
  it('should preserve realistic IntentAnalysis values through round-trip', () => {
    fc.assert(
      fc.property(realisticIntentAnalysisArbitrary, (analysis: IntentAnalysis) => {
        const serialized = serializeIntentAnalysis(analysis)
        const deserialized = deserializeIntentAnalysis(serialized)

        expect(deserialized).toEqual(analysis)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 14: Intent Analysis Output Structure**
   * **Validates: Requirements 5.2**
   *
   * *For any* IntentAnalysis with empty fields, validation SHALL reject it.
   */
  it('should reject IntentAnalysis with empty fields', () => {
    const emptyFieldCases = [
      { intent: '', mood: 'happy', topic: 'work' },
      { intent: 'greeting', mood: '', topic: 'work' },
      { intent: 'greeting', mood: 'happy', topic: '' },
      { intent: '', mood: '', topic: '' }
    ]

    for (const invalidAnalysis of emptyFieldCases) {
      const result = IntentAnalysisSchema.safeParse(invalidAnalysis)
      expect(result.success).toBe(false)
    }
  })

  /**
   * **Feature: social-copilot-v2, Property 14: Intent Analysis Output Structure**
   * **Validates: Requirements 5.2**
   *
   * The fallback intent SHALL have valid non-empty fields.
   */
  it('should have valid fallback intent with non-empty fields', () => {
    expect(FALLBACK_INTENT.intent.length).toBeGreaterThan(0)
    expect(FALLBACK_INTENT.mood.length).toBeGreaterThan(0)
    expect(FALLBACK_INTENT.topic.length).toBeGreaterThan(0)

    const result = validateIntentAnalysis(FALLBACK_INTENT)
    expect(result.success).toBe(true)
  })
})

// ============================================================================
// IntentAgent Response Parsing Tests
// ============================================================================

describe('IntentAgent Response Parsing - Property 14', () => {
  /**
   * **Feature: social-copilot-v2, Property 14: Intent Analysis Output Structure**
   * **Validates: Requirements 5.2, 5.4**
   *
   * *For any* valid JSON response string containing intent, mood, and topic,
   * the IntentAgent parser SHALL extract a valid IntentAnalysis object.
   */
  it('should parse valid JSON responses to IntentAnalysis structure', () => {
    // Create a mock OllamaClient for testing
    const mockClient = {
      generate: async () => ({ model: 'test', response: '', done: true }),
      checkHealth: async () => true,
      buildRequest: () => ({}),
      buildIntentAgentRequest: () => ({}),
      buildCoachAgentRequest: () => ({}),
      getConfig: () => ({})
    } as any

    const agent = new IntentAgent(mockClient)

    fc.assert(
      fc.property(realisticIntentAnalysisArbitrary, (analysis: IntentAnalysis) => {
        // Create a JSON response string
        const jsonResponse = JSON.stringify(analysis)

        // Parse the response
        const parsed = agent.parseResponse(jsonResponse)

        // Verify the parsed result matches the original
        expect(parsed).toEqual(analysis)
        expect(parsed.intent).toBe(analysis.intent)
        expect(parsed.mood).toBe(analysis.mood)
        expect(parsed.topic).toBe(analysis.topic)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 14: Intent Analysis Output Structure**
   * **Validates: Requirements 5.2, 5.4**
   *
   * *For any* valid IntentAnalysis wrapped in markdown code blocks,
   * the parser SHALL correctly extract the IntentAnalysis.
   */
  it('should parse JSON wrapped in markdown code blocks', () => {
    const mockClient = {
      generate: async () => ({ model: 'test', response: '', done: true }),
      checkHealth: async () => true,
      buildRequest: () => ({}),
      buildIntentAgentRequest: () => ({}),
      buildCoachAgentRequest: () => ({}),
      getConfig: () => ({})
    } as any

    const agent = new IntentAgent(mockClient)

    fc.assert(
      fc.property(realisticIntentAnalysisArbitrary, (analysis: IntentAnalysis) => {
        // Create a JSON response wrapped in markdown code blocks
        const jsonResponse = '```json\n' + JSON.stringify(analysis) + '\n```'

        // Parse the response
        const parsed = agent.parseResponse(jsonResponse)

        // Verify the parsed result matches the original
        expect(parsed).toEqual(analysis)
      }),
      { numRuns: 100 }
    )
  })
})
