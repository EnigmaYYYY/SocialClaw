import { exec } from 'child_process'
import { promisify } from 'util'
import { ParsedMessage } from '../models'

const execAsync = promisify(exec)

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Status of the accessibility reader
 */
export interface AccessibilityStatus {
  hasPermission: boolean
  isAvailable: boolean
  wechatWindowFound: boolean
  currentContact: string | null
  errorMessage?: string
}

/**
 * Raw UI element data extracted from accessibility tree
 */
export interface UIElement {
  role: string
  title?: string
  value?: string
  children?: UIElement[]
}

/**
 * WeChat window information
 */
export interface WeChatWindowInfo {
  windowId: number
  title: string
  bounds: {
    x: number
    y: number
    width: number
    height: number
  }
}

// ============================================================================
// Error Types
// ============================================================================

export class AccessibilityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccessibilityError'
  }
}

export class PermissionDeniedError extends AccessibilityError {
  constructor() {
    super('Accessibility permission not granted. Please enable in System Preferences > Privacy & Security > Accessibility')
    this.name = 'PermissionDeniedError'
  }
}

export class WeChatNotFoundError extends AccessibilityError {
  constructor() {
    super('WeChat application window not found. Please ensure WeChat is running.')
    this.name = 'WeChatNotFoundError'
  }
}

// ============================================================================
// AccessibilityReader Class
// ============================================================================

/**
 * AccessibilityReader - Reads WeChat chat messages using macOS Accessibility API
 *
 * This class provides functionality to:
 * - Check and request accessibility permissions (Requirement 3.1)
 * - Find WeChat window by app name (Requirement 3.2)
 * - Read UI element tree (AXScrollArea) to extract chat messages (Requirement 3.2)
 * - Extract current contact name from window title/UI (Requirement 3.2)
 *
 * Implementation uses AppleScript for accessibility interactions, which is a
 * common and reliable approach for Electron apps on macOS.
 *
 * Deprecated note:
 * This legacy reader is intentionally macOS-only. Windows should use
 * the Visual Monitor backend flow instead of AppleScript accessibility.
 */
export class AccessibilityReader {
  private static readonly WECHAT_APP_NAME = '微信'
  private static readonly WECHAT_APP_NAME_EN = 'WeChat'
  private static readonly IS_MACOS = process.platform === 'darwin'

  private cachedWindowInfo: WeChatWindowInfo | null = null
  private lastPermissionCheck: boolean | null = null
  private lastPermissionCheckTime: number = 0
  private static readonly PERMISSION_CACHE_TTL_MS = 5000 // Cache permission check for 5 seconds

  // ============================================================================
  // Permission Management
  // ============================================================================

  /**
   * Checks if accessibility permission is granted
   * Uses cached result if checked within TTL
   * Validates: Requirement 3.1
   * @returns true if permission is granted
   */
  async checkPermission(): Promise<boolean> {
    // Return cached result if still valid
    const now = Date.now()
    if (
      this.lastPermissionCheck !== null &&
      now - this.lastPermissionCheckTime < AccessibilityReader.PERMISSION_CACHE_TTL_MS
    ) {
      return this.lastPermissionCheck
    }

    try {
      // Use AppleScript to check if we can access accessibility features
      // This is a reliable way to check permission on macOS
      const script = `
        tell application "System Events"
          return (count of processes) > 0
        end tell
      `
      await this.runAppleScript(script)
      this.lastPermissionCheck = true
      this.lastPermissionCheckTime = now
      return true
    } catch (error) {
      // If we get an error, it likely means permission is not granted
      this.lastPermissionCheck = false
      this.lastPermissionCheckTime = now
      return false
    }
  }

  /**
   * Requests accessibility permission by opening System Preferences
   * Validates: Requirement 3.1
   * @returns true if request was initiated (user still needs to grant permission)
   */
  async requestPermission(): Promise<boolean> {
    try {
      // Open System Preferences to Accessibility pane
      const script = `
        tell application "System Preferences"
          activate
          set current pane to pane "com.apple.preference.security"
          reveal anchor "Privacy_Accessibility" of current pane
        end tell
      `
      await this.runAppleScript(script)
      return true
    } catch {
      // Try alternative method for newer macOS versions (System Settings)
      try {
        const altScript = `
          do shell script "open x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        `
        await this.runAppleScript(altScript)
        return true
      } catch {
        return false
      }
    }
  }

  // ============================================================================
  // WeChat Window Detection
  // ============================================================================

