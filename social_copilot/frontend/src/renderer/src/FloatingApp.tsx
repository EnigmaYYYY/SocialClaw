/**
 * FloatingApp Component - Main application for floating window mode
 *
 * Implements the compact floating window UI with:
 * - Onboarding wizard for first-time users
 * - Suggestion cards with copy functionality
 * - Status indicator
 * - Risk warning display
 * - Minimize/restore functionality
 * - Keyboard shortcuts
 * - Settings panel
 *
 * Requirements: 1.1, 1.2, 1.8, 2.1, 2.4, 2.5, 6.1, 6.2, 7.1, 7.2, 7.3, 9.2, 9.5, 10.2, 11.1, 11.2, 11.3, 11.4
 */
import { useState, useEffect, useCallback } from 'react'
import { FloatingWindow, CopyToast, SettingsPanel, OnboardingWizard } from './components'
import type { Suggestion, IntentAnalysis, RiskAssessment, AppStatus, OnboardingResult } from './components'
import type { AppSettings, UserProfile } from './components/SettingsPanel'
import './components/FloatingWindow.css'
import './components/OnboardingWizard.css'

function FloatingApp(): JSX.Element {
  // Application state
  const [status, setStatus] = useState<AppStatus>('idle')
  const [errorMessage, setErrorMessage] = useState<string | undefined>()
  
  // Onboarding state - Requirements 1.1, 1.2, 1.8
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [isInitializing, setIsInitializing] = useState(true)
  
  // Suggestion state
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [intent, setIntent] = useState<IntentAnalysis | null>(null)
  
  // Contact state
  const [contactName, setContactName] = useState<string | undefined>()
  const [riskAssessment, setRiskAssessment] = useState<RiskAssessment | null>(null)
  
  // Window state
  const [isMinimized, setIsMinimized] = useState(false)
  
  // Toast state
  const [toastVisible, setToastVisible] = useState(false)
  const [toastMessage, setToastMessage] = useState('')
  
  // Settings state - Requirements 11.1, 11.2, 11.3, 11.4
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null)
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null)

  // Initialize application on startup - Requirements 1.1
  useEffect(() => {
    const initializeApp = async (): Promise<void> => {
      try {
        if (window.electronAPI) {
          setStatus('idle')
          
          // Initialize app and check if first run - Requirements 1.1
          const initResult = await window.electronAPI.initialize()
          
          // Check if this is first run (show onboarding)
          if (initResult.isFirstRun) {
            setShowOnboarding(true)
            setIsInitializing(false)
            return
          }
          
          // Load settings - Requirements 11.1
          try {
            const settings = await window.electronAPI.settings.load()
            setAppSettings(settings)
          } catch (err) {
            console.warn('Failed to load settings:', err)
          }
          
          // Load user profile - Requirements 11.4
          try {
            const profile = await window.electronAPI.loadUserProfile()
            setUserProfile(profile)
          } catch (err) {
            console.warn('Failed to load user profile:', err)
          }
          
          // Check Ollama connectivity
          if (initResult.ollamaConnected) {
            setStatus('connected')
          } else {
            setStatus('error')
            setErrorMessage('无法连接到 Ollama 服务')
          }
        } else {
          setStatus('error')
          setErrorMessage('Electron API 不可用')
        }
      } catch (error) {
        console.error('Failed to initialize:', error)
        setStatus('error')
        setErrorMessage(error instanceof Error ? error.message : '初始化失败')
      } finally {
        setIsInitializing(false)
      }
    }
    void initializeApp()
  }, [])

  // Handle copy to clipboard with toast notification
  const handleCopy = useCallback((content: string, _index: number): void => {
    navigator.clipboard.writeText(content)
      .then(() => {
        setToastMessage('已复制到剪贴板')
        setToastVisible(true)
      })
      .catch((err) => {
        console.error('Failed to copy:', err)
        setToastMessage('复制失败')
        setToastVisible(true)
      })
  }, [])

  // Handle minimize
  const handleMinimize = useCallback((): void => {
    setIsMinimized(true)
  }, [])

  // Handle restore from minimized state
  const handleRestore = useCallback((): void => {
    setIsMinimized(false)
  }, [])

  // Handle settings button click - Requirements 11.1
  const handleSettings = useCallback((): void => {
    setSettingsOpen(true)
  }, [])
  
  // Handle settings panel close
  const handleSettingsClose = useCallback((): void => {
    setSettingsOpen(false)
  }, [])
  
  // Handle settings change - Requirements 11.2, 11.3, 11.5
  const handleSettingsChange = useCallback(async (newSettings: AppSettings): Promise<void> => {
    setAppSettings(newSettings)
    try {
      if (window.electronAPI) {
        await window.electronAPI.settings.save(newSettings)
        setToastMessage('设置已保存')
        setToastVisible(true)
      }
    } catch (error) {
      console.error('Failed to save settings:', error)
      setToastMessage('保存设置失败')
      setToastVisible(true)
    }
  }, [])
  
  // Handle user profile change - Requirements 11.4
  const handleUserProfileChange = useCallback(async (newProfile: UserProfile): Promise<void> => {
    setUserProfile(newProfile)
    try {
      if (window.electronAPI) {
        await window.electronAPI.saveUserProfile(newProfile)
        setToastMessage('画像已保存')
        setToastVisible(true)
      }
    } catch (error) {
      console.error('Failed to save user profile:', error)
      setToastMessage('保存画像失败')
      setToastVisible(true)
    }
  }, [])

  // Hide toast
  const handleHideToast = useCallback((): void => {
    setToastVisible(false)
  }, [])

  // Handle onboarding completion - Requirements 1.1, 1.8
  const handleOnboardingComplete = useCallback(async (result: OnboardingResult): Promise<void> => {
    try {
      if (window.electronAPI) {
        // Mark onboarding as complete
        await window.electronAPI.settings.completeOnboarding()
        
        // Show toast based on result
        if (result.skipped) {
          setToastMessage('已跳过导入，将从实时监控开始学习')
        } else {
          const failureSuffix = result.failedInitializationSessions > 0
            ? `，${result.failedInitializationSessions} 个会话初始化失败`
            : ''
          setToastMessage(
            `已导入 ${result.importedMessages} 条消息，初始化 ${result.initializedSessions} 个会话，更新 ${result.updatedProfiles} 个画像${failureSuffix}`
          )
        }
        setToastVisible(true)
        
        // Load settings and profile
        const settings = await window.electronAPI.settings.load()
        setAppSettings(settings)
        
        const profile = await window.electronAPI.loadUserProfile()
        setUserProfile(profile)
        
        // Check Ollama connectivity
        const isHealthy = await window.electronAPI.checkOllamaHealth()
        if (isHealthy) {
          setStatus('connected')
        } else {
          setStatus('error')
          setErrorMessage('无法连接到 Ollama 服务')
        }
      }
    } catch (error) {
      console.error('Failed to complete onboarding:', error)
      setToastMessage('设置完成，但部分功能可能受限')
      setToastVisible(true)
    } finally {
      setShowOnboarding(false)
    }
  }, [])

  // Start hot run service and listen for events - Requirements 3.5, 4.1, 5.1, 6.1
  useEffect(() => {
    if (!window.electronAPI || status !== 'connected') {
      return
    }

    // Set up hot run event listeners
    window.electronAPI.hotRun.onSuggestions((update) => {
      setSuggestions(update.suggestions)
      setIntent(update.intent)
      setContactName(update.contactId)
      
      // Update risk assessment from contact profile
      if (update.contactProfile?.risk_assessment) {
        setRiskAssessment(update.contactProfile.risk_assessment)
      }
      
      setStatus('monitoring')
    })

    window.electronAPI.hotRun.onContactChanged((data) => {
      setContactName(data.contactId)
      
      // Update risk assessment from contact profile
      if (data.profile?.risk_assessment) {
        setRiskAssessment(data.profile.risk_assessment)
      } else {
        setRiskAssessment(null)
      }
      
      // Clear suggestions when contact changes
      setSuggestions([])
      setIntent(null)
    })

    window.electronAPI.hotRun.onStatusChanged((hotRunStatus) => {
      if (hotRunStatus.isRunning) {
        setStatus('monitoring')
      } else if (hotRunStatus.errorMessage) {
        setStatus('error')
        setErrorMessage(hotRunStatus.errorMessage)
      }
    })

    window.electronAPI.hotRun.onError((error) => {
      console.error('Hot run error:', error.message)
      setToastMessage(error.message)
      setToastVisible(true)
    })

    // Start the hot run service
    const startHotRun = async (): Promise<void> => {
      try {
        setStatus('loading')
        await window.electronAPI.hotRun.start()
        setStatus('monitoring')
      } catch (error) {
        console.error('Failed to start hot run:', error)
        setStatus('error')
        setErrorMessage('启动实时监控失败')
      }
    }

    void startHotRun()

    // Cleanup on unmount
    return () => {
      window.electronAPI.hotRun.removeAllListeners()
      void window.electronAPI.hotRun.stop()
    }
  }, [status])

  // Show loading screen during initialization
  if (isInitializing) {
    return (
      <div className="floating-app-loading">
        <div className="loading-spinner" />
        <span>正在初始化...</span>
      </div>
    )
  }

  // Show onboarding wizard for first-time users - Requirements 1.1, 1.2, 1.8
  if (showOnboarding) {
    return <OnboardingWizard onComplete={handleOnboardingComplete} />
  }

  return (
    <>
      <FloatingWindow
        suggestions={suggestions}
        intent={intent}
        status={status}
        errorMessage={errorMessage}
        riskAssessment={riskAssessment}
        contactName={contactName}
        onCopy={handleCopy}
        onMinimize={handleMinimize}
        onSettings={handleSettings}
        isMinimized={isMinimized}
        onRestore={handleRestore}
      />
      
      {/* Settings Panel - Requirements 11.1, 11.2, 11.3, 11.4 */}
      <SettingsPanel
        isOpen={settingsOpen}
        onClose={handleSettingsClose}
        settings={appSettings}
        userProfile={userProfile}
        onSettingsChange={handleSettingsChange}
        onUserProfileChange={handleUserProfileChange}
      />
      
      <CopyToast
        message={toastMessage}
        isVisible={toastVisible}
        onHide={handleHideToast}
      />
    </>
  )
}

export default FloatingApp
