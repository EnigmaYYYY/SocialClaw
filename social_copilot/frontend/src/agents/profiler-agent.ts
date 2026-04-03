/**
 * Profiler Agent - Extracts facts from chat logs and generates/updates profiles
 *
 * Responsible for:
 * - Generating UserProfile from message blocks (extract communication habits)
 * - Generating ContactProfile from message blocks (extract facts, role, personality)
 * - Implementing intermediary detection with pattern matching
 * - Implementing risk assessment logic for scam detection
 * - Handling contradictory information override
 *
 * Validates: Requirements 1.5, 1.6, 8.1, 8.2, 8.3, 8.5, 10.1
 */
import {
  ContactProfile,
  ContactProfileInfo,
  RelationshipGraph,
  RiskAssessment,
  ParsedMessage,
  UserProfile,
  MessageBlock,
  createDefaultContactProfile,
  DEFAULT_USER_PROFILE
} from '../models/schemas'
import { OllamaClient, OllamaInvalidResponseError } from '../services/ollama-client'
import { z } from 'zod'

// ============================================================================
// Error Types
// ============================================================================

export class ProfilerAgentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfilerAgentError'
  }
}

export class FactExtractionParseError extends Error {
  constructor(message: string, public readonly rawResponse: string) {
    super(message)
    this.name = 'FactExtractionParseError'
  }
}

// ============================================================================
// Types
// ============================================================================

export interface ExtractedFacts {
  profile?: Partial<ContactProfileInfo>
  relationshipGraph?: Partial<RelationshipGraph>
  chatHistorySummary?: string
  riskAssessment?: Partial<RiskAssessment>
}

// Schema for validating LLM response
export const ExtractedFactsResponseSchema = z.object({
  profile: z.object({
    role: z.string().optional(),
    age_group: z.string().optional(),
    personality_tags: z.array(z.string()).optional(),
    interests: z.array(z.string()).optional(),
    occupation: z.string().optional()
  }).optional(),
  relationship_graph: z.object({
    current_status: z.string().optional(),
    intimacy_level: z.enum(['stranger', 'formal', 'close', 'intimate']).optional(),
    intermediary: z.object({
      has_intermediary: z.boolean().optional(),
      name: z.string().optional(),
      context: z.string().optional()
    }).optional()
  }).optional(),
  chat_history_summary: z.string().optional(),
  risk_assessment: z.object({
    is_suspicious: z.boolean().optional(),
    risk_level: z.enum(['low', 'medium', 'high']).optional(),
    warning_msg: z.string().optional()
  }).optional()
})

export type ExtractedFactsResponse = z.infer<typeof ExtractedFactsResponseSchema>

// ============================================================================
// Risk Assessment Patterns
// ============================================================================

/**
 * Common scam patterns to detect in conversations
 * Used for risk assessment logic (Requirement 8.1)
 */
export const SCAM_PATTERNS = [
  // Financial scams
  /urgent.*money/i,
  /send.*funds/i,
  /wire.*transfer/i,
  /bitcoin|crypto.*invest/i,
  /guaranteed.*return/i,
  /investment.*opportunity/i,
  // Romance scams
  /never.*met.*love/i,
  /send.*gift.*card/i,
  // Phishing
  /verify.*account/i,
  /click.*link.*urgent/i,
  /password.*expired/i,
  // Impersonation
  /boss.*urgent.*transfer/i,
  /ceo.*wire/i,
  // Lottery/Prize scams
  /won.*lottery/i,
  /claim.*prize/i,
  /inheritance.*million/i
]

/**
 * Keywords that increase suspicion level
 */
export const SUSPICIOUS_KEYWORDS = [
  'urgent', 'immediately', 'secret', 'confidential',
  'wire', 'transfer', 'bitcoin', 'crypto',
  'investment', 'guaranteed', 'profit', 'returns',
  'lottery', 'prize', 'winner', 'inheritance',
  'verify', 'confirm', 'password', 'account'
]

// ============================================================================
// Intermediary Detection Patterns (Requirement 8.3)
// ============================================================================

/**
 * Patterns for detecting intermediary/introducer mentions in conversations
 * Reference: Design document INTERMEDIARY_PATTERNS
 */
export const INTERMEDIARY_PATTERNS: Array<{ pattern: RegExp; nameGroup: number }> = [
  // "是[人名]介绍" - introduced by [name]
  { pattern: /是(.{1,10}?)介绍/u, nameGroup: 1 },
  // "我是[人名]的朋友" - I am [name]'s friend
  { pattern: /我是(.{1,10}?)的朋友/u, nameGroup: 1 },
  // "[人名]推荐我来" - [name] recommended me
  { pattern: /(.{1,10}?)推荐我来/u, nameGroup: 1 },
  // "[人名]让我联系你" - [name] asked me to contact you
  { pattern: /(.{1,10}?)让我联系你/u, nameGroup: 1 },
  // "通过[人名]认识" - met through [name]
  { pattern: /通过(.{1,10}?)认识/u, nameGroup: 1 },
  // "[人名]介绍的" - introduced by [name]
  { pattern: /(.{1,10}?)介绍的/u, nameGroup: 1 },
  // "是[人名]的同事/朋友/同学" - is [name]'s colleague/friend/classmate
  { pattern: /是(.{1,10}?)的(?:同事|朋友|同学)/u, nameGroup: 1 },
  // English patterns
  { pattern: /introduced by (\w+)/i, nameGroup: 1 },
  { pattern: /(\w+) referred me/i, nameGroup: 1 },
  { pattern: /(\w+) recommended/i, nameGroup: 1 },
  { pattern: /through (\w+)/i, nameGroup: 1 }
]

