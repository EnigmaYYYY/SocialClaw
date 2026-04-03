import { describe, expect, it } from 'vitest'

import {
  resolveAssistantExpandedFlag,
  resolveAssistantActivationIntent,
  resolveSurfacePreferenceForAssistantActivation,
  shouldShowSuggestionCardShortcut
} from './AssistantBubbleApp'

describe('AssistantBubbleApp helpers', () => {
  it('prefers suggestion card when assistant is re-opened with active suggestions', () => {
    expect(resolveSurfacePreferenceForAssistantActivation(true)).toBe('auto')
    expect(resolveSurfacePreferenceForAssistantActivation(false)).toBe('folio')
  })

  it('shows a shortcut back to suggestion card only when suggestions exist', () => {
    expect(shouldShowSuggestionCardShortcut(true)).toBe(true)
    expect(shouldShowSuggestionCardShortcut(false)).toBe(false)
  })

  it('collapses when the floating assistant is clicked while a surface is already open', () => {
    expect(resolveAssistantActivationIntent(true, 'whispers', true)).toBe('collapse')
    expect(resolveAssistantActivationIntent(true, 'folio', true)).toBe('collapse')
  })

  it('opens the right surface when currently collapsed', () => {
    expect(resolveAssistantActivationIntent(false, 'pet', true)).toBe('open_suggestion')
    expect(resolveAssistantActivationIntent(false, 'pet', false)).toBe('open_folio')
  })

  it('prefers live window bounds over stale expanded state when deciding activation', () => {
    expect(
      resolveAssistantExpandedFlag(
        {
          x: 0,
          y: 0,
          width: 80,
          height: 80
        },
        true
      )
    ).toBe(false)
    expect(
      resolveAssistantActivationIntent(
        resolveAssistantExpandedFlag(
          {
            x: 0,
            y: 0,
            width: 80,
            height: 80
          },
          true
        ),
        'whispers',
        true
      )
    ).toBe('open_suggestion')
  })
})
