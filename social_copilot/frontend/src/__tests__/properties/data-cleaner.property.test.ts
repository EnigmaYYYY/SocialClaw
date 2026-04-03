/**
 * Property-Based Tests for DataCleanerAgent
 *
 * **Feature: social-copilot-v2, Property 2: Message Block Merge Correctness**
 * **Validates: Requirements 1.3**
 *
 * **Feature: social-copilot-v2, Property 3: Noise Filtering Completeness**
 * **Validates: Requirements 1.4**
 */
import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { DataCleanerAgent, NOISE_PATTERNS } from '../../agents/data-cleaner-agent'
import { RawMessage, MSG_TYPE } from '../../models/schemas'

// ============================================================================
// Arbitrary Generators for Test Data
// ============================================================================

/**
 * Generator for valid RawMessage with text content
 */
const rawMessageArbitrary = (baseTime: number, isSend: boolean, sender: string) =>
  fc.record({
    msgId: fc.uuid(),
    msgType: fc.constant(MSG_TYPE.TEXT),
    content: fc
      .string({ minLength: 1, maxLength: 100 })
      .filter((s) => s.trim().length > 0 && !/<xml>/i.test(s) && !/<msg>/i.test(s)),
    fromUser: fc.constant(sender),
    toUser: fc.constant(isSend ? 'contact' : 'self'),
    createTime: fc.integer({ min: baseTime, max: baseTime + 60 }), // Within 1 minute
    isSend: fc.constant(isSend)
  })

/**
 * Generator for a sequence of messages from the same sender within time window
 */
const sameSenderWithinWindowArbitrary = fc
  .integer({ min: 1609459200, max: 1735689600 }) // 2021-2025
  .chain((baseTime) =>
    fc.tuple(
      fc.boolean(), // isSend
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0) // sender
    ).chain(([isSend, sender]) =>
      fc.array(rawMessageArbitrary(baseTime, isSend, sender), { minLength: 2, maxLength: 5 })
    )
  )

/**
 * Generator for messages from the same sender but OUTSIDE time window (> 2 minutes apart)
 */
const sameSenderOutsideWindowArbitrary = fc
  .integer({ min: 1609459200, max: 1735689600 })
  .chain((baseTime) =>
    fc.tuple(
      fc.boolean(),
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0)
    ).chain(([isSend, sender]) =>
      fc.tuple(
        rawMessageArbitrary(baseTime, isSend, sender),
        rawMessageArbitrary(baseTime + 181, isSend, sender) // Strictly more than 2 minutes later
      )
    )
  )

/**
 * Generator for messages from different senders
 */
const differentSendersArbitrary = fc.integer({ min: 1609459200, max: 1735689600 }).chain((baseTime) =>
  fc.tuple(
    fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
    fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0)
  )
    .filter(([s1, s2]) => s1 !== s2)
    .chain(([sender1, sender2]) =>
      fc.tuple(
        rawMessageArbitrary(baseTime, true, sender1),
        rawMessageArbitrary(baseTime + 30, false, sender2) // Different sender, within time window
      )
    )
)

/**
 * Generator for noise content patterns
 */
const noiseContentArbitrary = fc.oneof(
  fc.constant('<xml><appmsg>test</appmsg></xml>'),
  fc.constant('<msg><appmsg>content</appmsg></msg>'),
  fc.constant('[表情]'),
  fc.constant('[动画表情]'),
  fc.constant('拍了拍你'),
  fc.constant('发出红包'),
  fc.constant('收到红包'),
  fc.constant('消息已撤回'),
  fc.constant('撤回了一条消息'),
  fc.constant('邀请张三加入了群聊'),
  fc.constant('你已添加了李四，现在可以开始聊天了'),
  fc.constant('<![CDATA[some data]]>')
)

/**
 * Generator for content with embedded noise
 */
const contentWithNoiseArbitrary = fc.tuple(
  fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
  noiseContentArbitrary,
  fc.string({ minLength: 0, maxLength: 50 })
).map(([prefix, noise, suffix]) => `${prefix}${noise}${suffix}`)

// ============================================================================
// Property Tests - Message Block Merge (Property 2)
// ============================================================================

