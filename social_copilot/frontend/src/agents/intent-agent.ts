/**
 * Intent Agent - Analyzes chat logs to extract intent, mood, and topic
 *
 * Responsible for:
 * - Building system prompts for intent analysis
 * - Parsing LLM responses to IntentAnalysis structure
 * - Using temperature 0.1 for stable results (Requirement 6.4)
 * - Handling edge cases like fewer than 3 messages (Requirement 2.3)
 *
 * Validates: Requirements 2.1, 2.2, 2.3
 */
import {
  IntentAnalysis,
  IntentAnalysisSchema,
  ParsedMessage
} from '../models/schemas'
import { OllamaClient, OllamaInvalidResponseError } from '../services/ollama-client'

// ============================================================================
// Error Types
// ============================================================================

export class IntentAnalysisError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IntentAnalysisError'
  }
}

export class IntentParseError extends Error {
  constructor(message: string, public readonly rawResponse: string) {
    super(message)
    this.name = 'IntentParseError'
  }
}

// ============================================================================
// Fallback Intent
// ============================================================================

/**
 * Fallback intent used when analysis fails
 * As specified in design document error handling
 */
export const FALLBACK_INTENT: IntentAnalysis = {
  intent: 'unknown',
  mood: 'neutral',
  topic: 'general'
}

// ============================================================================
// System Prompt
// ============================================================================

const INTENT_ANALYSIS_SYSTEM_PROMPT = `You are an expert conversation analyst. Your task is to analyze chat messages and extract the underlying intent, emotional mood, and main topic.

Analyze the conversation and respond with a JSON object containing exactly these three fields:
- "intent": The primary purpose or goal of the conversation (e.g., "requesting_help", "casual_greeting", "urging_for_update", "expressing_concern", "making_plans", "sharing_news")
- "mood": The emotional tone of the conversation (e.g., "anxious", "friendly", "neutral", "frustrated", "excited", "formal")
- "topic": The main subject being discussed (e.g., "project_deadline", "weekend_plans", "work_issues", "personal_matters", "general_chat")

IMPORTANT:
- Respond ONLY with a valid JSON object, no additional text
- All three fields must be non-empty strings
- Base your analysis on the overall conversation context, not just the last message
- If the conversation is very short, make reasonable inferences from available context

Example response format:
{"intent": "requesting_help", "mood": "anxious", "topic": "project_deadline"}`

// ============================================================================
// IntentAgent Class
// ============================================================================

export class IntentAgent {
  private ollamaClient: OllamaClient
  private temperature: number

  /**
   * Creates a new IntentAgent
   * @param ollamaClient - The Ollama client for LLM communication
   * @param temperature - Temperature for LLM calls (default: 0.1 for stable results)
   */
  constructor(ollamaClient: OllamaClient, temperature: number = 0.1) {
    this.ollamaClient = ollamaClient
    this.temperature = temperature
  }

  /**
   * Analyzes chat logs and returns intent analysis
   * @param chatLogs - Array of chat messages (strings or ParsedMessage objects)
   * @returns IntentAnalysis with intent, mood, and topic
   * @throws IntentAnalysisError if analysis fails
   * Validates: Requirements 2.1, 2.2, 2.3
   */
  async analyze(chatLogs: string[] | ParsedMessage[]): Promise<IntentAnalysis> {
    // Handle empty input
    if (!chatLogs || chatLogs.length === 0) {
      return FALLBACK_INTENT
    }

    const prompt = this.buildPrompt(chatLogs)

    try {
      const response = await this.ollamaClient.generate({
        prompt,
        system: INTENT_ANALYSIS_SYSTEM_PROMPT,
        temperature: this.temperature // Requirement 6.4: Use temperature 0.1
      })

      return this.parseResponse(response.response)
    } catch (error) {
      if (error instanceof IntentParseError) {
        // Log the error but return fallback
        console.error(`Intent parsing failed: ${error.message}`, error.rawResponse)
        return FALLBACK_INTENT
      }
      if (error instanceof OllamaInvalidResponseError) {
        console.error(`Ollama response invalid: ${error.message}`)
        return FALLBACK_INTENT
      }
      // Re-throw connection/timeout errors
      throw error
    }
  }

  /**
   * Builds the prompt for intent analysis from chat logs
   * Handles both string arrays and ParsedMessage arrays
   * @param chatLogs - The chat messages to analyze
   * @returns Formatted prompt string
   */
  buildPrompt(chatLogs: string[] | ParsedMessage[]): string {
    const messageCount = chatLogs.length

    // Format messages for the prompt
    const formattedMessages = chatLogs.map((msg, index) => {
      if (typeof msg === 'string') {
        return `${index + 1}. ${msg}`
      }
      // ParsedMessage format
      const timestamp = msg.timestamp ? `[${msg.timestamp}] ` : ''
      return `${index + 1}. ${timestamp}${msg.sender}: ${msg.content}`
    }).join('\n')

    // Add context about message count for edge case handling (Requirement 2.3)
    let contextNote = ''
    if (messageCount < 3) {
      contextNote = `\n\nNote: This conversation has only ${messageCount} message(s). Please provide your best analysis based on the available context.`
    }

    return `Analyze the following conversation:\n\n${formattedMessages}${contextNote}`
  }

  /**
   * Parses the LLM response into IntentAnalysis structure
   * @param response - Raw response string from LLM
   * @returns Validated IntentAnalysis object
   * @throws IntentParseError if parsing fails
   */
  parseResponse(response: string): IntentAnalysis {
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
      throw new IntentParseError('No JSON object found in response', response)
    }

    try {
      const parsed = JSON.parse(jsonMatch[0])
      const result = IntentAnalysisSchema.safeParse(parsed)

      if (!result.success) {
        throw new IntentParseError(
          `Invalid IntentAnalysis structure: ${result.error.message}`,
          response
        )
      }

      return result.data
    } catch (error) {
      if (error instanceof IntentParseError) {
        throw error
      }
      throw new IntentParseError(
        `Failed to parse JSON: ${error instanceof Error ? error.message : 'Unknown error'}`,
        response
      )
    }
  }

  /**
   * Gets the system prompt used for intent analysis
   * Useful for testing and debugging
   */
  getSystemPrompt(): string {
    return INTENT_ANALYSIS_SYSTEM_PROMPT
  }

  /**
   * Gets the configured temperature
   * Useful for testing
   */
  getTemperature(): number {
    return this.temperature
  }
}
