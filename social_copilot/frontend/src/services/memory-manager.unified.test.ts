import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtemp } from 'fs/promises'
import { MemoryManager } from './memory-manager'
import {
  DEFAULT_USER_PROFILE,
  createDefaultUnifiedContactProfile
} from '../models/schemas'

describe('MemoryManager unified profile storage', () => {
  let testDir: string
  let memoryManager: MemoryManager

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'social-copilot-unified-'))
    memoryManager = new MemoryManager(testDir)
    await memoryManager.initialize()
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('migrates legacy user profile files into unified profiles', async () => {
    const legacyPath = join(testDir, 'user_profile.json')
    await writeFile(legacyPath, JSON.stringify(DEFAULT_USER_PROFILE), 'utf-8')

    const profile = await memoryManager.loadUnifiedUserProfile()
    const persisted = JSON.parse(await readFile(legacyPath, 'utf-8')) as Record<string, unknown>
    const legacyRoundTrip = await memoryManager.loadUserProfile()

    expect(profile.profile_type).toBe('user')
    expect(profile.owner_user_id).toBe(DEFAULT_USER_PROFILE.user_id)
    expect(profile.extend.legacy_tone_style).toBe(DEFAULT_USER_PROFILE.base_info.tone_style)
    expect(Array.isArray(profile.catchphrase)).toBe(true)
    expect(persisted.profile_type).toBe('user')
    expect(persisted.communication_style).toBeTruthy()
    expect(legacyRoundTrip.base_info.tone_style).toBe(DEFAULT_USER_PROFILE.base_info.tone_style)
    expect(legacyRoundTrip.communication_habits.msg_avg_length).toBe(
      DEFAULT_USER_PROFILE.communication_habits.msg_avg_length
    )
  })

  it('persists and reloads unified contact profiles without legacy shape loss', async () => {
    const contactId = 'contact_demo'
    const profile = createDefaultUnifiedContactProfile('captain1307', contactId, '演示联系人')
    profile.traits = [
      { value: 'direct', evidence_level: 'L2', evidences: [] },
      { value: 'curious', evidence_level: 'L2', evidences: [] }
    ]
    profile.interests = [
      { value: 'ai', evidence_level: 'L2', evidences: [] },
      { value: 'music', evidence_level: 'L2', evidences: [] }
    ]
    profile.catchphrase = [
      { value: '收到', evidence_level: 'L2', evidences: [] },
      { value: '哈哈', evidence_level: 'L2', evidences: [] }
    ]
    profile.extend.chat_history_summary = 'Discussed model evaluation and weekend plans.'

    await memoryManager.saveUnifiedContactProfile(contactId, profile)

    const loaded = await memoryManager.loadUnifiedContactProfile(contactId)
    const legacy = await memoryManager.loadContactProfile(contactId)
    const contactPath = join(testDir, 'contacts', `${contactId}.json`)
    const persisted = JSON.parse(await readFile(contactPath, 'utf-8')) as Record<string, unknown>

    expect(loaded).not.toBeNull()
    expect(loaded?.profile_type).toBe('contact')
    expect(loaded?.target_user_id).toBe(contactId)
    expect(loaded?.traits.map((item) => typeof item === 'string' ? item : item.value)).toEqual([
      'direct',
      'curious'
    ])
    expect(loaded?.catchphrase.map((item) => typeof item === 'string' ? item : item.value)).toEqual([
      '收到',
      '哈哈'
    ])
    expect(legacy?.chat_history_summary).toBe('Discussed model evaluation and weekend plans.')
    expect(persisted.display_name).toBe('演示联系人')
    expect(persisted.social_attributes).toBeTruthy()
    expect(persisted.catchphrase).toBeTruthy()
  })

  it('creates contact directory entries in unified shape from grouped API path', async () => {
    const created = await memoryManager.createUnifiedContactProfile('contact_new', '新联系人')
    const storedPath = join(testDir, 'contacts')
    await mkdir(storedPath, { recursive: true })
    const raw = JSON.parse(await readFile(join(storedPath, 'contact_new.json'), 'utf-8')) as Record<string, unknown>

    expect(created.profile_type).toBe('contact')
    expect(created.display_name).toBe('新联系人')
    expect(raw.profile_type).toBe('contact')
    expect(raw.display_name).toBe('新联系人')
  })
})
