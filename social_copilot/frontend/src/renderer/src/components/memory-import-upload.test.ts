import { describe, expect, it } from 'vitest'

import { resolveImportPathFromFiles } from './memory-import-upload'

describe('memory import upload helpers', () => {
  it('returns the selected file path when exactly one file is chosen', () => {
    expect(
      resolveImportPathFromFiles([
        {
          path: '/Users/enigma/Downloads/wechat-chat.csv',
          name: 'wechat-chat.csv'
        }
      ])
    ).toBe('/Users/enigma/Downloads/wechat-chat.csv')
  })

  it('returns the selected folder path when multiple files come from the same directory', () => {
    expect(
      resolveImportPathFromFiles([
        {
          path: '/Users/enigma/Downloads/chat-export/Alice/chat-1.csv',
          name: 'chat-1.csv'
        },
        {
          path: '/Users/enigma/Downloads/chat-export/Alice/chat-2.csv',
          name: 'chat-2.csv'
        }
      ])
    ).toBe('/Users/enigma/Downloads/chat-export/Alice')
  })

  it('returns null when no usable file paths exist', () => {
    expect(resolveImportPathFromFiles([])).toBeNull()
    expect(
      resolveImportPathFromFiles([
        {
          path: '',
          name: 'missing.csv'
        }
      ])
    ).toBeNull()
  })
})
