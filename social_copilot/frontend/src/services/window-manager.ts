/**
 * WindowManagerService - Manages floating window position and behavior
 *
 * Handles:
 * - Window position persistence (Property 7)
 * - Lazy Follow with debounce (Property 8)
 * - Fixed position mode (Property 9)
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7
 */

import { WindowPosition } from '../models/schemas'

// ============================================================================
// Types
// ============================================================================

export interface Rectangle {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowManagerConfig {
  debounceMs: number
  transitionDurationMs: number
}

export const DEFAULT_WINDOW_MANAGER_CONFIG: WindowManagerConfig = {
  debounceMs: 150,
  transitionDurationMs: 200
}

// ============================================================================
// Position State Management (Pure Functions for Testing)
// ============================================================================

/**
 * Represents the state of the window position manager
 */
export interface WindowPositionState {
  currentPosition: WindowPosition | null
  savedPosition: WindowPosition | null
  isMinimized: boolean
  lazyFollowEnabled: boolean
  pendingPosition: WindowPosition | null
  lastMoveTime: number
}

export const createInitialState = (savedPosition: WindowPosition | null = null): WindowPositionState => ({
  currentPosition: savedPosition,
  savedPosition,
  isMinimized: false,
  lazyFollowEnabled: true,
  pendingPosition: null,
  lastMoveTime: 0
})

/**
 * Updates the saved position in state
 * Validates: Requirements 2.3
 */
export function savePosition(
  state: WindowPositionState,
  position: WindowPosition
): WindowPositionState {
  return {
    ...state,
    savedPosition: { ...position },
    currentPosition: { ...position }
  }
}

/**
 * Restores position from saved state
 * Validates: Requirements 2.3
 */
export function restorePosition(state: WindowPositionState): WindowPositionState {
  if (!state.savedPosition) {
    return state
  }
  return {
    ...state,
    currentPosition: { ...state.savedPosition }
  }
}

/**
 * Checks if two positions are equal
 */
export function positionsEqual(a: WindowPosition | null, b: WindowPosition | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a.x === b.x && a.y === b.y
}

// ============================================================================
// Lazy Follow Logic (Pure Functions for Testing)
// ============================================================================

export interface LazyFollowState {
  pendingPosition: WindowPosition | null
  lastMoveTime: number
  debounceMs: number
}

export const createLazyFollowState = (debounceMs: number = 150): LazyFollowState => ({
  pendingPosition: null,
  lastMoveTime: 0,
  debounceMs
})

/**
 * Records a new target position for lazy follow
 * Returns the updated state with the pending position
 */
export function recordMoveEvent(
  state: LazyFollowState,
  targetPosition: WindowPosition,
  currentTime: number
): LazyFollowState {
  return {
    ...state,
    pendingPosition: { ...targetPosition },
    lastMoveTime: currentTime
  }
}

/**
 * Checks if debounce period has elapsed and returns the position to apply
 * Returns null if still within debounce period
 * Validates: Requirements 2.6
 */
export function checkDebounceElapsed(
  state: LazyFollowState,
  currentTime: number
): { shouldApply: boolean; position: WindowPosition | null } {
  if (!state.pendingPosition) {
    return { shouldApply: false, position: null }
  }

  const elapsed = currentTime - state.lastMoveTime
  if (elapsed >= state.debounceMs) {
    return { shouldApply: true, position: state.pendingPosition }
  }

  return { shouldApply: false, position: null }
}

/**
 * Clears the pending position after it has been applied
 */
export function clearPendingPosition(state: LazyFollowState): LazyFollowState {
  return {
    ...state,
    pendingPosition: null
  }
}

/**
 * Counts how many position updates should occur given a sequence of move events
 * within a time window. Used for Property 8 testing.
 * 
 * @param moveEvents Array of {position, time} events
 * @param debounceMs Debounce period in milliseconds
 * @param checkTime Time at which to check for final update
 * @returns Number of position updates that should occur
 */
export function countPositionUpdates(
  moveEvents: Array<{ position: WindowPosition; time: number }>,
  debounceMs: number,
  checkTime: number
): number {
  if (moveEvents.length === 0) return 0

  let updates = 0
  let state = createLazyFollowState(debounceMs)

  // Process each move event
  for (const event of moveEvents) {
    // Before recording new event, check if previous pending position should be applied
    const check = checkDebounceElapsed(state, event.time)
    if (check.shouldApply) {
      updates++
      state = clearPendingPosition(state)
    }
    // Record the new move event
    state = recordMoveEvent(state, event.position, event.time)
  }

  // Final check at checkTime
  const finalCheck = checkDebounceElapsed(state, checkTime)
  if (finalCheck.shouldApply) {
    updates++
  }

  return updates
}

// ============================================================================
// Fixed Position Mode Logic (Pure Functions for Testing)
// ============================================================================

export interface FixedPositionState {
  fixedPosition: WindowPosition | null
  isFixedMode: boolean
}

export const createFixedPositionState = (): FixedPositionState => ({
  fixedPosition: null,
  isFixedMode: false
})

/**
 * Enables fixed position mode with the current position
 * Validates: Requirements 2.7
 */
export function enableFixedMode(
  _state: FixedPositionState,
  currentPosition: WindowPosition
): FixedPositionState {
  return {
    fixedPosition: { ...currentPosition },
    isFixedMode: true
  }
}

/**
 * Disables fixed position mode
 */
export function disableFixedMode(state: FixedPositionState): FixedPositionState {
  return {
    ...state,
    isFixedMode: false
  }
}

/**
 * Determines the window position based on fixed mode state
 * When fixed mode is enabled, returns the fixed position regardless of target
 * Validates: Requirements 2.7
 */
export function resolvePosition(
  state: FixedPositionState,
  targetPosition: WindowPosition
): WindowPosition {
  if (state.isFixedMode && state.fixedPosition) {
    return { ...state.fixedPosition }
  }
  return { ...targetPosition }
}

/**
 * Checks if position should change given a target position
 * In fixed mode, position should never change from external targets
 */
export function shouldPositionChange(state: FixedPositionState): boolean {
  return !state.isFixedMode
}

// ============================================================================
// Window Manager Service Class
// ============================================================================

/**
 * WindowManagerService - Coordinates window position management
 * 
 * This class integrates the pure functions above with actual window operations.
 * For Electron integration, this would wrap BrowserWindow operations.
 */
export class WindowManagerService {
  private positionState: WindowPositionState
  private lazyFollowState: LazyFollowState
  private fixedPositionState: FixedPositionState
  private config: WindowManagerConfig
  private debounceTimer: ReturnType<typeof setTimeout> | null = null

