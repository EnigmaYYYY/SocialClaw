import { z } from 'zod'

// ============================================================================
// Ollama Client Configuration and Types
// ============================================================================

export interface OllamaConfig {
  baseUrl: string
  model: string
  keepAlive: number
  timeout: number
}

export const DEFAULT_OLLAMA_CONFIG: OllamaConfig = {
  baseUrl: 'http://localhost:11434',
  model: 'qwen3:8b',
  keepAlive: -1, // Keep model in memory (Requirement 9.3)
  timeout: 10000 // 10 second timeout
}

export interface OllamaRequest {
  model: string
  prompt: string
  system?: string
  temperature?: number
  stream?: boolean
  keep_alive?: number
}

export const OllamaResponseSchema = z.object({
  model: z.string(),
  response: z.string(),
  done: z.boolean(),
  context: z.array(z.number()).optional()
})

export type OllamaResponse = z.infer<typeof OllamaResponseSchema>

// ============================================================================
// Error Types
// ============================================================================

export class OllamaConnectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OllamaConnectionError'
  }
}

export class OllamaTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OllamaTimeoutError'
  }
}

export class OllamaModelNotFoundError extends Error {
  constructor(model: string) {
    super(`Model '${model}' not found. Run: ollama pull ${model}`)
    this.name = 'OllamaModelNotFoundError'
  }
}

export class OllamaInvalidResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OllamaInvalidResponseError'
  }
}


// ============================================================================
// OllamaClient Class
// ============================================================================

/**
 * OllamaClient - Client for communicating with local Ollama service
 *
 * Handles:
 * - Health checks to verify Ollama connectivity (Requirement 9.1)
 * - Generate requests with proper configuration (Requirements 9.3, 9.4)
 * - Timeout handling and error responses (Requirement 9.2)
 */
export class OllamaClient {
  private config: OllamaConfig

  constructor(config: Partial<OllamaConfig> = {}) {
    this.config = { ...DEFAULT_OLLAMA_CONFIG, ...config }
  }

  /**
   * Checks if Ollama service is available and responsive
   * @returns true if Ollama is healthy, false otherwise
   * Validates: Requirement 9.1
   */
  async checkHealth(): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout)

      const response = await fetch(`${this.config.baseUrl}/api/tags`, {
        method: 'GET',
        signal: controller.signal
      })

      clearTimeout(timeoutId)
      return response.ok
    } catch (error) {
      return false
    }
  }

  /**
   * Generates a response from the Ollama model
   * @param request - The generation request parameters
   * @returns OllamaResponse with the generated text
   * @throws OllamaConnectionError if Ollama is not available
   * @throws OllamaTimeoutError if request times out
   * @throws OllamaModelNotFoundError if model is not found
   * @throws OllamaInvalidResponseError if response format is invalid
   * Validates: Requirements 9.2, 9.3, 9.4
   */
  async generate(request: Omit<OllamaRequest, 'model' | 'keep_alive'>): Promise<OllamaResponse> {
    const fullRequest = this.buildRequest(request)

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout)

      const response = await fetch(`${this.config.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(fullRequest),
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        if (response.status === 404) {
          throw new OllamaModelNotFoundError(this.config.model)
        }
        const errorText = await response.text()
        throw new OllamaConnectionError(`Ollama request failed: ${response.status} - ${errorText}`)
      }

      const data = await response.json()
      return this.parseResponse(data)
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new OllamaTimeoutError(
            `Request timed out after ${this.config.timeout}ms. Ollama may be overloaded.`
          )
        }
        if (
          error instanceof OllamaConnectionError ||
          error instanceof OllamaTimeoutError ||
          error instanceof OllamaModelNotFoundError ||
          error instanceof OllamaInvalidResponseError
        ) {
          throw error
        }
        // Network errors
        if (error.message.includes('fetch') || error.message.includes('ECONNREFUSED')) {
          throw new OllamaConnectionError(
            'Cannot connect to Ollama. Please ensure Ollama is running at ' + this.config.baseUrl
          )
        }
      }
      throw new OllamaConnectionError(`Unexpected error: ${error}`)
    }
  }

  /**
   * Builds the full Ollama request with required configuration
   * Sets keep_alive: -1 (Requirement 9.3) and applies temperature
   * @param request - Partial request parameters
   * @returns Full OllamaRequest with all required fields
   */
  buildRequest(request: Omit<OllamaRequest, 'model' | 'keep_alive'>): OllamaRequest {
    return {
      model: this.config.model,
      prompt: request.prompt,
      system: request.system,
      temperature: request.temperature,
      stream: false, // Always use non-streaming for simplicity
      keep_alive: this.config.keepAlive // -1 to keep model in memory (Requirement 9.3)
    }
  }

  /**
   * Parses and validates the Ollama response
   * @param data - Raw response data from Ollama
   * @returns Validated OllamaResponse
   * @throws OllamaInvalidResponseError if response format is invalid
   */
  private parseResponse(data: unknown): OllamaResponse {
    const result = OllamaResponseSchema.safeParse(data)
    if (!result.success) {
      throw new OllamaInvalidResponseError(
        `Invalid response format from Ollama: ${result.error.message}`
      )
    }
    return result.data
  }

  /**
   * Gets the current configuration
   * Useful for testing and debugging
   */
  getConfig(): OllamaConfig {
    return { ...this.config }
  }

  /**
   * Creates a request configured for Intent Agent (temperature 0.1)
   * Validates: Requirement 9.4
   */
  buildIntentAgentRequest(prompt: string, system?: string): OllamaRequest {
    return this.buildRequest({
      prompt,
      system,
      temperature: 0.1 // Requirement 9.4: Intent Agent uses temperature 0.1
    })
  }

  /**
   * Creates a request configured for Coach Agent (default temperature)
   */
  buildCoachAgentRequest(prompt: string, system?: string): OllamaRequest {
    return this.buildRequest({
      prompt,
      system,
      temperature: 0.7 // Higher temperature for more creative suggestions
    })
  }
}
