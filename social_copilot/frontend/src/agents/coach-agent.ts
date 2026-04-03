/**
 * Social Coach Agent - Generates high-EQ reply suggestions with teaching annotations (教学注解)
 *
 * Responsible for:
 * - Building system prompts incorporating user profile and contact profile
 * - Generating exactly 3 reply suggestions with content and reason (教学注解)
 * - Mimicking user's communication habits (口头禅, 标点习惯, emoji usage)
 * - Adapting tone based on contact role and intimacy level
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5
 */
import {
  IntentAnalysis,
  Suggestion,
  SuggestionSchema,
  UserProfile,
  ContactProfile,
  IntimacyLevel
} from '../models/schemas'
import { OllamaClient, OllamaInvalidResponseError } from '../services/ollama-client'

// ============================================================================
// Error Types
// ============================================================================

export class CoachAgentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CoachAgentError'
  }
}

export class SuggestionParseError extends Error {
  constructor(message: string, public readonly rawResponse: string) {
    super(message)
    this.name = 'SuggestionParseError'
  }
}

// ============================================================================
// Types
// ============================================================================

export interface CoachContext {
  intent: IntentAnalysis
  userProfile: UserProfile
  contactProfile: ContactProfile
}

// ============================================================================
// Tone Mapping
// ============================================================================

const INTIMACY_TONE_MAP: Record<IntimacyLevel, string> = {
  stranger: 'polite and reserved, maintaining appropriate distance',
  formal: 'professional and respectful, using formal language',
  close: 'warm and friendly, using casual language',
  intimate: 'very casual and affectionate, using intimate expressions'
}


// ============================================================================
// System Prompt Builder
// ============================================================================

/**
 * Gets the role-based tone adjustment for formal roles
 * Requirement 6.4: Adjust tone for formal roles (导师, 长辈)
 */
function getRoleBasedToneAdjustment(role: string): string {
  const formalRoles = ['导师', '长辈', 'mentor', 'elder', 'teacher', 'professor', 'boss', 'manager', 'supervisor']
  const isFormRole = formalRoles.some(r => role.toLowerCase().includes(r.toLowerCase()))
  
  if (isFormRole) {
    return 'Use more respectful and formal language. Address them appropriately and show deference.'
  }
  return ''
}

/**
 * Builds the system prompt for the Social Coach Agent
 * Incorporates user profile, contact profile, and intimacy-based tone guidance
 * 
 * Key features:
 * - Mimics user's communication habits (口头禅, 标点习惯, emoji usage) - Requirement 6.3
 * - Adapts tone based on contact role (导师, 长辈) - Requirement 6.4
 * - Adapts tone based on intimacy level - Requirement 6.5
 */
export function buildCoachSystemPrompt(
  userProfile: UserProfile,
  contactProfile: ContactProfile
): string {
  const intimacyLevel = contactProfile.relationship_graph.intimacy_level
  const toneSuggestion = INTIMACY_TONE_MAP[intimacyLevel]
  const userToneStyle = userProfile.base_info.tone_style
  const contactRole = contactProfile.profile.role
  const roleAdjustment = getRoleBasedToneAdjustment(contactRole)

  // Build communication habits section (Requirement 6.3)
  const habitsSection = buildCommunicationHabitsSection(userProfile)

  return `You are an expert social communication coach (社交教练). Your task is to generate high-EQ reply suggestions with teaching annotations (教学注解) that help the user respond appropriately to conversations.

## User Profile
- Gender: ${userProfile.base_info.gender}
- Occupation: ${userProfile.base_info.occupation || 'Not specified'}
- Preferred tone style: ${userToneStyle}
- Message length preference: ${userProfile.communication_habits.msg_avg_length}
${habitsSection}

## Contact Profile
- Nickname: ${contactProfile.nickname}
- Role: ${contactRole}
- Age group: ${contactProfile.profile.age_group}
- Personality: ${contactProfile.profile.personality_tags.join(', ') || 'Unknown'}
- Interests: ${contactProfile.profile.interests.join(', ') || 'Unknown'}
- Relationship status: ${contactProfile.relationship_graph.current_status}
- Intimacy level: ${intimacyLevel}
${contactProfile.chat_history_summary ? `- Chat history summary: ${contactProfile.chat_history_summary}` : ''}

## Tone Guidelines
Based on the intimacy level (${intimacyLevel}), the tone should be: ${toneSuggestion}
Also match the user's preferred tone style: ${userToneStyle}
${roleAdjustment ? `\n**Role-based adjustment**: ${roleAdjustment}` : ''}

## Communication Style Mimicry (IMPORTANT - Requirement 6.3)
You MUST mimic the user's communication habits in your suggestions:
${userProfile.communication_habits.frequent_phrases && userProfile.communication_habits.frequent_phrases.length > 0 ? `- Use their frequent phrases (口头禅): ${userProfile.communication_habits.frequent_phrases.join(', ')}` : '- No specific frequent phrases recorded'}
${userProfile.communication_habits.punctuation_style ? `- Follow their punctuation style (标点习惯): ${userProfile.communication_habits.punctuation_style}` : '- No specific punctuation style recorded'}
${userProfile.communication_habits.emoji_usage && userProfile.communication_habits.emoji_usage.length > 0 ? `- Include their commonly used emojis: ${userProfile.communication_habits.emoji_usage.join(' ')}` : '- No specific emoji preferences recorded'}

## Instructions
Generate exactly 3 reply suggestions. Each suggestion must include:
1. "content": The actual reply text the user can send (mimicking their communication style)
2. "reason": A teaching annotation (教学注解) explaining the communication strategy behind this reply

IMPORTANT:
- Respond ONLY with a valid JSON array containing exactly 3 suggestion objects
- Each suggestion must have non-empty "content" and "reason" fields
- MIMIC the user's communication habits (frequent phrases, punctuation style, emoji usage)
- Adapt the language formality based on the intimacy level
- Match the user's preferred tone style and message length
- Consider the contact's personality and interests when crafting replies
${roleAdjustment ? '- Show appropriate respect for the contact\'s role' : ''}

Example response format:
[
  {"content": "Reply text here", "reason": "Strategy explanation here"},
  {"content": "Another reply option", "reason": "Why this works"},
  {"content": "Third alternative", "reason": "Communication benefit"}
]`
}

