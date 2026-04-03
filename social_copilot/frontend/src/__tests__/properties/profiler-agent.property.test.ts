/**
 * Property-Based Tests for ProfilerAgent
 *
 * **Feature: social-copilot-v2, Property 5: User Profile Generation Structure**
 * **Validates: Requirements 1.5**
 *
 * **Feature: social-copilot-v2, Property 6: Contact Profile Count Consistency**
 * **Validates: Requirements 1.6**
 *
 * **Feature: social-copilot-v2, Property 16: Intermediary Detection**
 * **Validates: Requirements 8.3**
 *
 * **Feature: social-copilot-v2, Property 18: Profile Fact Override**
 * **Validates: Requirements 8.5**
 *
 * **Feature: social-copilot-v2, Property 22: Risk Assessment Structure**
 * **Validates: Requirements 10.1, 10.3**
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'
import {
  ProfilerAgent,
  INTERMEDIARY_PATTERNS,
  SCAM_PATTERNS,
  SUSPICIOUS_KEYWORDS
} from '../../agents/profiler-agent'
import { OllamaClient } from '../../services/ollama-client'
import {
  MessageBlock,
  ContactProfile
} from '../../models/schemas'

// ============================================================================
// Mock OllamaClient
// ============================================================================

const createMockOllamaClient = () => {
  return {
    generate: vi.fn().mockRejectedValue(new Error('LLM not available')),
    checkHealth: vi.fn().mockResolvedValue(true),
    buildRequest: vi.fn(),
    getConfig: vi.fn()
  } as unknown as OllamaClient
}

// ============================================================================
// Arbitrary Generators
// ============================================================================

/**
 * Generator for valid MessageBlock with user messages (isSend = true)
 */
const userMessageBlockArbitrary = fc.record({
  id: fc.nat(),
  sender: fc.constant('self'),
  isSend: fc.constant(true),
  messages: fc.array(
    fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
    { minLength: 1, maxLength: 5 }
  ),
  cleanContent: fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0),
  startTime: fc.integer({ min: 1609459200, max: 1735689600 }),
  endTime: fc.integer({ min: 1609459200, max: 1735689600 })
})

/**
 * Generator for contact names
 */
const contactNameArbitrary = fc.string({ minLength: 1, maxLength: 20 })
  .filter(s => s.trim().length > 0 && s !== 'self')

/**
 * Generator for array of unique contact names
 */
const uniqueContactNamesArbitrary = fc.array(contactNameArbitrary, { minLength: 1, maxLength: 5 })
  .map(names => [...new Set(names)])
  .filter(names => names.length > 0)

/**
 * Generator for valid ContactProfile
 */