  /**
   * Finds the WeChat application window
   * Validates: Requirement 3.2
   * @returns WeChatWindowInfo or null if not found
   */
  async findWeChatWindow(): Promise<WeChatWindowInfo | null> {
    const hasPermission = await this.checkPermission()
    if (!hasPermission) {
      throw new PermissionDeniedError()
    }

    try {
      // Try to find WeChat window using System Events
      const script = `
        tell application "System Events"
          set wechatProcess to first process whose name is "${AccessibilityReader.WECHAT_APP_NAME}" or name is "${AccessibilityReader.WECHAT_APP_NAME_EN}"
          tell wechatProcess
            set frontWindow to first window
            set windowTitle to name of frontWindow
            set windowPosition to position of frontWindow
            set windowSize to size of frontWindow
            return windowTitle & "|" & (item 1 of windowPosition) & "|" & (item 2 of windowPosition) & "|" & (item 1 of windowSize) & "|" & (item 2 of windowSize)
          end tell
        end tell
      `
      const result = await this.runAppleScript(script)
      const parts = result.trim().split('|')

      if (parts.length >= 5) {
        const windowInfo: WeChatWindowInfo = {
          windowId: 1, // AppleScript doesn't easily provide window ID
          title: parts[0],
          bounds: {
            x: parseInt(parts[1], 10),
            y: parseInt(parts[2], 10),
            width: parseInt(parts[3], 10),
            height: parseInt(parts[4], 10)
          }
        }
        this.cachedWindowInfo = windowInfo
        return windowInfo
      }
      return null
    } catch (error) {
      // WeChat not running or window not found
      this.cachedWindowInfo = null
      return null
    }
  }

  /**
   * Checks if WeChat is currently running
   * @returns true if WeChat is running
   */
  async isWeChatRunning(): Promise<boolean> {
    try {
      const script = `
        tell application "System Events"
          return (name of processes) contains "${AccessibilityReader.WECHAT_APP_NAME}" or (name of processes) contains "${AccessibilityReader.WECHAT_APP_NAME_EN}"
        end tell
      `
      const result = await this.runAppleScript(script)
      return result.trim().toLowerCase() === 'true'
    } catch {
      return false
    }
  }

  // ============================================================================
  // Contact Name Extraction
  // ============================================================================

  /**
   * Extracts the current contact name from WeChat window
   * The contact name is typically shown in the window title or chat header
   * Validates: Requirement 3.2
   * @returns Contact name or null if not found
   */
  async getCurrentContactName(): Promise<string | null> {
    const windowInfo = await this.findWeChatWindow()
    if (!windowInfo) {
      return null
    }

    // Try to extract contact name from window title
    // WeChat window title format is typically: "ContactName - 微信" or just "微信"
    const title = windowInfo.title
    if (title && title !== AccessibilityReader.WECHAT_APP_NAME && title !== AccessibilityReader.WECHAT_APP_NAME_EN) {
      // Remove " - 微信" or " - WeChat" suffix if present
      const contactName = title
        .replace(/ - 微信$/, '')
        .replace(/ - WeChat$/, '')
        .trim()

      if (contactName && contactName !== AccessibilityReader.WECHAT_APP_NAME && contactName !== AccessibilityReader.WECHAT_APP_NAME_EN) {
        return contactName
      }
    }

    // Try to get contact name from UI elements (chat header)
    try {
      const script = `
        tell application "System Events"
          tell process "${AccessibilityReader.WECHAT_APP_NAME}"
            -- Try to find the chat header which contains contact name
            set chatWindow to first window
            -- Look for static text elements that might contain the contact name
            set allTexts to value of static texts of chatWindow
            return allTexts as string
          end tell
        end tell
      `
      const result = await this.runAppleScript(script)
      // Parse the result to find contact name (first non-empty text that's not a system label)
      const texts = result.split(',').map((t: string) => t.trim()).filter((t: string) => t.length > 0)
      if (texts.length > 0) {
        // The first meaningful text is usually the contact name
        return texts[0]
      }
    } catch {
      // Fall back to window title extraction
    }

    return null
  }

  // ============================================================================
  // Message Extraction
  // ============================================================================

