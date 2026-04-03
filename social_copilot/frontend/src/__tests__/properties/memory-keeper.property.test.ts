/**
 * Property-Based Tests for MemoryKeeperAgent
 *
 * Tests for:
 * - Property 11: Context Buffer Append
 * - Property 12: Context Buffer Size Limit
 * - Property 13: Session Expiry
 */
import { describe, it, expect, beforeEach } from 'vitest'
import * as fc from 'fast-check'
import { MemoryKeeperAgent } from '../../agents/memory-keeper-agent'
import { ParsedMessage } from '../../models'

// ============================================================================
// Test Utilities
// ============================================================================

let memoryKeeper: MemoryKeeperAgent

beforeEach(() => {
  memoryKeeper = new MemoryKeeperAgent()
})

// ============================================================================
// Arbitrary Generators
// ============================================================================

// Generator for valid contact IDs
const contactIdArbitrary = fc.stringMatching(/^[a-zA-Z0-9_-]+$/).filter((s) => s.length > 0)

// Generator for array of ParsedMessages with sequential timestamps
const parsedMessagesArbitrary = (
  minLength: number = 1,
  maxLength: number = 10
): fc.Arbitrary<ParsedMessage[]> => {
  return fc
    .array(
      fc.record({
        sender: fc.string({ minLength: 1 }),
        content: fc.string(),
        isFromUser: fc.boolean()
      }),
      { minLength, maxLength }
    )
    .map((messages) => {
      const baseTime = Date.now()
      return messages.map((m, i) => ({
        ...m,
        timestamp: new Date(baseTime + i * 1000) // 1 second apart
      }))
    })
}

// ============================================================================
// Property 11: Context Buffer Append
// ============================================================================