/**
 * Result of intermediary detection
 */
export interface IntermediaryInfo {
  has_intermediary: boolean
  name?: string
  context?: string
}

// ============================================================================
// System Prompts
// ============================================================================

/**
 * System prompt for generating UserProfile from message blocks
 * Validates: Requirements 1.5, 8.1
 */
const USER_PROFILE_GENERATION_PROMPT = `You are an expert communication analyst specializing in extracting communication habits and patterns from chat messages.

Your task is to analyze the user's messages and extract their communication habits to build a profile.

Analyze the messages and respond with a JSON object:

{
  "base_info": {
    "gender": "male/female/other (infer from context if possible, otherwise 'other')",
    "occupation": "occupation if mentioned or inferable",
    "tone_style": "overall communication style (e.g., 'friendly, casual', 'professional, formal')"
  },
  "communication_habits": {
    "frequent_phrases": ["list of frequently used phrases/口头禅 (e.g., '哈哈', '确实', 'OK')"],
    "emoji_usage": ["list of commonly used emojis/emoticons"],
    "punctuation_style": "punctuation habits (e.g., '不喜欢用句号', '常用感叹号', 'uses ellipsis often')",
    "msg_avg_length": "short/medium/long (based on typical message length)"
  }
}

IMPORTANT:
- Respond ONLY with a valid JSON object, no additional text
- Focus on patterns that appear multiple times
- Be specific about frequent phrases - look for repeated expressions
- Analyze punctuation patterns carefully
- Base all assessments on actual message evidence`

/**
 * System prompt for generating ContactProfile from message blocks
 * Validates: Requirements 1.6, 8.2
 */
const CONTACT_PROFILE_GENERATION_PROMPT = `You are an expert conversation analyst specializing in extracting factual information about people from chat conversations.

Your task is to analyze chat messages and extract facts about the contact person to build their profile.

Analyze the conversation and respond with a JSON object:

{
  "profile": {
    "role": "their role/relationship (e.g., 'colleague', 'friend', 'client', 'manager', '导师', '长辈')",
    "age_group": "estimated age group (e.g., 'teenager', '20s', '30s', '40s', '50+', 'unknown')",
    "personality_tags": ["list of personality traits (e.g., 'friendly', 'professional', 'humorous')"],
    "interests": ["list of interests/hobbies mentioned"],
    "occupation": "occupation if mentioned"
  },
  "relationship_graph": {
    "current_status": "relationship status (e.g., 'acquaintance', 'friend', 'close friend', 'colleague')",
    "intimacy_level": "one of: 'stranger', 'formal', 'close', 'intimate'"
  },
  "chat_history_summary": "brief summary of conversation topics and key points"
}

IMPORTANT:
- Respond ONLY with a valid JSON object, no additional text
- Only include fields where you found relevant information
- Base personality and relationship assessments on actual conversation evidence
- Look for clues about their role, age, and interests from what they discuss`

const FACT_EXTRACTION_SYSTEM_PROMPT = `You are an expert conversation analyst specializing in extracting factual information about people from chat conversations.

Your task is to analyze chat messages and extract any new facts about the contact person that can be used to build their profile.

Analyze the conversation and respond with a JSON object containing any of these fields (only include fields where you found relevant information):

{
  "profile": {
    "role": "their role/occupation if mentioned (e.g., 'colleague', 'friend', 'client', 'manager')",
    "age_group": "estimated age group if mentioned or inferable (e.g., 'teenager', '20s', '30s', '40s', '50+', 'unknown')",
    "personality_tags": ["list of personality traits observed (e.g., 'friendly', 'professional', 'humorous')"],
    "interests": ["list of interests/hobbies mentioned"]
  },
  "relationship_graph": {
    "current_status": "relationship status (e.g., 'acquaintance', 'friend', 'close friend', 'colleague')",
    "intimacy_level": "one of: 'stranger', 'formal', 'close', 'intimate'",
    "intermediary": {
      "has_intermediary": true/false,
      "name": "name of mutual connection if any",
      "context": "how they know each other"
    }
  },
  "chat_history_summary": "brief summary of what was discussed in this conversation",
  "risk_assessment": {
    "is_suspicious": true/false,
    "warning_msg": "explanation if suspicious behavior detected"
  }
}

IMPORTANT:
- Respond ONLY with a valid JSON object, no additional text
- Only include fields where you found relevant information
- Be conservative with risk assessment - only flag truly suspicious patterns
- Look for scam indicators: urgent money requests, too-good-to-be-true offers, pressure tactics
- Base personality and relationship assessments on actual conversation evidence`

