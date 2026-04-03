export interface RectWH {
  x: number
  y: number
  w: number
  h: number
}

export interface BoundsWH {
  x: number
  y: number
  width: number
  height: number
}

export interface Point2D {
  x: number
  y: number
}

export type DipToScreenPointMapper = (point: Point2D) => Point2D
export interface DipToScreenPointSource {
  dipToScreenPoint?: ((point: Point2D) => Point2D) | undefined
}

function normalizeRect(rect: RectWH): RectWH {
  const x = Math.round(rect.x)
  const y = Math.round(rect.y)
  const w = Math.max(0, Math.round(rect.w))
  const h = Math.max(0, Math.round(rect.h))
  return { x, y, w, h }
}

export function createDipToScreenPointMapper(
  source?: DipToScreenPointSource | null
): DipToScreenPointMapper | undefined {
  if (!source || typeof source.dipToScreenPoint !== 'function') {
    return undefined
  }
  return source.dipToScreenPoint.bind(source)
}

export function dipRectToScreenRect(rect: RectWH, mapper?: DipToScreenPointMapper): RectWH {
  const normalized = normalizeRect(rect)
  if (!mapper) {
    return normalized
  }
  const leftTop = mapper({ x: normalized.x, y: normalized.y })
  const rightBottom = mapper({
    x: normalized.x + normalized.w,
    y: normalized.y + normalized.h
  })
  const x = Math.min(leftTop.x, rightBottom.x)
  const y = Math.min(leftTop.y, rightBottom.y)
  const w = Math.max(0, Math.abs(rightBottom.x - leftTop.x))
  const h = Math.max(0, Math.abs(rightBottom.y - leftTop.y))
  return normalizeRect({ x, y, w, h })
}

export function dipBoundsToScreenRect(bounds: BoundsWH, mapper?: DipToScreenPointMapper): RectWH {
  return dipRectToScreenRect(
    {
      x: bounds.x,
      y: bounds.y,
      w: bounds.width,
      h: bounds.height
    },
    mapper
  )
}