const contactProfileArbitrary = fc.record({
  contact_id: fc.string({ minLength: 1 }),
  nickname: fc.string({ minLength: 1 }),
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

/**
 * Generator for new facts to override - simplified to avoid type issues
 */
const newProfileFactsArbitrary = fc.record({
  role: fc.string(),
  age_group: fc.string(),
  personality_tags: fc.array(fc.string()),
  interests: fc.array(fc.string())
})

const newRelationshipFactsArbitrary = fc.record({
  current_status: fc.string(),
  intimacy_level: fc.constantFrom('stranger', 'formal', 'close', 'intimate') as fc.Arbitrary<'stranger' | 'formal' | 'close' | 'intimate'>
})

/**
 * Generator for valid Chinese names (2-8 Chinese characters)
 */
const validChineseNameArbitrary = fc.stringOf(
  fc.constantFrom('张', '王', '李', '赵', '刘', '陈', '杨', '黄', '周', '吴', '明', '华', '伟', '芳', '敏', '静', '强', '磊', '洋', '勇'),
  { minLength: 2, maxLength: 4 }
)

/**
 * Common words that should be filtered out (same as in profiler-agent.ts isCommonWord)
 */
const COMMON_WORDS = [
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'the', 'a', 'an',
  'me', 'my', 'your', 'his', 'her', 'its', 'our', 'their'
]

/**
 * Generator for valid English names (alphanumeric, 2-8 chars)
 * Filters out names that would be treated as common words
 */
const validEnglishNameArbitrary = fc.stringOf(
  fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'),
  { minLength: 2, maxLength: 8 }
).filter(name => !COMMON_WORDS.includes(name.toLowerCase()))

/**
 * Generator for intermediary pattern content
 */
const intermediaryContentArbitrary = fc.oneof(
  validChineseNameArbitrary.map(name => `是${name}介绍`),
  validChineseNameArbitrary.map(name => `我是${name}的朋友`),
  validChineseNameArbitrary.map(name => `${name}推荐我来`),
  validChineseNameArbitrary.map(name => `${name}让我联系你`),
  validChineseNameArbitrary.map(name => `通过${name}认识`),
  validEnglishNameArbitrary.map(name => `introduced by ${name}`),
  validEnglishNameArbitrary.map(name => `${name} referred me`)
)

/**
 * Generator for scam content
 */
const scamContentArbitrary = fc.oneof(
  fc.constant('Please send money via wire transfer urgently'),
  fc.constant('This is an urgent investment opportunity with guaranteed returns'),
  fc.constant('You have won the lottery! Claim your prize now!'),
  fc.constant('I need you to verify your account password immediately'),
  fc.constant('Bitcoin crypto investment guaranteed profit'),
  fc.constant('Send gift card codes urgently'),
  fc.constant('Inheritance of million dollars waiting for you')
)

// ============================================================================
// Property 5: User Profile Generation Structure
// ============================================================================

describe('Property 5: User Profile Generation Structure', () => {
  let agent: ProfilerAgent
  let mockClient: OllamaClient

  beforeEach(() => {
    mockClient = createMockOllamaClient()
    agent = new ProfilerAgent(mockClient)
  })

  /**
   * **Feature: social-copilot-v2, Property 5: User Profile Generation Structure**
   * **Validates: Requirements 1.5**
   *
   * *For any* valid array of MessageBlock objects, the Profiler Agent should generate
   * a UserProfile with all required fields populated.
   */
  it('should generate UserProfile with all required fields from message blocks', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(userMessageBlockArbitrary, { minLength: 1, maxLength: 10 }),
        async (messageBlocks: MessageBlock[]) => {
          const profile = await agent.generateUserProfile(messageBlocks)

          // Verify all required fields exist
          expect(profile).toHaveProperty('user_id')
          expect(profile).toHaveProperty('base_info')
          expect(profile).toHaveProperty('communication_habits')
          expect(profile).toHaveProperty('last_updated')

          // Verify base_info structure
          expect(profile.base_info).toHaveProperty('gender')
          expect(profile.base_info).toHaveProperty('occupation')
          expect(profile.base_info).toHaveProperty('tone_style')

          // Verify communication_habits structure
          expect(profile.communication_habits).toHaveProperty('frequent_phrases')
          expect(profile.communication_habits).toHaveProperty('emoji_usage')
          expect(profile.communication_habits).toHaveProperty('punctuation_style')
          expect(profile.communication_habits).toHaveProperty('msg_avg_length')

          // Verify types
          expect(Array.isArray(profile.communication_habits.frequent_phrases)).toBe(true)
          expect(Array.isArray(profile.communication_habits.emoji_usage)).toBe(true)
          expect(typeof profile.communication_habits.punctuation_style).toBe('string')
          expect(['short', 'medium', 'long']).toContain(profile.communication_habits.msg_avg_length)
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 5: User Profile Generation Structure**
   * **Validates: Requirements 1.5**
   *
   * *For any* empty message blocks array, should return default profile.
   */
  it('should return default profile for empty message blocks', async () => {
    const profile = await agent.generateUserProfile([])

    expect(profile.user_id).toBe('self')
    expect(profile.base_info.gender).toBe('other')
    expect(profile.communication_habits.frequent_phrases).toEqual([])
    expect(profile.communication_habits.emoji_usage).toEqual([])
  })
})

// ============================================================================
// Property 6: Contact Profile Count Consistency
// ============================================================================

describe('Property 6: Contact Profile Count Consistency', () => {
  let agent: ProfilerAgent
  let mockClient: OllamaClient

  beforeEach(() => {
    mockClient = createMockOllamaClient()
    agent = new ProfilerAgent(mockClient)
  })

  /**
   * **Feature: social-copilot-v2, Property 6: Contact Profile Count Consistency**
   * **Validates: Requirements 1.6**
   *
   * *For any* valid array of MessageBlock objects containing N unique contact names,
   * the Profiler Agent should generate exactly N Contact Profile files.
   */
  it('should generate exactly N profiles for N unique contacts', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueContactNamesArbitrary,
        async (contactNames: string[]) => {
          // Create message blocks for each contact
          const messageBlocks: MessageBlock[] = []
          let id = 0

          for (const name of contactNames) {
            messageBlocks.push({
              id: id++,
              sender: name,
              isSend: false,
              messages: ['Hello from ' + name],
              cleanContent: 'Hello from ' + name,
              startTime: Date.now(),
              endTime: Date.now()
            })
          }

          const profiles = await agent.generateContactProfiles(messageBlocks)

          // Should have exactly N profiles for N unique contacts
          expect(profiles.size).toBe(contactNames.length)

          // Each contact should have a profile
          for (const name of contactNames) {
            expect(profiles.has(name)).toBe(true)
            const profile = profiles.get(name)!
            expect(profile.nickname).toBe(name)
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 6: Contact Profile Count Consistency**
   * **Validates: Requirements 1.6**
   *
   * *For any* message blocks with only user messages (isSend=true),
   * should generate zero contact profiles.
   */
  it('should generate zero profiles when only user messages exist', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(userMessageBlockArbitrary, { minLength: 1, maxLength: 5 }),
        async (messageBlocks: MessageBlock[]) => {
          const profiles = await agent.generateContactProfiles(messageBlocks)

          expect(profiles.size).toBe(0)
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ============================================================================
// Property 16: Intermediary Detection
// ============================================================================

describe('Property 16: Intermediary Detection', () => {
  let agent: ProfilerAgent
  let mockClient: OllamaClient

  beforeEach(() => {
    mockClient = createMockOllamaClient()
    agent = new ProfilerAgent(mockClient)
  })

  /**
   * **Feature: social-copilot-v2, Property 16: Intermediary Detection**
   * **Validates: Requirements 8.3**
   *
   * *For any* message content containing intermediary patterns,
   * the Profiler Agent should extract and populate the intermediary field.
   */
  it('should detect intermediary patterns and extract name', () => {
    fc.assert(
      fc.property(intermediaryContentArbitrary, (content: string) => {
        const messageBlocks: MessageBlock[] = [{
          id: 0,
          sender: 'contact',
          isSend: false,
          messages: [content],
          cleanContent: content,
          startTime: Date.now(),
          endTime: Date.now()
        }]

        const result = agent.extractIntermediaryInfo(messageBlocks)

        // Should detect intermediary
        expect(result.has_intermediary).toBe(true)
        expect(result.name).toBeDefined()
        expect(result.name!.length).toBeGreaterThan(0)
        expect(result.context).toBeDefined()
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 16: Intermediary Detection**
   * **Validates: Requirements 8.3**
   *
   * *For any* message content without intermediary patterns,
   * should return has_intermediary: false.
   */
  it('should return false for content without intermediary patterns', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }).filter(s => {
          // Filter out strings that match any intermediary pattern
          return !INTERMEDIARY_PATTERNS.some(({ pattern }) => pattern.test(s))
        }),
        (content: string) => {
          const messageBlocks: MessageBlock[] = [{
            id: 0,
            sender: 'contact',
            isSend: false,
            messages: [content],
            cleanContent: content,
            startTime: Date.now(),
            endTime: Date.now()
          }]

          const result = agent.extractIntermediaryInfo(messageBlocks)

          expect(result.has_intermediary).toBe(false)
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ============================================================================
// Property 18: Profile Fact Override
// ============================================================================

describe('Property 18: Profile Fact Override', () => {
  let agent: ProfilerAgent
  let mockClient: OllamaClient

  beforeEach(() => {
    mockClient = createMockOllamaClient()
    agent = new ProfilerAgent(mockClient)
  })

  /**
   * **Feature: social-copilot-v2, Property 18: Profile Fact Override**
   * **Validates: Requirements 8.5**
   *
   * *For any* existing ContactProfile and new profile facts,
   * the updated profile should contain only the new fact values.
   */
  it('should override old profile values with new values', () => {
    fc.assert(
      fc.property(
        contactProfileArbitrary,
        newProfileFactsArbitrary,
        (existingProfile: ContactProfile, newProfileFacts) => {
          const newFacts: Partial<ContactProfile> = {
            profile: {
              role: newProfileFacts.role,
              age_group: newProfileFacts.age_group,
              personality_tags: newProfileFacts.personality_tags,
              interests: newProfileFacts.interests
            }
          }

          const updated = agent.overrideProfileFacts(existingProfile, newFacts)

          // Check that new values override old values
          expect(updated.profile.role).toBe(newProfileFacts.role)
          expect(updated.profile.age_group).toBe(newProfileFacts.age_group)
          expect(updated.profile.personality_tags).toEqual(newProfileFacts.personality_tags)
          expect(updated.profile.interests).toEqual(newProfileFacts.interests)

          // Timestamp should be updated
          expect(updated.last_updated).toBeGreaterThanOrEqual(existingProfile.last_updated)
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 18: Profile Fact Override**
   * **Validates: Requirements 8.5**
   *
   * *For any* existing ContactProfile and new relationship facts,
   * the updated profile should contain only the new relationship values.
   */
  it('should override old relationship values with new values', () => {
    fc.assert(
      fc.property(
        contactProfileArbitrary,
        newRelationshipFactsArbitrary,
        (existingProfile: ContactProfile, newRelFacts) => {
          const newFacts: Partial<ContactProfile> = {
            relationship_graph: {
              current_status: newRelFacts.current_status,
              intimacy_level: newRelFacts.intimacy_level,
              intermediary: existingProfile.relationship_graph.intermediary
            }
          }

          const updated = agent.overrideProfileFacts(existingProfile, newFacts)

          // Check that new values override old values
          expect(updated.relationship_graph.current_status).toBe(newRelFacts.current_status)
          expect(updated.relationship_graph.intimacy_level).toBe(newRelFacts.intimacy_level)

          // Timestamp should be updated
          expect(updated.last_updated).toBeGreaterThanOrEqual(existingProfile.last_updated)
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 18: Profile Fact Override**
   * **Validates: Requirements 8.5**
   *
   * *For any* existing profile with empty new facts,
   * the profile should remain unchanged (except timestamp).
   */
  it('should preserve existing values when new facts are empty', () => {
    fc.assert(
      fc.property(contactProfileArbitrary, (existingProfile: ContactProfile) => {
        const updated = agent.overrideProfileFacts(existingProfile, {})

        // All fields except last_updated should be preserved
        expect(updated.contact_id).toBe(existingProfile.contact_id)
        expect(updated.nickname).toBe(existingProfile.nickname)
        expect(updated.profile).toEqual(existingProfile.profile)
        expect(updated.relationship_graph).toEqual(existingProfile.relationship_graph)
        expect(updated.chat_history_summary).toBe(existingProfile.chat_history_summary)
        expect(updated.risk_assessment).toEqual(existingProfile.risk_assessment)
      }),
      { numRuns: 100 }
    )
  })
})

// ============================================================================
// Property 22: Risk Assessment Structure
// ============================================================================

describe('Property 22: Risk Assessment Structure', () => {
  let agent: ProfilerAgent
  let mockClient: OllamaClient

  beforeEach(() => {
    mockClient = createMockOllamaClient()
    agent = new ProfilerAgent(mockClient)
  })

  /**
   * **Feature: social-copilot-v2, Property 22: Risk Assessment Structure**
   * **Validates: Requirements 10.1, 10.3**
   *
   * *For any* analyzed chat content with scam patterns,
   * the risk assessment output should contain valid structure.
   */
  it('should return valid risk assessment structure for scam content', () => {
    fc.assert(
      fc.property(scamContentArbitrary, (content: string) => {
        const messageBlocks: MessageBlock[] = [{
          id: 0,
          sender: 'contact',
          isSend: false,
          messages: [content],
          cleanContent: content,
          startTime: Date.now(),
          endTime: Date.now()
        }]

        const result = agent.assessRiskFromBlocks(messageBlocks)

        // Should detect as suspicious
        expect(result).toBeDefined()
        expect(result!.is_suspicious).toBe(true)
        expect(['low', 'medium', 'high']).toContain(result!.risk_level)
        expect(typeof result!.warning_msg).toBe('string')
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 22: Risk Assessment Structure**
   * **Validates: Requirements 10.1, 10.3**
   *
   * *For any* normal chat content without scam patterns,
   * should return undefined or non-suspicious assessment.
   */
  it('should return undefined for normal content', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }).filter(s => {
          // Filter out strings that match scam patterns or have too many suspicious keywords
          const matchesScam = SCAM_PATTERNS.some(p => p.test(s))
          const lowerS = s.toLowerCase()
          const keywordCount = SUSPICIOUS_KEYWORDS.filter(k => lowerS.includes(k.toLowerCase())).length
          return !matchesScam && keywordCount < 3
        }),
        (content: string) => {
          const messageBlocks: MessageBlock[] = [{
            id: 0,
            sender: 'contact',
            isSend: false,
            messages: [content],
            cleanContent: content,
            startTime: Date.now(),
            endTime: Date.now()
          }]

          const result = agent.assessRiskFromBlocks(messageBlocks)

          // Should not be flagged as suspicious
          expect(result === undefined || result.is_suspicious === false).toBe(true)
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 22: Risk Assessment Structure**
   * **Validates: Requirements 10.1, 10.3**
   *
   * *For any* risk assessment result, it should have valid enum values.
   */
  it('should always return valid risk_level enum values', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ minLength: 1, maxLength: 200 }),
          { minLength: 1, maxLength: 5 }
        ),
        (messages: string[]) => {
          const messageBlocks: MessageBlock[] = messages.map((content, id) => ({
            id,
            sender: 'contact',
            isSend: false,
            messages: [content],
            cleanContent: content,
            startTime: Date.now(),
            endTime: Date.now()
          }))

          const result = agent.assessRiskFromBlocks(messageBlocks)

          if (result) {
            expect(typeof result.is_suspicious).toBe('boolean')
            expect(['low', 'medium', 'high']).toContain(result.risk_level)
            expect(typeof result.warning_msg).toBe('string')
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})