describe('Property 11: Context Buffer Append', () => {
  /**
   * **Feature: social-copilot-v2, Property 11: Context Buffer Append**
   * **Validates: Requirements 4.1**
   *
   * *For any* new messages appended to the Context Buffer, the buffer should
   * contain all appended messages in chronological order.
   */
  it('should contain all appended messages in chronological order', () => {
    fc.assert(
      fc.property(contactIdArbitrary, parsedMessagesArbitrary(1, 20), (contactId, messages) => {
        // Create a fresh agent for each test run to avoid state pollution
        const agent = new MemoryKeeperAgent()
        
        // Use unique contact ID to avoid collisions
        const uniqueContactId = `${contactId}_${Date.now()}_${Math.random().toString(36).slice(2)}`

        // Append messages
        agent.appendMessages(uniqueContactId, messages)

        // Get buffer
        const buffer = agent.getContextBuffer(uniqueContactId)

        // Buffer should contain all messages (up to max size)
        const expectedCount = Math.min(messages.length, agent.getMaxBufferSize())
        expect(buffer.length).toBe(expectedCount)

        // Messages should be in chronological order
        for (let i = 1; i < buffer.length; i++) {
          expect(buffer[i].timestamp.getTime()).toBeGreaterThanOrEqual(
            buffer[i - 1].timestamp.getTime()
          )
        }
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 11: Context Buffer Append**
   * **Validates: Requirements 4.1**
   *
   * *For any* sequence of append operations, all messages should be preserved
   * in chronological order (up to max size).
   */
  it('should preserve messages across multiple append operations', () => {
    fc.assert(
      fc.property(contactIdArbitrary, (contactId) => {
        // Create a fresh agent for each test run
        const agent = new MemoryKeeperAgent()
        const uniqueContactId = `${contactId}_${Date.now()}_${Math.random().toString(36).slice(2)}`

        // Create multiple batches with strictly increasing timestamps
        const baseTime = Date.now()
        let timeOffset = 0
        const batches: ParsedMessage[][] = []
        
        for (let batchIdx = 0; batchIdx < 3; batchIdx++) {
          const batch: ParsedMessage[] = []
          for (let msgIdx = 0; msgIdx < 5; msgIdx++) {
            batch.push({
              timestamp: new Date(baseTime + timeOffset),
              sender: `sender_${batchIdx}_${msgIdx}`,
              content: `batch${batchIdx}_msg${msgIdx}`,
              isFromUser: msgIdx % 2 === 0
            })
            timeOffset += 1000 // 1 second apart
          }
          batches.push(batch)
        }

        // Append multiple batches
        for (const batch of batches) {
          agent.appendMessages(uniqueContactId, batch)
        }

        // Get buffer
        const buffer = agent.getContextBuffer(uniqueContactId)

        // Buffer should be in chronological order
        for (let i = 1; i < buffer.length; i++) {
          expect(buffer[i].timestamp.getTime()).toBeGreaterThanOrEqual(
            buffer[i - 1].timestamp.getTime()
          )
        }

        // Buffer size should not exceed max
        expect(buffer.length).toBeLessThanOrEqual(agent.getMaxBufferSize())
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 11: Context Buffer Append**
   * **Validates: Requirements 4.1**
   *
   * *For any* empty message array, appending should not change the buffer.
   */
  it('should not change buffer when appending empty array', () => {
    fc.assert(
      fc.property(contactIdArbitrary, parsedMessagesArbitrary(1, 10), (contactId, messages) => {
        // Append initial messages
        memoryKeeper.appendMessages(contactId, messages)
        const bufferBefore = memoryKeeper.getContextBuffer(contactId)

        // Append empty array
        memoryKeeper.appendMessages(contactId, [])
        const bufferAfter = memoryKeeper.getContextBuffer(contactId)

        // Buffer should be unchanged
        expect(bufferAfter.length).toBe(bufferBefore.length)
        for (let i = 0; i < bufferAfter.length; i++) {
          expect(bufferAfter[i].timestamp.getTime()).toBe(bufferBefore[i].timestamp.getTime())
          expect(bufferAfter[i].content).toBe(bufferBefore[i].content)
        }
      }),
      { numRuns: 100 }
    )
  })
})

// ============================================================================
// Property 12: Context Buffer Size Limit
// ============================================================================

describe('Property 12: Context Buffer Size Limit', () => {
  /**
   * **Feature: social-copilot-v2, Property 12: Context Buffer Size Limit**
   * **Validates: Requirements 4.2**
   *
   * *For any* Context Buffer, the number of messages should never exceed
   * the configured maximum size (default 50).
   */
  it('should never exceed maximum buffer size', () => {
    fc.assert(
      fc.property(
        contactIdArbitrary,
        fc.integer({ min: 1, max: 100 }), // custom max size
        parsedMessagesArbitrary(1, 200), // more messages than max
        (contactId, maxSize, messages) => {
          // Create agent with custom max size
          const agent = new MemoryKeeperAgent({ maxBufferSize: maxSize })

          // Append messages
          agent.appendMessages(contactId, messages)

          // Buffer should never exceed max size
          const buffer = agent.getContextBuffer(contactId)
          expect(buffer.length).toBeLessThanOrEqual(maxSize)
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 12: Context Buffer Size Limit**
   * **Validates: Requirements 4.2**
   *
   * *For any* sequence of append operations that exceeds max size,
   * oldest messages should be removed first.
   */
  it('should remove oldest messages when exceeding max size', () => {
    fc.assert(
      fc.property(contactIdArbitrary, (contactId) => {
        const maxSize = 10
        const agent = new MemoryKeeperAgent({ maxBufferSize: maxSize })

        // Create messages with sequential timestamps
        const baseTime = Date.now()
        const messages: ParsedMessage[] = []
        for (let i = 0; i < 20; i++) {
          messages.push({
            timestamp: new Date(baseTime + i * 1000),
            sender: `sender_${i}`,
            content: `message_${i}`,
            isFromUser: i % 2 === 0
          })
        }

        // Append all messages
        agent.appendMessages(contactId, messages)

        // Buffer should contain only the last maxSize messages
        const buffer = agent.getContextBuffer(contactId)
        expect(buffer.length).toBe(maxSize)

        // Verify these are the most recent messages
        for (let i = 0; i < buffer.length; i++) {
          const expectedIndex = messages.length - maxSize + i
          expect(buffer[i].content).toBe(`message_${expectedIndex}`)
        }
      }),
      { numRuns: 50 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 12: Context Buffer Size Limit**
   * **Validates: Requirements 4.2**
   *
   * *For any* buffer at max capacity, adding N new messages should result
   * in exactly N oldest messages being removed.
   */
  it('should remove exactly N oldest messages when adding N new messages at capacity', () => {
    fc.assert(
      fc.property(
        contactIdArbitrary,
        fc.integer({ min: 10, max: 20 }), // max size (at least 10)
        (contactId, maxSize) => {
          // newCount must be less than maxSize to ensure buffer index is valid
          const newCount = Math.min(5, maxSize - 1)
          const agent = new MemoryKeeperAgent({ maxBufferSize: maxSize })

          // Fill buffer to capacity
          const baseTime = Date.now()
          const initialMessages: ParsedMessage[] = []
          for (let i = 0; i < maxSize; i++) {
            initialMessages.push({
              timestamp: new Date(baseTime + i * 1000),
              sender: `sender_${i}`,
              content: `initial_${i}`,
              isFromUser: false
            })
          }
          agent.appendMessages(contactId, initialMessages)

          // Add new messages
          const newMessages: ParsedMessage[] = []
          for (let i = 0; i < newCount; i++) {
            newMessages.push({
              timestamp: new Date(baseTime + (maxSize + i) * 1000),
              sender: `new_sender_${i}`,
              content: `new_${i}`,
              isFromUser: true
            })
          }
          agent.appendMessages(contactId, newMessages)

          // Buffer should still be at max size
          const buffer = agent.getContextBuffer(contactId)
          expect(buffer.length).toBe(maxSize)

          // Last newCount messages should be the new ones
          for (let i = 0; i < newCount; i++) {
            const bufferIndex = maxSize - newCount + i
            expect(buffer[bufferIndex].content).toBe(`new_${i}`)
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})


// ============================================================================
// Property 13: Session Expiry
// ============================================================================

describe('Property 13: Session Expiry', () => {
  /**
   * **Feature: social-copilot-v2, Property 13: Session Expiry**
   * **Validates: Requirements 4.3**
   *
   * *For any* Context Buffer where the last message is older than 3 hours,
   * the buffer should be cleared when checked.
   */
  it('should clear buffer when last message is older than session expiry time', () => {
    fc.assert(
      fc.property(contactIdArbitrary, (contactId) => {
        // Use a short expiry time for testing (100ms)
        const expiryMs = 100
        const agent = new MemoryKeeperAgent({ sessionExpiryMs: expiryMs })

        // Create messages with old timestamps (before expiry)
        const oldTime = Date.now() - expiryMs - 1000 // 1 second past expiry
        const messages: ParsedMessage[] = [
          {
            timestamp: new Date(oldTime),
            sender: 'test_sender',
            content: 'old message',
            isFromUser: false
          }
        ]

        // Append messages
        agent.appendMessages(contactId, messages)

        // Check session expiry - should return true and clear buffer
        const wasExpired = agent.checkSessionExpiry(contactId)
        expect(wasExpired).toBe(true)

        // Buffer should be empty
        const buffer = agent.getContextBuffer(contactId)
        expect(buffer.length).toBe(0)
      }),
      { numRuns: 50 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 13: Session Expiry**
   * **Validates: Requirements 4.3**
   *
   * *For any* Context Buffer where the last message is within session expiry time,
   * the buffer should NOT be cleared.
   */
  it('should not clear buffer when last message is within session expiry time', () => {
    fc.assert(
      fc.property(contactIdArbitrary, parsedMessagesArbitrary(1, 10), (contactId, messages) => {
        // Use default expiry (3 hours) - messages are recent
        const agent = new MemoryKeeperAgent()

        // Append recent messages
        agent.appendMessages(contactId, messages)
        const bufferSizeBefore = agent.getBufferSize(contactId)

        // Check session expiry - should return false
        const wasExpired = agent.checkSessionExpiry(contactId)
        expect(wasExpired).toBe(false)

        // Buffer should be unchanged
        const bufferSizeAfter = agent.getBufferSize(contactId)
        expect(bufferSizeAfter).toBe(bufferSizeBefore)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 13: Session Expiry**
   * **Validates: Requirements 4.3**
   *
   * *For any* empty buffer, checkSessionExpiry should return false.
   */
  it('should return false for empty buffer', () => {
    fc.assert(
      fc.property(contactIdArbitrary, (contactId) => {
        const agent = new MemoryKeeperAgent()

        // Check expiry on non-existent buffer
        const wasExpired = agent.checkSessionExpiry(contactId)
        expect(wasExpired).toBe(false)
      }),
      { numRuns: 50 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 13: Session Expiry**
   * **Validates: Requirements 4.3**
   *
   * *For any* buffer that expires, getContextBuffer should return empty array.
   */
  it('should return empty array from getContextBuffer when session expired', () => {
    fc.assert(
      fc.property(contactIdArbitrary, (contactId) => {
        // Use a short expiry time for testing (100ms)
        const expiryMs = 100
        const agent = new MemoryKeeperAgent({ sessionExpiryMs: expiryMs })

        // Create messages with old timestamps
        const oldTime = Date.now() - expiryMs - 1000
        const messages: ParsedMessage[] = [
          {
            timestamp: new Date(oldTime),
            sender: 'test_sender',
            content: 'old message',
            isFromUser: false
          }
        ]

        // Append messages
        agent.appendMessages(contactId, messages)

        // getContextBuffer should check expiry and return empty
        const buffer = agent.getContextBuffer(contactId)
        expect(buffer.length).toBe(0)
      }),
      { numRuns: 50 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 13: Session Expiry**
   * **Validates: Requirements 4.3**
   *
   * *For any* expired session, new messages should start a fresh buffer.
   */
  it('should start fresh buffer after session expiry', () => {
    fc.assert(
      fc.property(contactIdArbitrary, (contactId) => {
        // Use a short expiry time for testing (100ms)
        const expiryMs = 100
        const agent = new MemoryKeeperAgent({ sessionExpiryMs: expiryMs })

        // Create old messages
        const oldTime = Date.now() - expiryMs - 1000
        const oldMessages: ParsedMessage[] = [
          {
            timestamp: new Date(oldTime),
            sender: 'old_sender',
            content: 'old message',
            isFromUser: false
          }
        ]
        agent.appendMessages(contactId, oldMessages)

        // Add new messages (this should detect expiry and start fresh)
        const newMessages: ParsedMessage[] = [
          {
            timestamp: new Date(),
            sender: 'new_sender',
            content: 'new message',
            isFromUser: true
          }
        ]
        agent.appendMessages(contactId, newMessages)

        // Buffer should only contain new message
        const buffer = agent.getContextBuffer(contactId)
        expect(buffer.length).toBe(1)
        expect(buffer[0].content).toBe('new message')
      }),
      { numRuns: 50 }
    )
  })
})
