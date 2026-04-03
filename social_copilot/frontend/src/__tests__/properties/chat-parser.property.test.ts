/**
 * Property-Based Tests for ChatParser
 *
 * **Feature: social-copilot, Property 1: Chat Log Parsing Round-Trip**
 * **Validates: Requirements 1.5**
 *
 * **Feature: social-copilot, Property 2: Whitespace Input Rejection**
 * **Validates: Requirements 1.3**
 */
import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { ChatParser, TextMessage } from '../../services/chat-parser'
import { ParsedMessage } from '../../models/schemas'

// Arbitrary generator for valid timestamp as Date object
const timestampArbitrary = fc
  .tuple(
    fc.integer({ min: 2020, max: 2030 }), // year
    fc.integer({ min: 1, max: 12 }), // month
    fc.integer({ min: 1, max: 28 }), // day (safe for all months)
    fc.integer({ min: 0, max: 23 }), // hour
    fc.integer({ min: 0, max: 59 }), // minute
    fc.integer({ min: 0, max: 59 }) // second
  )
  .map(([year, month, day, hour, minute, second]) => {
    // Create a proper Date object for ParsedMessage
    return new Date(year, month - 1, day, hour, minute, second)
  })

// Arbitrary generator for valid timestamp as string (YYYY-MM-DD HH:MM:SS format)
const timestampStringArbitrary = fc
  .tuple(
    fc.integer({ min: 2020, max: 2030 }), // year
    fc.integer({ min: 1, max: 12 }), // month
    fc.integer({ min: 1, max: 28 }), // day (safe for all months)
    fc.integer({ min: 0, max: 23 }), // hour
    fc.integer({ min: 0, max: 59 }), // minute
    fc.integer({ min: 0, max: 59 }) // second
  )
  .map(([year, month, day, hour, minute, second]) => {
    const pad = (n: number) => n.toString().padStart(2, '0')
    return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`
  })

// Arbitrary generator for valid sender name (non-empty, no colons or newlines)
const senderArbitrary = fc
  .string({ minLength: 1 })
  .filter((s) => !s.includes(':') && !s.includes('\n') && s.trim().length > 0)
  .map((s) => s.trim())

// Arbitrary generator for message content (no newlines)
const contentArbitrary = fc.string().filter((s) => !s.includes('\n'))

// Arbitrary generator for ParsedMessage with Date timestamp (for JSON serialization)
const parsedMessageWithDateArbitrary: fc.Arbitrary<ParsedMessage> = fc.record({
  timestamp: timestampArbitrary,
  sender: senderArbitrary,
  content: contentArbitrary,
  isFromUser: fc.boolean()
})

// Arbitrary generator for TextMessage with string timestamp (for text format)
const textMessageArbitrary: fc.Arbitrary<TextMessage> = fc.record({
  timestamp: timestampStringArbitrary,
  sender: senderArbitrary,
  content: contentArbitrary
})




// Arbitrary generator for array of ParsedMessages with Date timestamps (for JSON serialization)
const parsedMessagesWithDateArbitrary = fc.array(parsedMessageWithDateArbitrary, {
  minLength: 1,
  maxLength: 20
})

// Arbitrary generator for array of TextMessages (for text format)
const textMessagesArbitrary = fc.array(textMessageArbitrary, {
  minLength: 1,
  maxLength: 20
})

describe('Property 1: Chat Log Parsing Round-Trip', () => {
  /**
   * **Feature: social-copilot, Property 1: Chat Log Parsing Round-Trip**
   * **Validates: Requirements 1.5**
   *
   * *For any* valid array of ParsedMessage objects, serializing to JSON and
   * deserializing back SHALL produce an equivalent array with identical
   * sender, content, and timestamp values.
   */
  it('should preserve ParsedMessage array through JSON serialization round-trip', () => {
    fc.assert(
      fc.property(parsedMessagesWithDateArbitrary, (messages: ParsedMessage[]) => {
        const serialized = ChatParser.serialize(messages)
        const deserialized = ChatParser.deserialize(serialized)

        expect(deserialized.length).toBe(messages.length)

        // Verify each message field
        for (let i = 0; i < messages.length; i++) {
          expect(deserialized[i].sender).toBe(messages[i].sender)
          expect(deserialized[i].content).toBe(messages[i].content)
          expect(deserialized[i].isFromUser).toBe(messages[i].isFromUser)
          // Compare timestamps by value (Date objects may not be strictly equal)
          expect(deserialized[i].timestamp.getTime()).toBe(messages[i].timestamp.getTime())
        }
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot, Property 1: Chat Log Parsing Round-Trip**
   * **Validates: Requirements 1.5**
   *
   * *For any* valid ParsedMessage array with string timestamps, formatting to text and parsing back
   * SHALL produce an equivalent array.
   */
  it('should preserve TextMessage array through text format round-trip', () => {
    fc.assert(
      fc.property(textMessagesArbitrary, (messages: TextMessage[]) => {
        const formatted = ChatParser.formatMessages(messages)
        const parsed = ChatParser.parseText(formatted)

        expect(parsed.length).toBe(messages.length)

        for (let i = 0; i < messages.length; i++) {
          expect(parsed[i].sender).toBe(messages[i].sender)
          expect(parsed[i].content).toBe(messages[i].content)
          expect(parsed[i].timestamp).toBe(messages[i].timestamp)
        }
      }),
      { numRuns: 100 }
    )
  })
})


// Arbitrary generator for whitespace-only strings
const whitespaceOnlyArbitrary = fc
  .array(fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v'), { minLength: 0, maxLength: 50 })
  .map((chars) => chars.join(''))

describe('Property 2: Whitespace Input Rejection', () => {
  /**
   * **Feature: social-copilot, Property 2: Whitespace Input Rejection**
   * **Validates: Requirements 1.3**
   *
   * *For any* string composed entirely of whitespace characters (spaces, tabs, newlines),
   * the input validation SHALL reject the submission and return a validation error.
   */
  it('should reject all whitespace-only strings', () => {
    fc.assert(
      fc.property(whitespaceOnlyArbitrary, (whitespaceStr: string) => {
        expect(() => ChatParser.parseText(whitespaceStr)).toThrow(
          'Input cannot be empty or whitespace-only'
        )
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot, Property 2: Whitespace Input Rejection**
   * **Validates: Requirements 1.3**
   *
   * *For any* whitespace-only string, isWhitespaceOnly SHALL return true.
   */
  it('should identify all whitespace-only strings correctly', () => {
    fc.assert(
      fc.property(whitespaceOnlyArbitrary, (whitespaceStr: string) => {
        expect(ChatParser.isWhitespaceOnly(whitespaceStr)).toBe(true)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot, Property 2: Whitespace Input Rejection**
   * **Validates: Requirements 1.3**
   *
   * Empty string should also be rejected.
   */
  it('should reject empty string', () => {
    expect(() => ChatParser.parseText('')).toThrow('Input cannot be empty or whitespace-only')
    expect(ChatParser.isWhitespaceOnly('')).toBe(true)
  })
})
