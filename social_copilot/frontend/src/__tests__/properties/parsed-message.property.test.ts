/**
 * Property-Based Tests for ParsedMessage
 *
 * **Feature: social-copilot-v2, Property 4: Parsed Data Round-Trip**
 * **Validates: Requirements 1.7**
 */
import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  ParsedMessage,
  ParsedMessageSchema,
  serializeParsedMessage,
  deserializeParsedMessage,
  serializeParsedMessages,
  deserializeParsedMessages,
  validateParsedMessage
} from '../../models/schemas'

// Arbitrary generator for valid ParsedMessage
// Note: We use a date within a reasonable range to avoid edge cases with Date serialization
const parsedMessageArbitrary = fc.record({
  timestamp: fc.date({ min: new Date('2000-01-01'), max: new Date('2100-01-01') }),
  sender: fc.string({ minLength: 1 }),
  content: fc.string(),
  isFromUser: fc.boolean()
})

describe('Property 4: Parsed Data Round-Trip', () => {
  /**
   * **Feature: social-copilot-v2, Property 4: Parsed Data Round-Trip**
   * **Validates: Requirements 1.7**
   *
   * *For any* valid ParsedMessage object, serializing to JSON and deserializing back
   * SHALL produce an equivalent data structure.
   */
  it('should preserve ParsedMessage through JSON serialization round-trip', () => {
    fc.assert(
      fc.property(parsedMessageArbitrary, (message: ParsedMessage) => {
        const serialized = serializeParsedMessage(message)
        const deserialized = deserializeParsedMessage(serialized)

        // Compare timestamps by value since Date objects are serialized as ISO strings
        expect(deserialized.timestamp.getTime()).toBe(message.timestamp.getTime())
        expect(deserialized.sender).toBe(message.sender)
        expect(deserialized.content).toBe(message.content)
        expect(deserialized.isFromUser).toBe(message.isFromUser)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 4: Parsed Data Round-Trip**
   * **Validates: Requirements 1.7**
   *
   * *For any* valid array of ParsedMessage objects, serializing to JSON and deserializing back
   * SHALL produce an equivalent array.
   */
  it('should preserve ParsedMessage array through JSON serialization round-trip', () => {
    fc.assert(
      fc.property(fc.array(parsedMessageArbitrary), (messages: ParsedMessage[]) => {
        const serialized = serializeParsedMessages(messages)
        const deserialized = deserializeParsedMessages(serialized)

        expect(deserialized.length).toBe(messages.length)
        for (let i = 0; i < messages.length; i++) {
          expect(deserialized[i].timestamp.getTime()).toBe(messages[i].timestamp.getTime())
          expect(deserialized[i].sender).toBe(messages[i].sender)
          expect(deserialized[i].content).toBe(messages[i].content)
          expect(deserialized[i].isFromUser).toBe(messages[i].isFromUser)
        }
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 4: Parsed Data Round-Trip**
   * **Validates: Requirements 1.7**
   *
   * *For any* valid ParsedMessage object, the validation function SHALL accept it.
   */
  it('should validate all valid ParsedMessage objects', () => {
    fc.assert(
      fc.property(parsedMessageArbitrary, (message: ParsedMessage) => {
        const result = validateParsedMessage(message)

        expect(result.success).toBe(true)
        if (result.success) {
          expect(result.data.timestamp.getTime()).toBe(message.timestamp.getTime())
          expect(result.data.sender).toBe(message.sender)
          expect(result.data.content).toBe(message.content)
          expect(result.data.isFromUser).toBe(message.isFromUser)
        }
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 4: Parsed Data Round-Trip**
   * **Validates: Requirements 1.7**
   *
   * *For any* valid ParsedMessage, the Zod schema parse SHALL succeed.
   */
  it('should pass Zod schema validation for all valid ParsedMessages', () => {
    fc.assert(
      fc.property(parsedMessageArbitrary, (message: ParsedMessage) => {
        const result = ParsedMessageSchema.safeParse(message)

        expect(result.success).toBe(true)
      }),
      { numRuns: 100 }
    )
  })
})
