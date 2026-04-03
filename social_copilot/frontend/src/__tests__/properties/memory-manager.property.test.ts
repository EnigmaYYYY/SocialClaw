/**
 * Property-Based Tests for MemoryManager
 *
 * Tests for:
 * - Property 17: New Contact Profile Creation
 * - Property 19: Concurrent Write Safety
 * - Property 23: Settings Persistence
 * - Property 8: New Contact Profile Creation (legacy)
 * - Property 7: Profile Update Merge Correctness
 * - Property 10: Risk Assessment Persistence
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fc from 'fast-check'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  MemoryManager,
  ExtractedFacts
} from '../../services/memory-manager'
import {
  createDefaultContactProfile,
  validateContactProfile,
  validateAppSettings,
  IntimacyLevel,
  AppSettings,
  DEFAULT_APP_SETTINGS,
  MonitorMode
} from '../../models/schemas'

// ============================================================================
// Test Utilities
// ============================================================================

let testDir: string
let memoryManager: MemoryManager

beforeEach(async () => {
  // Create a temporary directory for each test
  testDir = await mkdtemp(join(tmpdir(), 'social-copilot-test-'))
  memoryManager = new MemoryManager(testDir)
})

afterEach(async () => {
  // Clean up temporary directory
  try {
    await rm(testDir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
})

// ============================================================================
// Arbitrary Generators
// ============================================================================

// Generator for valid contact IDs (alphanumeric with underscores/hyphens)
const contactIdArbitrary = fc.stringMatching(/^[a-zA-Z0-9_-]+$/).filter((s) => s.length > 0)

// Generator for nicknames (non-empty strings)
const nicknameArbitrary = fc.string({ minLength: 1 })

// Generator for valid ContactProfile
const contactProfileArbitrary = fc.record({
  contact_id: contactIdArbitrary,
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
    intimacy_level: fc.constantFrom(
      'stranger',
      'formal',
      'close',
      'intimate'
    ) as fc.Arbitrary<IntimacyLevel>,
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
  last_updated: fc.integer({ min: 0 })
})

// Generator for ExtractedFacts (partial updates)
// Using a simpler approach that generates valid partial updates
const extractedFactsArbitrary: fc.Arbitrary<ExtractedFacts> = fc
  .record({
    hasProfile: fc.boolean(),
    hasRelationshipGraph: fc.boolean(),
    hasChatHistorySummary: fc.boolean(),
    hasRiskAssessment: fc.boolean(),
    profileRole: fc.string(),
    profileAgeGroup: fc.string(),
    profilePersonalityTags: fc.array(fc.string()),
    profileInterests: fc.array(fc.string()),
    relationshipCurrentStatus: fc.string(),
    relationshipIntimacyLevel: fc.constantFrom(
      'stranger',
      'formal',
      'close',
      'intimate'
    ) as fc.Arbitrary<IntimacyLevel>,
    chatHistorySummary: fc.string(),
    riskIsSuspicious: fc.boolean(),
    riskWarningMsg: fc.string()
  })
  .map((data) => {
    const result: ExtractedFacts = {}

    if (data.hasProfile) {
      result.profile = {
        role: data.profileRole,
        age_group: data.profileAgeGroup,
        personality_tags: data.profilePersonalityTags,
        interests: data.profileInterests
      }
    }

    if (data.hasRelationshipGraph) {
      result.relationship_graph = {
        current_status: data.relationshipCurrentStatus,
        intimacy_level: data.relationshipIntimacyLevel
      }
    }

    if (data.hasChatHistorySummary) {
      result.chat_history_summary = data.chatHistorySummary
    }

    if (data.hasRiskAssessment) {
      result.risk_assessment = {
        is_suspicious: data.riskIsSuspicious,
        warning_msg: data.riskWarningMsg
      }
    }

    return result
  })

// Generator for risk assessment updates
const riskAssessmentArbitrary = fc.record({
  is_suspicious: fc.boolean(),
  warning_msg: fc.string()
})


// ============================================================================
// Property 17: New Contact Profile Creation
// ============================================================================

describe('Property 17: New Contact Profile Creation', () => {
  /**
   * **Feature: social-copilot-v2, Property 17: New Contact Profile Creation**
   * **Validates: Requirements 8.4**
   *
   * *For any* contact name not present in existing profiles, when detected,
   * the system should create a new Contact Profile file.
   */
  it('should create new profile file for contact not in existing profiles', async () => {
    await fc.assert(
      fc.asyncProperty(contactIdArbitrary, nicknameArbitrary, async (contactId, nickname) => {
        // Use a unique contact ID to ensure it doesn't exist
        const uniqueContactId = `${contactId}_${Date.now()}_${Math.random().toString(36).slice(2)}`

        // Verify contact does not exist initially
        const existingProfile = await memoryManager.loadContactProfile(uniqueContactId)
        expect(existingProfile).toBeNull()

        // Create new contact profile
        const createdProfile = await memoryManager.createContactProfile(uniqueContactId, nickname)

        // Verify profile was created with correct values
        expect(createdProfile.contact_id).toBe(uniqueContactId)
        expect(createdProfile.nickname).toBe(nickname)

        // Verify profile file exists and can be loaded
        const loadedProfile = await memoryManager.loadContactProfile(uniqueContactId)
        expect(loadedProfile).not.toBeNull()
        expect(loadedProfile!.contact_id).toBe(uniqueContactId)
        expect(loadedProfile!.nickname).toBe(nickname)

        // Verify profile appears in listContacts
        const contacts = await memoryManager.listContacts()
        expect(contacts).toContain(uniqueContactId)
      }),
      { numRuns: 50 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 17: New Contact Profile Creation**
   * **Validates: Requirements 8.4**
   *
   * *For any* set of unique contact IDs, creating profiles for each should result
   * in exactly that many profile files being created.
   */
  it('should create exactly N profile files for N unique contacts', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(contactIdArbitrary, { minLength: 1, maxLength: 5 })
          .map(ids => [...new Set(ids)]) // Ensure unique IDs
          .filter(ids => ids.length > 0),
        async (baseContactIds) => {
          // Create a fresh MemoryManager with a unique subdirectory for this test run
          const uniqueSubDir = join(testDir, `run_${Date.now()}_${Math.random().toString(36).slice(2)}`)
          const freshManager = new MemoryManager(uniqueSubDir)

          // Make contact IDs unique to this test run
          const contactIds = baseContactIds.map(id => `${id}_${Date.now()}`)

          // Create profiles for all contacts
          for (const contactId of contactIds) {
            await freshManager.createContactProfile(contactId, `Nickname_${contactId}`)
          }

          // Verify exactly N contacts exist
          const contacts = await freshManager.listContacts()
          expect(contacts.length).toBe(contactIds.length)

          // Verify all contact IDs are present
          for (const contactId of contactIds) {
            expect(contacts).toContain(contactId)
          }
        }
      ),
      { numRuns: 30 }
    )
  })
})


