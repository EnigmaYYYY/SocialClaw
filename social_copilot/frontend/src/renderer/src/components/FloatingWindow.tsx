/**
 * FloatingWindow Component - Compact floating window layout
 *
 * Implements:
 * - Suggestion cards (2-3) with content and reason (教学注解)
 * - Status indicator (monitoring, loading, error)
 * - Minimize/settings buttons
 * - Draggable title bar area
 * - Semi-transparent AI bubble icon for minimized state
 *
 * Requirements: 2.1, 2.4, 2.5, 6.1, 6.2, 9.2, 9.5
 */
import { useState, useEffect, useCallback } from 'react'
import { SuggestionCard } from './SuggestionCard'
import { StatusIndicator } from './StatusIndicator'
import { RiskWarningBanner } from './RiskWarningBanner'
import { MinimizedBubble } from './MinimizedBubble'

export interface Suggestion {
  content: string
  reason: string
}

export interface IntentAnalysis {
  intent: string
  mood: string
  topic: string
}

export interface RiskAssessment {
  is_suspicious: boolean
  risk_level: 'low' | 'medium' | 'high'
  warning_msg: string
}

export type AppStatus = 'monitoring' | 'loading' | 'error' | 'idle' | 'connected'

export interface FloatingWindowProps {
  suggestions: Suggestion[]
  intent: IntentAnalysis | null
  status: AppStatus
  errorMessage?: string
  riskAssessment?: RiskAssessment | null
  contactName?: string
  onCopy: (content: string, index: number) => void
  onMinimize: () => void
  onSettings: () => void
  isMinimized: boolean
  onRestore: () => void
}

export function FloatingWindow({
  suggestions,
  intent,
  status,
  errorMessage,
  riskAssessment,
  contactName,
  onCopy,
  onMinimize,
  onSettings,
  isMinimized,
  onRestore
}: FloatingWindowProps): JSX.Element {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)

  // Handle copy with visual feedback
  const handleCopy = useCallback((content: string, index: number): void => {
    onCopy(content, index)
    setCopiedIndex(index)
    // Clear copied state after 2 seconds
    setTimeout(() => setCopiedIndex(null), 2000)
  }, [onCopy])

  // Keyboard shortcuts for copying suggestions (Cmd+1/2/3)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && suggestions.length > 0) {
        const keyNum = parseInt(e.key, 10)
        if (keyNum >= 1 && keyNum <= 3 && keyNum <= suggestions.length) {
          e.preventDefault()
          handleCopy(suggestions[keyNum - 1].content, keyNum - 1)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [suggestions, handleCopy])

  // Show minimized bubble when minimized
  if (isMinimized) {
    return (
      <MinimizedBubble
        status={status}
        hasNewSuggestions={suggestions.length > 0}
        onClick={onRestore}
      />
    )
  }

  return (
    <div className="floating-window">
      {/* Draggable title bar area */}
      <div className="floating-header" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div className="header-left">
          <span className="app-icon">🤖</span>
          <span className="app-title">AI 社交军师</span>
        </div>
        <div className="header-actions" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            type="button"
            className="header-btn settings-btn"
            onClick={onSettings}
            title="设置"
          >
            ⚙️
          </button>
          <button
            type="button"
            className="header-btn minimize-btn"
            onClick={onMinimize}
            title="最小化"
          >
            −
          </button>
        </div>
      </div>

      {/* Risk warning banner - Requirements 10.2 */}
      {riskAssessment?.is_suspicious && (
        <RiskWarningBanner
          riskLevel={riskAssessment.risk_level}
          warningMsg={riskAssessment.warning_msg}
        />
      )}

      {/* Status indicator - Requirements 9.2, 9.5 */}
      <StatusIndicator
        status={status}
        errorMessage={errorMessage}
        contactName={contactName}
      />

      {/* Main content area */}
      <div className="floating-content">
        {/* Intent summary when available */}
        {intent && status !== 'loading' && (
          <div className="intent-summary-compact">
            <div className="intent-row">
              <span className="intent-label">意图:</span>
              <span className="intent-value">{intent.intent}</span>
            </div>
            <div className="intent-row">
              <span className="intent-label">情绪:</span>
              <span className="intent-value">{intent.mood}</span>
            </div>
          </div>
        )}

        {/* Loading state - Requirements 9.5 */}
        {status === 'loading' && (
          <div className="loading-state">
            <div className="loading-spinner" />
            <span>正在生成建议...</span>
          </div>
        )}

        {/* Suggestion cards - Requirements 6.1, 6.2 */}
        {status !== 'loading' && suggestions.length > 0 && (
          <div className="suggestions-container">
            {suggestions.slice(0, 3).map((suggestion, index) => (
              <SuggestionCard
                key={index}
                index={index}
                content={suggestion.content}
                reason={suggestion.reason}
                isCopied={copiedIndex === index}
                onCopy={() => handleCopy(suggestion.content, index)}
              />
            ))}
          </div>
        )}

        {/* Empty state */}
        {status !== 'loading' && suggestions.length === 0 && status !== 'error' && (
          <div className="empty-state-compact">
            <span className="empty-icon">💬</span>
            <span className="empty-text">等待对话分析...</span>
          </div>
        )}

        {/* Error state - Requirements 9.2 */}
        {status === 'error' && (
          <div className="error-state-compact">
            <span className="error-icon">❌</span>
            <span className="error-text">{errorMessage || '发生错误'}</span>
          </div>
        )}
      </div>

      {/* Keyboard shortcut hint */}
      {suggestions.length > 0 && (
        <div className="shortcut-hint">
          <span>⌘1-3 快速复制</span>
        </div>
      )}
    </div>
  )
}
