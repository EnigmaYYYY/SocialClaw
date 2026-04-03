/**
 * SuggestionPanel Component
 *
 * Displays reply suggestions in card format with copy functionality
 * Validates: Requirements 7.1, 7.2, 7.3
 */
import { useState } from 'react'

interface Suggestion {
  content: string
  reason: string
}

interface IntentAnalysis {
  intent: string
  mood: string
  topic: string
}

interface SuggestionPanelProps {
  suggestions: Suggestion[]
  intent: IntentAnalysis | null
  isLoading: boolean
  onCopy: (content: string) => void
}

export function SuggestionPanel({
  suggestions,
  intent,
  isLoading,
  onCopy
}: SuggestionPanelProps): JSX.Element {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)

  const handleCopy = (content: string, index: number): void => {
    onCopy(content)
    setCopiedIndex(index)
    setTimeout(() => setCopiedIndex(null), 2000)
  }

  return (
    <aside className="suggestion-panel">
      <h2>回复建议</h2>

      {isLoading && (
        <div className="loading-indicator">
          <div className="spinner" />
          <span>正在生成建议...</span>
        </div>
      )}

      {!isLoading && intent && (
        <div className="intent-summary">
          <div className="intent-item">
            <span className="label">意图:</span>
            <span className="value">{intent.intent}</span>
          </div>
          <div className="intent-item">
            <span className="label">情绪:</span>
            <span className="value">{intent.mood}</span>
          </div>
          <div className="intent-item">
            <span className="label">话题:</span>
            <span className="value">{intent.topic}</span>
          </div>
        </div>
      )}

      {!isLoading && suggestions.length === 0 && !intent && (
        <p className="empty-state">分析后的建议将在此显示</p>
      )}

      {!isLoading && suggestions.length > 0 && (
        <div className="suggestions-list">
          {suggestions.map((suggestion, index) => (
            <div
              key={index}
              className={`suggestion-card ${copiedIndex === index ? 'copied' : ''}`}
              onClick={() => handleCopy(suggestion.content, index)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  handleCopy(suggestion.content, index)
                }
              }}
            >
              <div className="suggestion-content">{suggestion.content}</div>
              <div className="suggestion-reason">{suggestion.reason}</div>
              <div className="copy-hint">
                {copiedIndex === index ? '✓ 已复制' : '点击复制'}
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}