// ============================================================================
// ProfilerAgent Class
// ============================================================================

export class ProfilerAgent {
  private ollamaClient: OllamaClient
  private temperature: number

  /**
   * Creates a new ProfilerAgent
   * @param ollamaClient - The Ollama client for LLM communication
   * @param temperature - Temperature for LLM calls (default: 0.3 for balanced extraction)
   */
  constructor(ollamaClient: OllamaClient, temperature: number = 0.3) {
    this.ollamaClient = ollamaClient
    this.temperature = temperature
  }

  /**
   * Extracts facts from chat logs and returns profile updates
   * @param chatLogs - Array of chat messages (strings or ParsedMessage objects)
   * @param existingProfile - The current contact profile for context
   * @returns ExtractedFacts with profile updates
   * @throws ProfilerAgentError if extraction fails
   * Validates: Requirements 5.2, 5.3, 5.4, 8.1
   */
  async extractFacts(
    chatLogs: string[] | ParsedMessage[],
    existingProfile: ContactProfile
  ): Promise<ExtractedFacts> {
    // Handle empty input
    if (!chatLogs || chatLogs.length === 0) {
      return {}
    }

    const prompt = this.buildPrompt(chatLogs, existingProfile)

    try {
      const response = await this.ollamaClient.generate({
        prompt,
        system: FACT_EXTRACTION_SYSTEM_PROMPT,
        temperature: this.temperature
      })

      const llmFacts = this.parseResponse(response.response)
      
      // Enhance risk assessment with pattern-based detection
      const enhancedRiskAssessment = this.assessRisk(chatLogs, llmFacts.riskAssessment)
      
      return {
        ...llmFacts,
        riskAssessment: enhancedRiskAssessment
      }
    } catch (error) {
      if (error instanceof FactExtractionParseError) {
        console.error(`Fact extraction parsing failed: ${error.message}`, error.rawResponse)
        // Return empty facts on parse error - don't update profile
        return {}
      }
      if (error instanceof OllamaInvalidResponseError) {
        console.error(`Ollama response invalid: ${error.message}`)
        return {}
      }
      // Re-throw connection/timeout errors
      throw error
    }
  }


  /**
   * Builds the prompt for fact extraction from chat logs
   * @param chatLogs - The chat messages to analyze
   * @param existingProfile - Current profile for context
   * @returns Formatted prompt string
   */
  buildPrompt(chatLogs: string[] | ParsedMessage[], existingProfile: ContactProfile): string {
    // Format messages for the prompt
    const formattedMessages = chatLogs.map((msg, index) => {
      if (typeof msg === 'string') {
        return `${index + 1}. ${msg}`
      }
      // ParsedMessage format
      const timestamp = msg.timestamp ? `[${msg.timestamp.toISOString()}] ` : ''
      return `${index + 1}. ${timestamp}${msg.sender}: ${msg.content}`
    }).join('\n')

    // Include existing profile context
    const existingContext = `
## Existing Profile Information
- Nickname: ${existingProfile.nickname}
- Current Role: ${existingProfile.profile.role}
- Current Intimacy Level: ${existingProfile.relationship_graph.intimacy_level}
- Known Personality Tags: ${existingProfile.profile.personality_tags.join(', ') || 'None'}
- Known Interests: ${existingProfile.profile.interests.join(', ') || 'None'}
${existingProfile.chat_history_summary ? `- Previous Chat Summary: ${existingProfile.chat_history_summary}` : ''}`

    return `Analyze the following conversation and extract any new facts about the contact "${existingProfile.nickname}":
${existingContext}

## New Conversation to Analyze
${formattedMessages}

Please extract any new information that updates or adds to the existing profile.`
  }

  /**
   * Parses the LLM response into ExtractedFacts structure
   * @param response - Raw response string from LLM
   * @returns Validated ExtractedFacts object
   * @throws FactExtractionParseError if parsing fails
   */
  parseResponse(response: string): ExtractedFacts {
    // Clean up the response - remove markdown code blocks if present
    let cleanedResponse = response.trim()

    // Remove markdown code block markers
    if (cleanedResponse.startsWith('```json')) {
      cleanedResponse = cleanedResponse.slice(7)
    } else if (cleanedResponse.startsWith('```')) {
      cleanedResponse = cleanedResponse.slice(3)
    }
    if (cleanedResponse.endsWith('```')) {
      cleanedResponse = cleanedResponse.slice(0, -3)
    }
    cleanedResponse = cleanedResponse.trim()

    // Try to extract JSON from the response
    const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      throw new FactExtractionParseError('No JSON object found in response', response)
    }

