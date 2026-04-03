/**
 * Property-Based Tests for Social Coach Agent
 *
 * **Feature: social-copilot-v2, Property 15: Suggestion Structure and Count**
 * **Validates: Requirements 6.1, 6.2, 6.6**
 *
 * Property 15: *For any* valid IntentAnalysis, UserProfile, and ContactProfile inputs,
 * the Social Coach Agent should generate exactly 3 Suggestion objects, each with
 * non-empty content and reason fields.
 */
import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'
import {
  CoachAgent,
  CoachContext,
  buildCoachSystemPrompt
} from '../../agents/coach-agent'
import { OllamaClient } from '../../services/ollama-client'
import {
  IntentAnalysis,
  UserProfile,
  ContactProfile,
  Suggestion,
  SuggestionSchema,
  IntimacyLevel,
  MsgLength,
  Gender,
  RiskLevel,
  serializeSuggestions,
  deserializeSuggestions
} from '../../models/schemas'

// ============================================================================
// Arbitrary Generators
// ============================================================================

/**
 * Generator for valid IntentAnalysis objects
 */
const intentAnalysisArbitrary: fc.Arbitrary<IntentAnalysis> = fc.record({
  intent: fc.string({ minLength: 1, maxLength: 50 }),
  mood: fc.string({ minLength: 1, maxLength: 30 }),
  topic: fc.string({ minLength: 1, maxLength: 50 })
})

/**
 * Generator for valid Gender enum values
 */
const genderArbitrary: fc.Arbitrary<Gender> = fc.constantFrom('male', 'female', 'other')

/**
 * Generator for valid MsgLength enum values
 */
const msgLengthArbitrary: fc.Arbitrary<MsgLength> = fc.constantFrom('short', 'medium', 'long')

/**
 * Generator for valid IntimacyLevel enum values
 */
const intimacyLevelArbitrary: fc.Arbitrary<IntimacyLevel> = fc.constantFrom(
  'stranger',
  'formal',
  'close',
  'intimate'
)

/**
 * Generator for valid RiskLevel enum values
 */
const riskLevelArbitrary: fc.Arbitrary<RiskLevel> = fc.constantFrom('low', 'medium', 'high')

/**
 * Generator for valid UserProfile objects
 */
const userProfileArbitrary: fc.Arbitrary<UserProfile> = fc.record({
  user_id: fc.string({ minLength: 1, maxLength: 20 }),
  base_info: fc.record({
    gender: genderArbitrary,
    occupation: fc.string({ maxLength: 50 }),
    tone_style: fc.string({ minLength: 1, maxLength: 50 })
  }),
  communication_habits: fc.record({
    frequent_phrases: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 5 }),
    emoji_usage: fc.array(fc.string({ minLength: 1, maxLength: 5 }), { maxLength: 5 }),
    punctuation_style: fc.string({ maxLength: 50 }),
    msg_avg_length: msgLengthArbitrary
  }),
  last_updated: fc.nat()
})

/**
 * Generator for valid ContactProfile objects
 */
const contactProfileArbitrary: fc.Arbitrary<ContactProfile> = fc.record({
  contact_id: fc.string({ minLength: 1, maxLength: 20 }),
  nickname: fc.string({ minLength: 1, maxLength: 30 }),
  profile: fc.record({
    role: fc.string({ minLength: 1, maxLength: 30 }),
    age_group: fc.string({ maxLength: 20 }),
    personality_tags: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 5 }),
    interests: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 5 }),
    occupation: fc.option(fc.string({ maxLength: 30 }), { nil: undefined })
  }),
  relationship_graph: fc.record({
    current_status: fc.string({ minLength: 1, maxLength: 30 }),
    intimacy_level: intimacyLevelArbitrary,
    intermediary: fc.record({
      has_intermediary: fc.boolean(),
      name: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
      context: fc.option(fc.string({ maxLength: 100 }), { nil: undefined })
    })
  }),
  chat_history_summary: fc.string({ maxLength: 200 }),
  risk_assessment: fc.record({
    is_suspicious: fc.boolean(),
    risk_level: riskLevelArbitrary,
    warning_msg: fc.string({ maxLength: 100 })
  }),
  last_updated: fc.nat()
})

