/**
 * Property-Based Tests for Suggestion
 * 
 * **Feature: social-copilot, Property 4: Suggestion Generation Completeness**
 * **Validates: Requirements 3.1, 3.2, 3.6**
 */
import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  Suggestion,
  SuggestionSchema,
  SuggestionsArraySchema,
  serializeSuggestion,
  deserializeSuggestion,
  serializeSuggestions,
  deserializeSuggestions,
  validateSuggestion
} from '../../models/schemas'

// Arbitrary generator for valid Suggestion (non-empty strings required)
const suggestionArbitrary = fc.record({
  content: fc.string({ minLength: 1 }),
  reason: fc.string({ minLength: 1 })
})

// Arbitrary generator for exactly 3 suggestions (as required by Coach Agent)
const suggestionsArrayArbitrary = fc.tuple(
  suggestionArbitrary,
  suggestionArbitrary,
  suggestionArbitrary
).map(([s1, s2, s3]) => [s1, s2, s3])

describe('Property 4: Suggestion Generation Completeness', () => {
  /**
   * **Feature: social-copilot, Property 4: Suggestion Generation Completeness**
   * **Validates: Requirements 3.1, 3.2, 3.6**
   * 
   * *For any* Suggestion object, it SHALL contain non-empty content and reason strings.
   */
  it('should have non-empty content and reason fields', () => {
    fc.assert(
      fc.property(suggestionArbitrary, (suggestion: Suggestion) => {
        expect(suggestion.content.length).toBeGreaterThan(0)
        expect(suggestion.reason.length).toBeGreaterThan(0)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot, Property 4: Suggestion Generation Completeness**
   * **Validates: Requirements 3.1, 3.2, 3.6**
   * 
   * *For any* Suggestion object, serializing then deserializing
   * SHALL produce an equivalent object.
   */
  it('should preserve Suggestion through JSON serialization round-trip', () => {
    fc.assert(
      fc.property(suggestionArbitrary, (suggestion: Suggestion) => {
        const serialized = serializeSuggestion(suggestion)
        const deserialized = deserializeSuggestion(serialized)
        
        expect(deserialized).toEqual(suggestion)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot, Property 4: Suggestion Generation Completeness**
   * **Validates: Requirements 3.1, 3.2, 3.6**
   * 
   * *For any* valid Suggestion, the validation function SHALL accept it.
   */
  it('should validate all valid Suggestion objects', () => {
    fc.assert(
      fc.property(suggestionArbitrary, (suggestion: Suggestion) => {
        const result = validateSuggestion(suggestion)
        
        expect(result.success).toBe(true)
        if (result.success) {
          expect(result.data).toEqual(suggestion)
        }
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot, Property 4: Suggestion Generation Completeness**
   * **Validates: Requirements 3.1, 3.2, 3.6**
   * 
   * *For any* array of exactly 3 Suggestion objects, serializing then deserializing
   * SHALL produce an equivalent array.
   */
  it('should preserve array of 3 suggestions through JSON serialization round-trip', () => {
    fc.assert(
      fc.property(suggestionsArrayArbitrary, (suggestions: Suggestion[]) => {
        expect(suggestions.length).toBe(3)
        
        const serialized = serializeSuggestions(suggestions)
        const deserialized = deserializeSuggestions(serialized)
        
        expect(deserialized).toEqual(suggestions)
        expect(deserialized.length).toBe(3)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot, Property 4: Suggestion Generation Completeness**
   * **Validates: Requirements 3.1, 3.2, 3.6**
   * 
   * *For any* array of exactly 3 valid Suggestions, the schema SHALL accept it.
   */
  it('should validate arrays of exactly 3 suggestions', () => {
    fc.assert(
      fc.property(suggestionsArrayArbitrary, (suggestions: Suggestion[]) => {
        const result = SuggestionsArraySchema.safeParse(suggestions)
        
        expect(result.success).toBe(true)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot, Property 4: Suggestion Generation Completeness**
   * **Validates: Requirements 3.1, 3.2, 3.6**
   * 
   * Arrays with fewer or more than 3 suggestions SHALL be rejected.
   */
  it('should reject arrays with incorrect number of suggestions', () => {
    const twoSuggestions = [
      { content: 'reply1', reason: 'reason1' },
      { content: 'reply2', reason: 'reason2' }
    ]
    const fourSuggestions = [
      { content: 'reply1', reason: 'reason1' },
      { content: 'reply2', reason: 'reason2' },
      { content: 'reply3', reason: 'reason3' },
      { content: 'reply4', reason: 'reason4' }
    ]

    expect(SuggestionsArraySchema.safeParse(twoSuggestions).success).toBe(false)
    expect(SuggestionsArraySchema.safeParse(fourSuggestions).success).toBe(false)
  })

  /**
   * **Feature: social-copilot, Property 4: Suggestion Generation Completeness**
   * **Validates: Requirements 3.1, 3.2, 3.6**
   * 
   * Suggestions with empty fields SHALL be rejected.
   */
  it('should reject Suggestion with empty fields', () => {
    const emptyFieldCases = [
      { content: '', reason: 'valid reason' },
      { content: 'valid content', reason: '' }
    ]

    for (const invalidSuggestion of emptyFieldCases) {
      const result = SuggestionSchema.safeParse(invalidSuggestion)
      expect(result.success).toBe(false)
    }
  })
})
