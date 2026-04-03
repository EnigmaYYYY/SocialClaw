/**
 * StatusIndicator Component - Shows current application status
 *
 * Displays:
 * - Monitoring status
 * - Loading indicator
 * - Error state
 * - Current contact name
 *
 * Requirements: 9.2, 9.5
 */

export type AppStatus = 'monitoring' | 'loading' | 'error' | 'idle' | 'connected'

export interface StatusIndicatorProps {
  status: AppStatus
  errorMessage?: string
  contactName?: string
}

export function StatusIndicator({
  status,
  errorMessage,
  contactName
}: StatusIndicatorProps): JSX.Element {
  const getStatusIcon = (): string => {
    switch (status) {
      case 'monitoring':
        return '👁️'
      case 'loading':
        return '⏳'
      case 'error':
        return '❌'
      case 'connected':
        return '✅'
      case 'idle':
      default:
        return '💤'
    }
  }

  const getStatusText = (): string => {
    switch (status) {
      case 'monitoring':
        return '监控中'
      case 'loading':
        return '分析中...'
      case 'error':
        return errorMessage || '连接错误'
      case 'connected':
        return 'Ollama 已连接'
      case 'idle':
      default:
        return '待机中'
    }
  }

  const getStatusClass = (): string => {
    switch (status) {
      case 'monitoring':
        return 'status-monitoring'
      case 'loading':
        return 'status-loading'
      case 'error':
        return 'status-error'
      case 'connected':
        return 'status-connected'
      case 'idle':
      default:
        return 'status-idle'
    }
  }

  return (
    <div className={`status-indicator-bar ${getStatusClass()}`}>
      <div className="status-left">
        <span className="status-icon">{getStatusIcon()}</span>
        <span className="status-text">{getStatusText()}</span>
      </div>
      {contactName && (
        <div className="status-right">
          <span className="contact-label">对话:</span>
          <span className="contact-name">{contactName}</span>
        </div>
      )}
    </div>
  )
}
