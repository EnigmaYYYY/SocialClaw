/**
 * SuggestionCard Component - Individual suggestion card with copy functionality
 *
 * Displays:
 * - Reply content
 * - Reason/teaching annotation (教学注解)
 * - Copy indicator
 * - Keyboard shortcut hint
 *
 * Requirements: 6.1, 6.2, 7.1, 7.2
 */

export interface SuggestionCardProps {
  index: number
  content: string
  reason: string
  isCopied: boolean
  onCopy: () => void
}

export function SuggestionCard({
  index,
  content,
  reason,
  isCopied,
  onCopy
}: SuggestionCardProps): JSX.Element {
  return (
    <div
      className={`suggestion-card-compact ${isCopied ? 'copied' : ''}`}
      onClick={onCopy}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onCopy()
        }
      }}
    >
      {/* Shortcut badge */}
      <div className="shortcut-badge">⌘{index + 1}</div>

      {/* Suggestion content */}
      <div className="card-content">
        <p className="suggestion-text">{content}</p>
      </div>

      {/* Teaching annotation (教学注解) */}
      <div className="card-reason">
        <span className="reason-label">💡</span>
        <span className="reason-text">{reason}</span>
      </div>

      {/* Copy indicator */}
      <div className="copy-indicator">
        {isCopied ? (
          <span className="copied-text">✓ 已复制</span>
        ) : (
          <span className="copy-text">点击复制</span>
        )}
      </div>
    </div>
  )
}
