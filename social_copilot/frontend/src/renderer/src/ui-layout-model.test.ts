import { describe, expect, it } from 'vitest'
import {
  createInitialSuggestionMessages,
  getMemoryFolderItems,
  getModeLabel
} from './ui-layout-model'

describe('ui layout model', () => {
  it('provides sidebar folders for memory management', () => {
    const folders = getMemoryFolderItems()

    expect(folders).toHaveLength(4)
    expect(folders.map((item) => item.id)).toEqual([
      'inbox',
      'today-clues',
      'long-term-memory',
      'relationship-clues'
    ])
    expect(folders.some((item) => item.name === '收件箱')).toBe(true)
    expect(folders.some((item) => item.name === '长期记忆')).toBe(true)
    expect(folders.some((item) => item.name === '关系线索')).toBe(true)
  })

  it('provides wechat-style suggestion bubbles', () => {
    const messages = createInitialSuggestionMessages()

    expect(messages.length).toBe(3)
    expect(messages.every((item) => item.content.length > 5)).toBe(true)
    expect(messages.every((item) => item.content === item.content.trim())).toBe(true)
  })

  it('maps monitor mode labels for settings panel', () => {
    expect(getModeLabel('hybrid')).toBe('Hybrid（自动优先）')
    expect(getModeLabel('manual')).toBe('Manual（手动框选）')
    expect(getModeLabel('auto')).toBe('Auto（自动识别）')
  })
})
