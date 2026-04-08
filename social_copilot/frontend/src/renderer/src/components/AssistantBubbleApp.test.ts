import { describe, expect, it } from 'vitest'

import {
  resolveAssistantActivationIntent,
  shouldShowFolioStage
} from './AssistantBubbleApp'

describe('AssistantBubbleApp folio visibility helpers', () => {
  it('opens folio when the bubble is manually activated without suggestions', () => {
    expect(resolveAssistantActivationIntent(false, 'pet', false)).toBe('open_folio')
  })

  it('does not show folio for auto surfaces during empty monitoring', () => {
    expect(shouldShowFolioStage(true, 'auto', false, false, false)).toBe(false)
  })

  it('shows folio only when the user explicitly switched to folio mode', () => {
    expect(shouldShowFolioStage(true, 'folio', false, false, false)).toBe(true)
  })
})
