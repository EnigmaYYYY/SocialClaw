/**
 * SettingsPanel Component - Application settings management
 *
 * Implements:
 * - Auto-follow mode toggle (Lazy Follow / Fixed Position)
 * - Monitor mode toggle (Auto/Accessibility/OCR)
 * - Manual profile JSON editing
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4
 */
import { useState, useEffect, useCallback } from 'react'

export type MonitorMode = 'auto' | 'accessibility' | 'ocr'

export type AppSettings = Parameters<typeof window.electronAPI.settings.save>[0]

export interface UserProfile {
  user_id: string
  base_info: {
    gender: 'male' | 'female' | 'other'
    occupation: string
    tone_style: string
  }
  communication_habits: {
    frequent_phrases: string[]
    emoji_usage: string[]
    punctuation_style: string
    msg_avg_length: 'short' | 'medium' | 'long'
  }
  last_updated: number
}

export interface SettingsPanelProps {
  isOpen: boolean
  onClose: () => void
  settings: AppSettings | null
  userProfile: UserProfile | null
  onSettingsChange: (settings: AppSettings) => void
  onUserProfileChange: (profile: UserProfile) => void
}

type SettingsTab = 'general' | 'profile' | 'evermemos'

export function SettingsPanel({
  isOpen,
  onClose,
  settings,
  userProfile,
  onSettingsChange,
  onUserProfileChange
}: SettingsPanelProps): JSX.Element | null {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const [profileJson, setProfileJson] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  // Update profile JSON when userProfile changes
  useEffect(() => {
    if (userProfile) {
      setProfileJson(JSON.stringify(userProfile, null, 2))
      setJsonError(null)
    }
  }, [userProfile])

  // Handle lazy follow toggle - Requirements 11.2
  const handleLazyFollowToggle = useCallback(() => {
    if (!settings) return
    const newSettings: AppSettings = {
      ...settings,
      floatingWindow: {
        ...settings.floatingWindow,
        lazyFollow: !settings.floatingWindow.lazyFollow
      }
    }
    onSettingsChange(newSettings)
  }, [settings, onSettingsChange])

  // Handle monitor mode change - Requirements 11.3
  const handleMonitorModeChange = useCallback((mode: MonitorMode) => {
    if (!settings) return
    const newSettings: AppSettings = {
      ...settings,
      monitorMode: mode
    }
    onSettingsChange(newSettings)
  }, [settings, onSettingsChange])

  // Handle profile JSON change - Requirements 11.4
  const handleProfileJsonChange = useCallback((value: string) => {
    setProfileJson(value)
    setJsonError(null)
  }, [])

  // Save profile JSON - Requirements 11.4
  const handleSaveProfile = useCallback(async () => {
    try {
      setIsSaving(true)
      const parsed = JSON.parse(profileJson) as UserProfile
      
      // Basic validation
      if (!parsed.user_id || !parsed.base_info || !parsed.communication_habits) {
        throw new Error('缺少必要字段: user_id, base_info, communication_habits')
      }
      
      onUserProfileChange(parsed)
      setJsonError(null)
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : 'JSON 格式错误')
    } finally {
      setIsSaving(false)
    }
  }, [profileJson, onUserProfileChange])

  // Reset profile JSON to original
  const handleResetProfile = useCallback(() => {
    if (userProfile) {
      setProfileJson(JSON.stringify(userProfile, null, 2))
      setJsonError(null)
    }
  }, [userProfile])

  // Handle backdrop click to close
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }, [onClose])

  if (!isOpen) return null

  return (
    <div className="settings-overlay" onClick={handleBackdropClick}>
      <div className="settings-panel">
        {/* Header */}
        <div className="settings-header">
          <h2 className="settings-title">⚙️ 设置</h2>
          <button
            type="button"
            className="settings-close-btn"
            onClick={onClose}
            aria-label="关闭设置"
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="settings-tabs">
          <button
            type="button"
            className={`settings-tab ${activeTab === 'general' ? 'active' : ''}`}
            onClick={() => setActiveTab('general')}
          >
            常规设置
          </button>
          <button
            type="button"
            className={`settings-tab ${activeTab === 'profile' ? 'active' : ''}`}
            onClick={() => setActiveTab('profile')}
          >
            画像编辑
          </button>
          <button
            type="button"
            className={`settings-tab ${activeTab === 'evermemos' ? 'active' : ''}`}
            onClick={() => setActiveTab('evermemos')}
          >
            EverMemOS
          </button>
        </div>

        {/* Content */}
        <div className="settings-content">
          {activeTab === 'general' && settings && (
            <GeneralSettings
              settings={settings}
              onLazyFollowToggle={handleLazyFollowToggle}
              onMonitorModeChange={handleMonitorModeChange}
            />
          )}

          {activeTab === 'profile' && (
            <ProfileEditor
              profileJson={profileJson}
              jsonError={jsonError}
              isSaving={isSaving}
              onJsonChange={handleProfileJsonChange}
              onSave={handleSaveProfile}
              onReset={handleResetProfile}
            />
          )}

          {activeTab === 'evermemos' && settings && (
            <EverMemOSSettings
              settings={settings}
              onSettingsChange={onSettingsChange}
            />
          )}
        </div>
      </div>
    </div>
  )
}


