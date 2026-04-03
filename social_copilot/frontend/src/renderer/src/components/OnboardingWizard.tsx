/**
 * OnboardingWizard Component - First-time user onboarding flow
 *
 * Implements the onboarding wizard with:
 * - Welcome screen explaining the app
 * - Data folder import option (file picker for WeChatMsg/wechatDataBackup exports)
 * - Skip option with explanation
 * - Progress indicator during data cleaning and profile generation
 *
 * Requirements: 1.1, 1.2, 1.8
 */
import { useState, useCallback } from 'react'
import './OnboardingWizard.css'

// ============================================================================
// Types
// ============================================================================

export type OnboardingStep = 'welcome' | 'import' | 'processing' | 'complete'

export interface OnboardingResult {
  skipped: boolean
  importedContacts: number
  importedMessages: number
  initializedSessions: number
  updatedProfiles: number
  failedInitializationSessions: number
  failedReasons: string[]
}

export interface OnboardingWizardProps {
  onComplete: (result: OnboardingResult) => void
}

interface ProcessingProgress {
  stage: 'importing' | 'normalizing' | 'persisting' | 'backfilling' | 'complete'
  progress: number
  message: string
}

// ============================================================================
// OnboardingWizard Component
// ============================================================================

export function OnboardingWizard({ onComplete }: OnboardingWizardProps): JSX.Element {
  const [currentStep, setCurrentStep] = useState<OnboardingStep>('welcome')
  const [processingProgress, setProcessingProgress] = useState<ProcessingProgress>({
    stage: 'importing',
    progress: 0,
    message: '准备导入数据...'
  })
  const [error, setError] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<{
    contacts: number
    messages: number
    initializedSessions: number
    updatedProfiles: number
    failedInitializationSessions: number
    failedReasons: string[]
  } | null>(null)

  // Handle skip button click - Requirements 1.8
  const handleSkip = useCallback(() => {
    onComplete({
      skipped: true,
      importedContacts: 0,
      importedMessages: 0,
      initializedSessions: 0,
      updatedProfiles: 0,
      failedInitializationSessions: 0,
      failedReasons: []
    })
  }, [onComplete])

  // Handle start import button click
  const handleStartImport = useCallback(() => {
    setCurrentStep('import')
  }, [])

  // Handle folder selection and import - Requirements 1.1, 1.2
  const handleSelectFolder = useCallback(async () => {
    setError(null)
    
    try {
      if (!window.electronAPI) {
        throw new Error('Electron API 不可用')
      }

      // Open folder picker and import data
      setCurrentStep('processing')
      setProcessingProgress({
        stage: 'importing',
        progress: 10,
        message: '正在读取数据文件...'
      })

      window.electronAPI.import.onInitializeMemoryProgress((progress) => {
        setProcessingProgress(progress)
      })

      const result = await window.electronAPI.import.initializeMemory()

      if (!result) {
        // User cancelled the dialog
        window.electronAPI.import.offInitializeMemoryProgress()
        setCurrentStep('import')
        return
      }

      if (!result.success) {
        setError(
          result.errors[0]
          || '无法识别数据格式，请选择包含 CSV 或数据库文件的聊天记录文件夹'
        )
        window.electronAPI.import.offInitializeMemoryProgress()
        setCurrentStep('import')
        return
      }

      if (result.errors.length > 0) {
        console.warn('Import warnings:', result.errors)
      }

      setProcessingProgress({
        stage: 'complete',
        progress: 100,
        message: '导入完成！'
      })

      setImportResult({
        contacts: result.importedContacts,
        messages: result.importedMessages,
        initializedSessions: result.initializedSessions,
        updatedProfiles: result.updatedProfiles,
        failedInitializationSessions: result.failedInitializationSessions,
        failedReasons: result.failedReasons
      })

      window.electronAPI.import.offInitializeMemoryProgress()
      setCurrentStep('complete')
    } catch (err) {
      console.error('Import failed:', err)
      window.electronAPI.import.offInitializeMemoryProgress()
      setError(err instanceof Error ? err.message : '导入失败，请重试')
      setCurrentStep('import')
    }
  }, [])

  // Handle completion
  const handleComplete = useCallback(() => {
    onComplete({
      skipped: false,
      importedContacts: importResult?.contacts ?? 0,
      importedMessages: importResult?.messages ?? 0,
      initializedSessions: importResult?.initializedSessions ?? 0,
      updatedProfiles: importResult?.updatedProfiles ?? 0,
      failedInitializationSessions: importResult?.failedInitializationSessions ?? 0,
      failedReasons: importResult?.failedReasons ?? []
    })
  }, [onComplete, importResult])

  // Render welcome step
  const renderWelcomeStep = (): JSX.Element => (
    <div className="onboarding-step welcome-step">
      <div className="welcome-icon">🤖</div>
      <h1>欢迎使用 Social Copilot</h1>
      <h2>AI 社交军师</h2>
      
      <div className="welcome-description">
        <p>
          Social Copilot 是一款智能聊天助手，通过分析您的聊天风格和好友关系，
          为您提供高情商的回复建议。
        </p>
        
        <div className="feature-list">
          <div className="feature-item">
            <span className="feature-icon">🎯</span>
            <div className="feature-text">
              <strong>深度个性化</strong>
              <span>基于历史聊天记录学习您的沟通风格</span>
            </div>
          </div>
          
          <div className="feature-item">
            <span className="feature-icon">🔒</span>
            <div className="feature-text">
              <strong>隐私安全</strong>
              <span>所有数据存储和 AI 推理均在本地完成</span>
            </div>
          </div>
          
          <div className="feature-item">
            <span className="feature-icon">📚</span>
            <div className="feature-text">
              <strong>辅助教学</strong>
              <span>带注解的回复建议帮助您理解社交潜台词</span>
            </div>
          </div>
        </div>
      </div>

      <div className="welcome-actions">
        <button 
          type="button" 
          className="primary-button"
          onClick={handleStartImport}
        >
          开始设置
        </button>
        <button 
          type="button" 
          className="skip-button"
          onClick={handleSkip}
        >
          跳过，稍后设置
        </button>
      </div>
    </div>
  )

  // Render import step
  const renderImportStep = (): JSX.Element => (
    <div className="onboarding-step import-step">
      <div className="step-header">
        <button 
          type="button" 
          className="back-button"
          onClick={() => setCurrentStep('welcome')}
        >
          ← 返回
        </button>
        <div className="step-indicator">
          <span className="step-dot active" />
          <span className="step-dot" />
        </div>
      </div>

      <h2>导入聊天记录</h2>
      <p className="step-description">
        导入您的微信聊天记录，让 AI 学习您的沟通风格和好友关系。
      </p>

      <div className="import-options">
        <div className="import-card" onClick={handleSelectFolder}>
          <div className="import-icon">📁</div>
          <h3>选择联系人/群聊聊天记录文件夹</h3>
          <p>支持以下格式的聊天记录文件：</p>
          <ul>
            <li>CSV 文件（优先）</li>
            <li>SQLite 数据库（.db / .sqlite）</li>
          </ul>
          <button type="button" className="select-folder-button">
            选择文件夹
          </button>
        </div>
      </div>

      {error && (
        <div className="import-error">
          <span className="error-icon">⚠️</span>
          <span>{error}</span>
        </div>
      )}

      <div className="import-help">
        <h4>如何获取聊天记录？</h4>
        <ol>
          <li>使用微信聊天记录导出工具导出数据</li>
          <li>将导出的文件夹选择到上方</li>
          <li>系统会自动识别 CSV 或数据库格式的文件</li>
        </ol>
      </div>

      <div className="skip-section">
        <p>没有聊天记录？</p>
        <button 
          type="button" 
          className="skip-link"
          onClick={handleSkip}
        >
          跳过此步骤，从实时监控开始学习
        </button>
      </div>
    </div>
  )

  // Render processing step
  const renderProcessingStep = (): JSX.Element => (
    <div className="onboarding-step processing-step">
      <div className="processing-animation">
        <div className="processing-spinner" />
      </div>
      
      <h2>正在处理数据</h2>
      
      <div className="progress-container">
        <div className="progress-bar">
          <div 
            className="progress-fill"
            style={{ width: `${processingProgress.progress}%` }}
          />
        </div>
        <span className="progress-text">{processingProgress.progress}%</span>
      </div>
      
      <p className="processing-message">{processingProgress.message}</p>
      
      <div className="processing-stages">
        <div className={`stage ${processingProgress.stage === 'importing' ? 'active' : processingProgress.progress > 20 ? 'completed' : ''}`}>
          <span className="stage-icon">📥</span>
          <span>导入数据</span>
        </div>
        <div className={`stage ${processingProgress.stage === 'normalizing' ? 'active' : processingProgress.progress > 45 ? 'completed' : ''}`}>
          <span className="stage-icon">🧹</span>
          <span>标准化消息</span>
        </div>
        <div className={`stage ${processingProgress.stage === 'persisting' ? 'active' : processingProgress.progress > 70 ? 'completed' : ''}`}>
          <span className="stage-icon">💾</span>
          <span>写入记录</span>
        </div>
        <div className={`stage ${processingProgress.stage === 'backfilling' ? 'active' : processingProgress.progress === 100 ? 'completed' : ''}`}>
          <span className="stage-icon">🧠</span>
          <span>初始化记忆</span>
        </div>
      </div>
    </div>
  )

  // Render complete step
  const renderCompleteStep = (): JSX.Element => (
    <div className="onboarding-step complete-step">
      <div className="complete-icon">✅</div>
      
      <h2>设置完成！</h2>
      
      <div className="import-summary">
        <div className="summary-item">
          <span className="summary-value">{importResult?.messages ?? 0}</span>
          <span className="summary-label">条消息</span>
        </div>
        <div className="summary-item">
          <span className="summary-value">{importResult?.contacts ?? 0}</span>
          <span className="summary-label">位联系人</span>
        </div>
        <div className="summary-item">
          <span className="summary-value">{importResult?.initializedSessions ?? 0}</span>
          <span className="summary-label">个初始化会话</span>
        </div>
      </div>
      
      <p className="complete-description">
        EverMemOS 已基于历史聊天构建初始记忆，现在可以在实时使用中继续增量学习。
      </p>

      {importResult && importResult.failedInitializationSessions > 0 ? (
        <div className="import-error">
          <span className="error-icon">⚠️</span>
          <span>
            有 {importResult.failedInitializationSessions} 个会话初始化失败。
            {importResult.failedReasons[0] ? ` 首条原因：${importResult.failedReasons[0]}` : ''}
          </span>
        </div>
      ) : null}
      
      <button 
        type="button" 
        className="primary-button"
        onClick={handleComplete}
      >
        开始使用
      </button>
    </div>
  )

  return (
    <div className="onboarding-wizard">
      <div className="onboarding-container">
        {currentStep === 'welcome' && renderWelcomeStep()}
        {currentStep === 'import' && renderImportStep()}
        {currentStep === 'processing' && renderProcessingStep()}
        {currentStep === 'complete' && renderCompleteStep()}
      </div>
    </div>
  )
}

export default OnboardingWizard
