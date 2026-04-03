import { readFile, writeFile, mkdir, readdir, access, rename, unlink } from 'fs/promises'
import { constants } from 'fs'
import { basename, join } from 'path'
import { homedir, userInfo } from 'os'
import {
  UserProfile,
  ContactProfile,
  UnifiedProfile,
  AppSettings,
  DEFAULT_APP_SETTINGS,
  createDefaultUnifiedUserProfile,
  createDefaultUnifiedContactProfile,
  serializeUnifiedProfile,
  deserializeAppSettings,
  serializeAppSettings,
  validateUserProfile,
  validateContactProfile,
  validateUnifiedProfile,
  validateAppSettings,
  RiskAssessment,
  ContactProfileInfo,
  RelationshipGraph,
  convertLegacyUserProfileToUnifiedProfile,
  convertLegacyContactProfileToUnifiedProfile,
  convertUnifiedProfileToLegacyUserProfile,
  convertUnifiedProfileToLegacyContactProfile
} from '../models'
import { ensureSocialClawEnvLoaded } from './project-env'

// ============================================================================
// Types for Profile Updates
// ============================================================================

export interface ExtractedFacts {
  profile?: Partial<ContactProfileInfo>
  relationship_graph?: Partial<RelationshipGraph>
  chat_history_summary?: string
  risk_assessment?: Partial<RiskAssessment>
}

// ============================================================================
// Error Types
// ============================================================================

export class MemoryManagerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryManagerError'
  }
}

export class ProfileNotFoundError extends MemoryManagerError {
  constructor(profileType: string, id?: string) {
    super(id ? `${profileType} not found: ${id}` : `${profileType} not found`)
    this.name = 'ProfileNotFoundError'
  }
}

export class ProfileValidationError extends MemoryManagerError {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileValidationError'
  }
}

export class FileLockError extends MemoryManagerError {
  constructor(filePath: string) {
    super(`Failed to acquire lock for file: ${filePath}`)
    this.name = 'FileLockError'
  }
}


// ============================================================================
// File Lock Implementation
// ============================================================================

/**
 * Simple file-based locking mechanism
 * Uses .lock files with retry mechanism (3 attempts, 100ms delay)
 */
class FileLock {
  private static readonly LOCK_EXTENSION = '.lock'
  private static readonly MAX_RETRIES = 3
  private static readonly RETRY_DELAY_MS = 100
  private static readonly LOCK_TIMEOUT_MS = 5000 // Lock expires after 5 seconds

  /**
   * Attempts to acquire a lock for the given file
   * @param filePath - Path to the file to lock
   * @returns true if lock acquired, false otherwise
   */
  static async acquire(filePath: string): Promise<boolean> {
    const lockPath = filePath + FileLock.LOCK_EXTENSION

    for (let attempt = 0; attempt < FileLock.MAX_RETRIES; attempt++) {
      try {
        // Check if lock exists and is stale
        try {
          const lockContent = await readFile(lockPath, 'utf-8')
          const lockTime = parseInt(lockContent, 10)
          if (Date.now() - lockTime > FileLock.LOCK_TIMEOUT_MS) {
            // Lock is stale, remove it
            await FileLock.release(filePath)
          } else {
            // Lock is active, wait and retry
            await FileLock.delay(FileLock.RETRY_DELAY_MS)
            continue
          }
        } catch {
          // Lock file doesn't exist, proceed to create
        }

        // Create lock file with current timestamp
        await writeFile(lockPath, Date.now().toString(), { flag: 'wx' })
        return true
      } catch (error) {
        // Lock file already exists or other error
        if (attempt < FileLock.MAX_RETRIES - 1) {
          await FileLock.delay(FileLock.RETRY_DELAY_MS)
        }
      }
    }
    return false
  }

  /**
   * Releases the lock for the given file
   * @param filePath - Path to the file to unlock
   */
  static async release(filePath: string): Promise<void> {
    const lockPath = filePath + FileLock.LOCK_EXTENSION
    try {
      const { unlink } = await import('fs/promises')
      await unlink(lockPath)
    } catch {
      // Lock file may not exist, ignore
    }
  }

