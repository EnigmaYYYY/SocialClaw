import { describe, expect, it } from 'vitest'
import { createDipToScreenPointMapper, dipBoundsToScreenRect, dipRectToScreenRect } from './coordinate-utils'

describe('coordinate utils', () => {
  it('keeps rectangle unchanged without mapper', () => {
    const rect = dipRectToScreenRect({ x: 10.2, y: 20.8, w: 30.1, h: 40.9 })
    expect(rect).toEqual({ x: 10, y: 21, w: 30, h: 41 })
  })

  it('maps dip rectangle to screen coordinates via mapper', () => {
    const rect = dipRectToScreenRect(
      { x: 100, y: 200, w: 60, h: 40 },
      ({ x, y }) => ({ x: x * 2, y: y * 2 })
    )
    expect(rect).toEqual({ x: 200, y: 400, w: 120, h: 80 })
  })

  it('maps assistant bounds to screen rect', () => {
    const rect = dipBoundsToScreenRect(
      { x: 300, y: 100, width: 286, height: 470 },
      ({ x, y }) => ({ x: x * 2, y: y * 2 })
    )
    expect(rect).toEqual({ x: 600, y: 200, w: 572, h: 940 })
  })

  it('returns undefined when electron screen mapper is unavailable', () => {
    expect(createDipToScreenPointMapper({})).toBeUndefined()
  })

  it('creates a bound mapper when electron screen mapper exists', () => {
    const mapper = createDipToScreenPointMapper({
      dipToScreenPoint: ({ x, y }) => ({ x: x * 2, y: y * 2 })
    })
    expect(mapper?.({ x: 20, y: 30 })).toEqual({ x: 40, y: 60 })
  })
})
