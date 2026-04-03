/**
 * Property-Based Tests for WindowManagerService
 *
 * Tests for:
 * - Property 7: Window Position Persistence
 * - Property 8: Lazy Follow Debounce
 * - Property 9: Fixed Position Mode
 */
import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  WindowManagerService,
  createInitialState,
  savePosition,
  restorePosition,
  positionsEqual,
  createLazyFollowState,
  recordMoveEvent,
  checkDebounceElapsed,
  clearPendingPosition,
  countPositionUpdates,
  createFixedPositionState,
  enableFixedMode,
  disableFixedMode,
  resolvePosition,
  shouldPositionChange,
  DEFAULT_WINDOW_MANAGER_CONFIG
} from '../../services/window-manager'
import { WindowPosition } from '../../models/schemas'

// ============================================================================
// Arbitrary Generators
// ============================================================================

// Generator for valid window positions
const windowPositionArbitrary: fc.Arbitrary<WindowPosition> = fc.record({
  x: fc.integer({ min: -5000, max: 5000 }),
  y: fc.integer({ min: -5000, max: 5000 })
})

// Generator for non-null window positions
const nonNullPositionArbitrary = windowPositionArbitrary

// Generator for debounce time in milliseconds
const debounceTimeArbitrary = fc.integer({ min: 50, max: 500 })

// Generator for timestamps
const timestampArbitrary = fc.integer({ min: 0, max: 1000000 })

// Generator for move events within a time window (used in Property 8 tests)
// Note: This generator is available for future use in move event sequence tests
// const moveEventArbitrary = fc.record({
//   position: windowPositionArbitrary,
//   time: fc.integer({ min: 0, max: 1000 })
// })

// ============================================================================
// Property 7: Window Position Persistence
// ============================================================================

