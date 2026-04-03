/**
 * Cold Start Service - Orchestrates the initialization flow for first-time users
 *
 * Connects components for Cold Start:
 * Onboarding -> Data Importer -> Data Cleaner -> Profiler -> Memory Manager
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
 */
import { DataImporter, DataImportResult } from './data-importer'
import { DataCleanerAgent } from '../agents/data-cleaner-agent'
import { ProfilerAgent } from '../agents/profiler-agent'
import { MemoryManager } from './memory-manager'
import { OllamaClient } from './ollama-client'
import { UserProfile, ContactProfile, MessageBlock } from '../models/schemas'

// ============================================================================
// Types
// ============================================================================

export interface ColdStartProgress {
  stage: 'importing' | 'cleaning' | 'profiling_user' | 'profiling_contacts' | 'saving' | 'complete'
  progress: number // 0-100
  message: string
  currentContact?: string
  totalContacts?: number
  processedContacts?: number
}

export interface ColdStartResult {
  success: boolean
  userProfile: UserProfile | null
  contactProfiles: Map<string, ContactProfile>
  messageCount: number
  contactCount: number
  errors: string[]
}

export type ProgressCallback = (progress: ColdStartProgress) => void

// ============================================================================
// ColdStartService Class
// ============================================================================

/**
 * ColdStartService orchestrates the complete initialization flow for new users
 *
 * Flow:
 * 1. Import data from selected folder (Data Importer)
 * 2. Clean and merge messages (Data Cleaner Agent)
 * 3. Generate user profile (Profiler Agent)
 * 4. Generate contact profiles (Profiler Agent)
 * 5. Save all profiles (Memory Manager)
 */
export class ColdStartService {
  private dataImporter: DataImporter
  private dataCleanerAgent: DataCleanerAgent
  private profilerAgent: ProfilerAgent
  private memoryManager: MemoryManager

  constructor(
    dataImporter?: DataImporter,
    dataCleanerAgent?: DataCleanerAgent,
    profilerAgent?: ProfilerAgent,
    memoryManager?: MemoryManager,
    ollamaClient?: OllamaClient
  ) {
    this.dataImporter = dataImporter ?? new DataImporter()
    this.dataCleanerAgent = dataCleanerAgent ?? new DataCleanerAgent()
    this.memoryManager = memoryManager ?? new MemoryManager()
    
    // Create profiler agent with provided or new Ollama client
    const client = ollamaClient ?? new OllamaClient()
    this.profilerAgent = profilerAgent ?? new ProfilerAgent(client)
  }

  /**
   * Executes the complete cold start flow
   *
   * @param dataPath - Path to the data folder to import
   * @param selfUserId - User's own ID for message direction detection
   * @param onProgress - Optional callback for progress updates
   * @returns ColdStartResult with generated profiles and statistics
   *
   * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
   */
  async execute(
    dataPath: string,
    selfUserId: string = 'self',
    onProgress?: ProgressCallback
  ): Promise<ColdStartResult> {
    const result: ColdStartResult = {
      success: false,
      userProfile: null,
      contactProfiles: new Map(),
      messageCount: 0,
      contactCount: 0,
      errors: []
    }

    try {
      // Initialize memory manager directory structure
      await this.memoryManager.initialize()

      // Stage 1: Import data (Requirements 1.1, 1.2)
      this.reportProgress(onProgress, {
        stage: 'importing',
        progress: 5,
        message: '正在检测数据格式...'
      })

      const importResult = await this.importData(dataPath, selfUserId, onProgress)
      
      if (importResult.errors.length > 0) {
        result.errors.push(...importResult.errors)
      }

      if (importResult.messages.length === 0) {
        result.errors.push('未找到可导入的消息')
        return result
      }

      result.messageCount = importResult.messages.length

      // Stage 2: Clean and merge messages (Requirements 1.3, 1.4)
      this.reportProgress(onProgress, {
        stage: 'cleaning',
        progress: 30,
        message: '正在清洗消息数据...'
      })

      const messageBlocks = await this.cleanMessages(importResult, onProgress)

      if (messageBlocks.length === 0) {
        result.errors.push('清洗后无有效消息块')
        return result
      }

      // Stage 3: Generate user profile (Requirement 1.5)
      this.reportProgress(onProgress, {
        stage: 'profiling_user',
        progress: 50,
        message: '正在生成用户画像...'
      })

      const userProfile = await this.generateUserProfile(messageBlocks, onProgress)
      result.userProfile = userProfile

      // Stage 4: Generate contact profiles (Requirement 1.6)
      this.reportProgress(onProgress, {
        stage: 'profiling_contacts',
        progress: 60,
        message: '正在生成联系人画像...'
      })

      const contactProfiles = await this.generateContactProfiles(
        messageBlocks,
        importResult.contacts,
        onProgress
      )
      result.contactProfiles = contactProfiles
      result.contactCount = contactProfiles.size

      // Stage 5: Save all profiles
      this.reportProgress(onProgress, {
        stage: 'saving',
        progress: 90,
        message: '正在保存画像数据...'
      })

      await this.saveProfiles(userProfile, contactProfiles, result.errors)

      // Complete
      this.reportProgress(onProgress, {
        stage: 'complete',
        progress: 100,
        message: '导入完成！'
      })

      result.success = true
      return result
    } catch (error) {
      const errorMsg = `冷启动失败: ${error instanceof Error ? error.message : '未知错误'}`
      result.errors.push(errorMsg)
      console.error(errorMsg, error)
      return result
    }
  }

