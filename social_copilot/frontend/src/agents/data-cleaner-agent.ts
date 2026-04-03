/**
 * Data Cleaner Agent
 *
 * Responsible for cleaning raw message data:
 * - Merging consecutive messages from the same sender within a time window
 * - Filtering noise content (XML tags, system notifications, etc.)
 * - Handling various message types
 *
 * References:
 * - WeClone/weclone/data/strategies.py (TimeWindowStrategy)
 * - WeClone/weclone/data/models.py (skip_type_list, cut_type_list)
 * - WeClone/weclone/data/qa_generator.py (group_consecutive_messages)
 *
 * _Requirements: 1.3, 1.4_
 */

import { RawMessage, MessageBlock, MSG_TYPE } from '../models/schemas'

// ============================================================================
// Constants - Noise Filtering Patterns (reference: WeClone skip_type_list)
// ============================================================================

/**
 * Regex patterns for noise content that should be removed from message content
 * Reference: Design document SKIP_PATTERNS
 */
export const NOISE_PATTERNS: RegExp[] = [
  /<xml>[\s\S]*?<\/xml>/gi, // XML tags
  /<msg>[\s\S]*?<\/msg>/gi, // MSG tags
  /\[表情\]/g, // Emoji placeholder
  /\[动画表情\]/g, // Animated emoji placeholder
  /拍了拍/g, // Pat pat
  /发出红包/g, // Red packet sent
  /收到红包/g, // Red packet received
  /领取了.*红包/g, // Red packet claimed
  /消息已撤回/g, // Message recalled
  /撤回了一条消息/g, // Recalled a message
  /邀请.*加入了群聊/g, // Group invite notification
  /移出了群聊/g, // Removed from group
  /修改群名为/g, // Group name changed
  /你已添加了.*现在可以开始聊天了/g, // Friend added notification
  /以上是打招呼的内容/g, // Greeting content marker
  /\[位置\]/g, // Location placeholder
  /\[文件\]/g, // File placeholder
  /\[语音通话\]/g, // Voice call placeholder
  /\[视频通话\]/g, // Video call placeholder
  /\[转账\]/g, // Transfer placeholder
  /\[收藏\]/g, // Favorites placeholder
  /<!\[CDATA\[[\s\S]*?\]\]>/gi // CDATA sections
]

/**
 * Message types that should be skipped entirely
 * Reference: WeClone skip_type_list
 */
export const SKIP_MESSAGE_TYPES: string[] = [
  '添加好友',
  '推荐公众号',
  '动画表情',
  '位置',
  '文件',
  '位置共享',
  '引用回复',
  '群公告',
  '转账',
  '语音通话',
  '视频通话',
  '系统通知',
  '消息撤回',
  '拍一拍',
  '邀请加群'
]

/**
 * Message types that should be cut/truncated (content replaced with placeholder)
 * Reference: WeClone cut_type_list
 */
export const CUT_MESSAGE_TYPES: string[] = [
  '图片',
  '视频',
  '合并转发的聊天记录',
  '语音',
  '(分享)音乐',
  '(分享)卡片式链接',
  '(分享)笔记',
  '(分享)小程序',
  '(分享)收藏夹',
  '(分享)视频号名片',
  '(分享)视频号视频'
]

/**
 * System message content patterns that indicate the message should be skipped
 */
export const SYSTEM_MESSAGE_PATTERNS: RegExp[] = [
  /^<msg>.*<\/msg>$/s, // Pure XML message
  /^<xml>.*<\/xml>$/s, // Pure XML message
  /你已添加了.*现在可以开始聊天了/, // Friend added
  /以上是打招呼的内容/, // Greeting marker
  /^拍了拍/, // Pat pat at start
  /红包/, // Red packet related
  /转账/, // Transfer related
  /撤回/, // Recall related
  /邀请.*加入/, // Group invite
  /移出了群聊/, // Removed from group
  /修改群名/ // Group name change
]

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_TIME_WINDOW_SECONDS = 120 // 2 minutes

