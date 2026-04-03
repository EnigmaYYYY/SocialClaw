import { describe, expect, it } from 'vitest'
import { clampRoiRect, isRoiRectValid, normalizeRoiRect } from './roi-overlay-utils'

describe('roi overlay utils', () => {
  it('normalizes drag points into positive roi rectangle', () => {
    const roi = normalizeRoiRect({ x: 360, y: 420 }, { x: 120, y: 100 })
    expect(roi).toEqual({ x: 120, y: 100, w: 240, h: 320 })
  })

  it('clamps roi rectangle inside target bounds', () => {
    const roi = clampRoiRect({ x: -20, y: 40, w: 9000, h: 9000 }, 1920, 1080)
    expect(roi.x).toBe(0)
    expect(roi.y).toBe(40)
    expect(roi.w).toBe(1920)
    expect(roi.h).toBe(1040)
  })

  it('validates integer and positive roi contracts', () => {
    expect(isRoiRectValid({ x: 0, y: 0, w: 1, h: 1 })).toBe(true)
    expect(isRoiRectValid({ x: 0, y: 0, w: 0, h: 1 })).toBe(false)
    expect(isRoiRectValid({ x: -1, y: 0, w: 1, h: 1 })).toBe(false)
  })
})
