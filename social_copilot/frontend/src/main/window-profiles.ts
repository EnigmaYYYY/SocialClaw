export interface WindowProfile {
  width: number
  height: number
  minWidth?: number
  minHeight?: number
  frame: boolean
  alwaysOnTop: boolean
  transparent: boolean
  skipTaskbar: boolean
  resizable: boolean
  titleBarStyle?: 'default' | 'hidden' | 'hiddenInset' | 'customButtonsOnHover'
}

export type AssistantWindowMode = 'collapsed' | 'expanded'

export interface Bounds2D {
  width: number
  height: number
}

export interface Point2D {
  x: number
  y: number
}

const MAIN_WINDOW_DEFAULTS = {
  width: 1040,
  height: 760,
  minWidth: 920,
  minHeight: 620
} as const

const ASSISTANT_WINDOW_DEFAULTS = {
  collapsedSize: 80,
  expandedWidth: 344,
  expandedHeight: 388,
  margin: 16
} as const

export function createMainWindowProfile(): WindowProfile {
  return {
    width: MAIN_WINDOW_DEFAULTS.width,
    height: MAIN_WINDOW_DEFAULTS.height,
    minWidth: MAIN_WINDOW_DEFAULTS.minWidth,
    minHeight: MAIN_WINDOW_DEFAULTS.minHeight,
    frame: true,
    alwaysOnTop: false,
    transparent: false,
    skipTaskbar: false,
    resizable: true,
    titleBarStyle: 'default'
  }
}

export function createAssistantWindowProfile(mode: AssistantWindowMode = 'collapsed'): WindowProfile {
  const width =
    mode === 'collapsed' ? ASSISTANT_WINDOW_DEFAULTS.collapsedSize : ASSISTANT_WINDOW_DEFAULTS.expandedWidth
  const height =
    mode === 'collapsed' ? ASSISTANT_WINDOW_DEFAULTS.collapsedSize : ASSISTANT_WINDOW_DEFAULTS.expandedHeight

  return {
    width,
    height,
    frame: false,
    alwaysOnTop: true,
    transparent: true,
    skipTaskbar: true,
    resizable: false,
    titleBarStyle: 'hidden'
  }
}

export function getDefaultAssistantPosition(
  workArea: Bounds2D,
  mode: AssistantWindowMode = 'collapsed'
): Point2D {
  const profile = createAssistantWindowProfile(mode)
  const x = workArea.width - profile.width - ASSISTANT_WINDOW_DEFAULTS.margin
  const y = Math.max(
    ASSISTANT_WINDOW_DEFAULTS.margin,
    Math.floor((workArea.height - profile.height) / 2)
  )
  return { x, y }
}

export function expandAssistantBoundsFromCollapsed(bounds: {
  x: number
  y: number
  width: number
  height: number
}): {
  x: number
  y: number
  width: number
  height: number
} {
  const expanded = createAssistantWindowProfile('expanded')
  return {
    x: bounds.x + bounds.width - expanded.width,
    y: bounds.y + bounds.height - expanded.height,
    width: expanded.width,
    height: expanded.height
  }
}

export function collapseAssistantBoundsFromExpanded(bounds: {
  x: number
  y: number
  width: number
  height: number
}): {
  x: number
  y: number
  width: number
  height: number
} {
  const collapsed = createAssistantWindowProfile('collapsed')
  return {
    x: bounds.x + (bounds.width - collapsed.width),
    y: bounds.y + (bounds.height - collapsed.height),
    width: collapsed.width,
    height: collapsed.height
  }
}

export function isAssistantWindowExpandedBounds(bounds: {
  width: number
  height: number
}): boolean {
  const collapsed = createAssistantWindowProfile('collapsed')
  return bounds.width > collapsed.width || bounds.height > collapsed.height
}

export function clampToWorkArea(position: Point2D, windowSize: Bounds2D, workArea: Bounds2D): Point2D {
  const maxX = Math.max(workArea.width - windowSize.width, 0)
  const maxY = Math.max(workArea.height - windowSize.height, 0)
  return {
    x: Math.min(Math.max(position.x, 0), maxX),
    y: Math.min(Math.max(position.y, 0), maxY)
  }
}