// ============================================================================
// DataCleanerAgent Class
// ============================================================================

export class DataCleanerAgent {
  private defaultTimeWindowSeconds: number

  constructor(timeWindowSeconds: number = DEFAULT_TIME_WINDOW_SECONDS) {
    this.defaultTimeWindowSeconds = timeWindowSeconds
  }

  /**
   * Merge consecutive messages from the same sender within the time window
   * into MessageBlock objects.
   *
   * Reference: WeClone group_consecutive_messages
   *
   * @param messages - Array of raw messages to merge
   * @param timeWindowMinutes - Time window in minutes (default: 2, or uses constructor value)
   * @returns Array of merged MessageBlock objects
   */
  mergeMessageBlocks(messages: RawMessage[], timeWindowMinutes?: number): MessageBlock[] {
    if (messages.length === 0) {
      return []
    }

    const timeWindowSeconds =
      timeWindowMinutes !== undefined ? timeWindowMinutes * 60 : this.defaultTimeWindowSeconds
    const blocks: MessageBlock[] = []
    let blockId = 0

    // Sort messages by createTime
    const sortedMessages = [...messages].sort((a, b) => a.createTime - b.createTime)

    // Filter out messages that should be skipped
    const filteredMessages = sortedMessages.filter((msg) => !this.shouldSkipMessage(msg.msgType, msg.content))

    if (filteredMessages.length === 0) {
      return []
    }

    let currentGroup: RawMessage[] = [filteredMessages[0]]

    for (let i = 1; i < filteredMessages.length; i++) {
      const currentMsg = filteredMessages[i]
      const lastMsg = currentGroup[currentGroup.length - 1]

      // Check if this message should be merged with the current group
      const isSameSender = this.isSameSender(lastMsg, currentMsg)
      const isWithinTimeWindow = this.isWithinTimeWindow(lastMsg, currentMsg, timeWindowSeconds)

      if (isSameSender && isWithinTimeWindow) {
        // Add to current group
        currentGroup.push(currentMsg)
      } else {
        // Finalize current group and start a new one
        const block = this.createMessageBlock(currentGroup, blockId++)
        if (block) {
          blocks.push(block)
        }
        currentGroup = [currentMsg]
      }
    }

    // Don't forget the last group
    if (currentGroup.length > 0) {
      const block = this.createMessageBlock(currentGroup, blockId)
      if (block) {
        blocks.push(block)
      }
    }

    return blocks
  }

  /**
   * Filter noise content from a message string
   *
   * @param content - The message content to filter
   * @returns Cleaned content with noise patterns removed
   */
  filterNoise(content: string): string {
    if (!content) {
      return ''
    }

    let cleaned = content

    // Apply all noise patterns
    for (const pattern of NOISE_PATTERNS) {
      cleaned = cleaned.replace(pattern, '')
    }

    // Trim whitespace and normalize multiple spaces/newlines
    cleaned = cleaned.replace(/\s+/g, ' ').trim()

    return cleaned
  }

  /**
   * Determine if a message should be skipped entirely based on type and content
   *
   * @param msgType - The message type number
   * @param content - The message content
   * @returns true if the message should be skipped
   */
  shouldSkipMessage(msgType: number, content: string): boolean {
    // Skip system messages
    if (msgType === MSG_TYPE.SYSTEM) {
      return true
    }

    // Skip VOIP messages
    if (msgType === MSG_TYPE.VOIP) {
      return true
    }

    // Check content against system message patterns
    for (const pattern of SYSTEM_MESSAGE_PATTERNS) {
      if (pattern.test(content)) {
        return true
      }
    }

    // Skip if content is empty after filtering
    const filtered = this.filterNoise(content)
    if (!filtered || filtered.trim() === '') {
      return true
    }

    return false
  }