// ============================================================================
// General Settings Sub-component
// ============================================================================

interface GeneralSettingsProps {
  settings: AppSettings
  onLazyFollowToggle: () => void
  onMonitorModeChange: (mode: MonitorMode) => void
}

function GeneralSettings({
  settings,
  onLazyFollowToggle,
  onMonitorModeChange
}: GeneralSettingsProps): JSX.Element {
  return (
    <div className="settings-section">
      {/* Window Follow Mode - Requirements 11.2 */}
      <div className="settings-group">
        <h3 className="settings-group-title">窗口跟随模式</h3>
        <p className="settings-group-desc">
          控制悬浮窗是否跟随微信窗口移动
        </p>
        <div className="settings-toggle-row">
          <span className="toggle-label">
            {settings.floatingWindow.lazyFollow ? '松耦合跟随 (Lazy Follow)' : '固定位置'}
          </span>
          <button
            type="button"
            className={`toggle-switch ${settings.floatingWindow.lazyFollow ? 'active' : ''}`}
            onClick={onLazyFollowToggle}
            aria-pressed={settings.floatingWindow.lazyFollow}
            aria-label="切换窗口跟随模式"
          >
            <span className="toggle-slider" />
          </button>
        </div>
        <p className="settings-hint">
          {settings.floatingWindow.lazyFollow
            ? '窗口将在微信移动停止 150ms 后平滑跟随'
            : '窗口将保持在固定位置，不跟随微信移动'}
        </p>
      </div>

      {/* Monitor Mode - Requirements 11.3 */}
      <div className="settings-group">
        <h3 className="settings-group-title">监控模式</h3>
        <p className="settings-group-desc">
          选择读取微信聊天内容的方式
        </p>
        <div className="settings-radio-group">
          <label className="settings-radio">
            <input
              type="radio"
              name="monitorMode"
              value="auto"
              checked={settings.monitorMode === 'auto'}
              onChange={() => onMonitorModeChange('auto')}
            />
            <span className="radio-label">
              <span className="radio-title">自动选择</span>
              <span className="radio-desc">优先使用 Accessibility API，失败时降级到 OCR</span>
            </span>
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="monitorMode"
              value="accessibility"
              checked={settings.monitorMode === 'accessibility'}
              onChange={() => onMonitorModeChange('accessibility')}
            />
            <span className="radio-label">
              <span className="radio-title">Accessibility API</span>
              <span className="radio-desc">通过 macOS 辅助功能读取 UI 元素（推荐）</span>
            </span>
          </label>
          <label className="settings-radio">
            <input
              type="radio"
              name="monitorMode"
              value="ocr"
              checked={settings.monitorMode === 'ocr'}
              onChange={() => onMonitorModeChange('ocr')}
            />
            <span className="radio-label">
              <span className="radio-title">OCR 识别</span>
              <span className="radio-desc">通过屏幕截图和文字识别获取内容</span>
            </span>
          </label>
        </div>
      </div>

      {/* Session Expiry Info */}
      <div className="settings-group">
        <h3 className="settings-group-title">会话设置</h3>
        <div className="settings-info-row">
          <span className="info-label">话题过期时间</span>
          <span className="info-value">{settings.sessionExpiryHours} 小时</span>
        </div>
        <p className="settings-hint">
          超过此时间未收到新消息，将自动清空上下文缓存开始新话题
        </p>
      </div>
    </div>
  )
}

// ============================================================================
// Profile Editor Sub-component
// ============================================================================

interface ProfileEditorProps {
  profileJson: string
  jsonError: string | null
  isSaving: boolean
  onJsonChange: (value: string) => void
  onSave: () => void
  onReset: () => void
}