describe('Property 7: Window Position Persistence', () => {
  /**
   * **Feature: social-copilot-v2, Property 7: Window Position Persistence**
   * **Validates: Requirements 2.3**
   *
   * *For any* window position set by the user, after saving and reloading,
   * the restored position should match the saved position.
   */
  it('should persist and restore position correctly using pure functions', () => {
    fc.assert(
      fc.property(nonNullPositionArbitrary, (position) => {
        // Create initial state
        const initialState = createInitialState(null)

        // Save position
        const savedState = savePosition(initialState, position)

        // Verify saved position matches input
        expect(savedState.savedPosition).toEqual(position)
        expect(savedState.currentPosition).toEqual(position)

        // Create new state simulating app restart (only savedPosition persisted)
        const reloadedState = createInitialState(savedState.savedPosition)

        // Restore position
        const restoredState = restorePosition(reloadedState)

        // Verify restored position matches original
        expect(restoredState.currentPosition).toEqual(position)
        expect(positionsEqual(restoredState.currentPosition, position)).toBe(true)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 7: Window Position Persistence**
   * **Validates: Requirements 2.3**
   *
   * *For any* sequence of position saves, the last saved position should be
   * the one that is restored.
   */
  it('should restore the most recently saved position', () => {
    fc.assert(
      fc.property(
        fc.array(nonNullPositionArbitrary, { minLength: 1, maxLength: 10 }),
        (positions) => {
          let state = createInitialState(null)

          // Save multiple positions
          for (const position of positions) {
            state = savePosition(state, position)
          }

          // The last position should be saved
          const lastPosition = positions[positions.length - 1]
          expect(state.savedPosition).toEqual(lastPosition)

          // Simulate reload and restore
          const reloadedState = createInitialState(state.savedPosition)
          const restoredState = restorePosition(reloadedState)

          expect(restoredState.currentPosition).toEqual(lastPosition)
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 7: Window Position Persistence**
   * **Validates: Requirements 2.3**
   *
   * *For any* valid position, the WindowManagerService should correctly
   * save and restore the position.
   */
  it('should persist position through WindowManagerService', () => {
    fc.assert(
      fc.property(nonNullPositionArbitrary, (position) => {
        // Create service
        const service = new WindowManagerService()

        // Save position
        service.saveWindowPosition(position)

        // Verify saved position
        expect(service.getSavedPosition()).toEqual(position)
        expect(service.getCurrentPosition()).toEqual(position)

        // Create new service simulating app restart
        const newService = new WindowManagerService(
          DEFAULT_WINDOW_MANAGER_CONFIG,
          service.getSavedPosition()
        )

        // Restore position
        const restoredPosition = newService.restoreWindowPosition()

        // Verify restored position matches
        expect(restoredPosition).toEqual(position)
        expect(newService.getCurrentPosition()).toEqual(position)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 7: Window Position Persistence**
   * **Validates: Requirements 2.3**
   *
   * Position equality should be reflexive, symmetric, and transitive.
   */
  it('should have correct position equality semantics', () => {
    fc.assert(
      fc.property(
        nonNullPositionArbitrary,
        nonNullPositionArbitrary,
        nonNullPositionArbitrary,
        (a, b, c) => {
          // Reflexive: a == a
          expect(positionsEqual(a, a)).toBe(true)

          // Symmetric: a == b implies b == a
          const aEqualsB = positionsEqual(a, b)
          const bEqualsA = positionsEqual(b, a)
          expect(aEqualsB).toBe(bEqualsA)

          // Transitive: a == b and b == c implies a == c
          if (positionsEqual(a, b) && positionsEqual(b, c)) {
            expect(positionsEqual(a, c)).toBe(true)
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ============================================================================
// Property 8: Lazy Follow Debounce
// ============================================================================

describe('Property 8: Lazy Follow Debounce', () => {
  /**
   * **Feature: social-copilot-v2, Property 8: Lazy Follow Debounce**
   * **Validates: Requirements 2.6**
   *
   * *For any* sequence of WeChat window move events within 150ms,
   * the floating window should only update position once after the debounce period.
   */
  it('should only apply position once after debounce period for rapid moves', () => {
    fc.assert(
      fc.property(
        fc.array(nonNullPositionArbitrary, { minLength: 2, maxLength: 10 }),
        debounceTimeArbitrary,
        (positions, debounceMs) => {
          // Create move events all within the debounce window
          const moveEvents = positions.map((position, index) => ({
            position,
            time: index * 10 // 10ms apart, all within debounce window
          }))

          // Check time is after debounce period from last event
          const lastEventTime = moveEvents[moveEvents.length - 1].time
          const checkTime = lastEventTime + debounceMs + 1

          // Count updates
          const updates = countPositionUpdates(moveEvents, debounceMs, checkTime)

          // Should only have 1 update (the final one after debounce)
          expect(updates).toBe(1)
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 8: Lazy Follow Debounce**
   * **Validates: Requirements 2.6**
   *
   * *For any* move event, checking before debounce period should not apply position.
   */
  it('should not apply position before debounce period elapses', () => {
    fc.assert(
      fc.property(
        nonNullPositionArbitrary,
        debounceTimeArbitrary,
        timestampArbitrary,
        (position, debounceMs, startTime) => {
          let state = createLazyFollowState(debounceMs)

          // Record move event
          state = recordMoveEvent(state, position, startTime)

          // Check before debounce period
          const checkTime = startTime + debounceMs - 1
          const result = checkDebounceElapsed(state, checkTime)

          expect(result.shouldApply).toBe(false)
          expect(result.position).toBeNull()
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 8: Lazy Follow Debounce**
   * **Validates: Requirements 2.6**
   *
   * *For any* move event, checking after debounce period should apply position.
   */
  it('should apply position after debounce period elapses', () => {
    fc.assert(
      fc.property(
        nonNullPositionArbitrary,
        debounceTimeArbitrary,
        timestampArbitrary,
        (position, debounceMs, startTime) => {
          let state = createLazyFollowState(debounceMs)

          // Record move event
          state = recordMoveEvent(state, position, startTime)

          // Check after debounce period
          const checkTime = startTime + debounceMs
          const result = checkDebounceElapsed(state, checkTime)

          expect(result.shouldApply).toBe(true)
          expect(result.position).toEqual(position)
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 8: Lazy Follow Debounce**
   * **Validates: Requirements 2.6**
   *
   * *For any* sequence of move events with gaps larger than debounce period,
   * each gap should result in a position update.
   */
  it('should apply position for each gap larger than debounce period', () => {
    fc.assert(
      fc.property(
        fc.array(nonNullPositionArbitrary, { minLength: 2, maxLength: 5 }),
        debounceTimeArbitrary,
        (positions, debounceMs) => {
          // Create move events with gaps larger than debounce
          const moveEvents = positions.map((position, index) => ({
            position,
            time: index * (debounceMs + 50) // Each event is debounceMs + 50ms apart
          }))

          // Check time is after debounce period from last event
          const lastEventTime = moveEvents[moveEvents.length - 1].time
          const checkTime = lastEventTime + debounceMs + 1

          // Count updates
          const updates = countPositionUpdates(moveEvents, debounceMs, checkTime)

          // Should have one update per position (each gap allows the previous to apply)
          expect(updates).toBe(positions.length)
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 8: Lazy Follow Debounce**
   * **Validates: Requirements 2.6**
   *
   * After clearing pending position, no position should be applied.
   */
  it('should not apply position after clearing pending', () => {
    fc.assert(
      fc.property(
        nonNullPositionArbitrary,
        debounceTimeArbitrary,
        timestampArbitrary,
        (position, debounceMs, startTime) => {
          let state = createLazyFollowState(debounceMs)

          // Record move event
          state = recordMoveEvent(state, position, startTime)

          // Clear pending position
          state = clearPendingPosition(state)

          // Check after debounce period
          const checkTime = startTime + debounceMs + 1
          const result = checkDebounceElapsed(state, checkTime)

          expect(result.shouldApply).toBe(false)
          expect(result.position).toBeNull()
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ============================================================================
// Property 9: Fixed Position Mode
// ============================================================================

describe('Property 9: Fixed Position Mode', () => {
  /**
   * **Feature: social-copilot-v2, Property 9: Fixed Position Mode**
   * **Validates: Requirements 2.7**
   *
   * *For any* WeChat window movement when auto-follow is disabled,
   * the floating window position should remain unchanged.
   */
  it('should maintain fixed position regardless of target movement', () => {
    fc.assert(
      fc.property(
        nonNullPositionArbitrary,
        fc.array(nonNullPositionArbitrary, { minLength: 1, maxLength: 10 }),
        (fixedPosition, targetPositions) => {
          // Enable fixed mode with initial position
          let state = createFixedPositionState()
          state = enableFixedMode(state, fixedPosition)

          // For each target position, resolved position should be the fixed position
          for (const targetPosition of targetPositions) {
            const resolved = resolvePosition(state, targetPosition)
            expect(resolved).toEqual(fixedPosition)
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 9: Fixed Position Mode**
   * **Validates: Requirements 2.7**
   *
   * When fixed mode is disabled, position should follow target.
   */
  it('should follow target position when fixed mode is disabled', () => {
    fc.assert(
      fc.property(
        nonNullPositionArbitrary,
        nonNullPositionArbitrary,
        (initialPosition, targetPosition) => {
          // Create state and enable then disable fixed mode
          let state = createFixedPositionState()
          state = enableFixedMode(state, initialPosition)
          state = disableFixedMode(state)

          // Resolved position should be the target
          const resolved = resolvePosition(state, targetPosition)
          expect(resolved).toEqual(targetPosition)
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 9: Fixed Position Mode**
   * **Validates: Requirements 2.7**
   *
   * shouldPositionChange should return false in fixed mode.
   */
  it('should not allow position change in fixed mode', () => {
    fc.assert(
      fc.property(
        nonNullPositionArbitrary,
        nonNullPositionArbitrary,
        (fixedPosition, _targetPosition) => {
          let state = createFixedPositionState()
          state = enableFixedMode(state, fixedPosition)

          expect(shouldPositionChange(state)).toBe(false)
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 9: Fixed Position Mode**
   * **Validates: Requirements 2.7**
   *
   * shouldPositionChange should return true when not in fixed mode.
   */
  it('should allow position change when not in fixed mode', () => {
    fc.assert(
      fc.property(nonNullPositionArbitrary, (_targetPosition) => {
        const state = createFixedPositionState()

        expect(shouldPositionChange(state)).toBe(true)
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 9: Fixed Position Mode**
   * **Validates: Requirements 2.7**
   *
   * WindowManagerService should respect fixed mode setting.
   */
  it('should respect fixed mode in WindowManagerService', () => {
    fc.assert(
      fc.property(
        nonNullPositionArbitrary,
        nonNullPositionArbitrary,
        (initialPosition, targetPosition) => {
          const service = new WindowManagerService()

          // Set initial position
          service.setPosition(initialPosition)

          // Disable lazy follow (enables fixed mode)
          service.setLazyFollow(false)

          // Verify fixed mode is active
          expect(service.isFixedMode()).toBe(true)
          expect(service.isLazyFollowEnabled()).toBe(false)

          // Handle target window move
          service.handleTargetWindowMove(targetPosition)

          // Position should remain at initial position
          expect(service.getCurrentPosition()).toEqual(initialPosition)

          // Clean up
          service.destroy()
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * **Feature: social-copilot-v2, Property 9: Fixed Position Mode**
   * **Validates: Requirements 2.7**
   *
   * Toggling fixed mode should preserve the fixed position.
   */
  it('should preserve fixed position when toggling mode', () => {
    fc.assert(
      fc.property(nonNullPositionArbitrary, (position) => {
        let state = createFixedPositionState()

        // Enable fixed mode
        state = enableFixedMode(state, position)
        expect(state.fixedPosition).toEqual(position)
        expect(state.isFixedMode).toBe(true)

        // Disable fixed mode
        state = disableFixedMode(state)
        expect(state.isFixedMode).toBe(false)
        // Fixed position should still be stored (for potential re-enable)
        expect(state.fixedPosition).toEqual(position)
      }),
      { numRuns: 100 }
    )
  })
})