/**
 * Builds the communication habits section for the system prompt
 * Emphasizes mimicking user's style (Requirement 6.3)
 */
function buildCommunicationHabitsSection(userProfile: UserProfile): string {
  const habits = userProfile.communication_habits
  const sections: string[] = []

  if (habits.frequent_phrases && habits.frequent_phrases.length > 0) {
    sections.push(`- Frequent phrases (口头禅): ${habits.frequent_phrases.join(', ')}`)
  }
  if (habits.punctuation_style) {
    sections.push(`- Punctuation style (标点习惯): ${habits.punctuation_style}`)
  }
  if (habits.emoji_usage && habits.emoji_usage.length > 0) {
    sections.push(`- Emoji usage: ${habits.emoji_usage.join(' ')}`)
  }

  return sections.length > 0 ? sections.join('\n') : ''
}

// ============================================================================
// CoachAgent Class
// ============================================================================

export class CoachAgent {
  private ollamaClient: OllamaClient
  private temperature: number

  /**
   * Creates a new CoachAgent
   * @param ollamaClient - The Ollama client for LLM communication
   * @param temperature - Temperature for LLM calls (default: 0.7 for creative suggestions)
   */
  constructor(ollamaClient: OllamaClient, temperature: number = 0.7) {
    this.ollamaClient = ollamaClient
    this.temperature = temperature
  }

  /**
   * Generates reply suggestions based on context
   * @param context - The coach context including intent, user profile, and contact profile
   * @returns Array of exactly 3 Suggestion objects
   * @throws CoachAgentError if generation fails
   * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5
   */
  async generateSuggestions(context: CoachContext): Promise<Suggestion[]> {
    const systemPrompt = buildCoachSystemPrompt(context.userProfile, context.contactProfile)
    const prompt = this.buildPrompt(context.intent)

    try {
      const response = await this.ollamaClient.generate({
        prompt,
        system: systemPrompt,
        temperature: this.temperature
      })

      return this.parseResponse(response.response)
    } catch (error) {
      if (error instanceof SuggestionParseError) {
        console.error(`Suggestion parsing failed: ${error.message}`, error.rawResponse)
        throw new CoachAgentError(`Failed to parse suggestions: ${error.message}`)
      }
      if (error instanceof OllamaInvalidResponseError) {
        console.error(`Ollama response invalid: ${error.message}`)
        throw new CoachAgentError(`Invalid Ollama response: ${error.message}`)
      }
      // Re-throw connection/timeout errors
      throw error
    }
  }

  /**
   * Builds the prompt for suggestion generation from intent analysis
   * @param intent - The intent analysis from IntentAgent
   * @returns Formatted prompt string
   */
  buildPrompt(intent: IntentAnalysis): string {
    return `Based on the following conversation analysis, generate 3 high-EQ reply suggestions:

## Conversation Analysis
- Intent: ${intent.intent}
- Mood: ${intent.mood}
- Topic: ${intent.topic}

Please generate exactly 3 reply suggestions that appropriately address this conversation context.`
  }

  /**
   * Parses the LLM response into Suggestion array
   * @param response - Raw response string from LLM
   * @returns Array of exactly 3 validated Suggestion objects
   * @throws SuggestionParseError if parsing fails or count is not 3
   */
  parseResponse(response: string): Suggestion[] {
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

    // Try to extract JSON array from the response
    const jsonMatch = cleanedResponse.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      throw new SuggestionParseError('No JSON array found in response', response)
    }

    try {
      const parsed = JSON.parse(jsonMatch[0])

      // Validate it's an array
      if (!Array.isArray(parsed)) {
        throw new SuggestionParseError('Response is not an array', response)
      }

      // Validate exactly 3 suggestions (Requirement 3.1)
      if (parsed.length !== 3) {
        throw new SuggestionParseError(
          `Expected exactly 3 suggestions, got ${parsed.length}`,
          response
        )
      }

      // Validate each suggestion
      const suggestions: Suggestion[] = []
      for (let i = 0; i < parsed.length; i++) {
        const result = SuggestionSchema.safeParse(parsed[i])
        if (!result.success) {
          throw new SuggestionParseError(
            `Invalid suggestion at index ${i}: ${result.error.message}`,
            response
          )
        }
        suggestions.push(result.data)
      }

      return suggestions
    } catch (error) {
      if (error instanceof SuggestionParseError) {
        throw error
      }
      throw new SuggestionParseError(
        `Failed to parse JSON: ${error instanceof Error ? error.message : 'Unknown error'}`,
        response
      )
    }
  }

  /**
   * Gets the configured temperature
   * Useful for testing
   */
  getTemperature(): number {
    return this.temperature
  }

  /**
   * Gets the system prompt for a given context
   * Useful for testing and debugging
   */
  getSystemPrompt(userProfile: UserProfile, contactProfile: ContactProfile): string {
    return buildCoachSystemPrompt(userProfile, contactProfile)
  }
}
