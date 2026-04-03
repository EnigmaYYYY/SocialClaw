import { readFile } from 'fs/promises'
import {
  ParsedMessage,
  serializeParsedMessages,
  deserializeParsedMessages
} from '../models'

/**
 * TextMessage - Intermediate type for text-based chat log parsing
 * Used internally by ChatParser for text format round-trips
 */
export interface TextMessage {
  timestamp?: string
  sender: string
  content: string
}

/**
 * ChatParser - Parses WeChat export format chat logs
 *
 * WeChat export format examples:
 * - "2024-01-15 10:30:45 张三: 你好"
 * - "2024-01-15 10:31:00 李四: 你好，最近怎么样？"
 * - "张三: 简单消息" (without timestamp)
 */
export class ChatParser {
  // WeChat format: "YYYY-MM-DD HH:MM:SS sender:content"
  // Note: We use `:` without consuming trailing whitespace to preserve content exactly
  private static readonly WECHAT_FORMAT_WITH_TIMESTAMP =
    /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(.+?):(.*)$/

  // Simple format: "sender:content"
  private static readonly SIMPLE_FORMAT = /^(.+?):(.*)$/

  /**
   * Validates that input is not empty or whitespace-only
   * @throws Error if input is empty or whitespace-only
   */
  static validateInput(text: string): void {
    if (!text || text.trim().length === 0) {
      throw new Error('Input cannot be empty or whitespace-only')
    }
  }

  /**
   * Checks if a string is empty or contains only whitespace
   */
  static isWhitespaceOnly(text: string): boolean {
    return !text || text.trim().length === 0
  }

  /**
   * Parses raw text into an array of TextMessage objects
   * @param rawText - The raw chat log text
   * @returns Array of TextMessage objects (intermediate format)
   * @throws Error if input is empty or whitespace-only
   */
  static parseText(rawText: string): TextMessage[] {
    ChatParser.validateInput(rawText)

    const lines = rawText.split('\n')
    const messages: TextMessage[] = []

    for (const line of lines) {
      // Skip empty lines but preserve content whitespace
      if (!line.trim()) continue

      // Only trim leading whitespace to preserve content trailing spaces
      const processedLine = line.trimStart()
      const message = ChatParser.parseLine(processedLine)
      if (message) {
        messages.push(message)
      }
    }

    return messages
  }


  /**
   * Parses a single line of chat log
   * @param line - A single line from the chat log
   * @returns TextMessage or null if line cannot be parsed
   */
  private static parseLine(line: string): TextMessage | null {
    // Try WeChat format with timestamp first
    const wechatMatch = line.match(ChatParser.WECHAT_FORMAT_WITH_TIMESTAMP)
    if (wechatMatch) {
      return {
        timestamp: wechatMatch[1],
        sender: wechatMatch[2].trim(),
        content: wechatMatch[3]
      }
    }

    // Try simple format without timestamp
    const simpleMatch = line.match(ChatParser.SIMPLE_FORMAT)
    if (simpleMatch) {
      return {
        sender: simpleMatch[1].trim(),
        content: simpleMatch[2]
      }
    }

    // Cannot parse line - skip it
    return null
  }

  /**
   * Parses a chat log file
   * @param filePath - Path to the .txt file
   * @returns Array of TextMessage objects
   * @throws Error if file cannot be read or content is empty/whitespace-only
   */
  static async parseFile(filePath: string): Promise<TextMessage[]> {
    const content = await readFile(filePath, 'utf-8')
    return ChatParser.parseText(content)
  }

  /**
   * Serializes an array of ParsedMessage objects to JSON string
   * @param messages - Array of ParsedMessage objects
   * @returns JSON string representation
   */
  static serialize(messages: ParsedMessage[]): string {
    return serializeParsedMessages(messages)
  }

  /**
   * Deserializes a JSON string to an array of ParsedMessage objects
   * @param json - JSON string representation
   * @returns Array of ParsedMessage objects
   * @throws Error if JSON is invalid or doesn't match schema
   */
  static deserialize(json: string): ParsedMessage[] {
    return deserializeParsedMessages(json)
  }

  /**
   * Formats a TextMessage back to text format
   * Used for round-trip testing
   * @param message - TextMessage object
   * @returns Formatted string representation
   */
  static formatMessage(message: TextMessage): string {
    if (message.timestamp) {
      return `${message.timestamp} ${message.sender}:${message.content}`
    }
    return `${message.sender}:${message.content}`
  }

  /**
   * Formats an array of TextMessage objects back to text format
   * @param messages - Array of TextMessage objects
   * @returns Formatted text with each message on a new line
   */
  static formatMessages(messages: TextMessage[]): string {
    return messages.map((m) => ChatParser.formatMessage(m)).join('\n')
  }

  /**
   * Converts TextMessage array to ParsedMessage array
   * @param messages - Array of TextMessage objects
   * @param selfSender - The sender name to identify as user (for isFromUser)
   * @returns Array of ParsedMessage objects
   */
  static toFullMessages(messages: TextMessage[], selfSender: string = 'self'): ParsedMessage[] {
    return messages.map(m => ({
      timestamp: m.timestamp ? new Date(m.timestamp.replace(' ', 'T')) : new Date(),
      sender: m.sender,
      content: m.content,
      isFromUser: m.sender === selfSender
    }))
  }
}
