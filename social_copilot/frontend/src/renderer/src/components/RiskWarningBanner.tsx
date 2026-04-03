/**
 * RiskWarningBanner Component - Displays risk warning for suspicious contacts
 *
 * Shows a red warning banner when a contact is flagged as suspicious
 *
 * Requirements: 10.2
 */

export interface RiskWarningBannerProps {
  riskLevel: 'low' | 'medium' | 'high'
  warningMsg: string
}

export function RiskWarningBanner({
  riskLevel,
  warningMsg
}: RiskWarningBannerProps): JSX.Element {
  const getRiskClass = (): string => {
    switch (riskLevel) {
      case 'high':
        return 'risk-high'
      case 'medium':
        return 'risk-medium'
      case 'low':
      default:
        return 'risk-low'
    }
  }

  const getRiskIcon = (): string => {
    switch (riskLevel) {
      case 'high':
        return '🚨'
      case 'medium':
        return '⚠️'
      case 'low':
      default:
        return '⚡'
    }
  }

  const getRiskLabel = (): string => {
    switch (riskLevel) {
      case 'high':
        return '高风险'
      case 'medium':
        return '中风险'
      case 'low':
      default:
        return '低风险'
    }
  }

  return (
    <div className={`risk-warning-banner-compact ${getRiskClass()}`}>
      <div className="risk-header">
        <span className="risk-icon">{getRiskIcon()}</span>
        <span className="risk-label">{getRiskLabel()}</span>
      </div>
      <p className="risk-message">{warningMsg || '该联系人可能存在风险，请谨慎交流'}</p>
    </div>
  )
}