  /**
   * Reads chat messages from the WeChat window using Accessibility API
   * Extracts visible messages from the AXScrollArea (message list)
   * Validates: Requirement 3.2
   * @returns Array of ParsedMessage objects
   */
  async readChatMessages(): Promise<ParsedMessage[]> {
    const hasPermission = await this.checkPermission()
    if (!hasPermission) {
      throw new PermissionDeniedError()
    }

    const isRunning = await this.isWeChatRunning()
    if (!isRunning) {
      throw new WeChatNotFoundError()
    }

    try {
      // Use AppleScript to extract text from WeChat's message area
      // WeChat uses a scroll area (AXScrollArea) to display messages
      const script = `
        tell application "System Events"
          tell process "${AccessibilityReader.WECHAT_APP_NAME}"
            set chatWindow to first window
            -- Get all UI elements that might contain messages
            -- WeChat typically uses groups or rows within a scroll area
            set messageTexts to {}
            
            try
              -- Try to find scroll areas which contain the message list
              set scrollAreas to scroll areas of chatWindow
              repeat with scrollArea in scrollAreas
                try
                  -- Get all text elements within the scroll area
                  set textElements to value of static texts of scrollArea
                  set messageTexts to messageTexts & textElements
                end try
                try
                  -- Also try groups which might contain message bubbles
                  set groups to groups of scrollArea
                  repeat with grp in groups
                    try
                      set grpTexts to value of static texts of grp
                      set messageTexts to messageTexts & grpTexts
                    end try
                  end repeat
                end try
              end repeat
            end try
            
            -- Also try direct static texts in the window
            try
              set directTexts to value of static texts of chatWindow
              set messageTexts to messageTexts & directTexts
            end try
            
            -- Return as newline-separated string
            set AppleScript's text item delimiters to "|||"
            return messageTexts as string
          end tell
        end tell
      `

      const result = await this.runAppleScript(script)
      return this.parseAccessibilityResult(result)
    } catch (error) {
      if (error instanceof AccessibilityError) {
        throw error
      }
      throw new AccessibilityError(`Failed to read chat messages: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Parses the raw accessibility result into ParsedMessage objects
   * @param rawResult - Raw string from AppleScript
   * @returns Array of ParsedMessage objects
   */
  private parseAccessibilityResult(rawResult: string): ParsedMessage[] {
    if (!rawResult || rawResult.trim() === '') {
      return []
    }

    const messages: ParsedMessage[] = []
    const items = rawResult.split('|||').filter((item) => item.trim().length > 0)

    // WeChat message format in accessibility tree varies
    // Common patterns:
    // - "SenderName: MessageContent"
    // - "MessageContent" (sender shown separately)
    // - "[Time] SenderName: MessageContent"

    let currentSender: string | null = null
    const now = new Date()

    for (const item of items) {
      const trimmed = item.trim()
      if (!trimmed) continue

      // Skip system UI elements
      if (this.isSystemUIElement(trimmed)) continue

      // Try to parse as "Sender: Content" format
      const colonIndex = trimmed.indexOf(':')
      if (colonIndex > 0 && colonIndex < 20) {
        // Likely a "Sender: Content" format
        const potentialSender = trimmed.substring(0, colonIndex).trim()
        const content = trimmed.substring(colonIndex + 1).trim()

        if (potentialSender && content && !this.isTimeString(potentialSender)) {
          currentSender = potentialSender
          messages.push({
            timestamp: now,
            sender: currentSender,
            content: content,
            isFromUser: this.isFromUser(currentSender)
          })
          continue
        }
      }

      // If we have a current sender, treat this as a continuation message
      if (currentSender && trimmed.length > 0) {
        messages.push({
          timestamp: now,
          sender: currentSender,
          content: trimmed,
          isFromUser: this.isFromUser(currentSender)
        })
      } else if (trimmed.length > 0) {
        // Unknown sender, use placeholder
        messages.push({
          timestamp: now,
          sender: 'Unknown',
          content: trimmed,
          isFromUser: false
        })
      }
    }

    return messages
  }

  /**
   * Checks if a string is a system UI element that should be skipped
   */
  private isSystemUIElement(text: string): boolean {
    const systemPatterns = [
      /^missing value$/i,
      /^$/, // Empty
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
      /^Video$/i
    ]
    return systemPatterns.some((pattern) => pattern.test(text))
  }

  /**
   * Checks if a string looks like a time string
   */
  private isTimeString(text: string): boolean {
    // Common time formats: "10:30", "10:30:45", "上午10:30", "下午3:45"
    return /^(上午|下午)?\d{1,2}:\d{2}(:\d{2})?$/.test(text)
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

  // ============================================================================
  // Status and Utilities
  // ============================================================================

  /**
   * Gets the current status of the accessibility reader
   * @returns AccessibilityStatus object
   */
  async getStatus(): Promise<AccessibilityStatus> {
    const hasPermission = await this.checkPermission()
    const isRunning = hasPermission ? await this.isWeChatRunning() : false
    const windowInfo = isRunning ? await this.findWeChatWindow() : null
    const currentContact = windowInfo ? await this.getCurrentContactName() : null

    return {
      hasPermission,
      isAvailable: hasPermission && isRunning,
      wechatWindowFound: windowInfo !== null,
      currentContact,
      errorMessage: !hasPermission
        ? 'Accessibility permission not granted'
        : !isRunning
          ? 'WeChat is not running'
          : !windowInfo
            ? 'WeChat window not found'
            : undefined
    }
  }

  /**
   * Gets the cached WeChat window info
   * @returns Cached WeChatWindowInfo or null
   */
  getCachedWindowInfo(): WeChatWindowInfo | null {
    return this.cachedWindowInfo
  }

  /**
   * Clears the permission cache to force a fresh check
   */
  clearPermissionCache(): void {
    this.lastPermissionCheck = null
    this.lastPermissionCheckTime = 0
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Runs an AppleScript and returns the result
   * @param script - AppleScript code to execute
   * @returns Script output as string
   */
  private async runAppleScript(script: string): Promise<string> {
    if (!AccessibilityReader.IS_MACOS) {
      throw new AccessibilityError(
        'Legacy AccessibilityReader is macOS-only. Please use Visual Monitor API realtime flow on Windows.'
      )
    }
    try {
      const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`)
      return stdout
    } catch (error) {
      if (error instanceof Error && 'stderr' in error) {
        const stderr = (error as { stderr: string }).stderr
        if (stderr.includes('not allowed assistive access') || stderr.includes('accessibility')) {
          throw new PermissionDeniedError()
        }
      }
      throw error
    }
  }
}