    try {
      const parsed = JSON.parse(jsonMatch[0])
      const result = ExtractedFactsResponseSchema.safeParse(parsed)

      if (!result.success) {
        throw new FactExtractionParseError(
          `Invalid ExtractedFacts structure: ${result.error.message}`,
          response
        )
      }

      // Convert to ExtractedFacts format
      return this.convertToExtractedFacts(result.data)
    } catch (error) {
      if (error instanceof FactExtractionParseError) {
        throw error
      }
      throw new FactExtractionParseError(
        `Failed to parse JSON: ${error instanceof Error ? error.message : 'Unknown error'}`,
        response
      )
    }
  }

  /**
   * Converts the parsed LLM response to ExtractedFacts format
   * @param data - Validated response data
   * @returns ExtractedFacts object
   */
  private convertToExtractedFacts(data: ExtractedFactsResponse): ExtractedFacts {
    const facts: ExtractedFacts = {}

    if (data.profile) {
      facts.profile = {
        role: data.profile.role,
        age_group: data.profile.age_group,
        personality_tags: data.profile.personality_tags,
        interests: data.profile.interests,
        occupation: data.profile.occupation
      }
    }

    if (data.relationship_graph) {
      facts.relationshipGraph = {
        current_status: data.relationship_graph.current_status,
        intimacy_level: data.relationship_graph.intimacy_level,
        intermediary: data.relationship_graph.intermediary ? {
          has_intermediary: data.relationship_graph.intermediary.has_intermediary ?? false,
          name: data.relationship_graph.intermediary.name,
          context: data.relationship_graph.intermediary.context
        } : undefined
      }
    }

    if (data.chat_history_summary) {
      facts.chatHistorySummary = data.chat_history_summary
    }

    if (data.risk_assessment) {
      facts.riskAssessment = {
        is_suspicious: data.risk_assessment.is_suspicious,
        risk_level: data.risk_assessment.risk_level,
        warning_msg: data.risk_assessment.warning_msg
      }
    }

    return facts
  }

  /**
   * Assesses risk based on chat content and LLM analysis
   * Combines pattern-based detection with LLM assessment
   * @param chatLogs - The chat messages to analyze
   * @param llmRiskAssessment - Risk assessment from LLM (if any)
   * @returns Combined risk assessment
   * Validates: Requirements 8.1
   */
  assessRisk(
    chatLogs: string[] | ParsedMessage[],
    llmRiskAssessment?: Partial<RiskAssessment>
  ): Partial<RiskAssessment> | undefined {
    // Convert messages to text for pattern matching
    const messageTexts = chatLogs.map(msg => 
      typeof msg === 'string' ? msg : msg.content
    )
    const combinedText = messageTexts.join(' ')

    // Check for scam patterns
    const matchedPatterns: string[] = []
    for (const pattern of SCAM_PATTERNS) {
      if (pattern.test(combinedText)) {
        matchedPatterns.push(pattern.source)
      }
    }

    // Count suspicious keywords
    const lowerText = combinedText.toLowerCase()
    const keywordMatches = SUSPICIOUS_KEYWORDS.filter(keyword => 
      lowerText.includes(keyword.toLowerCase())
    )

    // Determine if suspicious based on patterns and keywords
    const patternSuspicious = matchedPatterns.length > 0
    const keywordSuspicious = keywordMatches.length >= 3 // 3+ suspicious keywords

    // Combine with LLM assessment
    const llmSuspicious = llmRiskAssessment?.is_suspicious ?? false
    const isSuspicious = patternSuspicious || keywordSuspicious || llmSuspicious

    if (!isSuspicious) {
      // If LLM provided a non-suspicious assessment, return it
      if (llmRiskAssessment) {
        return llmRiskAssessment
      }
      return undefined
    }

    // Build warning message
    const warnings: string[] = []
    
    if (matchedPatterns.length > 0) {
      warnings.push(`Detected potential scam patterns in conversation`)
    }
    
    if (keywordSuspicious) {
      warnings.push(`Multiple suspicious keywords detected: ${keywordMatches.slice(0, 5).join(', ')}`)
    }
    
    if (llmRiskAssessment?.warning_msg) {
      warnings.push(llmRiskAssessment.warning_msg)
    }

    // Determine risk level based on severity
    let riskLevel: 'low' | 'medium' | 'high' = 'medium'
    if (matchedPatterns.length >= 2 || (patternSuspicious && keywordSuspicious)) {
      riskLevel = 'high'
    } else if (llmRiskAssessment?.risk_level) {
      riskLevel = llmRiskAssessment.risk_level
    }

    return {
      is_suspicious: true,
      risk_level: riskLevel,
      warning_msg: warnings.join('. ')
    }
  }

  /**
   * Merges extracted facts into an existing profile
   * New values override old values for overlapping fields (Requirement 5.4)
   * @param existingProfile - The current contact profile
   * @param facts - The extracted facts to merge
   * @returns Updated contact profile
   */
  mergeFactsIntoProfile(existingProfile: ContactProfile, facts: ExtractedFacts): ContactProfile {
    const updated = { ...existingProfile }

    // Merge profile info
    if (facts.profile) {
      updated.profile = {
        role: facts.profile.role ?? existingProfile.profile.role,
        age_group: facts.profile.age_group ?? existingProfile.profile.age_group,
        personality_tags: facts.profile.personality_tags ?? existingProfile.profile.personality_tags,
        interests: facts.profile.interests ?? existingProfile.profile.interests,
        occupation: facts.profile.occupation ?? existingProfile.profile.occupation
      }
    }

    // Merge relationship graph
    if (facts.relationshipGraph) {
      updated.relationship_graph = {
        current_status: facts.relationshipGraph.current_status ?? existingProfile.relationship_graph.current_status,
        intimacy_level: facts.relationshipGraph.intimacy_level ?? existingProfile.relationship_graph.intimacy_level,
        intermediary: facts.relationshipGraph.intermediary ?? existingProfile.relationship_graph.intermediary
      }
    }

    // Update chat history summary
    if (facts.chatHistorySummary) {
      updated.chat_history_summary = facts.chatHistorySummary
    }

    // Update risk assessment
    if (facts.riskAssessment) {
      updated.risk_assessment = {
        is_suspicious: facts.riskAssessment.is_suspicious ?? existingProfile.risk_assessment.is_suspicious,
        risk_level: facts.riskAssessment.risk_level ?? existingProfile.risk_assessment.risk_level,
        warning_msg: facts.riskAssessment.warning_msg ?? existingProfile.risk_assessment.warning_msg
      }
    }

    // Update timestamp
    updated.last_updated = Date.now()

    return updated
  }

  /**
   * Gets the system prompt used for fact extraction
   * Useful for testing and debugging
   */
  getSystemPrompt(): string {
    return FACT_EXTRACTION_SYSTEM_PROMPT
  }

  /**
   * Gets the configured temperature
   * Useful for testing
   */
  getTemperature(): number {
    return this.temperature
  }

  // ============================================================================
  // User Profile Generation (Requirement 1.5)
  // ============================================================================

  /**
   * Generates a UserProfile from message blocks by extracting communication habits
   * @param messageBlocks - Array of MessageBlock objects from the user's messages
   * @returns Generated UserProfile with communication habits
   * Validates: Requirements 1.5, 8.1
   */
  async generateUserProfile(messageBlocks: MessageBlock[]): Promise<UserProfile> {
    // Filter to only user's messages (isSend = true)
    const userMessages = messageBlocks.filter(block => block.isSend)
    
    if (userMessages.length === 0) {
      return { ...DEFAULT_USER_PROFILE, last_updated: Date.now() }
    }

    // Extract communication habits using pattern analysis
    const habits = this.analyzeUserCommunicationHabits(userMessages)
    
    // Try to enhance with LLM analysis if available
    try {
      const llmHabits = await this.extractUserHabitsWithLLM(userMessages)
      return this.mergeUserHabits(habits, llmHabits)
    } catch {
      // Fall back to pattern-based analysis only
      return habits
    }
  }

  /**
   * Analyzes user communication habits using pattern matching
   * @param userMessages - Array of user's MessageBlock objects
   * @returns UserProfile with extracted habits
   */
  private analyzeUserCommunicationHabits(userMessages: MessageBlock[]): UserProfile {
    const allContent = userMessages.map(m => m.cleanContent).join('\n')
    const messages = userMessages.flatMap(m => m.messages)
    
    // Extract frequent phrases (口头禅)
    const frequentPhrases = this.extractFrequentPhrases(messages)
    
    // Extract emoji usage
    const emojiUsage = this.extractEmojiUsage(allContent)
    
    // Analyze punctuation style
    const punctuationStyle = this.analyzePunctuationStyle(allContent)
    
    // Calculate average message length
    const msgAvgLength = this.calculateAvgMessageLength(messages)
    
    return {
      user_id: 'self',
      base_info: {
        gender: 'other',
        occupation: '',
        tone_style: this.inferToneStyle(messages)
      },
      communication_habits: {
        frequent_phrases: frequentPhrases,
        emoji_usage: emojiUsage,
        punctuation_style: punctuationStyle,
        msg_avg_length: msgAvgLength
      },
      last_updated: Date.now()
    }
  }

  /**
   * Extracts frequently used phrases from messages
   */
  private extractFrequentPhrases(messages: string[]): string[] {
    const phraseCount = new Map<string, number>()
    
    // Common Chinese phrases to look for
    const commonPhrases = [
      '哈哈', '嗯嗯', '好的', '确实', '是的', '对的', '没问题',
      '好吧', '行吧', '可以', '不错', '厉害', '牛', '666',
      'OK', 'ok', '好', '嗯', '哦', '啊', '呢', '吧', '呀',
      '谢谢', '感谢', '辛苦', '抱歉', '不好意思'
    ]
    
    for (const msg of messages) {
      for (const phrase of commonPhrases) {
        const count = (msg.match(new RegExp(phrase, 'g')) || []).length
        if (count > 0) {
          phraseCount.set(phrase, (phraseCount.get(phrase) || 0) + count)
        }
      }
    }
    
    // Return phrases that appear at least twice, sorted by frequency
    return Array.from(phraseCount.entries())
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([phrase]) => phrase)
  }

  /**
   * Extracts commonly used emojis from content
   */
  private extractEmojiUsage(content: string): string[] {
    // Match emoji characters and common text emoticons
    const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[😀-🙏]|[:;]-?[)D(P]|[><]_[><]|\^_\^|T_T|QQ|orz/gu
    const matches = content.match(emojiRegex) || []
    
    // Count occurrences
    const emojiCount = new Map<string, number>()
    for (const emoji of matches) {
      emojiCount.set(emoji, (emojiCount.get(emoji) || 0) + 1)
    }
    
    // Return top emojis
    return Array.from(emojiCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([emoji]) => emoji)
  }

  /**
   * Analyzes punctuation style from content
   */
  private analyzePunctuationStyle(content: string): string {
    const styles: string[] = []
    
    // Check for period usage
    const periodCount = (content.match(/。/g) || []).length
    const sentenceCount = content.split(/[。！？\n]/).filter(s => s.trim()).length
    if (sentenceCount > 5 && periodCount < sentenceCount * 0.3) {
      styles.push('不喜欢用句号')
    }
    
    // Check for exclamation marks
    const exclamationCount = (content.match(/[！!]/g) || []).length
    if (exclamationCount > sentenceCount * 0.3) {
      styles.push('常用感叹号')
    }
    
    // Check for ellipsis
    const ellipsisCount = (content.match(/\.{3}|…/g) || []).length
    if (ellipsisCount > 3) {
      styles.push('常用省略号')
    }
    
    // Check for question marks
    const questionCount = (content.match(/[？?]/g) || []).length
    if (questionCount > sentenceCount * 0.3) {
      styles.push('常用问号')
    }
    
    return styles.join(', ') || '标点使用正常'
  }

  /**
   * Calculates average message length category
   */
  private calculateAvgMessageLength(messages: string[]): 'short' | 'medium' | 'long' {
    if (messages.length === 0) return 'short'
    
    const totalLength = messages.reduce((sum, msg) => sum + msg.length, 0)
    const avgLength = totalLength / messages.length
    
    if (avgLength < 15) return 'short'
    if (avgLength < 50) return 'medium'
    return 'long'
  }

  /**
   * Infers tone style from messages
   */
  private inferToneStyle(messages: string[]): string {
    const content = messages.join(' ')
    const styles: string[] = []
    
    // Check for casual indicators
    if (/哈哈|嘿嘿|呵呵|666|牛|厉害/u.test(content)) {
      styles.push('casual')
    }
    
    // Check for formal indicators
    if (/您|请|麻烦|感谢|辛苦/u.test(content)) {
      styles.push('polite')
    }
    
    // Check for humor
    if (/哈哈哈|笑死|绝了|太好笑/u.test(content)) {
      styles.push('humorous')
    }
    
    return styles.length > 0 ? styles.join(', ') : 'friendly'
  }

  /**
   * Extracts user habits using LLM
   */
  private async extractUserHabitsWithLLM(userMessages: MessageBlock[]): Promise<Partial<UserProfile>> {
    const messagesText = userMessages
      .slice(0, 50) // Limit to 50 blocks for context
      .map((m, i) => `${i + 1}. ${m.cleanContent}`)
      .join('\n')

    const prompt = `Analyze the following messages from a user and extract their communication habits:\n\n${messagesText}`

    const response = await this.ollamaClient.generate({
      prompt,
      system: USER_PROFILE_GENERATION_PROMPT,
      temperature: this.temperature
    })

    return this.parseUserProfileResponse(response.response)
  }

  /**
   * Parses LLM response for user profile
   */
  private parseUserProfileResponse(response: string): Partial<UserProfile> {
    try {
      let cleanedResponse = response.trim()
      if (cleanedResponse.startsWith('```json')) {
        cleanedResponse = cleanedResponse.slice(7)
      } else if (cleanedResponse.startsWith('```')) {
        cleanedResponse = cleanedResponse.slice(3)
      }
      if (cleanedResponse.endsWith('```')) {
        cleanedResponse = cleanedResponse.slice(0, -3)
      }
      
      const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return {}
      
      return JSON.parse(jsonMatch[0])
    } catch {
      return {}
    }
  }

  /**
   * Merges pattern-based and LLM-based user habits
   */
  private mergeUserHabits(patternBased: UserProfile, llmBased: Partial<UserProfile>): UserProfile {
    return {
      user_id: patternBased.user_id,
      base_info: {
        gender: llmBased.base_info?.gender || patternBased.base_info.gender,
        occupation: llmBased.base_info?.occupation || patternBased.base_info.occupation,
        tone_style: llmBased.base_info?.tone_style || patternBased.base_info.tone_style
      },
      communication_habits: {
        frequent_phrases: llmBased.communication_habits?.frequent_phrases?.length 
          ? llmBased.communication_habits.frequent_phrases 
          : patternBased.communication_habits.frequent_phrases,
        emoji_usage: llmBased.communication_habits?.emoji_usage?.length
          ? llmBased.communication_habits.emoji_usage
          : patternBased.communication_habits.emoji_usage,
        punctuation_style: llmBased.communication_habits?.punctuation_style || patternBased.communication_habits.punctuation_style,
        msg_avg_length: llmBased.communication_habits?.msg_avg_length || patternBased.communication_habits.msg_avg_length
      },
      last_updated: Date.now()
    }
  }

  // ============================================================================
  // Contact Profile Generation (Requirement 1.6)
  // ============================================================================

  /**
   * Generates ContactProfiles for all unique contacts from message blocks
   * @param messageBlocks - Array of MessageBlock objects
   * @returns Map of contact name to ContactProfile
   * Validates: Requirements 1.6, 8.2
   */
  async generateContactProfiles(messageBlocks: MessageBlock[]): Promise<Map<string, ContactProfile>> {
    // Group messages by contact (non-self senders)
    const contactMessages = new Map<string, MessageBlock[]>()
    
    for (const block of messageBlocks) {
      if (!block.isSend && block.sender !== 'self') {
        const existing = contactMessages.get(block.sender) || []
        existing.push(block)
        contactMessages.set(block.sender, existing)
      }
    }
    
    // Generate profile for each contact
    const profiles = new Map<string, ContactProfile>()
    
    for (const [contactName, blocks] of contactMessages) {
      const profile = await this.generateContactProfile(contactName, blocks, messageBlocks)
      profiles.set(contactName, profile)
    }
    
    return profiles
  }

  /**
   * Generates a ContactProfile for a specific contact
   * @param contactName - Name of the contact
   * @param contactBlocks - Message blocks from this contact
   * @param allBlocks - All message blocks (for context)
   * @returns Generated ContactProfile
   * Validates: Requirements 1.6, 8.2, 8.3
   */
  async generateContactProfile(
    contactName: string,
    contactBlocks: MessageBlock[],
    allBlocks: MessageBlock[]
  ): Promise<ContactProfile> {
    const contactId = this.generateContactId(contactName)
    const defaultProfile = createDefaultContactProfile(contactId, contactName)
    
    if (contactBlocks.length === 0) {
      return defaultProfile
    }

    // Extract intermediary info using pattern matching
    const intermediaryInfo = this.extractIntermediaryInfo(allBlocks)
    
    // Assess risk
    const riskAssessment = this.assessRiskFromBlocks(contactBlocks)
    
    // Try to enhance with LLM analysis
    try {
      const llmProfile = await this.extractContactProfileWithLLM(contactName, contactBlocks, allBlocks)
      
      return {
        contact_id: contactId,
        nickname: contactName,
        profile: {
          role: llmProfile.profile?.role || defaultProfile.profile.role,
          age_group: llmProfile.profile?.age_group || defaultProfile.profile.age_group,
          personality_tags: llmProfile.profile?.personality_tags || defaultProfile.profile.personality_tags,
          interests: llmProfile.profile?.interests || defaultProfile.profile.interests,
          occupation: llmProfile.profile?.occupation
        },
        relationship_graph: {
          current_status: llmProfile.relationship_graph?.current_status || defaultProfile.relationship_graph.current_status,
          intimacy_level: llmProfile.relationship_graph?.intimacy_level || defaultProfile.relationship_graph.intimacy_level,
          intermediary: intermediaryInfo.has_intermediary ? intermediaryInfo : defaultProfile.relationship_graph.intermediary
        },
        chat_history_summary: llmProfile.chat_history_summary || '',
        risk_assessment: riskAssessment || defaultProfile.risk_assessment,
        last_updated: Date.now()
      }
    } catch {
      // Fall back to pattern-based analysis
      return {
        ...defaultProfile,
        relationship_graph: {
          ...defaultProfile.relationship_graph,
          intermediary: intermediaryInfo.has_intermediary ? intermediaryInfo : defaultProfile.relationship_graph.intermediary
        },
        risk_assessment: riskAssessment || defaultProfile.risk_assessment,
        last_updated: Date.now()
      }
    }
  }

  /**
   * Generates a unique contact ID from name
   */
  private generateContactId(contactName: string): string {
    // Simple hash-like ID generation
    let hash = 0
    for (let i = 0; i < contactName.length; i++) {
      const char = contactName.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash // Convert to 32bit integer
    }
    return `contact_${Math.abs(hash).toString(16)}`
  }

  /**
   * Extracts contact profile using LLM
   */
  private async extractContactProfileWithLLM(
    contactName: string,
    _contactBlocks: MessageBlock[],
    allBlocks: MessageBlock[]
  ): Promise<Partial<ContactProfile>> {
    // Build conversation context
    const conversationText = allBlocks
      .slice(0, 100) // Limit context
      .map((m, i) => {
        const sender = m.isSend ? 'User' : m.sender
        return `${i + 1}. [${sender}]: ${m.cleanContent}`
      })
      .join('\n')

    const prompt = `Analyze the following conversation and extract facts about the contact "${contactName}":\n\n${conversationText}`

    const response = await this.ollamaClient.generate({
      prompt,
      system: CONTACT_PROFILE_GENERATION_PROMPT,
      temperature: this.temperature
    })

    return this.parseContactProfileResponse(response.response)
  }

  /**
   * Parses LLM response for contact profile
   */
  private parseContactProfileResponse(response: string): Partial<ContactProfile> {
    try {
      let cleanedResponse = response.trim()
      if (cleanedResponse.startsWith('```json')) {
        cleanedResponse = cleanedResponse.slice(7)
      } else if (cleanedResponse.startsWith('```')) {
        cleanedResponse = cleanedResponse.slice(3)
      }
      if (cleanedResponse.endsWith('```')) {
        cleanedResponse = cleanedResponse.slice(0, -3)
      }
      
      const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return {}
      
      return JSON.parse(jsonMatch[0])
    } catch {
      return {}
    }
  }

  // ============================================================================
  // Intermediary Detection (Requirement 8.3)
  // ============================================================================

  /**
   * Extracts intermediary/introducer information from message blocks
   * Uses pattern matching to detect introduction context
   * @param messageBlocks - Array of MessageBlock objects
   * @returns IntermediaryInfo with detected intermediary details
   * Validates: Requirements 8.3
   */
  extractIntermediaryInfo(messageBlocks: MessageBlock[]): IntermediaryInfo {
    const allContent = messageBlocks.map(m => m.cleanContent).join('\n')
    
    for (const { pattern, nameGroup } of INTERMEDIARY_PATTERNS) {
      const match = allContent.match(pattern)
      if (match && match[nameGroup]) {
        const name = match[nameGroup].trim()
        // Filter out common false positives
        if (name.length > 0 && name.length <= 10 && !this.isCommonWord(name)) {
          return {
            has_intermediary: true,
            name,
            context: match[0]
          }
        }
      }
    }
    
    return { has_intermediary: false }
  }

  /**
   * Checks if a string is a common word (not a name)
   */
  private isCommonWord(word: string): boolean {
    const commonWords = [
      '我', '你', '他', '她', '它', '我们', '你们', '他们',
      '这', '那', '这个', '那个', '什么', '谁', '哪',
      'I', 'you', 'he', 'she', 'it', 'we', 'they', 'the', 'a', 'an'
    ]
    return commonWords.includes(word.toLowerCase())
  }

  // ============================================================================
  // Risk Assessment from Blocks (Requirement 10.1)
  // ============================================================================

  /**
   * Assesses risk from message blocks
   * @param blocks - Message blocks to analyze
   * @returns RiskAssessment or undefined if no risk detected
   * Validates: Requirements 10.1, 10.3
   */
  assessRiskFromBlocks(blocks: MessageBlock[]): RiskAssessment | undefined {
    const messages = blocks.map(b => b.cleanContent)
    const result = this.assessRisk(messages, undefined)
    
    if (result && result.is_suspicious) {
      return {
        is_suspicious: result.is_suspicious,
        risk_level: result.risk_level || 'medium',
        warning_msg: result.warning_msg || ''
      }
    }
    
    return undefined
  }

  // ============================================================================
  // Contradictory Information Override (Requirement 8.5)
  // ============================================================================

  /**
   * Updates a profile with new facts, overriding contradictory information
   * New values always override old values for the same field
   * @param existingProfile - The current contact profile
   * @param newFacts - New facts to merge (new values override old)
   * @returns Updated contact profile
   * Validates: Requirements 8.5
   */
  overrideProfileFacts(existingProfile: ContactProfile, newFacts: Partial<ContactProfile>): ContactProfile {
    const updated = { ...existingProfile }
    
    // Override profile info fields
    if (newFacts.profile) {
      updated.profile = {
        role: newFacts.profile.role ?? existingProfile.profile.role,
        age_group: newFacts.profile.age_group ?? existingProfile.profile.age_group,
        personality_tags: newFacts.profile.personality_tags ?? existingProfile.profile.personality_tags,
        interests: newFacts.profile.interests ?? existingProfile.profile.interests,
        occupation: newFacts.profile.occupation ?? existingProfile.profile.occupation
      }
    }
    
    // Override relationship graph fields
    if (newFacts.relationship_graph) {
      updated.relationship_graph = {
        current_status: newFacts.relationship_graph.current_status ?? existingProfile.relationship_graph.current_status,
        intimacy_level: newFacts.relationship_graph.intimacy_level ?? existingProfile.relationship_graph.intimacy_level,
        intermediary: newFacts.relationship_graph.intermediary ?? existingProfile.relationship_graph.intermediary
      }
    }
    
    // Override other fields
    if (newFacts.chat_history_summary !== undefined) {
      updated.chat_history_summary = newFacts.chat_history_summary
    }
    
    if (newFacts.risk_assessment) {
      updated.risk_assessment = {
        is_suspicious: newFacts.risk_assessment.is_suspicious ?? existingProfile.risk_assessment.is_suspicious,
        risk_level: newFacts.risk_assessment.risk_level ?? existingProfile.risk_assessment.risk_level,
        warning_msg: newFacts.risk_assessment.warning_msg ?? existingProfile.risk_assessment.warning_msg
      }
    }
    
    updated.last_updated = Date.now()
    
    return updated
  }
}