/**
 * Generator for valid Suggestion objects (for round-trip testing)
 */
const suggestionArbitrary: fc.Arbitrary<Suggestion> = fc.record({
  content: fc.string({ minLength: 1, maxLength: 200 }),
  reason: fc.string({ minLength: 1, maxLength: 200 })
})

/**
 * Generator for exactly 3 suggestions (as required by Coach Agent)
 */
const suggestionsArrayArbitrary: fc.Arbitrary<Suggestion[]> = fc
  .tuple(suggestionArbitrary, suggestionArbitrary, suggestionArbitrary)
  .map(([s1, s2, s3]) => [s1, s2, s3])

/**
 * Generator for valid CoachContext objects
 */
const coachContextArbitrary: fc.Arbitrary<CoachContext> = fc.record({
  intent: intentAnalysisArbitrary,
  userProfile: userProfileArbitrary,
  contactProfile: contactProfileArbitrary
})

// ============================================================================
// Mock Ollama Client Factory
// ============================================================================

/**
 * Creates a mock OllamaClient that returns valid suggestions
 */
function createMockOllamaClient(suggestions: Suggestion[]): OllamaClient {
  return {
    generate: vi.fn().mockResolvedValue({
      model: 'qwen3:8b',
      response: JSON.stringify(suggestions),
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
// Property Tests
// ============================================================================

describe('Property 15: Suggestion Structure and Count', () => {
  /**
   * **Feature: social-copilot-v2, Property 15: Suggestion Structure and Count**
   * **Validates: Requirements 6.1, 6.2, 6.6**
   *
   * *For any* valid IntentAnalysis, UserProfile, and ContactProfile inputs,
   * the system prompt should be properly constructed without errors.
   */
  it('should build valid system prompt for any valid user and contact profiles', () => {
    fc.assert(
      fc.property(userProfileArbitrary, contactProfileArbitrary, (userProfile, contactProfile) => {
        // Should not throw for any valid input
        const prompt = buildCoachSystemPrompt(userProfile, contactProfile)

        // Prompt should be a non-empty string
        expect(typeof prompt).toBe('string')
        expect(prompt.length).toBeGreaterThan(0)

        // Prompt should contain key sections
        expect(prompt).toContain('User Profile')
        expect(prompt).toContain('Contact Profile')
        expect(prompt).toContain('Tone Guidelines')
        expect(prompt).toContain('exactly 3 reply suggestions')
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 15: Suggestion Structure and Count**
   * **Validates: Requirements 6.1, 6.2, 6.6**
   *
   * *For any* valid CoachContext, when the LLM returns valid suggestions,
   * the CoachAgent should return exactly 3 Suggestion objects.
   */
  it('should return exactly 3 suggestions for any valid context when LLM responds correctly', async () => {
    await fc.assert(
      fc.asyncProperty(
        coachContextArbitrary,
        suggestionsArrayArbitrary,
        async (context, mockSuggestions) => {
          const mockClient = createMockOllamaClient(mockSuggestions)
          const agent = new CoachAgent(mockClient)

          const result = await agent.generateSuggestions(context)

          // Requirement 6.1: Generate exactly 3 suggestions
          expect(result).toHaveLength(3)

          // Requirement 6.2: Each suggestion has content and reason
          for (const suggestion of result) {
            expect(suggestion.content.length).toBeGreaterThan(0)
            expect(suggestion.reason.length).toBeGreaterThan(0)
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 15: Suggestion Structure and Count**
   * **Validates: Requirements 6.1, 6.2, 6.6**
   *
   * *For any* valid array of 3 Suggestion objects, each suggestion should
   * pass schema validation.
   */
  it('should validate all suggestions against schema', () => {
    fc.assert(
      fc.property(suggestionsArrayArbitrary, (suggestions) => {
        expect(suggestions).toHaveLength(3)

        for (const suggestion of suggestions) {
          const result = SuggestionSchema.safeParse(suggestion)
          expect(result.success).toBe(true)
        }
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 15: Suggestion Structure and Count**
   * **Validates: Requirements 6.6**
   *
   * *For any* valid array of 3 Suggestion objects, serializing then deserializing
   * should produce an equivalent array (round-trip consistency).
   */
  it('should preserve suggestions through JSON serialization round-trip', () => {
    fc.assert(
      fc.property(suggestionsArrayArbitrary, (suggestions) => {
        const serialized = serializeSuggestions(suggestions)
        const deserialized = deserializeSuggestions(serialized)

        expect(deserialized).toEqual(suggestions)
        expect(deserialized).toHaveLength(3)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 15: Suggestion Structure and Count**
   * **Validates: Requirements 6.3, 6.4, 6.5**
   *
   * *For any* contact with a formal role (导师, 长辈, mentor, etc.),
   * the system prompt should include role-based tone adjustment.
   */
  it('should include role-based tone adjustment for formal roles', () => {
    const formalRoles = ['导师', '长辈', 'mentor', 'teacher', 'professor', 'boss', 'manager']

    fc.assert(
      fc.property(
        userProfileArbitrary,
        contactProfileArbitrary,
        fc.constantFrom(...formalRoles),
        (userProfile, contactProfile, formalRole) => {
          // Set the contact's role to a formal role
          const modifiedContact = {
            ...contactProfile,
            profile: {
              ...contactProfile.profile,
              role: formalRole
            }
          }

          const prompt = buildCoachSystemPrompt(userProfile, modifiedContact)

          // Should include role-based adjustment for formal roles
          expect(prompt).toContain('Role-based adjustment')
          expect(prompt).toContain('respectful')
        }
      ),
      { numRuns: 50 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 15: Suggestion Structure and Count**
   * **Validates: Requirements 6.3**
   *
   * *For any* user profile with communication habits, the system prompt
   * should include the Communication Style Mimicry section.
   */
  it('should include communication style mimicry section for any user profile', () => {
    fc.assert(
      fc.property(userProfileArbitrary, contactProfileArbitrary, (userProfile, contactProfile) => {
        const prompt = buildCoachSystemPrompt(userProfile, contactProfile)

        // Should always include the mimicry section
        expect(prompt).toContain('Communication Style Mimicry')
        expect(prompt).toContain('MIMIC')
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 15: Suggestion Structure and Count**
   * **Validates: Requirements 6.5**
   *
   * *For any* intimacy level, the system prompt should include appropriate
   * tone guidance.
   */
  it('should include intimacy-based tone guidance for all intimacy levels', () => {
    const intimacyToneMap: Record<IntimacyLevel, string> = {
      stranger: 'polite and reserved',
      formal: 'professional and respectful',
      close: 'warm and friendly',
      intimate: 'very casual and affectionate'
    }

    fc.assert(
      fc.property(
        userProfileArbitrary,
        contactProfileArbitrary,
        intimacyLevelArbitrary,
        (userProfile, contactProfile, intimacyLevel) => {
          const modifiedContact = {
            ...contactProfile,
            relationship_graph: {
              ...contactProfile.relationship_graph,
              intimacy_level: intimacyLevel
            }
          }

          const prompt = buildCoachSystemPrompt(userProfile, modifiedContact)

          // Should include the appropriate tone for the intimacy level
          expect(prompt).toContain(`Intimacy level: ${intimacyLevel}`)
          expect(prompt).toContain(intimacyToneMap[intimacyLevel])
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 15: Suggestion Structure and Count**
   * **Validates: Requirements 6.1, 6.2**
   *
   * The parseResponse method should correctly parse valid JSON arrays
   * with exactly 3 suggestions.
   */
  it('should correctly parse valid suggestion responses', () => {
    fc.assert(
      fc.property(suggestionsArrayArbitrary, (suggestions) => {
        const mockClient = createMockOllamaClient(suggestions)
        const agent = new CoachAgent(mockClient)

        // Simulate LLM response
        const response = JSON.stringify(suggestions)
        const parsed = agent.parseResponse(response)

        expect(parsed).toHaveLength(3)
        expect(parsed).toEqual(suggestions)
      }),
      { numRuns: 100 }
    )
  })
})