function ProfileEditor({
  profileJson,
  jsonError,
  isSaving,
  onJsonChange,
  onSave,
  onReset
}: ProfileEditorProps): JSX.Element {
  return (
    <div className="settings-section">
      {/* Profile JSON Editor - Requirements 11.4 */}
      <div className="settings-group">
        <h3 className="settings-group-title">用户画像 JSON</h3>
        <p className="settings-group-desc">
          直接编辑用户画像数据，修改后点击保存生效
        </p>
        <div className="json-editor-container">
          <textarea
            className={`json-editor ${jsonError ? 'has-error' : ''}`}
            value={profileJson}
            onChange={(e) => onJsonChange(e.target.value)}
            spellCheck={false}
            placeholder="加载中..."
          />
          {jsonError && (
            <div className="json-error">
              <span className="error-icon">⚠️</span>
              <span className="error-text">{jsonError}</span>
            </div>
          )}
        </div>
        <div className="json-editor-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onReset}
            disabled={isSaving}
          >
            重置
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onSave}
            disabled={isSaving}
          >
            {isSaving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>

      {/* Profile Structure Help */}
      <div className="settings-group">
        <h3 className="settings-group-title">字段说明</h3>
        <div className="profile-help">
          <div className="help-item">
            <span className="help-field">base_info.gender</span>
            <span className="help-desc">性别: male / female / other</span>
          </div>
          <div className="help-item">
            <span className="help-field">base_info.occupation</span>
            <span className="help-desc">职业</span>
          </div>
          <div className="help-item">
            <span className="help-field">base_info.tone_style</span>
            <span className="help-desc">说话风格，如 "幽默, 随和"</span>
          </div>
          <div className="help-item">
            <span className="help-field">communication_habits.frequent_phrases</span>
            <span className="help-desc">口头禅列表</span>
          </div>
          <div className="help-item">
            <span className="help-field">communication_habits.emoji_usage</span>
            <span className="help-desc">常用表情列表</span>
          </div>
          <div className="help-item">
            <span className="help-field">communication_habits.punctuation_style</span>
            <span className="help-desc">标点习惯，如 "不喜欢用句号"</span>
          </div>
          <div className="help-item">
            <span className="help-field">communication_habits.msg_avg_length</span>
            <span className="help-desc">消息长度: short / medium / long</span>
          </div>
        </div>
      </div>
    </div>
  )
}


// ============================================================================
// EverMemOS Settings Sub-component
// ============================================================================

interface EverMemOSSettingsProps {
  settings: AppSettings
  onSettingsChange: (settings: AppSettings) => void
}

