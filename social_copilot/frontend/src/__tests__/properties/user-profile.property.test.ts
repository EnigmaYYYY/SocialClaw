/**
 * Property-Based Tests for UserProfile
 *
 * **Feature: social-copilot-v2, Property 20: Profile Round-Trip Consistency**
 * **Validates: Requirements 8.7**
 */
import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  UserProfile,
  UserProfileSchema,
  serializeUserProfile,
  deserializeUserProfile,
  validateUserProfile
} from '../../models/schemas'

// Arbitrary generator for valid UserProfile
const userProfileArbitrary = fc.record({
  user_id: fc.string({ minLength: 1 }),
  base_info: fc.record({
    gender: fc.constantFrom('male', 'female', 'other') as fc.Arbitrary<'male' | 'female' | 'other'>,
    occupation: fc.string(),
    tone_style: fc.string()
  }),
  communication_habits: fc.record({
    frequent_phrases: fc.array(fc.string()),
    emoji_usage: fc.array(fc.string()),
    punctuation_style: fc.string(),
    msg_avg_length: fc.constantFrom('short', 'medium', 'long') as fc.Arbitrary<'short' | 'medium' | 'long'>
  }),
  last_updated: fc.nat()
})

describe('Property 20: Profile Round-Trip Consistency (UserProfile)', () => {
  /**
   * **Feature: social-copilot-v2, Property 20: Profile Round-Trip Consistency**
   * **Validates: Requirements 8.7**
   *
   * *For any* valid UserProfile object, serializing to JSON and deserializing back
   * SHALL produce an equivalent object.
   */
  it('should preserve UserProfile through JSON serialization round-trip', () => {
    fc.assert(
      fc.property(userProfileArbitrary, (profile: UserProfile) => {
        const serialized = serializeUserProfile(profile)
        const deserialized = deserializeUserProfile(serialized)

        expect(deserialized).toEqual(profile)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 20: Profile Round-Trip Consistency**
   * **Validates: Requirements 8.7**
   *
   * *For any* valid UserProfile object, the validation function SHALL accept it.
   */
  it('should validate all valid UserProfile objects', () => {
    fc.assert(
      fc.property(userProfileArbitrary, (profile: UserProfile) => {
        const result = validateUserProfile(profile)

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
   * *For any* valid UserProfile, the Zod schema parse SHALL succeed.
   */
  it('should pass Zod schema validation for all valid UserProfiles', () => {
    fc.assert(
      fc.property(userProfileArbitrary, (profile: UserProfile) => {
        const result = UserProfileSchema.safeParse(profile)

        expect(result.success).toBe(true)
      }),
      { numRuns: 100 }
    )
  })
})