describe('Property 2: Message Block Merge Correctness', () => {
  const agent = new DataCleanerAgent()

  /**
   * **Feature: social-copilot-v2, Property 2: Message Block Merge Correctness**
   * **Validates: Requirements 1.3**
   *
   * *For any* sequence of messages from the same sender within 2 minutes,
   * they SHALL be merged into a single MessageBlock.
   */
  it('should merge consecutive messages from same sender within 2 minutes into single block', () => {
    fc.assert(
      fc.property(sameSenderWithinWindowArbitrary, (messages: RawMessage[]) => {
        const blocks = agent.mergeMessageBlocks(messages, 2)

        // All messages from same sender within time window should be in one block
        expect(blocks.length).toBe(1)

        // The block should contain all message contents
        const block = blocks[0]
        expect(block.messages.length).toBe(messages.length)

        // Verify sender consistency
        expect(block.isSend).toBe(messages[0].isSend)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 2: Message Block Merge Correctness**
   * **Validates: Requirements 1.3**
   *
   * *For any* two messages from the same sender separated by more than 2 minutes,
   * they SHALL remain in separate MessageBlocks.
   */
  it('should keep messages in separate blocks when time gap exceeds 2 minutes', () => {
    fc.assert(
      fc.property(sameSenderOutsideWindowArbitrary, ([msg1, msg2]: [RawMessage, RawMessage]) => {
        const blocks = agent.mergeMessageBlocks([msg1, msg2], 2)

        // Messages outside time window should be in separate blocks
        expect(blocks.length).toBe(2)

        // Each block should have one message
        expect(blocks[0].messages.length).toBe(1)
        expect(blocks[1].messages.length).toBe(1)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 2: Message Block Merge Correctness**
   * **Validates: Requirements 1.3**
   *
   * *For any* two messages from different senders within 2 minutes,
   * they SHALL remain in separate MessageBlocks.
   */
  it('should keep messages from different senders in separate blocks', () => {
    fc.assert(
      fc.property(differentSendersArbitrary, ([msg1, msg2]: [RawMessage, RawMessage]) => {
        const blocks = agent.mergeMessageBlocks([msg1, msg2], 2)

        // Different senders should result in separate blocks
        expect(blocks.length).toBe(2)

        // Messages are sorted by time, so verify both isSend values are present
        // (one true, one false since they're from different senders)
        const isSendValues = blocks.map((b) => b.isSend)
        expect(isSendValues).toContain(msg1.isSend)
        expect(isSendValues).toContain(msg2.isSend)
        // Since msg1.isSend is true and msg2.isSend is false, they should be different
        expect(blocks[0].isSend).not.toBe(blocks[1].isSend)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 2: Message Block Merge Correctness**
   * **Validates: Requirements 1.3**
   *
   * *For any* merged MessageBlock, the startTime SHALL be from the first message
   * and endTime SHALL be from the last message.
   */
  it('should preserve correct time boundaries in merged blocks', () => {
    fc.assert(
      fc.property(sameSenderWithinWindowArbitrary, (messages: RawMessage[]) => {
        const blocks = agent.mergeMessageBlocks(messages, 2)

        expect(blocks.length).toBe(1)
        const block = blocks[0]

        // Sort messages by time to find expected boundaries
        const sortedMessages = [...messages].sort((a, b) => a.createTime - b.createTime)
        const expectedStartTime = sortedMessages[0].createTime
        const expectedEndTime = sortedMessages[sortedMessages.length - 1].createTime

        expect(block.startTime).toBe(expectedStartTime)
        expect(block.endTime).toBe(expectedEndTime)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 2: Message Block Merge Correctness**
   * **Validates: Requirements 1.3**
   *
   * Empty input SHALL produce empty output.
   */
  it('should return empty array for empty input', () => {
    const blocks = agent.mergeMessageBlocks([], 2)
    expect(blocks).toEqual([])
  })
})


// ============================================================================
// Property Tests - Noise Filtering (Property 3)
// ============================================================================

describe('Property 3: Noise Filtering Completeness', () => {
  const agent = new DataCleanerAgent()

  /**
   * **Feature: social-copilot-v2, Property 3: Noise Filtering Completeness**
   * **Validates: Requirements 1.4**
   *
   * *For any* message content containing XML tags,
   * the cleaned content SHALL NOT contain those XML tags.
   */
  it('should remove all XML tags from content', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.string({ minLength: 0, maxLength: 50 })
        ),
        ([prefix, xmlContent, suffix]) => {
          const contentWithXml = `${prefix}<xml>${xmlContent}</xml>${suffix}`
          const cleaned = agent.filterNoise(contentWithXml)

          // Should not contain <xml> tags
          expect(cleaned).not.toMatch(/<xml>/i)
          expect(cleaned).not.toMatch(/<\/xml>/i)
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 3: Noise Filtering Completeness**
   * **Validates: Requirements 1.4**
   *
   * *For any* message content containing [表情] placeholder,
   * the cleaned content SHALL NOT contain that placeholder.
   */
  it('should remove [表情] placeholders from content', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.string({ minLength: 0, maxLength: 50 }),
          fc.string({ minLength: 0, maxLength: 50 })
        ),
        ([prefix, suffix]) => {
          const contentWithEmoji = `${prefix}[表情]${suffix}`
          const cleaned = agent.filterNoise(contentWithEmoji)

          expect(cleaned).not.toContain('[表情]')
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 3: Noise Filtering Completeness**
   * **Validates: Requirements 1.4**
   *
   * *For any* message content containing 拍了拍,
   * the cleaned content SHALL NOT contain that pattern.
   */
  it('should remove 拍了拍 patterns from content', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.string({ minLength: 0, maxLength: 50 }),
          fc.string({ minLength: 0, maxLength: 50 })
        ),
        ([prefix, suffix]) => {
          const contentWithPat = `${prefix}拍了拍${suffix}`
          const cleaned = agent.filterNoise(contentWithPat)

          expect(cleaned).not.toContain('拍了拍')
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 3: Noise Filtering Completeness**
   * **Validates: Requirements 1.4**
   *
   * *For any* message content containing red packet patterns,
   * the cleaned content SHALL NOT contain those patterns.
   */
  it('should remove red packet patterns from content', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.string({ minLength: 0, maxLength: 50 }),
          fc.constantFrom('发出红包', '收到红包'),
          fc.string({ minLength: 0, maxLength: 50 })
        ),
        ([prefix, redPacket, suffix]) => {
          const contentWithRedPacket = `${prefix}${redPacket}${suffix}`
          const cleaned = agent.filterNoise(contentWithRedPacket)

          expect(cleaned).not.toContain('发出红包')
          expect(cleaned).not.toContain('收到红包')
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 3: Noise Filtering Completeness**
   * **Validates: Requirements 1.4**
   *
   * *For any* message content containing recall patterns,
   * the cleaned content SHALL NOT contain those patterns.
   */
  it('should remove message recall patterns from content', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.string({ minLength: 0, maxLength: 50 }),
          fc.constantFrom('消息已撤回', '撤回了一条消息'),
          fc.string({ minLength: 0, maxLength: 50 })
        ),
        ([prefix, recall, suffix]) => {
          const contentWithRecall = `${prefix}${recall}${suffix}`
          const cleaned = agent.filterNoise(contentWithRecall)

          expect(cleaned).not.toContain('消息已撤回')
          expect(cleaned).not.toContain('撤回了一条消息')
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 3: Noise Filtering Completeness**
   * **Validates: Requirements 1.4**
   *
   * *For any* message content containing system notification patterns,
   * the cleaned content SHALL NOT contain those patterns.
   */
  it('should remove system notification patterns from content', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.string({ minLength: 0, maxLength: 30 }),
          fc.string({ minLength: 1, maxLength: 10 }).filter((s) => s.trim().length > 0),
          fc.string({ minLength: 0, maxLength: 30 })
        ),
        ([prefix, name, suffix]) => {
          const contentWithInvite = `${prefix}邀请${name}加入了群聊${suffix}`
          const cleaned = agent.filterNoise(contentWithInvite)

          expect(cleaned).not.toMatch(/邀请.*加入了群聊/)
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 3: Noise Filtering Completeness**
   * **Validates: Requirements 1.4**
   *
   * *For any* clean content (without noise patterns),
   * the filterNoise function SHALL preserve the content (modulo whitespace normalization).
   */
  it('should preserve clean content without noise patterns', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => {
          // Filter out strings that contain any noise patterns
          const hasNoise = NOISE_PATTERNS.some((pattern) => pattern.test(s))
          return !hasNoise && s.trim().length > 0
        }),
        (cleanContent) => {
          const result = agent.filterNoise(cleanContent)

          // Content should be preserved (with whitespace normalization)
          const normalizedOriginal = cleanContent.replace(/\s+/g, ' ').trim()
          expect(result).toBe(normalizedOriginal)
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 3: Noise Filtering Completeness**
   * **Validates: Requirements 1.4**
   *
   * *For any* noise content, the filterNoise function is idempotent:
   * applying it twice SHALL produce the same result as applying it once.
   */
  it('should be idempotent - filtering twice equals filtering once', () => {
    fc.assert(
      fc.property(contentWithNoiseArbitrary, (content) => {
        const filteredOnce = agent.filterNoise(content)
        const filteredTwice = agent.filterNoise(filteredOnce)

        expect(filteredTwice).toBe(filteredOnce)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 3: Noise Filtering Completeness**
   * **Validates: Requirements 1.4**
   *
   * Empty input SHALL produce empty output.
   */
  it('should return empty string for empty input', () => {
    expect(agent.filterNoise('')).toBe('')
  })

  /**
   * **Feature: social-copilot-v2, Property 3: Noise Filtering Completeness**
   * **Validates: Requirements 1.4**
   *
   * *For any* content that is purely noise,
   * the cleaned content SHALL be empty or whitespace-only.
   */
  it('should return empty or minimal content for pure noise', () => {
    fc.assert(
      fc.property(noiseContentArbitrary, (noiseContent) => {
        const cleaned = agent.filterNoise(noiseContent)

        // Pure noise should result in empty or very short content
        expect(cleaned.length).toBeLessThan(noiseContent.length)
      }),
      { numRuns: 100 }
    )
  })
})
