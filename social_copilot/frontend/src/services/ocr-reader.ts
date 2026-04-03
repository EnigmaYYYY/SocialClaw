import { exec } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import Tesseract from 'tesseract.js'
import { ParsedMessage } from '../models'

const execAsync = promisify(exec)
const fsPromises = fs.promises

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Screen region bounds for capture
 */
export interface ScreenRegion {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Status of the OCR reader
 */
export interface OCRStatus {
  isAvailable: boolean
  isInitialized: boolean
  lastCaptureTime: number | null
  errorMessage?: string
}

/**
 * OCR recognition result
 */
export interface OCRResult {
  text: string
  confidence: number
  lines: OCRLine[]
}

/**
 * Individual line from OCR
 */
export interface OCRLine {
  text: string
  confidence: number
  bbox: {
    x0: number
    y0: number
    x1: number
    y1: number
  }
}

// ============================================================================
// Error Types
// ============================================================================

export class OCRError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OCRError'
  }
}

export class ScreenCaptureError extends OCRError {
  constructor(message: string) {
    super(`Screen capture failed: ${message}`)
    this.name = 'ScreenCaptureError'
  }
}

export class OCRRecognitionError extends OCRError {
  constructor(message: string) {
    super(`OCR recognition failed: ${message}`)
    this.name = 'OCRRecognitionError'
  }
}

// ============================================================================
// OCRReader Class
// ============================================================================

/**
 * OCRReader - Reads WeChat chat messages using OCR as fallback
 *
 * This class provides functionality to:
 * - Capture specific screen region (chat message area) (Requirement 3.4)
 * - Perform OCR recognition on captured image (Requirement 3.3)
 * - Parse recognized text into message format (Requirement 3.3)
 *
 * Implementation uses macOS screencapture command for screen capture
 * and tesseract.js for OCR recognition.
 */
export class OCRReader {
  private static readonly TEMP_DIR = path.join(os.tmpdir(), 'social-copilot-ocr')
  private static readonly CAPTURE_FILENAME = 'capture.png'
  private static readonly IS_MACOS = process.platform === 'darwin'

  private worker: Tesseract.Worker | null = null
  private isInitialized: boolean = false
  private lastCaptureTime: number | null = null

  // Default chat area offset ratios (relative to window bounds)
  // These are approximate values for WeChat's chat message area
  private static readonly CHAT_AREA_LEFT_RATIO = 0.25 // Chat area starts at ~25% from left
  private static readonly CHAT_AREA_TOP_RATIO = 0.1 // Chat area starts at ~10% from top
  private static readonly CHAT_AREA_WIDTH_RATIO = 0.75 // Chat area is ~75% of window width
  private static readonly CHAT_AREA_HEIGHT_RATIO = 0.8 // Chat area is ~80% of window height

  // ============================================================================
  // Initialization
  // ============================================================================

