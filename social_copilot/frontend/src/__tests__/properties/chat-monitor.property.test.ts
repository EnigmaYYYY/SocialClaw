/**
 * Property-Based Tests for ChatMonitorService
 *
 * **Feature: social-copilot-v2, Property 10: Message Deduplication**
 * **Validates: Requirements 3.6**
 */
import { describe, it, expect, beforeEach } from 'vitest'
import * as fc from 'fast-check'
import { ChatMonitorService } from '../../services/chat-monitor'
import { ParsedMessage } from '../../models/schemas'

// ============================================================================
// Arbitrary Generators for Test Data
// ============================================================================

/**
 * Generator for valid ParsedMessage
 */
const parsedMessageArbitrary = fc.record({
  timestamp: fc.date({ min: new Date('2021-01-01'), max: new Date('2025-12-31') }),
  sender: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
  content: fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
  isFromUser: fc.boolean()
})

/**
 * Generator for array of unique ParsedMessages (no duplicates)
 */
const uniqueMessagesArbitrary = fc
  .array(parsedMessageArbitrary, { minLength: 1, maxLength: 20 })
  .map((messages) => {
    // Ensure uniqueness by varying timestamps
    return messages.map((msg, index) => ({
      ...msg,
      timestamp: new Date(msg.timestamp.getTime() + index * 1000) // Add index seconds to ensure uniqueness
    }))
  })

/**
 * Generator for array of messages with some duplicates
 */
const messagesWithDuplicatesArbitrary = fc
  .tuple(
    fc.array(parsedMessageArbitrary, { minLength: 1, maxLength: 10 }),
    fc.integer({ min: 1, max: 5 }) // Number of duplicates to add
  )
  .map(([messages, numDuplicates]) => {
    const result = [...messages]
    // Add duplicates by copying random messages
    for (let i = 0; i < numDuplicates && messages.length > 0; i++) {
      const randomIndex = Math.floor(Math.random() * messages.length)
      result.push({ ...messages[randomIndex] }) // Exact copy
    }
    return result
  })

/**
 * Generator for a single message that will be duplicated
 */
const duplicateMessagePairArbitrary = parsedMessageArbitrary.map((msg) => ({
  original: msg,
  duplicate: { ...msg } // Exact copy
}))

// ============================================================================
// Property Tests - Message Deduplication (Property 10)
// ============================================================================