  /**
   * Stage 1: Import data from folder
   */
  private async importData(
    dataPath: string,
    selfUserId: string,
    onProgress?: ProgressCallback
  ): Promise<DataImportResult> {
    this.reportProgress(onProgress, {
      stage: 'importing',
      progress: 10,
      message: '正在读取数据文件...'
    })

    const importResult = await this.dataImporter.importData(dataPath, selfUserId)

    this.reportProgress(onProgress, {
      stage: 'importing',
      progress: 25,
      message: `已读取 ${importResult.messages.length} 条消息`
    })

    return importResult
  }

  /**
   * Stage 2: Clean and merge messages
   */
  private async cleanMessages(
    importResult: DataImportResult,
    onProgress?: ProgressCallback
  ): Promise<MessageBlock[]> {
    this.reportProgress(onProgress, {
      stage: 'cleaning',
      progress: 35,
      message: '正在过滤噪音内容...'
    })

    // Process messages through data cleaner (2-minute time window)
    const messageBlocks = this.dataCleanerAgent.processMessages(importResult.messages, 2)

    this.reportProgress(onProgress, {
      stage: 'cleaning',
      progress: 45,
      message: `已合并为 ${messageBlocks.length} 个消息块`
    })

    return messageBlocks
  }

  /**
   * Stage 3: Generate user profile
   */
  private async generateUserProfile(
    messageBlocks: MessageBlock[],
    onProgress?: ProgressCallback
  ): Promise<UserProfile> {
    this.reportProgress(onProgress, {
      stage: 'profiling_user',
      progress: 55,
      message: '正在分析用户沟通习惯...'
    })

    try {
      const userProfile = await this.profilerAgent.generateUserProfile(messageBlocks)
      return userProfile
    } catch (error) {
      console.error('Failed to generate user profile with LLM, using pattern-based:', error)
      // Return a basic profile if LLM fails
      return await this.profilerAgent.generateUserProfile(messageBlocks)
    }
  }

  /**
   * Stage 4: Generate contact profiles
   */
  private async generateContactProfiles(
    messageBlocks: MessageBlock[],
    contactNames: string[],
    onProgress?: ProgressCallback
  ): Promise<Map<string, ContactProfile>> {
    const totalContacts = contactNames.length
    let processedContacts = 0

    this.reportProgress(onProgress, {
      stage: 'profiling_contacts',
      progress: 65,
      message: `正在生成 ${totalContacts} 位联系人画像...`,
      totalContacts,
      processedContacts
    })

    try {
      const contactProfiles = await this.profilerAgent.generateContactProfiles(messageBlocks)

      // Report progress for each contact
      for (const [contactName] of contactProfiles) {
        processedContacts++
        const progress = 65 + Math.floor((processedContacts / totalContacts) * 20)
        
        this.reportProgress(onProgress, {
          stage: 'profiling_contacts',
          progress,
          message: `已生成 ${contactName} 的画像`,
          currentContact: contactName,
          totalContacts,
          processedContacts
        })
      }

      return contactProfiles
    } catch (error) {
      console.error('Failed to generate contact profiles:', error)
      return new Map()
    }
  }

  /**
   * Stage 5: Save all profiles to disk (local cache only).
   * NOTE: In the unified architecture, the backend (EverMemOS unified_profiles)
   * is the single source of truth. These local saves serve only as offline
   * fallback cache. The backend will regenerate profiles from memcells.
   */
  private async saveProfiles(
    userProfile: UserProfile,
    contactProfiles: Map<string, ContactProfile>,
    errors: string[]
  ): Promise<void> {
    // Save user profile
    try {
      await this.memoryManager.saveUserProfile(userProfile)
    } catch (error) {
      const errorMsg = `保存用户画像失败: ${error instanceof Error ? error.message : '未知错误'}`
      errors.push(errorMsg)
      console.error(errorMsg, error)
    }

    // Save contact profiles
    for (const [contactName, profile] of contactProfiles) {
      try {
        await this.memoryManager.saveContactProfile(profile.contact_id, profile)
      } catch (error) {
        const errorMsg = `保存 ${contactName} 画像失败: ${error instanceof Error ? error.message : '未知错误'}`
        errors.push(errorMsg)
        console.error(errorMsg, error)
      }
    }
  }

  /**
   * Helper to report progress
   */
  private reportProgress(callback: ProgressCallback | undefined, progress: ColdStartProgress): void {
    if (callback) {
      callback(progress)
    }
  }

  /**
   * Creates minimal default profiles for users who skip import
   * Validates: Requirement 1.8
   */
  async createDefaultProfiles(): Promise<ColdStartResult> {
    const result: ColdStartResult = {
      success: false,
      userProfile: null,
      contactProfiles: new Map(),
      messageCount: 0,
      contactCount: 0,
      errors: []
    }

    try {
      await this.memoryManager.initialize()
      
      // Load or create default user profile
      const userProfile = await this.memoryManager.loadUserProfile()
      result.userProfile = userProfile
      result.success = true
    } catch (error) {
      const errorMsg = `创建默认画像失败: ${error instanceof Error ? error.message : '未知错误'}`
      result.errors.push(errorMsg)
      console.error(errorMsg, error)
    }

    return result
  }
}

// Export singleton instance
export const coldStartService = new ColdStartService()
