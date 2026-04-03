export interface RoiRect {
  x: number
  y: number
  w: number
  h: number
}

export interface Point2D {
  x: number
  y: number
}

export function normalizeRoiRect(start: Point2D, end: Point2D): RoiRect {
  const x = Math.min(start.x, end.x)
  const y = Math.min(start.y, end.y)
  const w = Math.abs(end.x - start.x)
  const h = Math.abs(end.y - start.y)
  return { x, y, w, h }
}

export function clampRoiRect(rect: RoiRect, maxWidth: number, maxHeight: number): RoiRect {
  const x = Math.max(0, Math.min(rect.x, Math.max(maxWidth - 1, 0)))
  const y = Math.max(0, Math.min(rect.y, Math.max(maxHeight - 1, 0)))
  const maxW = Math.max(maxWidth - x, 1)
  const maxH = Math.max(maxHeight - y, 1)
  const w = Math.max(1, Math.min(rect.w, maxW))
  const h = Math.max(1, Math.min(rect.h, maxH))
  return { x, y, w, h }
}

export function isRoiRectValid(rect: RoiRect): boolean {
  return Number.isInteger(rect.x) &&
    Number.isInteger(rect.y) &&
    Number.isInteger(rect.w) &&
    Number.isInteger(rect.h) &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.w > 0 &&
    rect.h > 0
}