  /**
   * Initializes the OCR reader by creating temp directory and Tesseract worker
   * @param language - OCR language (default: 'chi_sim+eng' for Chinese Simplified + English)
   */
  async initialize(language: string = 'chi_sim+eng'): Promise<void> {
    if (this.isInitialized) {
      return
    }
    if (!OCRReader.IS_MACOS) {
      throw new OCRError(
        'Legacy OCRReader is macOS-only. Please use Visual Monitor API realtime flow on Windows.'
      )
    }

    try {
      // Ensure temp directory exists
      await fsPromises.mkdir(OCRReader.TEMP_DIR, { recursive: true })

      // Create Tesseract worker with specified language
      this.worker = await Tesseract.createWorker(language)

      this.isInitialized = true
    } catch (error) {
      throw new OCRError(
        `Failed to initialize OCR reader: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * Terminates the OCR worker and cleans up resources
   */
  async terminate(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate()
      this.worker = null
    }
    this.isInitialized = false

    // Clean up temp files
    try {
      const capturePath = path.join(OCRReader.TEMP_DIR, OCRReader.CAPTURE_FILENAME)
      await fsPromises.unlink(capturePath).catch(() => {
        /* ignore if file doesn't exist */
      })
    } catch {
      // Ignore cleanup errors
    }
  }

  // ============================================================================
  // Screen Capture
  // ============================================================================

  /**
   * Captures a specific screen region
   * Uses macOS screencapture command
   * Validates: Requirement 3.4
   * @param region - Screen region to capture
   * @returns Path to the captured image file
   */
  async captureScreenRegion(region: ScreenRegion): Promise<string> {
    const capturePath = path.join(OCRReader.TEMP_DIR, OCRReader.CAPTURE_FILENAME)

    try {
      // Ensure temp directory exists
      await fsPromises.mkdir(OCRReader.TEMP_DIR, { recursive: true })

      // Use macOS screencapture command with region
      // -x: no sound
      // -R: capture specific region (x,y,width,height)
      const command = `screencapture -x -R${region.x},${region.y},${region.width},${region.height} "${capturePath}"`

      await execAsync(command)

      // Verify the file was created
      await fsPromises.access(capturePath)

      this.lastCaptureTime = Date.now()
      return capturePath
    } catch (error) {
      throw new ScreenCaptureError(error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Captures the full screen
   * @returns Path to the captured image file
   */
  async captureFullScreen(): Promise<string> {
    const capturePath = path.join(OCRReader.TEMP_DIR, OCRReader.CAPTURE_FILENAME)

    try {
      await fsPromises.mkdir(OCRReader.TEMP_DIR, { recursive: true })

      // Capture full screen without region specification
      const command = `screencapture -x "${capturePath}"`
      await execAsync(command)

      await fsPromises.access(capturePath)

      this.lastCaptureTime = Date.now()
      return capturePath
    } catch (error) {
      throw new ScreenCaptureError(error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Calculates the chat message area region based on WeChat window bounds
   * Validates: Requirement 3.4
   * @param windowBounds - WeChat window bounds
   * @returns Screen region for the chat message area
   */
  calculateChatAreaRegion(windowBounds: ScreenRegion): ScreenRegion {
    return {
      x: Math.round(windowBounds.x + windowBounds.width * OCRReader.CHAT_AREA_LEFT_RATIO),
      y: Math.round(windowBounds.y + windowBounds.height * OCRReader.CHAT_AREA_TOP_RATIO),
      width: Math.round(windowBounds.width * OCRReader.CHAT_AREA_WIDTH_RATIO),
      height: Math.round(windowBounds.height * OCRReader.CHAT_AREA_HEIGHT_RATIO)
    }
  }

  // ============================================================================
  // OCR Recognition
  // ============================================================================

  /**
   * Performs OCR recognition on an image file
   * Validates: Requirement 3.3
   * @param imagePath - Path to the image file
   * @returns OCR result with text and confidence
   */
  async recognizeImage(imagePath: string): Promise<OCRResult> {
    if (!this.isInitialized || !this.worker) {
      throw new OCRError('OCR reader not initialized. Call initialize() first.')
    }

    try {
      const result = await this.worker.recognize(imagePath)

      const lines: OCRLine[] = result.data.lines.map((line) => ({
        text: line.text.trim(),
        confidence: line.confidence,
        bbox: {
          x0: line.bbox.x0,
          y0: line.bbox.y0,
          x1: line.bbox.x1,
          y1: line.bbox.y1
        }
      }))

      return {
        text: result.data.text,
        confidence: result.data.confidence,
        lines: lines.filter((line) => line.text.length > 0)
      }
    } catch (error) {
      throw new OCRRecognitionError(error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Captures and recognizes text from a screen region
   * Combines capture and recognition in one operation
   * @param region - Screen region to capture and recognize
   * @returns OCR result
   */
  async captureAndRecognize(region: ScreenRegion): Promise<OCRResult> {
    const imagePath = await this.captureScreenRegion(region)
    return this.recognizeImage(imagePath)
  }

  // ============================================================================
  // Message Parsing
  // ============================================================================

  /**
   * Parses OCR result into ParsedMessage objects
   * Validates: Requirement 3.3
   * @param ocrResult - OCR recognition result
   * @returns Array of ParsedMessage objects
   */
  parseOCRResultToMessages(ocrResult: OCRResult): ParsedMessage[] {
    const messages: ParsedMessage[] = []
    const now = new Date()

    // Process each line from OCR
    for (const line of ocrResult.lines) {
      const trimmed = line.text.trim()
      if (!trimmed) continue

      // Skip low confidence lines
      if (line.confidence < 50) continue

      // Skip system UI elements
      if (this.isSystemUIElement(trimmed)) continue

      // Try to parse as "Sender: Content" format
      const parsed = this.parseMessageLine(trimmed)

      if (parsed) {
        messages.push({
          timestamp: now,
          sender: parsed.sender,
          content: parsed.content,
          isFromUser: this.isFromUser(parsed.sender)
        })
      } else if (trimmed.length > 0 && !this.isTimeString(trimmed)) {
        // Treat as content-only message with unknown sender
        messages.push({
          timestamp: now,
          sender: 'Unknown',
          content: trimmed,
          isFromUser: false
        })
      }
    }

    return this.mergeConsecutiveMessages(messages)
  }

  /**
   * Reads chat messages from a screen region using OCR
   * Main entry point for reading messages
   * Validates: Requirements 3.3, 3.4
   * @param region - Screen region containing chat messages
   * @returns Array of ParsedMessage objects
   */
  async readChatMessages(region: ScreenRegion): Promise<ParsedMessage[]> {
    const ocrResult = await this.captureAndRecognize(region)
    return this.parseOCRResultToMessages(ocrResult)
  }

  /**
   * Reads chat messages from WeChat window bounds
   * Automatically calculates the chat area region
   * @param windowBounds - WeChat window bounds
   * @returns Array of ParsedMessage objects
   */
  async readChatMessagesFromWindow(windowBounds: ScreenRegion): Promise<ParsedMessage[]> {
    const chatRegion = this.calculateChatAreaRegion(windowBounds)
    return this.readChatMessages(chatRegion)
  }

  // ============================================================================
  // Status
  // ============================================================================

  /**
   * Gets the current status of the OCR reader
   * @returns OCRStatus object
   */
  getStatus(): OCRStatus {
    const isAvailable = OCRReader.IS_MACOS
    return {
      isAvailable,
      isInitialized: this.isInitialized,
      lastCaptureTime: this.lastCaptureTime,
      errorMessage: !isAvailable
        ? 'Legacy OCRReader is macOS-only'
        : !this.isInitialized
          ? 'OCR reader not initialized'
          : undefined
    }
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Parses a message line in "Sender: Content" format
   * @param line - Line to parse
   * @returns Parsed sender and content, or null if not parseable
   */
  private parseMessageLine(line: string): { sender: string; content: string } | null {
    // Common patterns for WeChat messages:
    // - "SenderName: MessageContent"
    // - "SenderName：MessageContent" (Chinese colon)

    // Try both English and Chinese colons
    const colonPatterns = [':', '：']

    for (const colon of colonPatterns) {
      const colonIndex = line.indexOf(colon)
      if (colonIndex > 0 && colonIndex < 30) {
        // Sender name should be reasonable length
        const potentialSender = line.substring(0, colonIndex).trim()
        const content = line.substring(colonIndex + 1).trim()

        // Validate sender name (not a time string, not too long)
        if (
          potentialSender &&
          content &&
          !this.isTimeString(potentialSender) &&
          potentialSender.length <= 20
        ) {
          return { sender: potentialSender, content }
        }
      }
    }

    return null
  }

  /**
   * Merges consecutive messages from the same sender
   * @param messages - Array of messages to merge
   * @returns Merged messages
   */
  private mergeConsecutiveMessages(messages: ParsedMessage[]): ParsedMessage[] {
    if (messages.length === 0) return []

    const merged: ParsedMessage[] = []
    let current = { ...messages[0] }

    for (let i = 1; i < messages.length; i++) {
      const msg = messages[i]
      if (msg.sender === current.sender) {
        // Merge content with newline
        current.content = `${current.content}\n${msg.content}`
      } else {
        merged.push(current)
        current = { ...msg }
      }
    }
    merged.push(current)

    return merged
  }

  /**
   * Checks if a string is a system UI element that should be skipped
   */
  private isSystemUIElement(text: string): boolean {
    const systemPatterns = [
      /^微信$/,
      /^WeChat$/i,
      /^发送$/,
      /^Send$/i,
      /^表情$/,
      /^Emoji$/i,
      /^文件$/,
      /^File$/i,
      /^截图$/,
      /^Screenshot$/i,
      /^语音$/,
      /^Voice$/i,
      /^视频$/,
      /^Video$/i,
      /^聊天$/,
      /^Chat$/i,
      /^通讯录$/,
      /^Contacts$/i,
      /^收藏$/,
      /^Favorites$/i,
      /^设置$/,
      /^Settings$/i,
      /^\+$/,
      /^搜索$/,
      /^Search$/i
    ]
    return systemPatterns.some((pattern) => pattern.test(text.trim()))
  }

  /**
   * Checks if a string looks like a time string
   */
  private isTimeString(text: string): boolean {
    // Common time formats: "10:30", "10:30:45", "上午10:30", "下午3:45"
    // Also date formats: "2024-01-01", "昨天", "今天", "星期一"
    const timePatterns = [
      /^(上午|下午)?\d{1,2}:\d{2}(:\d{2})?$/,
      /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/,
      /^(昨天|今天|前天|星期[一二三四五六日天])$/,
      /^(Yesterday|Today|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i
    ]
    return timePatterns.some((pattern) => pattern.test(text.trim()))
  }

  /**
   * Determines if a message is from the user
   * This is a heuristic - in practice, you'd compare against the user's profile
   */
  private isFromUser(sender: string): boolean {
    // Common indicators that a message is from the user
    const userIndicators = ['我', 'Me', 'You', '自己']
    return userIndicators.some((indicator) => sender.includes(indicator))
  }
}
