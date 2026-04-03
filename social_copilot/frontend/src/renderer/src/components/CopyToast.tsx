/**
 * CopyToast Component - Brief confirmation toast when content is copied
 *
 * Requirements: 7.2
 */
import { useEffect, useState } from 'react'

export interface CopyToastProps {
  message: string
  isVisible: boolean
  duration?: number
  onHide: () => void
}

export function CopyToast({
  message,
  isVisible,
  duration = 2000,
  onHide
}: CopyToastProps): JSX.Element | null {
  const [shouldRender, setShouldRender] = useState(isVisible)

  useEffect(() => {
    if (isVisible) {
      setShouldRender(true)
      const timer = setTimeout(() => {
        onHide()
      }, duration)
      return () => clearTimeout(timer)
    } else {
      // Delay unmount for animation
      const timer = setTimeout(() => {
        setShouldRender(false)
      }, 300)
      return () => clearTimeout(timer)
    }
  }, [isVisible, duration, onHide])

  if (!shouldRender) {
    return null
  }

  return (
    <div className={`copy-toast ${isVisible ? 'visible' : 'hiding'}`}>
      <span className="copy-toast-icon">✓</span>
      <span>{message}</span>
    </div>
  )
}