  // Callbacks for actual window operations (to be set by Electron main process)
  private onPositionChange?: (position: WindowPosition, animate: boolean) => void
  private onMinimize?: () => void
  private onRestore?: () => void

  constructor(
    config: WindowManagerConfig = DEFAULT_WINDOW_MANAGER_CONFIG,
    savedPosition: WindowPosition | null = null
  ) {
    this.config = config
    this.positionState = createInitialState(savedPosition)
    this.lazyFollowState = createLazyFollowState(config.debounceMs)
    this.fixedPositionState = createFixedPositionState()
  }

  /**
   * Sets callbacks for window operations
   */
  setCallbacks(callbacks: {
    onPositionChange?: (position: WindowPosition, animate: boolean) => void
    onMinimize?: () => void
    onRestore?: () => void
  }): void {
    this.onPositionChange = callbacks.onPositionChange
    this.onMinimize = callbacks.onMinimize
    this.onRestore = callbacks.onRestore
  }

  /**
   * Gets the current window position
   */
  getCurrentPosition(): WindowPosition | null {
    return this.positionState.currentPosition
  }

  /**
   * Gets the saved window position
   */
  getSavedPosition(): WindowPosition | null {
    return this.positionState.savedPosition
  }

  /**
   * Saves the current position for persistence
   * Validates: Requirements 2.3
   */
  saveWindowPosition(position: WindowPosition): void {
    this.positionState = savePosition(this.positionState, position)
  }

  /**
   * Restores the window to saved position
   * Validates: Requirements 2.3
   */
  restoreWindowPosition(): WindowPosition | null {
    this.positionState = restorePosition(this.positionState)
    if (this.positionState.currentPosition && this.onPositionChange) {
      this.onPositionChange(this.positionState.currentPosition, false)
    }
    return this.positionState.currentPosition
  }

  /**
   * Sets the window position directly (without lazy follow)
   */
  setPosition(position: WindowPosition, animate: boolean = false): void {
    this.positionState = {
      ...this.positionState,
      currentPosition: { ...position }
    }
    if (this.onPositionChange) {
      this.onPositionChange(position, animate)
    }
  }

  /**
   * Handles WeChat window move event with lazy follow
   * Validates: Requirements 2.6
   */
  handleTargetWindowMove(targetPosition: WindowPosition): void {
    // In fixed mode, ignore target window movements
    if (!shouldPositionChange(this.fixedPositionState)) {
      return
    }

    const currentTime = Date.now()
    this.lazyFollowState = recordMoveEvent(this.lazyFollowState, targetPosition, currentTime)

    // Clear existing debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    // Set new debounce timer
    this.debounceTimer = setTimeout(() => {
      const check = checkDebounceElapsed(this.lazyFollowState, Date.now())
      if (check.shouldApply && check.position) {
        this.setPosition(check.position, true) // Animate the transition
        this.lazyFollowState = clearPendingPosition(this.lazyFollowState)
      }
    }, this.config.debounceMs)
  }

  /**
   * Enables or disables lazy follow mode
   */
  setLazyFollow(enabled: boolean): void {
    this.positionState = {
      ...this.positionState,
      lazyFollowEnabled: enabled
    }
    
    if (!enabled) {
      // Enable fixed mode with current position
      if (this.positionState.currentPosition) {
        this.fixedPositionState = enableFixedMode(
          this.fixedPositionState,
          this.positionState.currentPosition
        )
      }
    } else {
      // Disable fixed mode
      this.fixedPositionState = disableFixedMode(this.fixedPositionState)
    }
  }

  /**
   * Checks if lazy follow is enabled
   */
  isLazyFollowEnabled(): boolean {
    return this.positionState.lazyFollowEnabled
  }

  /**
   * Checks if fixed position mode is active
   */
  isFixedMode(): boolean {
    return this.fixedPositionState.isFixedMode
  }

  /**
   * Gets the fixed position (if in fixed mode)
   */
  getFixedPosition(): WindowPosition | null {
    return this.fixedPositionState.fixedPosition
  }

  /**
   * Minimizes the window to icon
   * Validates: Requirements 2.4
   */
  minimizeToIcon(): void {
    this.positionState = {
      ...this.positionState,
      isMinimized: true
    }
    if (this.onMinimize) {
      this.onMinimize()
    }
  }

  /**
   * Restores the window from icon
   * Validates: Requirements 2.5
   */
  restoreFromIcon(): void {
    this.positionState = {
      ...this.positionState,
      isMinimized: false
    }
    if (this.onRestore) {
      this.onRestore()
    }
  }

  /**
   * Checks if window is minimized
   */
  isMinimized(): boolean {
    return this.positionState.isMinimized
  }

  /**
   * Cleans up resources
   */
  destroy(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }
}
