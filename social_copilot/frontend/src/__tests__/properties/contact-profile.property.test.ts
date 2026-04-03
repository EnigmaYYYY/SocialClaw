/**
 * Property-Based Tests for ContactProfile
 *
 * **Feature: social-copilot-v2, Property 20: Profile Round-Trip Consistency**
 * **Validates: Requirements 8.7**
 */
import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  ContactProfile,
  ContactProfileSchema,
  serializeContactProfile,
  deserializeContactProfile,
  validateContactProfile
} from '../../models/schemas'

// Arbitrary generator for valid ContactProfile
const contactProfileArbitrary = fc.record({
  contact_id: fc.string({ minLength: 1 }),
  nickname: fc.string(),
  profile: fc.record({
    role: fc.string(),
    age_group: fc.string(),
    personality_tags: fc.array(fc.string()),
    interests: fc.array(fc.string()),
    occupation: fc.option(fc.string(), { nil: undefined })
  }),
  relationship_graph: fc.record({
    current_status: fc.string(),
    intimacy_level: fc.constantFrom('stranger', 'formal', 'close', 'intimate') as fc.Arbitrary<
      'stranger' | 'formal' | 'close' | 'intimate'
    >,
    intermediary: fc.record({
      has_intermediary: fc.boolean(),
      name: fc.option(fc.string(), { nil: undefined }),
      context: fc.option(fc.string(), { nil: undefined })
    })
  }),
  chat_history_summary: fc.string(),
  risk_assessment: fc.record({
    is_suspicious: fc.boolean(),
    risk_level: fc.constantFrom('low', 'medium', 'high') as fc.Arbitrary<'low' | 'medium' | 'high'>,
    warning_msg: fc.string()
  }),
  last_updated: fc.nat()
})

describe('Property 20: Profile Round-Trip Consistency (ContactProfile)', () => {
  /**
   * **Feature: social-copilot-v2, Property 20: Profile Round-Trip Consistency**
   * **Validates: Requirements 8.7**
   *
   * *For any* valid ContactProfile object, serializing to JSON and deserializing back
   * SHALL produce an equivalent object with all fields preserved.
   */
  it('should preserve ContactProfile through JSON serialization round-trip', () => {
    fc.assert(
      fc.property(contactProfileArbitrary, (profile: ContactProfile) => {
        const serialized = serializeContactProfile(profile)
        const deserialized = deserializeContactProfile(serialized)

        expect(deserialized).toEqual(profile)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 20: Profile Round-Trip Consistency**
   * **Validates: Requirements 8.7**
   *
   * *For any* valid ContactProfile object, the validation function SHALL accept it.
   */
  it('should validate all valid ContactProfile objects', () => {
    fc.assert(
      fc.property(contactProfileArbitrary, (profile: ContactProfile) => {
        const result = validateContactProfile(profile)

        expect(result.success).toBe(true)
        if (result.success) {
          expect(result.data).toEqual(profile)
        }
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 20: Profile Round-Trip Consistency**
   * **Validates: Requirements 8.7**
   *
   * *For any* valid ContactProfile, the Zod schema parse SHALL succeed.
   */
  it('should pass Zod schema validation for all valid ContactProfiles', () => {
    fc.assert(
      fc.property(contactProfileArbitrary, (profile: ContactProfile) => {
        const result = ContactProfileSchema.safeParse(profile)

        expect(result.success).toBe(true)
      }),
      { numRuns: 100 }
    )
  })
})
