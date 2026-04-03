import { describe, expect, it } from 'vitest'
import {
  collapseAssistantBoundsFromExpanded,
  clampToWorkArea,
  createAssistantWindowProfile,
  expandAssistantBoundsFromCollapsed,
  isAssistantWindowExpandedBounds,
  createMainWindowProfile,
  getDefaultAssistantPosition
} from './window-profiles'

describe('window profiles', () => {
  it('builds a rectangular main console window profile', () => {
    const main = createMainWindowProfile()

    expect(main.frame).toBe(true)
    expect(main.alwaysOnTop).toBe(false)
    expect(main.transparent).toBe(false)
    expect(main.width).toBeGreaterThanOrEqual(1000)
    expect(main.height).toBeGreaterThanOrEqual(700)
  })

  it('builds a floating profile that can render bubble and chat popover', () => {
    const assistant = createAssistantWindowProfile('collapsed')

    expect(assistant.frame).toBe(false)
    expect(assistant.alwaysOnTop).toBe(true)
    expect(assistant.transparent).toBe(true)
    expect(assistant.skipTaskbar).toBe(true)
    expect(assistant.width).toBe(80)
    expect(assistant.height).toBe(80)
  })

  it('computes a right-side default assistant position within work area', () => {
    const workArea = { width: 1440, height: 900 }
    const position = getDefaultAssistantPosition(workArea, 'collapsed')

    expect(position.x).toBeGreaterThan(1300)
    expect(position.y).toBeGreaterThanOrEqual(0)
    expect(position.y).toBeLessThan(900)
  })

  it('clamps assistant position into visible bounds', () => {
    const clamped = clampToWorkArea(
      { x: 3000, y: -100 },
      { width: 80, height: 80 },
      { width: 1440, height: 900 }
    )

    expect(clamped.x).toBe(1360)
    expect(clamped.y).toBe(0)
  })

  it('anchors expanded bounds so orb stays in place', () => {
    const expanded = expandAssistantBoundsFromCollapsed({
      x: 1380,
      y: 420,
      width: 80,
      height: 80
    })
    expect(expanded).toEqual({
      x: 1152,
      y: 160,
      width: 308,
      height: 340
    })

    const collapsed = collapseAssistantBoundsFromExpanded(expanded)
    expect(collapsed).toEqual({
      x: 1380,
      y: 420,
      width: 80,
      height: 80
    })
  })

  it('detects expanded state from current window bounds', () => {
    expect(isAssistantWindowExpandedBounds({ width: 80, height: 80 })).toBe(false)
    expect(isAssistantWindowExpandedBounds({ width: 308, height: 340 })).toBe(true)
  })
})
