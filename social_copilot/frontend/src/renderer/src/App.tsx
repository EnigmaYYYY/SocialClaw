/**
 * App Component - Main Application Layout
 *
 * Implements responsive layout with minimum 800px width
 * Contains chat input, suggestions panel, and contact selector
 * Validates: Requirements 7.1, 7.2, 7.4, 7.5
 */
import { useState, useEffect, useCallback } from 'react'
import { ChatInputArea, SuggestionPanel, ContactSelector, UserProfileSettings } from './components'

interface Suggestion {
  content: string
  reason: string
}

interface IntentAnalysis {
  intent: string
  mood: string
  topic: string
}

interface ContactProfile {
  contact_id: string
  nickname: string
  chat_history_summary: string
  risk_assessment: {
    is_suspicious: boolean
    warning_msg: string
  }
}

type OllamaStatus = 'checking' | 'connected' | 'error'
type AppStatus = 'initializing' | 'ready' | 'error'

function App(): JSX.Element {
  // App initialization state
  const [appStatus, setAppStatus] = useState<AppStatus>('initializing')
  const [initError, setInitError] = useState<string | null>(null)

  // Ollama connection state
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus>('checking')

  // Contact state
  const [contacts, setContacts] = useState<string[]>([])
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null)
  const [selectedContactProfile, setSelectedContactProfile] = useState<ContactProfile | null>(null)
  const [contactsLoading, setContactsLoading] = useState(true)

  // Suggestion state
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [intent, setIntent] = useState<IntentAnalysis | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)

  // Settings panel state
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)

  // Initialize application on startup
  // - Creates data directory and default profiles (Requirement 4.1)
  // - Checks Ollama connectivity (Requirement 6.1)
  // - Loads contact list
  useEffect(() => {
    const initializeApp = async (): Promise<void> => {
      try {
        if (window.electronAPI) {
          // Call the unified initialization function
          const result = await window.electronAPI.initialize()

          // Set Ollama status based on initialization result
          setOllamaStatus(result.ollamaConnected ? 'connected' : 'error')

          // Set contacts from initialization result
          setContacts(result.contacts)
          if (result.contacts.length > 0) {
            setSelectedContactId(result.contacts[0])
          }

          setAppStatus('ready')
        } else {
          setOllamaStatus('error')
          setAppStatus('error')
          setInitError('Electron API not available')
        }
      } catch (error) {
        console.error('Failed to initialize application:', error)
        setOllamaStatus('error')
        setAppStatus('error')
        setInitError(error instanceof Error ? error.message : 'Unknown error')
      } finally {
        setContactsLoading(false)
      }
    }
    void initializeApp()
  }, [])

  // Load selected contact profile
  useEffect(() => {
    const loadProfile = async (): Promise<void> => {
      if (selectedContactId && window.electronAPI) {
        const profile = await window.electronAPI.profile.loadContact(selectedContactId)
        setSelectedContactProfile(profile as ContactProfile | null)
      }
    }
    void loadProfile()
  }, [selectedContactId])

  // Refresh contact list (called after chat submission in case new contact was created)
  const refreshContacts = useCallback(async (): Promise<void> => {
    if (window.electronAPI) {
      try {
        const contactList = await window.electronAPI.listContacts()
        setContacts(contactList)
      } catch (error) {
        console.error('Failed to refresh contacts:', error)
      }
    }
  }, [])

  // Handle chat submission
  const handleSubmitChat = useCallback(
    async (chatText: string): Promise<void> => {
      if (!selectedContactId || ollamaStatus !== 'connected') return

      setIsAnalyzing(true)
      setSuggestions([])
      setIntent(null)

      try {
        if (window.electronAPI) {
          const chatLogs = chatText.split('\n').filter((line) => line.trim())
          const result = await window.electronAPI.submitChat(chatLogs, selectedContactId)
          setSuggestions(result.suggestions)
          setIntent(result.intent)

          // Refresh contacts in case a new contact was created
          await refreshContacts()
        }
      } catch (error) {
        console.error('Failed to analyze chat:', error)
      } finally {
        setIsAnalyzing(false)
      }
    },
    [selectedContactId, ollamaStatus, refreshContacts]
  )

  // Handle file import
  const handleImportFile = useCallback(async (): Promise<string | null> => {
    if (window.electronAPI) {
      return window.electronAPI.importFile()
    }
    return null
  }, [])

  // Handle contact selection
  const handleSelectContact = useCallback((contactId: string): void => {
    setSelectedContactId(contactId)
    setSuggestions([])
    setIntent(null)
  }, [])

  // Handle loading contact profile
  const handleLoadContactProfile = useCallback(
    async (contactId: string): Promise<ContactProfile | null> => {
      if (window.electronAPI) {
        return window.electronAPI.profile.loadContact(contactId) as Promise<ContactProfile | null>
      }
      return null
    },
    []
  )

  // Handle copy to clipboard
  const handleCopy = useCallback((content: string): void => {
    navigator.clipboard.writeText(content).catch((err) => {
      console.error('Failed to copy:', err)
    })
  }, [])

  const isDisabled = ollamaStatus !== 'connected' || !selectedContactId || appStatus !== 'ready'

  // Show loading screen during initialization
  if (appStatus === 'initializing') {
    return (
      <div className="app app-loading">
        <div className="loading-screen">
          <div className="spinner" />
          <span>正在初始化应用...</span>
        </div>
      </div>
    )
  }

  // Show error screen if initialization failed
  if (appStatus === 'error' && initError) {
    return (
      <div className="app app-error">
        <div className="error-screen">
          <span className="error-icon">❌</span>
          <h2>初始化失败</h2>
          <p>{initError}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
          >
            重试
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Social Copilot - AI 社交军师</h1>
        <div className="header-actions">
          <button
            type="button"
            className="settings-button"
            onClick={() => setIsSettingsOpen(true)}
            title="用户设置"
          >
            ⚙️ 设置
          </button>
          <div className={`status-indicator ${ollamaStatus}`}>
            Ollama:{' '}
            {ollamaStatus === 'checking'
              ? '检查中...'
              : ollamaStatus === 'connected'
                ? '已连接'
                : '未连接'}
          </div>
        </div>
      </header>

      {/* Ollama connection error banner */}
      {ollamaStatus === 'error' && (
        <div className="ollama-error-banner">
          <div className="error-header">
            <span className="error-icon">❌</span>
            <span className="error-title">无法连接到 Ollama 服务</span>
          </div>
          <div className="error-troubleshooting">
            <p>请按以下步骤排查:</p>
            <ol>
              <li>确保 Ollama 已安装并正在运行</li>
              <li>
                在终端运行: <code>ollama serve</code>
              </li>
              <li>
                确保已下载模型: <code>ollama pull qwen3:8b</code>
              </li>
              <li>检查 Ollama 是否在 localhost:11434 运行</li>
            </ol>
            <button
              type="button"
              className="retry-button"
              onClick={async () => {
                setOllamaStatus('checking')
                try {
                  const isHealthy = await window.electronAPI?.checkOllamaHealth()
                  setOllamaStatus(isHealthy ? 'connected' : 'error')
                } catch {
                  setOllamaStatus('error')
                }
              }}
            >
              重新连接
            </button>
          </div>
        </div>
      )}

      {/* Risk warning banner */}
      {selectedContactProfile?.risk_assessment.is_suspicious && (
        <div className="risk-warning-banner">
          <span className="warning-icon">⚠️</span>
          <span className="warning-text">
            警告: {selectedContactProfile.risk_assessment.warning_msg || '该联系人可能存在风险'}
          </span>
        </div>
      )}

      <main className="app-main">
        <ContactSelector
          contacts={contacts}
          selectedContactId={selectedContactId}
          onSelectContact={handleSelectContact}
          onLoadContactProfile={handleLoadContactProfile}
          isLoading={contactsLoading}
        />

        <section className="chat-area">
          <ChatInputArea
            onSubmit={handleSubmitChat}
            onImport={handleImportFile}
            isLoading={isAnalyzing}
            disabled={isDisabled}
          />
        </section>

        <SuggestionPanel
          suggestions={suggestions}
          intent={intent}
          isLoading={isAnalyzing}
          onCopy={handleCopy}
        />
      </main>

      {/* User Profile Settings Panel */}
      <UserProfileSettings
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />
    </div>
  )
}

export default App