function EverMemOSSettings({
  settings,
  onSettingsChange
}: EverMemOSSettingsProps): JSX.Element {
  const [isSaving, setIsSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)

  // Update EverMemOS connection settings
  const updateEverMemOS = useCallback((key: keyof typeof settings.evermemos, value: unknown) => {
    const newSettings: AppSettings = {
      ...settings,
      evermemos: {
        ...settings.evermemos,
        [key]: value
      }
    }
    onSettingsChange(newSettings)
  }, [settings, onSettingsChange])

  // Update LLM config
  const updateLLM = useCallback((key: string, value: unknown) => {
    const newSettings: AppSettings = {
      ...settings,
      evermemos: {
        ...settings.evermemos,
        llm: {
          ...settings.evermemos.llm,
          [key]: value
        }
      }
    }
    onSettingsChange(newSettings)
  }, [settings, onSettingsChange])

  // Save LLM config to backend
  const handleSaveLLMConfig = useCallback(async () => {
    setIsSaving(true)
    setSaveMessage(null)
    try {
      const response = await fetch(`${settings.evermemos.apiBaseUrl}/api/v1/copilot/config/llm`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings.evermemos.llm)
      })
      if (!response.ok) {
        throw new Error(`保存失败: ${response.status}`)
      }
      setSaveMessage('✅ 已保存到 EverMemOS 服务')
    } catch (error) {
      setSaveMessage(`❌ 保存失败: ${error instanceof Error ? error.message : '未知错误'}`)
    } finally {
      setIsSaving(false)
    }
  }, [settings])

  return (
    <div className="settings-section">
      {/* Connection Settings */}
      <div className="settings-group">
        <h3 className="settings-group-title">连接设置</h3>
        <p className="settings-group-desc">
          配置与 EverMemOS 服务的连接参数
        </p>
        <div className="settings-toggle-row">
          <span className="toggle-label">启用 EverMemOS</span>
          <button
            type="button"
            className={`toggle-switch ${settings.evermemos.enabled ? 'active' : ''}`}
            onClick={() => updateEverMemOS('enabled', !settings.evermemos.enabled)}
            aria-pressed={settings.evermemos.enabled}
            aria-label="切换 EverMemOS 启用状态"
          >
            <span className="toggle-slider" />
          </button>
        </div>
        <div className="settings-input-row">
          <label className="input-label">API 地址</label>
          <input
            type="text"
            className="settings-input"
            value={settings.evermemos.apiBaseUrl}
            onChange={(e) => updateEverMemOS('apiBaseUrl', e.target.value)}
            placeholder="http://127.0.0.1:1995"
          />
        </div>
        <div className="settings-input-row">
          <label className="input-label">用户 ID</label>
          <input
            type="text"
            className="settings-input"
            value={settings.evermemos.ownerUserId}
            onChange={(e) => updateEverMemOS('ownerUserId', e.target.value)}
            placeholder="self"
          />
        </div>
        <p className="settings-group-desc">
          建议把当前账号的显示名设置成你的微信昵称，并尽量与旧聊天导出里“本人”名称一致，否则历史聊天导入时可能把自己识别成好友。
        </p>
        <div className="settings-input-row">
          <label className="input-label">超时时间 (ms)</label>
          <input
            type="number"
            className="settings-input"
            value={settings.evermemos.requestTimeoutMs}
            onChange={(e) => updateEverMemOS('requestTimeoutMs', parseInt(e.target.value, 10) || 12000)}
            min={1000}
            max={60000}
          />
        </div>
        <div className="settings-input-row">
          <label className="input-label">回填分批大小</label>
          <input
            type="number"
            className="settings-input"
            value={settings.evermemos.backfillChunkSize}
            onChange={(e) => updateEverMemOS('backfillChunkSize', parseInt(e.target.value, 10) || 20)}
            min={1}
            max={200}
          />
        </div>
        <div className="settings-input-row">
          <label className="input-label">每条消息预算 (秒)</label>
          <input
            type="number"
            className="settings-input"
            value={settings.evermemos.backfillChunkMessageBudgetSeconds}
            onChange={(e) =>
              updateEverMemOS(
                'backfillChunkMessageBudgetSeconds',
                parseInt(e.target.value, 10) || 3
              )
            }
            min={1}
            max={120}
          />
        </div>
        <p className="settings-group-desc">
          用于旧聊天回填画像时每批发送给 EverMemOS 的消息条数。默认 20；会话越大、模型越慢时，适当调小通常更稳。
        </p>
        <p className="settings-group-desc">
          历史回填现在按线性公式计算超时：单个 chunk 超时 = 回填分批大小 × 每条消息预算秒数。默认 3 秒/条，所以 10 条约 30 秒，20 条约 60 秒；整次顺序回填的理论总预算会再乘以 chunk 数。
        </p>
      </div>

      {/* LLM Configuration */}
      <div className="settings-group">
        <h3 className="settings-group-title">LLM 配置</h3>
        <p className="settings-group-desc">
          配置 EverMemOS 使用的大语言模型参数
        </p>
        <div className="settings-input-row">
          <label className="input-label">API Base URL</label>
          <input
            type="text"
            className="settings-input"
            value={settings.evermemos.llm.baseUrl}
            onChange={(e) => updateLLM('baseUrl', e.target.value)}
            placeholder="https://api.openai.com/v1"
          />
        </div>
        <div className="settings-input-row">
          <label className="input-label">API Key</label>
          <input
            type="password"
            className="settings-input"
            value={settings.evermemos.llm.apiKey}
            onChange={(e) => updateLLM('apiKey', e.target.value)}
            placeholder="sk-..."
          />
        </div>
        <div className="settings-input-row">
          <label className="input-label">模型名称</label>
          <input
            type="text"
            className="settings-input"
            value={settings.evermemos.llm.model}
            onChange={(e) => updateLLM('model', e.target.value)}
            placeholder="gpt-4"
          />
        </div>
        <div className="settings-input-row">
          <label className="input-label">Temperature</label>
          <input
            type="number"
            className="settings-input"
            value={settings.evermemos.llm.temperature}
            onChange={(e) => updateLLM('temperature', parseFloat(e.target.value) || 0.3)}
            step={0.1}
            min={0}
            max={2}
          />
        </div>
        <div className="settings-input-row">
          <label className="input-label">Max Tokens</label>
          <input
            type="number"
            className="settings-input"
            value={settings.evermemos.llm.maxTokens}
            onChange={(e) => updateLLM('maxTokens', parseInt(e.target.value, 10) || 8192)}
            min={1}
            max={32768}
          />
        </div>
        <div className="settings-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSaveLLMConfig}
            disabled={isSaving}
          >
            {isSaving ? '保存中...' : '保存到服务端'}
          </button>
          {saveMessage && (
            <span className="save-message">{saveMessage}</span>
          )}
        </div>
      </div>
    </div>
  )
}