describe('Property 10: Message Deduplication', () => {
  let monitor: ChatMonitorService

  beforeEach(() => {
    monitor = new ChatMonitorService()
  })

  /**
   * **Feature: social-copilot-v2, Property 10: Message Deduplication**
   * **Validates: Requirements 3.6**
   *
   * *For any* sequence of detected messages containing duplicates (same msgId),
   * only unique new messages should be forwarded to downstream.
   */
  it('should return only unique messages when duplicates are present', () => {
    fc.assert(
      fc.property(messagesWithDuplicatesArbitrary, (messages: ParsedMessage[]) => {
        // Clear state before test
        monitor.clearDeduplicationState()

        // Process all messages
        const result = monitor.deduplicateMessages(messages)

        // Count unique messages by generating IDs
        const uniqueIds = new Set(messages.map((m) => monitor.generateMessageId(m)))

        // Result should have exactly the number of unique messages
        expect(result.length).toBe(uniqueIds.size)

        // All returned messages should have unique IDs
        const resultIds = result.map((m) => monitor.generateMessageId(m))
        const uniqueResultIds = new Set(resultIds)
        expect(resultIds.length).toBe(uniqueResultIds.size)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 10: Message Deduplication**
   * **Validates: Requirements 3.6**
   *
   * *For any* message processed twice, the second occurrence should not be returned.
   */
  it('should not return the same message twice', () => {
    fc.assert(
      fc.property(duplicateMessagePairArbitrary, ({ original, duplicate }) => {
        // Clear state before test
        monitor.clearDeduplicationState()

        // Process original message
        const firstResult = monitor.deduplicateMessages([original])
        expect(firstResult.length).toBe(1)

        // Process duplicate message
        const secondResult = monitor.deduplicateMessages([duplicate])
        expect(secondResult.length).toBe(0)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 10: Message Deduplication**
   * **Validates: Requirements 3.6**
   *
   * *For any* sequence of unique messages, all should be returned.
   */
  it('should return all messages when there are no duplicates', () => {
    fc.assert(
      fc.property(uniqueMessagesArbitrary, (messages: ParsedMessage[]) => {
        // Clear state before test
        monitor.clearDeduplicationState()

        // Process all messages
        const result = monitor.deduplicateMessages(messages)

        // All unique messages should be returned
        expect(result.length).toBe(messages.length)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 10: Message Deduplication**
   * **Validates: Requirements 3.6**
   *
   * *For any* message, the generated ID should be deterministic.
   */
  it('should generate deterministic message IDs', () => {
    fc.assert(
      fc.property(parsedMessageArbitrary, (message: ParsedMessage) => {
        const id1 = monitor.generateMessageId(message)
        const id2 = monitor.generateMessageId(message)

        // Same message should always produce same ID
        expect(id1).toBe(id2)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 10: Message Deduplication**
   * **Validates: Requirements 3.6**
   *
   * *For any* two different messages, they should have different IDs
   * (with high probability - content hash collision is possible but rare).
   */
  it('should generate different IDs for different messages', () => {
    fc.assert(
      fc.property(
        fc.tuple(parsedMessageArbitrary, parsedMessageArbitrary).filter(([m1, m2]) => {
          // Ensure messages are actually different
          return (
            m1.timestamp.getTime() !== m2.timestamp.getTime() ||
            m1.sender !== m2.sender ||
            m1.content !== m2.content
          )
        }),
        ([message1, message2]) => {
          const id1 = monitor.generateMessageId(message1)
          const id2 = monitor.generateMessageId(message2)

          // Different messages should have different IDs
          expect(id1).not.toBe(id2)
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 10: Message Deduplication**
   * **Validates: Requirements 3.6**
   *
   * Clearing deduplication state should allow previously seen messages to be returned again.
   */
  it('should allow previously seen messages after clearing state', () => {
    fc.assert(
      fc.property(parsedMessageArbitrary, (message: ParsedMessage) => {
        // Clear state before test
        monitor.clearDeduplicationState()

        // Process message first time
        const firstResult = monitor.deduplicateMessages([message])
        expect(firstResult.length).toBe(1)

        // Process same message again - should be filtered
        const secondResult = monitor.deduplicateMessages([message])
        expect(secondResult.length).toBe(0)

        // Clear state
        monitor.clearDeduplicationState()

        // Process same message again - should be returned
        const thirdResult = monitor.deduplicateMessages([message])
        expect(thirdResult.length).toBe(1)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 10: Message Deduplication**
   * **Validates: Requirements 3.6**
   *
   * Empty input should produce empty output.
   */
  it('should return empty array for empty input', () => {
    monitor.clearDeduplicationState()
    const result = monitor.deduplicateMessages([])
    expect(result).toEqual([])
  })

  /**
   * **Feature: social-copilot-v2, Property 10: Message Deduplication**
   * **Validates: Requirements 3.6**
   *
   * The order of returned messages should match the order of input messages.
   */
  it('should preserve message order', () => {
    fc.assert(
      fc.property(uniqueMessagesArbitrary, (messages: ParsedMessage[]) => {
        // Clear state before test
        monitor.clearDeduplicationState()

        // Process all messages
        const result = monitor.deduplicateMessages(messages)

        // Order should be preserved
        for (let i = 0; i < result.length; i++) {
          expect(result[i].content).toBe(messages[i].content)
          expect(result[i].sender).toBe(messages[i].sender)
        }
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 10: Message Deduplication**
   * **Validates: Requirements 3.6**
   *
   * The seen message IDs set should grow with each new unique message.
   */
  it('should track seen message IDs correctly', () => {
    fc.assert(
      fc.property(uniqueMessagesArbitrary, (messages: ParsedMessage[]) => {
        // Clear state before test
        monitor.clearDeduplicationState()

        // Process messages one by one
        for (let i = 0; i < messages.length; i++) {
          monitor.deduplicateMessages([messages[i]])
          const seenIds = monitor.getSeenMessageIds()
          expect(seenIds.size).toBe(i + 1)
        }
      }),
      { numRuns: 100 }
    )
  })
})