  /**
   * Get a text representation for non-text message types
   *
   * @param msgType - The message type number
   * @param subType - Optional sub-type for APP messages
   * @returns A placeholder text for the message type
   */
  getMessageTypeText(msgType: number, subType?: number): string {
    switch (msgType) {
      case MSG_TYPE.IMAGE:
        return '[图片]'
      case MSG_TYPE.VOICE:
        return '[语音]'
      case MSG_TYPE.VIDEO:
        return '[视频]'
      case MSG_TYPE.EMOJI:
        return '[表情]'
      case MSG_TYPE.CARD:
        return '[名片]'
      case MSG_TYPE.POSITION:
        return '[位置]'
      case MSG_TYPE.APP:
        return this.getAppMessageTypeText(subType)
      case MSG_TYPE.SYSTEM:
        return '[系统消息]'
      case MSG_TYPE.VOIP:
        return '[通话]'
      default:
        return ''
    }
  }

  /**
   * Get text representation for APP message sub-types
   */
  private getAppMessageTypeText(subType?: number): string {
    if (!subType) {
      return '[链接]'
    }

    // Reference: APP_MSG_TYPE from schemas
    switch (subType) {
      case 1:
        return '' // Text - no placeholder needed
      case 3:
        return '[音乐]'
      case 5:
        return '[链接]'
      case 6:
        return '[文件]'
      case 19:
        return '[转发消息]'
      case 33:
        return '[小程序]'
      case 57:
        return '[引用]'
      case 2000:
        return '[转账]'
      case 2003:
        return '[红包]'
      default:
        return '[链接]'
    }
  }

  /**
   * Check if two messages are from the same sender
   */
  private isSameSender(msg1: RawMessage, msg2: RawMessage): boolean {
    return msg1.isSend === msg2.isSend && msg1.fromUser === msg2.fromUser
  }

  /**
   * Check if two messages are within the time window
   * Reference: WeClone TimeWindowStrategy
   */
  private isWithinTimeWindow(msg1: RawMessage, msg2: RawMessage, windowSeconds: number): boolean {
    const timeDiff = Math.abs(msg2.createTime - msg1.createTime)
    return timeDiff <= windowSeconds
  }

  /**
   * Create a MessageBlock from a group of messages
   */
  private createMessageBlock(messages: RawMessage[], id: number): MessageBlock | null {
    if (messages.length === 0) {
      return null
    }

    const firstMsg = messages[0]
    const lastMsg = messages[messages.length - 1]

    // Extract and clean content from each message
    const messageContents: string[] = []
    for (const msg of messages) {
      let content = msg.content

      // For non-text messages, use type placeholder
      if (msg.msgType !== MSG_TYPE.TEXT) {
        const typeText = this.getMessageTypeText(msg.msgType, msg.subType)
        if (typeText) {
          content = typeText
        }
      }

      // Filter noise from content
      const cleaned = this.filterNoise(content)
      if (cleaned) {
        messageContents.push(cleaned)
      }
    }

    // If no valid content after cleaning, skip this block
    if (messageContents.length === 0) {
      return null
    }

    // Combine messages with newline separator (reference: WeClone _combine_text)
    const cleanContent = messageContents.join('\n')

    return {
      id,
      sender: firstMsg.isSend ? 'self' : firstMsg.fromUser,
      isSend: firstMsg.isSend,
      messages: messageContents,
      cleanContent,
      startTime: firstMsg.createTime,
      endTime: lastMsg.createTime
    }
  }

  /**
   * Process a batch of raw messages: filter, merge, and clean
   *
   * @param messages - Array of raw messages
   * @param timeWindowMinutes - Time window for merging (default: 2)
   * @returns Array of cleaned and merged MessageBlock objects
   */
  processMessages(messages: RawMessage[], timeWindowMinutes: number = 2): MessageBlock[] {
    return this.mergeMessageBlocks(messages, timeWindowMinutes)
  }
}

// Export singleton instance
export const dataCleanerAgent = new DataCleanerAgent()