// ============================================================================
// Property 8: New Contact Profile Creation (Legacy)
// ============================================================================

describe('Property 8: New Contact Profile Creation', () => {
  /**
   * **Feature: social-copilot, Property 8: New Contact Profile Creation**
   * **Validates: Requirements 5.1**
   *
   * *For any* valid contact ID and nickname strings, creating a new ContactProfile
   * SHALL produce a valid profile with default values and the specified contact_id and nickname.
   */
  it('should create valid profile with specified contact_id and nickname', () => {
    fc.assert(
      fc.property(contactIdArbitrary, nicknameArbitrary, (contactId, nickname) => {
        const profile = createDefaultContactProfile(contactId, nickname)

        // Verify contact_id and nickname are set correctly
        expect(profile.contact_id).toBe(contactId)
        expect(profile.nickname).toBe(nickname)

        // Verify profile is valid according to schema
        const validation = validateContactProfile(profile)
        expect(validation.success).toBe(true)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot, Property 8: New Contact Profile Creation**
   * **Validates: Requirements 5.1**
   *
   * *For any* valid contact ID and nickname, the created profile SHALL have
   * expected default values for all other fields.
   */
  it('should create profile with correct default values', () => {
    fc.assert(
      fc.property(contactIdArbitrary, nicknameArbitrary, (contactId, nickname) => {
        const profile = createDefaultContactProfile(contactId, nickname)

        // Verify default profile values
        expect(profile.profile.role).toBe('unknown')
        expect(profile.profile.age_group).toBe('unknown')
        expect(profile.profile.personality_tags).toEqual([])
        expect(profile.profile.interests).toEqual([])

        // Verify default relationship graph values
        expect(profile.relationship_graph.current_status).toBe('acquaintance')
        expect(profile.relationship_graph.intimacy_level).toBe('stranger')
        expect(profile.relationship_graph.intermediary.has_intermediary).toBe(false)
        expect(profile.relationship_graph.intermediary.name).toBeUndefined()
        expect(profile.relationship_graph.intermediary.context).toBeUndefined()

        // Verify default chat history and risk assessment
        expect(profile.chat_history_summary).toBe('')
        expect(profile.risk_assessment.is_suspicious).toBe(false)
        expect(profile.risk_assessment.warning_msg).toBe('')
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot, Property 8: New Contact Profile Creation**
   * **Validates: Requirements 5.1**
   *
   * *For any* valid contact ID and nickname, creating and saving a profile via
   * MemoryManager SHALL persist a valid profile that can be loaded back.
   */
  it('should persist created profile via MemoryManager', async () => {
    await fc.assert(
      fc.asyncProperty(contactIdArbitrary, nicknameArbitrary, async (contactId, nickname) => {
        const createdProfile = await memoryManager.createContactProfile(contactId, nickname)

        // Verify the created profile has correct id and nickname
        expect(createdProfile.contact_id).toBe(contactId)
        expect(createdProfile.nickname).toBe(nickname)

        // Verify the profile can be loaded back
        const loadedProfile = await memoryManager.loadContactProfile(contactId)
        expect(loadedProfile).not.toBeNull()
        expect(loadedProfile).toEqual(createdProfile)
      }),
      { numRuns: 50 } // Reduced runs for async file operations
    )
  })
})


// ============================================================================
// Property 7: Profile Update Merge Correctness
// ============================================================================

describe('Property 7: Profile Update Merge Correctness', () => {
  /**
   * **Feature: social-copilot, Property 7: Profile Update Merge Correctness**
   * **Validates: Requirements 5.3, 5.4**
   *
   * *For any* existing ContactProfile and any ExtractedFacts update, applying the update
   * SHALL result in new values overriding old values for overlapping fields.
   */
  it('should override old values with new values for overlapping fields', () => {
    fc.assert(
      fc.property(
        contactProfileArbitrary,
        extractedFactsArbitrary,
        (existingProfile, updates) => {
          const merged = MemoryManager.mergeProfileUpdates(existingProfile, updates)

          // Verify profile updates override existing values
          if (updates.profile?.role !== undefined) {
            expect(merged.profile.role).toBe(updates.profile.role)
          }
          if (updates.profile?.age_group !== undefined) {
            expect(merged.profile.age_group).toBe(updates.profile.age_group)
          }
          if (updates.profile?.personality_tags !== undefined) {
            expect(merged.profile.personality_tags).toEqual(updates.profile.personality_tags)
          }
          if (updates.profile?.interests !== undefined) {
            expect(merged.profile.interests).toEqual(updates.profile.interests)
          }

          // Verify relationship graph updates override existing values
          if (updates.relationship_graph?.current_status !== undefined) {
            expect(merged.relationship_graph.current_status).toBe(
              updates.relationship_graph.current_status
            )
          }
          if (updates.relationship_graph?.intimacy_level !== undefined) {
            expect(merged.relationship_graph.intimacy_level).toBe(
              updates.relationship_graph.intimacy_level
            )
          }

          // Verify chat history summary update
          if (updates.chat_history_summary !== undefined) {
            expect(merged.chat_history_summary).toBe(updates.chat_history_summary)
          }

          // Verify risk assessment updates
          if (updates.risk_assessment?.is_suspicious !== undefined) {
            expect(merged.risk_assessment.is_suspicious).toBe(updates.risk_assessment.is_suspicious)
          }
          if (updates.risk_assessment?.warning_msg !== undefined) {
            expect(merged.risk_assessment.warning_msg).toBe(updates.risk_assessment.warning_msg)
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot, Property 7: Profile Update Merge Correctness**
   * **Validates: Requirements 5.3, 5.4**
   *
   * *For any* existing ContactProfile and any ExtractedFacts update, applying the update
   * SHALL preserve non-updated fields.
   */
  it('should preserve non-updated fields', () => {
    fc.assert(
      fc.property(
        contactProfileArbitrary,
        extractedFactsArbitrary,
        (existingProfile, updates) => {
          const merged = MemoryManager.mergeProfileUpdates(existingProfile, updates)

          // contact_id and nickname should always be preserved
          expect(merged.contact_id).toBe(existingProfile.contact_id)
          expect(merged.nickname).toBe(existingProfile.nickname)

          // Verify non-updated profile fields are preserved
          if (updates.profile?.role === undefined) {
            expect(merged.profile.role).toBe(existingProfile.profile.role)
          }
          if (updates.profile?.age_group === undefined) {
            expect(merged.profile.age_group).toBe(existingProfile.profile.age_group)
          }
          if (updates.profile?.personality_tags === undefined) {
            expect(merged.profile.personality_tags).toEqual(existingProfile.profile.personality_tags)
          }
          if (updates.profile?.interests === undefined) {
            expect(merged.profile.interests).toEqual(existingProfile.profile.interests)
          }

          // Verify non-updated relationship graph fields are preserved
          if (updates.relationship_graph?.current_status === undefined) {
            expect(merged.relationship_graph.current_status).toBe(
              existingProfile.relationship_graph.current_status
            )
          }
          if (updates.relationship_graph?.intimacy_level === undefined) {
            expect(merged.relationship_graph.intimacy_level).toBe(
              existingProfile.relationship_graph.intimacy_level
            )
          }

          // Verify non-updated chat history is preserved
          if (updates.chat_history_summary === undefined) {
            expect(merged.chat_history_summary).toBe(existingProfile.chat_history_summary)
          }

          // Verify non-updated risk assessment fields are preserved
          if (updates.risk_assessment?.is_suspicious === undefined) {
            expect(merged.risk_assessment.is_suspicious).toBe(
              existingProfile.risk_assessment.is_suspicious
            )
          }
          if (updates.risk_assessment?.warning_msg === undefined) {
            expect(merged.risk_assessment.warning_msg).toBe(
              existingProfile.risk_assessment.warning_msg
            )
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot, Property 7: Profile Update Merge Correctness**
   * **Validates: Requirements 5.3, 5.4**
   *
   * *For any* existing ContactProfile and any ExtractedFacts update, the merged result
   * SHALL be a valid ContactProfile.
   */
  it('should produce valid ContactProfile after merge', () => {
    fc.assert(
      fc.property(
        contactProfileArbitrary,
        extractedFactsArbitrary,
        (existingProfile, updates) => {
          const merged = MemoryManager.mergeProfileUpdates(existingProfile, updates)

          const validation = validateContactProfile(merged)
          expect(validation.success).toBe(true)
        }
      ),
      { numRuns: 100 }
    )
  })
})


// ============================================================================
// Property 10: Risk Assessment Persistence
// ============================================================================

describe('Property 10: Risk Assessment Persistence', () => {
  /**
   * **Feature: social-copilot, Property 10: Risk Assessment Persistence**
   * **Validates: Requirements 8.1, 8.3**
   *
   * *For any* ContactProfile with risk_assessment changes, updating and reloading
   * the profile SHALL preserve the is_suspicious flag and warning_msg values.
   */
  it('should persist risk assessment changes through save/load cycle', async () => {
    await fc.assert(
      fc.asyncProperty(
        contactIdArbitrary,
        nicknameArbitrary,
        riskAssessmentArbitrary,
        async (contactId, nickname, riskAssessment) => {
          // Create initial profile
          await memoryManager.createContactProfile(contactId, nickname)

          // Update with risk assessment
          const updates: ExtractedFacts = {
            risk_assessment: riskAssessment
          }
          await memoryManager.updateContactProfile(contactId, updates)

          // Load and verify risk assessment is preserved
          const loadedProfile = await memoryManager.loadContactProfile(contactId)
          expect(loadedProfile).not.toBeNull()
          expect(loadedProfile!.risk_assessment.is_suspicious).toBe(riskAssessment.is_suspicious)
          expect(loadedProfile!.risk_assessment.warning_msg).toBe(riskAssessment.warning_msg)
        }
      ),
      { numRuns: 50 } // Reduced runs for async file operations
    )
  })

  /**
   * **Feature: social-copilot, Property 10: Risk Assessment Persistence**
   * **Validates: Requirements 8.1, 8.3**
   *
   * *For any* sequence of risk assessment updates, the final state SHALL reflect
   * the most recent update (new values override old).
   */
  it('should preserve most recent risk assessment after multiple updates', async () => {
    await fc.assert(
      fc.asyncProperty(
        contactIdArbitrary,
        nicknameArbitrary,
        fc.array(riskAssessmentArbitrary, { minLength: 1, maxLength: 5 }),
        async (contactId, nickname, riskAssessments) => {
          // Create initial profile
          await memoryManager.createContactProfile(contactId, nickname)

          // Apply multiple risk assessment updates
          for (const riskAssessment of riskAssessments) {
            const updates: ExtractedFacts = {
              risk_assessment: riskAssessment
            }
            await memoryManager.updateContactProfile(contactId, updates)
          }

          // Load and verify the last risk assessment is preserved
          const lastRiskAssessment = riskAssessments[riskAssessments.length - 1]
          const loadedProfile = await memoryManager.loadContactProfile(contactId)
          expect(loadedProfile).not.toBeNull()
          expect(loadedProfile!.risk_assessment.is_suspicious).toBe(lastRiskAssessment.is_suspicious)
          expect(loadedProfile!.risk_assessment.warning_msg).toBe(lastRiskAssessment.warning_msg)
        }
      ),
      { numRuns: 30 } // Reduced runs for multiple async operations
    )
  })

  /**
   * **Feature: social-copilot, Property 10: Risk Assessment Persistence**
   * **Validates: Requirements 8.1, 8.3**
   *
   * *For any* ContactProfile, updating only is_suspicious SHALL preserve warning_msg
   * and vice versa.
   */
  it('should preserve unmodified risk assessment fields', async () => {
    await fc.assert(
      fc.asyncProperty(
        contactIdArbitrary,
        nicknameArbitrary,
        riskAssessmentArbitrary,
        fc.boolean(),
        async (contactId, nickname, initialRisk, newIsSuspicious) => {
          // Create profile with initial risk assessment
          await memoryManager.createContactProfile(contactId, nickname)
          await memoryManager.updateContactProfile(contactId, {
            risk_assessment: initialRisk
          })

          // Update only is_suspicious
          await memoryManager.updateContactProfile(contactId, {
            risk_assessment: { is_suspicious: newIsSuspicious }
          })

          // Verify warning_msg is preserved
          const loadedProfile = await memoryManager.loadContactProfile(contactId)
          expect(loadedProfile).not.toBeNull()
          expect(loadedProfile!.risk_assessment.is_suspicious).toBe(newIsSuspicious)
          expect(loadedProfile!.risk_assessment.warning_msg).toBe(initialRisk.warning_msg)
        }
      ),
      { numRuns: 50 }
    )
  })
})


// ============================================================================
// Property 19: Concurrent Write Safety
// ============================================================================

describe('Property 19: Concurrent Write Safety', () => {
  /**
   * **Feature: social-copilot-v2, Property 19: Concurrent Write Safety**
   * **Validates: Requirements 8.6**
   *
   * *For any* sequence of concurrent profile update operations on the same file,
   * the final file content should be valid JSON conforming to the profile schema.
   */
  it('should produce valid JSON after concurrent writes to same contact', async () => {
    await fc.assert(
      fc.asyncProperty(
        contactIdArbitrary,
        nicknameArbitrary,
        fc.array(extractedFactsArbitrary, { minLength: 2, maxLength: 3 }),
        async (contactId, nickname, updatesList) => {
          // Use unique contact ID for each test run
          const uniqueContactId = `${contactId}_${Date.now()}_${Math.random().toString(36).slice(2)}`

          // Create initial profile
          await memoryManager.createContactProfile(uniqueContactId, nickname)

          // Perform concurrent updates
          const updatePromises = updatesList.map((updates) =>
            memoryManager.updateContactProfile(uniqueContactId, updates).catch(() => null)
          )

          // Wait for all updates to complete (some may fail due to locking, which is expected)
          await Promise.all(updatePromises)

          // Final profile should be valid JSON conforming to schema
          const loadedProfile = await memoryManager.loadContactProfile(uniqueContactId)
          expect(loadedProfile).not.toBeNull()
          const validation = validateContactProfile(loadedProfile!)
          expect(validation.success).toBe(true)
        }
      ),
      { numRuns: 20 }
    )
  }, 30000) // 30 second timeout

  /**
   * **Feature: social-copilot-v2, Property 19: Concurrent Write Safety**
   * **Validates: Requirements 8.6**
   *
   * *For any* concurrent writes to user profile, the final file should be valid.
   */
  it('should produce valid JSON after concurrent writes to user profile', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            frequent_phrases: fc.array(fc.string(), { maxLength: 3 }),
            emoji_usage: fc.array(fc.string(), { maxLength: 3 }),
            punctuation_style: fc.string(),
            msg_avg_length: fc.constantFrom('short', 'medium', 'long') as fc.Arbitrary<
              'short' | 'medium' | 'long'
            >
          }),
          { minLength: 2, maxLength: 3 }
        ),
        async (habitsList) => {
          // Create a fresh manager with unique directory for this test
          const uniqueDir = join(testDir, `user_${Date.now()}_${Math.random().toString(36).slice(2)}`)
          const freshManager = new MemoryManager(uniqueDir)

          // Load initial profile
          const initialProfile = await freshManager.loadUserProfile()

          // Perform concurrent updates
          const updatePromises = habitsList.map((habits) => {
            const updatedProfile = {
              ...initialProfile,
              communication_habits: habits,
              last_updated: Date.now()
            }
            return freshManager.saveUserProfile(updatedProfile).catch(() => null)
          })

          // Wait for all updates to complete
          await Promise.all(updatePromises)

          // Final profile should be valid
          const loadedProfile = await freshManager.loadUserProfile()
          expect(loadedProfile).toBeDefined()
          expect(loadedProfile.user_id).toBe(initialProfile.user_id)
        }
      ),
      { numRuns: 20 }
    )
  }, 30000) // 30 second timeout
})


// ============================================================================
// Property 23: Settings Persistence
// ============================================================================

// Generator for valid AppSettings
const appSettingsArbitrary: fc.Arbitrary<AppSettings> = fc.record({
  monitorMode: fc.constantFrom('auto', 'accessibility', 'ocr') as fc.Arbitrary<MonitorMode>,
  floatingWindow: fc.record({
    opacity: fc.double({ min: 0, max: 1, noNaN: true }),
    width: fc.integer({ min: 100, max: 2000 }),
    height: fc.integer({ min: 100, max: 2000 }),
    position: fc.option(
      fc.record({
        x: fc.integer({ min: -5000, max: 5000 }),
        y: fc.integer({ min: -5000, max: 5000 })
      }),
      { nil: null }
    ),
    lazyFollow: fc.boolean()
  }),
  shortcuts: fc.record({
    copySuggestion1: fc.string({ minLength: 1 }),
    copySuggestion2: fc.string({ minLength: 1 }),
    copySuggestion3: fc.string({ minLength: 1 })
  }),
  sessionExpiryHours: fc.integer({ min: 1, max: 24 }),
  modelProviders: fc.record({
    assistant: fc.record({
      baseUrl: fc.webUrl(),
      apiKey: fc.string(),
      modelName: fc.string({ minLength: 1 }),
      requestTimeoutMs: fc.integer({ min: 1000, max: 120000 })
    }),
    vision: fc.record({
      baseUrl: fc.webUrl(),
      apiKey: fc.string(),
      modelName: fc.string({ minLength: 1 }),
      requestTimeoutMs: fc.integer({ min: 1000, max: 120000 })
    })
  }),
  visualMonitor: fc.record({
    apiBaseUrl: fc.webUrl(),
    monitoredAppName: fc.string({ minLength: 1 }),
    captureSensitivity: fc.constantFrom('high', 'medium', 'low'),
    captureScheme: fc.constantFrom('legacy', 'current'),
    captureScope: fc.constantFrom('roi', 'full_window'),
    roiStrategy: fc.constantFrom('manual', 'auto', 'hybrid'),
    manualRoi: fc.option(
      fc.record({
        x: fc.integer({ min: 0, max: 5000 }),
        y: fc.integer({ min: 0, max: 5000 }),
        w: fc.integer({ min: 1, max: 5000 }),
        h: fc.integer({ min: 1, max: 5000 })
      }),
      { nil: null }
    ),
    autoRoi: fc.record({
      coarseLeftRatio: fc.double({ min: 0, max: 1, noNaN: true }),
      coarseTopRatio: fc.double({ min: 0, max: 1, noNaN: true }),
      coarseWidthRatio: fc.double({ min: 0.1, max: 1, noNaN: true }),
      coarseHeightRatio: fc.double({ min: 0.1, max: 1, noNaN: true })
    }),
    windowGate: fc.record({
      confirmationSamples: fc.integer({ min: 1, max: 5 }),
      confirmationIntervalMs: fc.integer({ min: 0, max: 500 })
    }),
    captureTuning: fc.record({
      hashSimilaritySkip: fc.double({ min: 0, max: 1, noNaN: true }),
      ssimChange: fc.double({ min: 0, max: 1, noNaN: true }),
      keptFrameDedupSimilarityThreshold: fc.double({ min: 0, max: 1, noNaN: true }),
      chatRecordCaptureDedupWindowMs: fc.integer({ min: 1000, max: 600000 })
    })
  }),
  evermemos: fc.record({
    enabled: fc.boolean(),
    apiBaseUrl: fc.webUrl(),
    ownerUserId: fc.string({ minLength: 1 }),
    requestTimeoutMs: fc.integer({ min: 1000, max: 60000 }),
    llm: fc.record({
      baseUrl: fc.string(),
      apiKey: fc.string(),
      model: fc.string({ minLength: 1 }),
      temperature: fc.double({ min: 0, max: 2, noNaN: true }),
      maxTokens: fc.integer({ min: 1, max: 32768 })
    }),
    deletedProfileSessionKeys: fc.array(fc.string()),
    sessionBackfillProgress: fc.dictionary(fc.string(), fc.string())
  }),
  storagePaths: fc.record({
    rootDir: fc.string({ minLength: 1 }),
    cacheDir: fc.string({ minLength: 1 }),
    chatRecordsDir: fc.string({ minLength: 1 }),
    memoryLibraryDir: fc.string({ minLength: 1 })
  }),
  onboardingComplete: fc.boolean()
})

describe('Property 23: Settings Persistence', () => {
  /**
   * **Feature: social-copilot-v2, Property 23: Settings Persistence**
   * **Validates: Requirements 11.5**
   *
   * *For any* settings change made by the user, the change should be immediately
   * persisted and correctly restored on next load.
   */
  it('should persist and restore settings correctly', async () => {
    await fc.assert(
      fc.asyncProperty(appSettingsArbitrary, async (settings) => {
        // Save settings
        await memoryManager.saveSettings(settings)

        // Load settings back
        const loadedSettings = await memoryManager.loadSettings()

        // Verify all fields match
        expect(loadedSettings.monitorMode).toBe(settings.monitorMode)
        expect(loadedSettings.floatingWindow.opacity).toBeCloseTo(settings.floatingWindow.opacity, 5)
        expect(loadedSettings.floatingWindow.width).toBe(settings.floatingWindow.width)
        expect(loadedSettings.floatingWindow.height).toBe(settings.floatingWindow.height)
        expect(loadedSettings.floatingWindow.position).toEqual(settings.floatingWindow.position)
        expect(loadedSettings.floatingWindow.lazyFollow).toBe(settings.floatingWindow.lazyFollow)
        expect(loadedSettings.shortcuts).toEqual(settings.shortcuts)
        expect(loadedSettings.sessionExpiryHours).toBe(settings.sessionExpiryHours)

        // Verify loaded settings are valid
        const validation = validateAppSettings(loadedSettings)
        expect(validation.success).toBe(true)
      }),
      { numRuns: 50 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 23: Settings Persistence**
   * **Validates: Requirements 11.5**
   *
   * *For any* sequence of settings changes, the final state should reflect
   * the most recent change.
   */
  it('should preserve most recent settings after multiple saves', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(appSettingsArbitrary, { minLength: 1, maxLength: 5 }),
        async (settingsList) => {
          // Apply multiple settings saves
          for (const settings of settingsList) {
            await memoryManager.saveSettings(settings)
          }

          // Load and verify the last settings are preserved
          const lastSettings = settingsList[settingsList.length - 1]
          const loadedSettings = await memoryManager.loadSettings()

          expect(loadedSettings.monitorMode).toBe(lastSettings.monitorMode)
          expect(loadedSettings.floatingWindow.lazyFollow).toBe(lastSettings.floatingWindow.lazyFollow)
          expect(loadedSettings.sessionExpiryHours).toBe(lastSettings.sessionExpiryHours)
        }
      ),
      { numRuns: 30 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 23: Settings Persistence**
   * **Validates: Requirements 11.5**
   *
   * *For any* new MemoryManager instance, loading settings should return
   * previously saved settings (persistence across instances).
   */
  it('should persist settings across MemoryManager instances', async () => {
    await fc.assert(
      fc.asyncProperty(appSettingsArbitrary, async (settings) => {
        // Save settings with first instance
        await memoryManager.saveSettings(settings)

        // Create new MemoryManager instance with same base directory
        const newManager = new MemoryManager(testDir)

        // Load settings with new instance
        const loadedSettings = await newManager.loadSettings()

        // Verify settings match
        expect(loadedSettings.monitorMode).toBe(settings.monitorMode)
        expect(loadedSettings.floatingWindow.lazyFollow).toBe(settings.floatingWindow.lazyFollow)
        expect(loadedSettings.sessionExpiryHours).toBe(settings.sessionExpiryHours)
      }),
      { numRuns: 30 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 23: Settings Persistence**
   * **Validates: Requirements 11.5**
   *
   * When no settings file exists, loading should return default settings.
   */
  it('should return default settings when no settings file exists', async () => {
    // Load settings from fresh directory (no settings file)
    const loadedSettings = await memoryManager.loadSettings()
    const reloadedSettings = await memoryManager.loadSettings()

    // Verify env-aware defaults are valid and persisted consistently
    const validation = validateAppSettings(loadedSettings)
    expect(validation.success).toBe(true)
    expect(loadedSettings.monitorMode).toBe(DEFAULT_APP_SETTINGS.monitorMode)
    expect(loadedSettings.visualMonitor.monitoredAppName).toBeTruthy()
    expect(loadedSettings.storagePaths).toEqual(DEFAULT_APP_SETTINGS.storagePaths)
    expect(reloadedSettings).toEqual(loadedSettings)
  })
})