  private static delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}


// ============================================================================
// MemoryManager Class
// ============================================================================

/**
 * MemoryManager - Manages local file storage for profiles
 *
 * Handles:
 * - User profile loading/saving with validation (Requirements 4.1, 4.2, 4.3, 4.4)
 * - Contact profile CRUD operations (Requirements 5.1, 5.5, 5.6)
 * - File locking for concurrent write protection (Requirement 5.5)
 * - Directory structure initialization
 */
export class MemoryManager {
  private readonly baseDir: string
  private readonly contactsDir: string
  private readonly userProfilePath: string
  private readonly settingsPath: string

  constructor(baseDir?: string) {
    ensureSocialClawEnvLoaded(__dirname)
    this.baseDir = baseDir || join(homedir(), 'SocialCopilot')
    this.contactsDir = join(this.baseDir, 'contacts')
    this.userProfilePath = join(this.baseDir, 'user_profile.json')
    this.settingsPath = join(this.baseDir, 'settings.json')
  }

  /**
   * Initializes the directory structure on first run
   * Creates ~/SocialCopilot/ and ~/SocialCopilot/contacts/
   * Validates: Requirement 4.1
   */
  async initialize(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true })
    await mkdir(this.contactsDir, { recursive: true })
  }

  /**
   * Checks if a file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath, constants.F_OK)
      return true
    } catch {
      return false
    }
  }

  // ============================================================================
  // User Profile Operations
  // ============================================================================

  /**
   * Loads the user profile from disk
   * Creates default profile if it doesn't exist (Requirement 4.1)
   * Validates JSON structure against schema (Requirement 4.3)
   * Resets to default if invalid (Requirement 4.4)
   * @returns UserProfile
   */
  async loadUserProfile(): Promise<UserProfile> {
    const profile = await this.loadUnifiedUserProfile()
    return convertUnifiedProfileToLegacyUserProfile(profile)
  }

  async loadUnifiedUserProfile(): Promise<UnifiedProfile> {
    await this.initialize()
    const ownerUserId = await this.resolveOwnerUserId()

    if (!(await this.fileExists(this.userProfilePath))) {
      const profile = createDefaultUnifiedUserProfile(ownerUserId)
      await this.saveUnifiedUserProfile(profile)
      return profile
    }

    try {
      const content = await readFile(this.userProfilePath, 'utf-8')
      const parsed = JSON.parse(content) as unknown
      const validation = validateUnifiedProfile(parsed)

      if (!validation.success) {
        const legacyValidation = validateUserProfile(parsed)
        if (legacyValidation.success) {
          const migrated = {
            ...convertLegacyUserProfileToUnifiedProfile(legacyValidation.data),
            owner_user_id: ownerUserId,
            profile_id: ownerUserId
          }
          await this.saveUnifiedUserProfile(migrated)
          return migrated
        }
        console.warn('User profile validation failed, resetting to default')
        const fallbackProfile = createDefaultUnifiedUserProfile(ownerUserId)
        await this.saveUnifiedUserProfile(fallbackProfile)
        return fallbackProfile
      }

      if (
        this.shouldNormalizeOwnerId(validation.data.owner_user_id) ||
        validation.data.owner_user_id !== ownerUserId ||
        validation.data.profile_id !== ownerUserId ||
        validation.data.display_name !== 'Me'
      ) {
        const normalized = {
          ...validation.data,
          owner_user_id: ownerUserId,
          profile_id: ownerUserId,
          display_name: 'Me'
        }
        await this.saveUnifiedUserProfile(normalized)
        return normalized
      }

      return validation.data
    } catch (error) {
      console.warn('Failed to load user profile, resetting to default:', error)
      const fallbackProfile = createDefaultUnifiedUserProfile(ownerUserId)
      await this.saveUnifiedUserProfile(fallbackProfile)
      return fallbackProfile
    }
  }

  /**
   * Saves the user profile to disk with file locking
   * Persists changes immediately (Requirement 4.2)
   * Uses file locking to prevent concurrent write conflicts (Requirement 5.5)
   * @param profile - UserProfile to save
   */
  async saveUserProfile(profile: UserProfile): Promise<void> {
    await this.saveUnifiedUserProfile(convertLegacyUserProfileToUnifiedProfile(profile))
  }

  async saveUnifiedUserProfile(profile: UnifiedProfile): Promise<void> {
    await this.initialize()
    const ownerUserId = await this.resolveOwnerUserId(profile.owner_user_id)
    const normalizedProfile: UnifiedProfile = {
      ...profile,
      profile_type: 'user',
      owner_user_id: ownerUserId,
      profile_id: ownerUserId,
      display_name: 'Me'
    }

    const validation = validateUnifiedProfile(normalizedProfile)
    if (!validation.success) {
      throw new ProfileValidationError(`Invalid unified user profile: ${validation.error.message}`)
    }

    const lockAcquired = await FileLock.acquire(this.userProfilePath)
    if (!lockAcquired) {
      throw new FileLockError(this.userProfilePath)
    }

    try {
      const content = serializeUnifiedProfile(validation.data)
      // Write to temp file first, then rename for atomic operation
      const tempPath = this.userProfilePath + '.tmp'
      await writeFile(tempPath, content, 'utf-8')
      await rename(tempPath, this.userProfilePath)
    } finally {
      await FileLock.release(this.userProfilePath)
    }
  }


  // ============================================================================
  // Contact Profile Operations
  // ============================================================================

  /**
   * Gets the file path for a contact profile
   */
  private getContactProfilePath(contactId: string): string {
    // Sanitize contact ID to prevent path traversal
    const sanitizedId = contactId.replace(/[^a-zA-Z0-9_-]/g, '_')
    return join(this.contactsDir, `${sanitizedId}.json`)
  }

  private normalizeContactLookupValue(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null
    }
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  private async resolveExistingContactProfileByLookup(
    lookupId: string
  ): Promise<{ profilePath: string; profile: UnifiedProfile } | null> {
    const normalizedLookup = this.normalizeContactLookupValue(lookupId)
    if (!normalizedLookup) {
      return null
    }

    try {
      const files = await readdir(this.contactsDir)
      for (const file of files) {
        if (!file.endsWith('.json')) {
          continue
        }
        const profilePath = join(this.contactsDir, file)
        try {
          const content = await readFile(profilePath, 'utf-8')
          const parsed = JSON.parse(content) as unknown
          const validation = validateUnifiedProfile(parsed)
          if (!validation.success) {
            continue
          }
          const profile = validation.data
          const candidates = new Set<string>()
          const filenameId = basename(file, '.json')
          candidates.add(filenameId)
          for (const candidate of [
            profile.profile_id,
            profile.target_user_id,
            profile.conversation_id,
            profile.display_name,
            ...(profile.aliases ?? [])
          ]) {
            const normalizedCandidate = this.normalizeContactLookupValue(candidate)
            if (normalizedCandidate) {
              candidates.add(normalizedCandidate)
            }
          }
          if (candidates.has(normalizedLookup)) {
            return { profilePath, profile }
          }
        } catch {
          continue
        }
      }
    } catch {
      return null
    }

    return null
  }

  private buildProfileIdentitySet(profile: UnifiedProfile, fileName?: string): Set<string> {
    const identities = new Set<string>()
    if (fileName) {
      identities.add(basename(fileName, '.json'))
    }
    for (const candidate of [
      profile.profile_id,
      profile.target_user_id,
      profile.conversation_id,
      profile.display_name,
      ...(profile.aliases ?? [])
    ]) {
      const normalized = this.normalizeContactLookupValue(candidate)
      if (normalized) {
        identities.add(normalized)
      }
    }
    return identities
  }

  private async cleanupDuplicateContactProfiles(
    canonicalContactId: string,
    profile: UnifiedProfile
  ): Promise<void> {
    const canonicalPath = this.getContactProfilePath(canonicalContactId)
    const canonicalIdentities = this.buildProfileIdentitySet(profile)

    try {
      const files = await readdir(this.contactsDir)
      for (const file of files) {
        if (!file.endsWith('.json')) {
          continue
        }
        const profilePath = join(this.contactsDir, file)
        if (profilePath === canonicalPath) {
          continue
        }

        try {
          const content = await readFile(profilePath, 'utf-8')
          const parsed = JSON.parse(content) as unknown
          const validation = validateUnifiedProfile(parsed)
          if (!validation.success) {
            continue
          }
          const existingProfile = validation.data
          const sameIdentity =
            (existingProfile.profile_id && existingProfile.profile_id === profile.profile_id) ||
            (existingProfile.target_user_id && existingProfile.target_user_id === profile.target_user_id) ||
            (existingProfile.conversation_id && existingProfile.conversation_id === profile.conversation_id)
          if (!sameIdentity) {
            continue
          }

          const mergedAliases = Array.from(
            new Set([
              ...(profile.aliases ?? []),
              ...(existingProfile.aliases ?? []),
              existingProfile.display_name || '',
              existingProfile.target_user_id || '',
              existingProfile.conversation_id || ''
            ].filter((value) => typeof value === 'string' && value.trim().length > 0))
          )

          profile.aliases = mergedAliases
          for (const identity of this.buildProfileIdentitySet(existingProfile, file)) {
            canonicalIdentities.add(identity)
          }

          await unlink(profilePath).catch(() => undefined)
        } catch {
          continue
        }
      }
    } catch {
      return
    }

    profile.aliases = Array.from(canonicalIdentities).filter(
      (value) => value !== canonicalContactId
    )
  }

  async deleteUnifiedContactProfilesByIdentity(identity: {
    profile_id?: string | null
    target_user_id?: string | null
    conversation_id?: string | null
    display_name?: string | null
    aliases?: string[] | null
  }): Promise<number> {
    await this.initialize()

    const lookupValues = new Set<string>()
    for (const candidate of [
      identity.profile_id,
      identity.target_user_id,
      identity.conversation_id,
      identity.display_name,
      ...(identity.aliases ?? [])
    ]) {
      const normalized = this.normalizeContactLookupValue(candidate)
      if (normalized) {
        lookupValues.add(normalized)
      }
    }
    if (lookupValues.size === 0) {
      return 0
    }

    let deletedCount = 0
    try {
      const files = await readdir(this.contactsDir)
      for (const file of files) {
        if (!file.endsWith('.json')) {
          continue
        }
        const profilePath = join(this.contactsDir, file)
        try {
          const content = await readFile(profilePath, 'utf-8')
          const parsed = JSON.parse(content) as unknown
          const validation = validateUnifiedProfile(parsed)
          if (!validation.success) {
            continue
          }

          const existingIdentities = this.buildProfileIdentitySet(validation.data, file)
          const matched = Array.from(lookupValues).some((value) => existingIdentities.has(value))
          if (!matched) {
            continue
          }

          await unlink(profilePath).catch(() => undefined)
          deletedCount += 1
        } catch {
          continue
        }
      }
    } catch {
      return deletedCount
    }

    return deletedCount
  }

  /**
   * Loads a contact profile from disk
   * @param contactId - The contact's unique identifier
   * @returns ContactProfile or null if not found
   * Validates: Requirement 5.6
   */
  async loadContactProfile(contactId: string): Promise<ContactProfile | null> {
    const profile = await this.loadUnifiedContactProfile(contactId)
    return profile ? convertUnifiedProfileToLegacyContactProfile(profile) : null
  }

  async loadUnifiedContactProfile(contactId: string): Promise<UnifiedProfile | null> {
    await this.initialize()
    const ownerUserId = await this.resolveOwnerUserId()

    const requestedProfilePath = this.getContactProfilePath(contactId)
    let profilePath = requestedProfilePath

    if (!(await this.fileExists(profilePath))) {
      const resolved = await this.resolveExistingContactProfileByLookup(contactId)
      if (!resolved) {
        return null
      }
      profilePath = resolved.profilePath
    }

    try {
      const content = await readFile(profilePath, 'utf-8')
      const parsed = JSON.parse(content) as unknown
      const validation = validateUnifiedProfile(parsed)

      if (!validation.success) {
        const legacyValidation = validateContactProfile(parsed)
        if (legacyValidation.success) {
          const migrated = {
            ...convertLegacyContactProfileToUnifiedProfile(legacyValidation.data, ownerUserId),
            owner_user_id: ownerUserId
          }
          await this.saveUnifiedContactProfile(contactId, migrated)
          return migrated
        }
        console.warn(`Contact profile validation failed for ${contactId}`)
        return null
      }

      if (
        this.shouldNormalizeOwnerId(validation.data.owner_user_id) ||
        validation.data.owner_user_id !== ownerUserId
      ) {
        const normalized = {
          ...validation.data,
          owner_user_id: ownerUserId
        }
        await this.saveUnifiedContactProfile(contactId, normalized)
        return normalized
      }

      if (profilePath !== requestedProfilePath) {
        const migrated = {
          ...validation.data,
          aliases: Array.from(
            new Set([
              ...(validation.data.aliases ?? []),
              validation.data.display_name || '',
              validation.data.target_user_id || '',
              validation.data.conversation_id || ''
            ].filter((value) => typeof value === 'string' && value.trim().length > 0))
          )
        }
        await this.saveUnifiedContactProfile(contactId, migrated)
        return migrated
      }

      return validation.data
    } catch (error) {
      console.warn(`Failed to load contact profile ${contactId}:`, error)
      return null
    }
  }

  /**
   * Saves a contact profile to disk with file locking
   * Uses file locking to prevent concurrent write conflicts (Requirement 5.5)
   * @param contactId - The contact's unique identifier
   * @param profile - ContactProfile to save
   */
  async saveContactProfile(contactId: string, profile: ContactProfile): Promise<void> {
    await this.saveUnifiedContactProfile(contactId, convertLegacyContactProfileToUnifiedProfile(profile))
  }

  async saveUnifiedContactProfile(contactId: string, profile: UnifiedProfile): Promise<void> {
    await this.initialize()
    const ownerUserId = await this.resolveOwnerUserId(profile.owner_user_id)

    const normalizedProfile: UnifiedProfile = {
      ...profile,
      profile_type: 'contact',
      owner_user_id: ownerUserId,
      target_user_id: profile.target_user_id || contactId,
      conversation_id: profile.conversation_id || contactId,
      profile_id: profile.profile_id || contactId,
      display_name: profile.display_name || contactId,
      aliases: Array.from(
        new Set(
          [
            ...(profile.aliases ?? []),
            profile.display_name || '',
            profile.target_user_id || '',
            profile.conversation_id || ''
          ].filter((value) => typeof value === 'string' && value.trim().length > 0)
        )
      )
    }
    const validation = validateUnifiedProfile(normalizedProfile)
    if (!validation.success) {
      throw new ProfileValidationError(`Invalid unified contact profile: ${validation.error.message}`)
    }

    const dedupedProfile = { ...validation.data }
    await this.cleanupDuplicateContactProfiles(contactId, dedupedProfile)
    const dedupedValidation = validateUnifiedProfile(dedupedProfile)
    if (!dedupedValidation.success) {
      throw new ProfileValidationError(`Invalid unified contact profile: ${dedupedValidation.error.message}`)
    }

    const profilePath = this.getContactProfilePath(contactId)

    const lockAcquired = await FileLock.acquire(profilePath)
    if (!lockAcquired) {
      throw new FileLockError(profilePath)
    }

    try {
      const content = serializeUnifiedProfile(dedupedValidation.data)
      // Write to temp file first, then rename for atomic operation
      const tempPath = profilePath + '.tmp'
      await writeFile(tempPath, content, 'utf-8')
      await rename(tempPath, profilePath)
    } finally {
      await FileLock.release(profilePath)
    }
  }

  /**
   * Creates a new contact profile with default values
   * Validates: Requirement 5.1
   * @param contactId - The contact's unique identifier
   * @param nickname - The contact's display name
   * @returns The newly created ContactProfile
   */
  async createContactProfile(contactId: string, nickname: string): Promise<ContactProfile> {
    const profile = await this.createUnifiedContactProfile(contactId, nickname)
    return convertUnifiedProfileToLegacyContactProfile(profile)
  }

  async createUnifiedContactProfile(contactId: string, nickname: string): Promise<UnifiedProfile> {
    await this.initialize()

    const profile = createDefaultUnifiedContactProfile(await this.resolveOwnerUserId(), contactId, nickname)
    await this.saveUnifiedContactProfile(contactId, profile)
    return profile
  }

  /**
   * Lists all contact IDs from the contacts directory
   * @returns Array of contact IDs
   */
  async listContacts(): Promise<string[]> {
    await this.initialize()

    try {
      const files = await readdir(this.contactsDir)
      return files
        .filter((file) => file.endsWith('.json'))
        .map((file) => file.replace('.json', ''))
    } catch {
      return []
    }
  }

  /**
   * Merges extracted facts into an existing contact profile
   * New values override old values for overlapping fields (Requirement 5.4)
   * Non-updated fields are preserved (Requirement 5.3)
   * @param existingProfile - The current contact profile
   * @param updates - The extracted facts to merge
   * @returns Updated ContactProfile
   */
  static mergeProfileUpdates(
    existingProfile: ContactProfile,
    updates: ExtractedFacts
  ): ContactProfile {
    const merged: ContactProfile = { ...existingProfile }

    // Merge profile info
    if (updates.profile) {
      merged.profile = {
        ...existingProfile.profile,
        ...updates.profile,
        // Merge arrays by replacing (new overrides old per Requirement 5.4)
        personality_tags:
          updates.profile.personality_tags ?? existingProfile.profile.personality_tags,
        interests: updates.profile.interests ?? existingProfile.profile.interests
      }
    }

    // Merge relationship graph
    if (updates.relationship_graph) {
      merged.relationship_graph = {
        ...existingProfile.relationship_graph,
        ...updates.relationship_graph,
        // Merge intermediary object
        intermediary: updates.relationship_graph.intermediary
          ? {
              ...existingProfile.relationship_graph.intermediary,
              ...updates.relationship_graph.intermediary
            }
          : existingProfile.relationship_graph.intermediary
      }
    }

    // Update chat history summary
    if (updates.chat_history_summary !== undefined) {
      merged.chat_history_summary = updates.chat_history_summary
    }

    // Merge risk assessment
    if (updates.risk_assessment) {
      merged.risk_assessment = {
        ...existingProfile.risk_assessment,
        ...updates.risk_assessment
      }
    }

    return merged
  }

  /**
   * Updates a contact profile with extracted facts
   * Loads existing profile, merges updates, and saves
   * @param contactId - The contact's unique identifier
   * @param updates - The extracted facts to merge
   * @returns Updated ContactProfile
   */
  async updateContactProfile(
    contactId: string,
    updates: ExtractedFacts
  ): Promise<ContactProfile> {
    const existingProfile = await this.loadContactProfile(contactId)
    if (!existingProfile) {
      throw new ProfileNotFoundError('ContactProfile', contactId)
    }

    const updatedProfile = MemoryManager.mergeProfileUpdates(existingProfile, updates)
    await this.saveContactProfile(contactId, updatedProfile)
    return updatedProfile
  }

  // ============================================================================
  // Settings Operations
  // ============================================================================

  /**
   * Loads application settings from disk
   * Creates default settings if they don't exist
   * Validates: Requirement 11.5
   * @returns AppSettings
   */
  async loadSettings(): Promise<AppSettings> {
    await this.initialize()
    const normalizedDefaults = this.normalizeSettingsOwnerId(this.buildDefaultAppSettings())

    if (!(await this.fileExists(this.settingsPath))) {
      // Create default settings on first run
      await this.saveSettings(normalizedDefaults)
      return { ...normalizedDefaults }
    }

    try {
      const content = await readFile(this.settingsPath, 'utf-8')
      const settings = deserializeAppSettings(content)
      const normalizedSettings = this.normalizeSettingsOwnerId(settings)
      const validation = validateAppSettings(normalizedSettings)

      if (!validation.success) {
        // Reset to default if invalid
        console.warn('Settings validation failed, resetting to default')
        await this.saveSettings(normalizedDefaults)
        return { ...normalizedDefaults }
      }

      if (normalizedSettings.evermemos.ownerUserId !== settings.evermemos.ownerUserId) {
        await this.saveSettings(normalizedSettings)
      }
      return normalizedSettings
    } catch (error) {
      // File corrupted or invalid JSON, reset to default
      console.warn('Failed to load settings, resetting to default:', error)
      await this.saveSettings(normalizedDefaults)
      return { ...normalizedDefaults }
    }
  }

  /**
   * Saves application settings to disk with file locking
   * Persists changes immediately (Requirement 11.5)
   * Uses file locking to prevent concurrent write conflicts
   * @param settings - AppSettings to save
   */
  async saveSettings(settings: AppSettings): Promise<void> {
    await this.initialize()
    const normalizedSettings = this.normalizeSettingsOwnerId(settings)

    const validation = validateAppSettings(normalizedSettings)
    if (!validation.success) {
      throw new ProfileValidationError(`Invalid settings: ${validation.error.message}`)
    }

    const lockAcquired = await FileLock.acquire(this.settingsPath)
    if (!lockAcquired) {
      throw new FileLockError(this.settingsPath)
    }

    try {
      const content = serializeAppSettings(validation.data)
      // Write to temp file first, then rename for atomic operation
      const tempPath = this.settingsPath + '.tmp'
      await writeFile(tempPath, content, 'utf-8')
      await rename(tempPath, this.settingsPath)
    } finally {
      await FileLock.release(this.settingsPath)
    }
  }

  /**
   * Gets the settings file path
   */
  getSettingsPath(): string {
    return this.settingsPath
  }

  /**
   * Gets the base directory path
   */
  getBaseDir(): string {
    return this.baseDir
  }

  private shouldNormalizeOwnerId(value: string | null | undefined): boolean {
    const normalized = (value ?? '').trim().toLowerCase()
    return normalized.length === 0 || normalized === 'self'
  }

  private normalizeSettingsOwnerId(settings: AppSettings): AppSettings {
    if (!this.shouldNormalizeOwnerId(settings.evermemos.ownerUserId)) {
      return settings
    }
    return {
      ...settings,
      evermemos: {
        ...settings.evermemos,
        ownerUserId: this.getDefaultOwnerUserId()
      }
    }
  }

  private getDefaultOwnerUserId(): string {
    const fromEnv = process.env.SOCIAL_COPILOT_OWNER_ID?.trim()
    if (fromEnv) {
      return fromEnv
    }
    const fromUsername = process.env.USERNAME?.trim()
    if (fromUsername) {
      return fromUsername
    }
    const fromOs = userInfo().username?.trim()
    if (fromOs) {
      return fromOs
    }
    return 'self'
  }

  private buildDefaultAppSettings(): AppSettings {
    const defaults = structuredClone(DEFAULT_APP_SETTINGS)
    const assistantApiKey =
      this.getEnvString('SOCIAL_COPILOT_ASSISTANT_API_KEY') ??
      this.getEnvString('SOCIAL_COPILOT_AGENT_API_KEY') ??
      this.getEnvString('LLM_API_KEY') ??
      defaults.modelProviders.assistant.apiKey
    const visionApiKey =
      this.getEnvString('SOCIAL_COPILOT_VISION_API_KEY') ??
      this.getEnvString('SOCIAL_COPILOT_VLM_API_KEY') ??
      this.getEnvString('LLM_API_KEY') ??
      defaults.modelProviders.vision.apiKey

    defaults.visualMonitor.apiBaseUrl =
      this.getEnvString('SOCIAL_COPILOT_VISUAL_MONITOR_API_BASE_URL') ??
      defaults.visualMonitor.apiBaseUrl
    defaults.visualMonitor.monitoredAppName =
      this.getEnvString('SOCIAL_COPILOT_VISUAL_MONITORED_APP') ??
      defaults.visualMonitor.monitoredAppName

    defaults.modelProviders.assistant = {
      ...defaults.modelProviders.assistant,
      baseUrl:
        this.getEnvString('SOCIAL_COPILOT_ASSISTANT_BASE_URL') ??
        this.getEnvString('LLM_BASE_URL') ??
        defaults.modelProviders.assistant.baseUrl,
      apiKey: assistantApiKey,
      modelName:
        this.getEnvString('SOCIAL_COPILOT_ASSISTANT_MODEL') ??
        defaults.modelProviders.assistant.modelName
    }

    defaults.modelProviders.vision = {
      ...defaults.modelProviders.vision,
      baseUrl:
        this.getEnvString('SOCIAL_COPILOT_VISION_BASE_URL') ??
        this.getEnvString('LLM_BASE_URL') ??
        defaults.modelProviders.vision.baseUrl,
      apiKey: visionApiKey,
      modelName:
        this.getEnvString('SOCIAL_COPILOT_VISION_MODEL') ??
        defaults.modelProviders.vision.modelName
    }

    defaults.evermemos = {
      ...defaults.evermemos,
      enabled: this.getEnvBoolean('SOCIAL_COPILOT_EVERMEMOS_ENABLED', defaults.evermemos.enabled),
      apiBaseUrl:
        this.getEnvString('SOCIAL_COPILOT_EVERMEMOS_API_BASE_URL') ??
        defaults.evermemos.apiBaseUrl,
      ownerUserId:
        this.getEnvString('SOCIAL_COPILOT_OWNER_ID') ??
        defaults.evermemos.ownerUserId,
      requestTimeoutMs: this.getEnvNumber(
        'SOCIAL_COPILOT_EVERMEMOS_REQUEST_TIMEOUT_MS',
        defaults.evermemos.requestTimeoutMs
      ),
      backfillChunkSize: Math.round(
        this.getEnvNumber(
          'SOCIAL_COPILOT_EVERMEMOS_BACKFILL_CHUNK_SIZE',
          defaults.evermemos.backfillChunkSize
        )
      ),
      llm: {
        ...defaults.evermemos.llm,
        baseUrl: this.getEnvString('LLM_BASE_URL') ?? defaults.evermemos.llm.baseUrl,
        apiKey: this.getEnvString('LLM_API_KEY') ?? defaults.evermemos.llm.apiKey,
        model: this.getEnvString('LLM_MODEL') ?? defaults.evermemos.llm.model,
        temperature: this.getEnvNumber('LLM_TEMPERATURE', defaults.evermemos.llm.temperature),
        maxTokens: Math.round(
          this.getEnvNumber('LLM_MAX_TOKENS', defaults.evermemos.llm.maxTokens)
        )
      }
    }

    return defaults
  }

  private getEnvString(key: string): string | undefined {
    const value = process.env[key]?.trim()
    return value ? value : undefined
  }

  private getEnvNumber(key: string, fallback: number): number {
    const raw = this.getEnvString(key)
    if (!raw) {
      return fallback
    }
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  private getEnvBoolean(key: string, fallback: boolean): boolean {
    const raw = this.getEnvString(key)
    if (!raw) {
      return fallback
    }
    const normalized = raw.toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false
    }
    return fallback
  }

  private async resolveOwnerUserId(preferred?: string | null): Promise<string> {
    if (!this.shouldNormalizeOwnerId(preferred)) {
      return String(preferred).trim()
    }

    if (await this.fileExists(this.settingsPath)) {
      try {
        const raw = await readFile(this.settingsPath, 'utf-8')
        const settings = deserializeAppSettings(raw)
        const ownerUserId = settings.evermemos.ownerUserId?.trim()
        if (ownerUserId && ownerUserId.toLowerCase() !== 'self') {
          return ownerUserId
        }
      } catch {
        // ignore and fall back to local default
      }
    }

    return this.getDefaultOwnerUserId()
  }

  /**
   * Gets the contacts directory path
   */
  getContactsDir(): string {
    return this.contactsDir
  }
}
