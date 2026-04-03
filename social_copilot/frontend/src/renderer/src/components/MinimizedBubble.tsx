/**
 * MinimizedBubble Component - Semi-transparent AI bubble icon for minimized state
 *
 * Displays a compact bubble when the floating window is minimized
 * Shows status indicator and notification badge for new suggestions
 *
 * Requirements: 2.4, 2.5
 */

export type AppStatus = 'monitoring' | 'loading' | 'error' | 'idle' | 'connected'

export interface MinimizedBubbleProps {
  status: AppStatus
  hasNewSuggestions: boolean
  onClick: () => void
}

export function MinimizedBubble({
  status,
  hasNewSuggestions,
  onClick
}: MinimizedBubbleProps): JSX.Element {
  const getStatusClass = (): string => {
    switch (status) {
      case 'monitoring':
        return 'bubble-monitoring'
      case 'loading':
        return 'bubble-loading'
      case 'error':
        return 'bubble-error'
      case 'connected':
        return 'bubble-connected'
      case 'idle':
      default:
        return 'bubble-idle'
    }
  }

  return (
    <div
      className={`minimized-bubble ${getStatusClass()}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      title="点击展开 AI 社交军师"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <span className="bubble-icon">🤖</span>
      
      {/* Status indicator dot */}
      <div className={`status-dot ${status}`} />
      
      {/* New suggestions badge */}
      {hasNewSuggestions && (
        <div className="notification-badge">
          <span>!</span>
        </div>
      )}
      
      {/* Loading animation */}
      {status === 'loading' && (
        <div className="bubble-loading-ring" />
      )}
    </div>
  )
}
