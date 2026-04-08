import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchAssistantPersonaSkills,
  type AssistantPersonaSkillOption
} from '../../services/assistant-persona-skills'
import { getMemoryFolderItems } from './ui-layout-model'
import { MemoryLibraryPanel } from './components/MemoryLibraryPanel'

type AppSettings = Parameters<typeof window.electronAPI.settings.save>[0]
type MemorySectionOverview = Awaited<ReturnType<typeof window.electronAPI.memoryFiles.getOverview>>[number]
type ModelProviderKey = keyof AppSettings['modelProviders']
type ModelProviderSettings = AppSettings['modelProviders'][ModelProviderKey]

type ProviderConnectionKey = 'Assistant' | '视觉模型' | 'EverMemOS' | 'EverMemOS 模型' | 'EverMemOS Vectorize' | 'EverMemOS Vectorize 模型' | 'EverMemOS Rerank' | 'EverMemOS Rerank 模型'
type ProviderFeedbackKey = 'assistant' | 'vision' | 'evermemos' | 'evermemosVectorize' | 'evermemosRerank'
type ProviderFeedbackTone = 'info' | 'success' | 'error'
type ProviderFeedbackState = {
  message: string
  tone: ProviderFeedbackTone
}

const CHAT_RECORD_CAPTURE_DEDUP_WINDOW_MIN_MS = 1000
const CHAT_RECORD_CAPTURE_DEDUP_WINDOW_MAX_MS = 600000
const CHAT_RECORD_CAPTURE_DEDUP_WINDOW_DEFAULT_MS = 120000
const ASSISTANT_TIMEOUT_MIN_MS = 1000
const ASSISTANT_TIMEOUT_MAX_MS = 120000
const ASSISTANT_TIMEOUT_DEFAULT_MS = 30000

export function captureSensitivityToScheme(
  value: AppSettings['visualMonitor']['captureSensitivity']
): AppSettings['visualMonitor']['captureScheme'] {
  return value === 'high' ? 'legacy' : 'current'
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback
  }
  return Math.min(max, Math.max(min, value))
}

export function chatRecordCaptureDedupWindowMsToSeconds(value: number): number {
  return clampNumber(
    Math.round(value / 1000),
    CHAT_RECORD_CAPTURE_DEDUP_WINDOW_MIN_MS / 1000,
    CHAT_RECORD_CAPTURE_DEDUP_WINDOW_MAX_MS / 1000,
    CHAT_RECORD_CAPTURE_DEDUP_WINDOW_DEFAULT_MS / 1000
  )
}

export function chatRecordCaptureDedupWindowSecondsToMs(value: number): number {
  return Math.round(
    clampNumber(
      value,
      CHAT_RECORD_CAPTURE_DEDUP_WINDOW_MIN_MS / 1000,
      CHAT_RECORD_CAPTURE_DEDUP_WINDOW_MAX_MS / 1000,
      CHAT_RECORD_CAPTURE_DEDUP_WINDOW_DEFAULT_MS / 1000
    ) * 1000
  )
}

export function assistantTimeoutMsToSeconds(value: number): number {
  return clampNumber(
    Math.round(value / 1000),
    ASSISTANT_TIMEOUT_MIN_MS / 1000,
    ASSISTANT_TIMEOUT_MAX_MS / 1000,
    ASSISTANT_TIMEOUT_DEFAULT_MS / 1000
  )
}

export function assistantTimeoutSecondsToMs(value: number): number {
  return Math.round(
    clampNumber(
      value,
      ASSISTANT_TIMEOUT_MIN_MS / 1000,
      ASSISTANT_TIMEOUT_MAX_MS / 1000,
      ASSISTANT_TIMEOUT_DEFAULT_MS / 1000
    ) * 1000
  )
}


export function MainConsoleApp(): JSX.Element {
  const folders = useMemo(() => getMemoryFolderItems(), [])
  const [selectedFolderId, setSelectedFolderId] = useState(folders[0]?.id ?? 'inbox')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [memoryOverview, setMemoryOverview] = useState<MemorySectionOverview[]>([])
  const [statusMessage, setStatusMessage] = useState('正在加载设置...')
  const [statusTone, setStatusTone] = useState<'info' | 'success' | 'error'>('info')
  const [isSaving, setIsSaving] = useState(false)
  const [memoryRefreshToken, setMemoryRefreshToken] = useState(0)
  const monitorPreviewTimerRef = useRef<number | null>(null)
  const [modelLists, setModelLists] = useState<Record<ModelProviderKey, string[]>>({
    assistant: [],
    vision: []
  })
  const [modelListLoading, setModelListLoading] = useState<Record<ModelProviderKey, boolean>>({
    assistant: false,
    vision: false
  })
  const [providerConnectionTesting, setProviderConnectionTesting] = useState<Partial<Record<ProviderConnectionKey, boolean>>>({})
  const [providerFeedback, setProviderFeedback] = useState<Partial<Record<ProviderFeedbackKey, ProviderFeedbackState>>>({})
  const [assistantPersonaSkills, setAssistantPersonaSkills] = useState<AssistantPersonaSkillOption[]>([])
  const [assistantPersonaSkillsLoading, setAssistantPersonaSkillsLoading] = useState(false)

  // New account modal state
  const [showNewAccountModal, setShowNewAccountModal] = useState(false)
  const [newAccountName, setNewAccountName] = useState('')

  // Compute owner display name from settings
  const ownerDisplayName = useMemo(() => {
    if (!settings) return 'captain1307'
    const accounts = settings.evermemos.availableAccounts ?? [
      { userId: 'captain1307', displayName: 'captain1307' },
      { userId: '🌟', displayName: '🌟' }
    ]
    const account = accounts.find(a => a.userId === settings.evermemos.ownerUserId)
    return account?.displayName ?? settings.evermemos.ownerUserId
  }, [settings])

  const loadMemoryOverview = useCallback(async (): Promise<void> => {
    try {
      const [overview, profiles] = await Promise.all([
        window.electronAPI.memoryFiles.getOverview(),
        window.electronAPI.profileAdmin.list().catch(() => [])
      ])
      setMemoryOverview(
        overview.map((item) =>
          item.id === 'long-term-memory'
            ? {
                ...item,
                count: profiles.length
              }
            : item
        )
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : '记忆文件加载失败'
      pushStatus(`记忆文件加载失败: ${message}`, 'error')
    }
  }, [])

  // Handle creating a new account
  const handleCreateNewAccount = useCallback(() => {
    const trimmedName = newAccountName.trim()
    if (!trimmedName) return

    const newUserId = `user_${Date.now().toString(36)}`

    setSettings((previous) => {
      if (!previous) return previous
      const newSettings = {
        ...previous,
        evermemos: {
          ...previous.evermemos,
          ownerUserId: newUserId,
          availableAccounts: [
            ...(previous.evermemos.availableAccounts ?? [
              { userId: 'captain1307', displayName: 'Me' },
              { userId: '🌟', displayName: '🌟' }
            ]),
            { userId: newUserId, displayName: trimmedName }
          ]
        }
      }
      void window.electronAPI.settings.save(newSettings).then(() => {
        setMemoryRefreshToken((t) => t + 1)
        void loadMemoryOverview()
        pushStatus(`已创建并切换到账号: ${trimmedName}`, 'success')
      })
      return newSettings
    })

    setShowNewAccountModal(false)
    setNewAccountName('')
  }, [newAccountName, loadMemoryOverview])

  // Handle account switch - refresh all data
  const handleAccountSwitch = useCallback((newUserId: string) => {
    const prevUserId = settings?.evermemos.ownerUserId
    if (prevUserId === newUserId) return

    // Create new settings first
    const newSettings = {
      ...settings!,
      evermemos: {
        ...settings!.evermemos,
        ownerUserId: newUserId
      }
    }

    // Update local state
    setSettings(newSettings)

    // Save settings first, then refresh data
    window.electronAPI.settings.save(newSettings).then(() => {
      // Clear and refresh after settings are saved
      setMemoryRefreshToken((t) => t + 1)
      void loadMemoryOverview()
      pushStatus(`已切换到账号: ${newUserId}`, 'success')
    })
  }, [settings?.evermemos.ownerUserId, settings, loadMemoryOverview])

  // Handle account deletion
  const handleDeleteAccount = useCallback((userIdToDelete: string) => {
    if (!settings) return

    const accounts = settings.evermemos.availableAccounts ?? []

    // Prevent deleting the last account
    if (accounts.length <= 1) {
      pushStatus('无法删除最后一个账号', 'error')
      return
    }

    // Find the account display name
    const accountToDelete = accounts.find(a => a.userId === userIdToDelete)
    const displayName = accountToDelete?.displayName ?? userIdToDelete

    // Confirm deletion
    if (!window.confirm(`确定要删除账号 "${displayName}" 吗？\n\n该账号的设置将被删除，但数据文件仍会保留。`)) {
      return
    }

    // Filter out the account to delete
    const newAccounts = accounts.filter(a => a.userId !== userIdToDelete)

    // If deleting current account, switch to first available account
    const newOwnerUserId = settings.evermemos.ownerUserId === userIdToDelete
      ? newAccounts[0].userId
      : settings.evermemos.ownerUserId

    const newSettings = {
      ...settings,
      evermemos: {
        ...settings.evermemos,
        ownerUserId: newOwnerUserId,
        availableAccounts: newAccounts
      }
    }

    setSettings(newSettings)
    window.electronAPI.settings.save(newSettings).then(() => {
      setMemoryRefreshToken(t => t + 1)
      void loadMemoryOverview()
      pushStatus(`已删除账号: ${displayName}`, 'success')
    })
  }, [settings, loadMemoryOverview])

  useEffect(() => {
    let active = true
    const load = async (): Promise<void> => {
      try {
        const loaded = await window.electronAPI.settings.load()
        if (!active) return
        setSettings(loaded)
        await loadMemoryOverview()
        pushStatus('设置已加载，可直接修改并保存', 'info')
      } catch (error) {
        if (!active) return
        const message = error instanceof Error ? error.message : '设置加载失败'
        pushStatus(`设置加载失败: ${message}`, 'error')
      }
    }

    void load()
    window.electronAPI.roi.onStatus((event) => {
      if (!active) return
      pushStatus(event.message, event.type === 'error' ? 'error' : 'info')
      setSettings((current) => {
        if (!current) return current
        if (event.type === 'manual_applied' && event.roi) {
          return {
            ...current,
            visualMonitor: {
              ...current.visualMonitor,
              captureScope: 'roi',
              roiStrategy: 'manual',
              manualRoi: event.roi
            }
          }
        }
        if (event.type === 'manual_reset') {
          return {
            ...current,
            visualMonitor: {
              ...current.visualMonitor,
              roiStrategy: 'hybrid',
              manualRoi: null
            }
          }
        }
        return current
      })
    })

    return () => {
      active = false
      if (monitorPreviewTimerRef.current !== null) {
        window.clearTimeout(monitorPreviewTimerRef.current)
        monitorPreviewTimerRef.current = null
      }
      window.electronAPI.roi.offStatus()
    }
  }, [])

  const updateSettings = (updater: (previous: AppSettings) => AppSettings): void => {
    setSettings((previous) => {
      if (!previous) return previous
      return updater(previous)
    })
  }

  const pushStatus = useCallback((message: string, tone: 'info' | 'success' | 'error' = 'info'): void => {
    setStatusMessage(message)
    setStatusTone(tone)
  }, [])

  const updateProviderFeedback = useCallback(
    (key: ProviderFeedbackKey, message: string, tone: ProviderFeedbackTone): void => {
      setProviderFeedback((previous) => ({
        ...previous,
        [key]: { message, tone }
      }))
    },
    []
  )

  const updateModelProvider = useCallback(
    (provider: ModelProviderKey, updater: (previous: ModelProviderSettings) => ModelProviderSettings): void => {
      updateSettings((previous) => ({
        ...previous,
        modelProviders: {
          ...previous.modelProviders,
          [provider]: updater(previous.modelProviders[provider])
        }
      }))
    },
    []
  )

  const loadModelOptions = useCallback(
    async (provider: ModelProviderKey): Promise<void> => {
      if (!settings) return
      const config = settings.modelProviders[provider]
      const trimmedBaseUrl = config.baseUrl.trim()
      const feedbackKey: ProviderFeedbackKey = provider
      const providerLabel = provider === 'assistant' ? 'Assistant' : '视觉模型'
      if (!trimmedBaseUrl) {
        updateProviderFeedback(feedbackKey, `${providerLabel} 地址不能为空`, 'error')
        return
      }

      setModelListLoading((previous) => ({ ...previous, [provider]: true }))
      try {
        const models = await window.electronAPI.settings.listModels(trimmedBaseUrl, config.apiKey)
        setModelLists((previous) => ({ ...previous, [provider]: models }))
        if (models.length === 0) {
          updateProviderFeedback(feedbackKey, `${providerLabel} 模型列表为空，可继续手动填写模型名`, 'info')
        } else {
          updateProviderFeedback(feedbackKey, `已拉取 ${models.length} 个${provider === 'assistant' ? ' Assistant' : '视觉'}模型`, 'success')
          if (!models.includes(config.modelName)) {
            updateModelProvider(provider, (previous) => ({
              ...previous,
              modelName: models[0]
            }))
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '模型列表拉取失败'
        updateProviderFeedback(feedbackKey, `${providerLabel} 模型列表拉取失败: ${message}`, 'error')
      } finally {
        setModelListLoading((previous) => ({ ...previous, [provider]: false }))
      }
    },
    [settings, updateModelProvider, updateProviderFeedback]
  )

  const testProviderConnection = useCallback(
    async (
      key: ProviderFeedbackKey,
      label: string,
      baseUrl: string,
      apiKey: string = '',
      selectedModel: string = '',
      streamStrategy: AppSettings['modelProviders']['assistant']['streamStrategy'] = 'non_stream'
    ): Promise<void> => {
      const trimmedBaseUrl = baseUrl.trim()
      if (!trimmedBaseUrl) {
        updateProviderFeedback(key, `${label} 地址不能为空`, 'error')
        return
      }
      setProviderConnectionTesting((previous) => ({ ...previous, [label]: true }))
      try {
        const message = await window.electronAPI.settings.testConnection(trimmedBaseUrl, apiKey, selectedModel, streamStrategy)
        updateProviderFeedback(key, `${label} ${message}`, 'success')
      } catch (error) {
        const message = error instanceof Error ? error.message : '连接测试失败'
        updateProviderFeedback(key, `${label} 连接测试失败: ${message}`, 'error')
      } finally {
        setProviderConnectionTesting((previous) => ({ ...previous, [label]: false }))
      }
    },
    [updateProviderFeedback]
  )

  const loadAssistantPersonaSkills = useCallback(
    async (baseUrl?: string): Promise<void> => {
      const trimmedBaseUrl = (baseUrl ?? settings?.visualMonitor.apiBaseUrl ?? '').trim()
      if (!trimmedBaseUrl) {
        setAssistantPersonaSkills([])
        return
      }
      setAssistantPersonaSkillsLoading(true)
      try {
        const skills = await fetchAssistantPersonaSkills(trimmedBaseUrl)
        setAssistantPersonaSkills(skills)
      } catch (error) {
        console.error('Failed to load assistant persona skills:', error)
        setAssistantPersonaSkills([])
      } finally {
        setAssistantPersonaSkillsLoading(false)
      }
    },
    [settings?.visualMonitor.apiBaseUrl]
  )

  useEffect(() => {
    if (!settings) {
      return
    }
    void loadAssistantPersonaSkills(settings.visualMonitor.apiBaseUrl)
  }, [loadAssistantPersonaSkills, settings?.visualMonitor.apiBaseUrl])

  const testVisionProviderConnection = useCallback(
    async (
      key: ProviderFeedbackKey,
      label: string,
      baseUrl: string,
      apiKey: string = '',
      selectedModel: string = '',
      maxTokens: number = 2000,
      disableThinking: boolean = true,
      streamStrategy: AppSettings['modelProviders']['vision']['streamStrategy'] = 'stream'
    ): Promise<void> => {
      const trimmedBaseUrl = baseUrl.trim()
      if (!trimmedBaseUrl) {
        updateProviderFeedback(key, `${label} 地址不能为空`, 'error')
        return
      }
      setProviderConnectionTesting((previous) => ({ ...previous, [label]: true }))
      try {
        const message = await window.electronAPI.settings.testVisionConnection(
          trimmedBaseUrl,
          apiKey,
          selectedModel,
          maxTokens,
          disableThinking,
          streamStrategy
        )
        updateProviderFeedback(key, `${label} ${message}`, 'success')
      } catch (error) {
        const message = error instanceof Error ? error.message : '连接测试失败'
        updateProviderFeedback(key, `${label} 连接测试失败: ${message}`, 'error')
      } finally {
        setProviderConnectionTesting((previous) => ({ ...previous, [label]: false }))
      }
    },
    [updateProviderFeedback]
  )

  const queueMonitorPreviewSync = useCallback((nextSettings: AppSettings, successMessage: string): void => {
    if (monitorPreviewTimerRef.current !== null) {
      window.clearTimeout(monitorPreviewTimerRef.current)
    }
    monitorPreviewTimerRef.current = window.setTimeout(() => {
      monitorPreviewTimerRef.current = null
      void window.electronAPI.hotRun
        .updateSettings(nextSettings)
        .then(() => {
          pushStatus(successMessage, 'success')
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : '实时同步失败'
          pushStatus(`参数实时同步失败: ${message}`, 'error')
        })
    }, 220)
  }, [pushStatus])

  const updateWindowGate = useCallback(
    (key: keyof AppSettings['visualMonitor']['windowGate'], value: number): void => {
      updateSettings((previous) => {
        const nextSettings: AppSettings = {
          ...previous,
          visualMonitor: {
            ...previous.visualMonitor,
            windowGate: {
              ...previous.visualMonitor.windowGate,
              [key]: value
            }
          }
        }
        queueMonitorPreviewSync(nextSettings, '窗口确认门控参数已实时同步（点击保存后可持久化）')
        return nextSettings
      })
    },
    [queueMonitorPreviewSync]
  )

  const updateCaptureSensitivity = useCallback((value: AppSettings['visualMonitor']['captureSensitivity']): void => {
    updateSettings((previous) => {
      const nextSettings: AppSettings = {
        ...previous,
        visualMonitor: {
          ...previous.visualMonitor,
          captureSensitivity: value,
          captureScheme: captureSensitivityToScheme(value)
        }
      }
      queueMonitorPreviewSync(nextSettings, '截图灵敏度已实时同步（点击保存后可持久化）')
      return nextSettings
    })
  }, [queueMonitorPreviewSync])

  const updateCaptureScope = useCallback((value: AppSettings['visualMonitor']['captureScope']): void => {
    updateSettings((previous) => {
      const nextSettings: AppSettings = {
        ...previous,
        visualMonitor: {
          ...previous.visualMonitor,
          captureScope: value
        }
      }
      queueMonitorPreviewSync(nextSettings, '截图区域范围已实时同步（点击保存后可持久化）')
      return nextSettings
    })
  }, [queueMonitorPreviewSync])

  const updateRoiStrategy = useCallback((value: AppSettings['visualMonitor']['roiStrategy']): void => {
    updateSettings((previous) => {
      const nextSettings: AppSettings = {
        ...previous,
        visualMonitor: {
          ...previous.visualMonitor,
          captureScope: 'roi',
          roiStrategy: value
        }
      }
      queueMonitorPreviewSync(nextSettings, 'ROI 策略已实时同步（点击保存后可持久化）')
      return nextSettings
    })
  }, [queueMonitorPreviewSync])

  const updateAutoRoi = useCallback((key: keyof AppSettings['visualMonitor']['autoRoi'], value: number): void => {
    updateSettings((previous) => {
      const nextSettings: AppSettings = {
        ...previous,
        visualMonitor: {
          ...previous.visualMonitor,
          autoRoi: {
            ...previous.visualMonitor.autoRoi,
            [key]: value
          }
        }
      }
      if (nextSettings.visualMonitor.captureScope === 'roi' && nextSettings.visualMonitor.roiStrategy !== 'manual') {
        queueMonitorPreviewSync(nextSettings, 'Auto ROI 调参已实时同步（点击保存后可持久化）')
      }
      return nextSettings
    })
  }, [queueMonitorPreviewSync])

  const updateVisualMonitorCaptureTuning = useCallback(
    (
      key: keyof AppSettings['visualMonitor']['captureTuning'],
      value: number,
      options?: { previewBackend?: boolean; successMessage?: string }
    ): void => {
      updateSettings((previous) => {
        const nextSettings: AppSettings = {
          ...previous,
          visualMonitor: {
            ...previous.visualMonitor,
            captureTuning: {
              ...previous.visualMonitor.captureTuning,
              [key]: value
            }
          }
        }
        if (options?.previewBackend) {
          queueMonitorPreviewSync(
            nextSettings,
            options.successMessage ?? '截图与缓存阈值已实时同步（点击保存后可持久化）'
          )
        }
        return nextSettings
      })
    },
    [queueMonitorPreviewSync]
  )

  const openOverlay = async (): Promise<void> => {
    try {
      pushStatus('正在切换到前台聊天窗口...', 'info')
      await window.electronAPI.roi.openOverlay()
      pushStatus('已进入 Overlay，请框选聊天区域后确认', 'info')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Overlay 打开失败'
      pushStatus(`Overlay 打开失败: ${message}`, 'error')
    }
  }

  const resetManualRoi = async (): Promise<void> => {
    try {
      const result = await window.electronAPI.roi.resetManualRoi()
      pushStatus(result.message, 'success')
      updateSettings((previous) => ({
        ...previous,
        visualMonitor: {
          ...previous.visualMonitor,
          roiStrategy: 'hybrid',
          manualRoi: null
        }
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : '重置失败'
      pushStatus(`重置失败: ${message}`, 'error')
    }
  }

  const refreshMemoryLibrary = useCallback(async (): Promise<void> => {
    await loadMemoryOverview()
    setMemoryRefreshToken((current) => current + 1)
  }, [loadMemoryOverview, pushStatus])


  const saveSettings = async (): Promise<void> => {
    if (!settings) return
    setIsSaving(true)
    try {
      await window.electronAPI.settings.save(settings)
      await refreshMemoryLibrary()
      pushStatus('设置已保存', 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : '设置保存失败'
      pushStatus(`设置保存失败: ${message}`, 'error')
    } finally {
      setIsSaving(false)
    }
  }

  const memoryCounts = useMemo(() => {
    return new Map(memoryOverview.map((item) => [item.id, item.count]))
  }, [memoryOverview])
  const isSettingsView = selectedFolderId === 'settings'

  return (
    <div className="console-shell">
      <aside className="console-sidebar">
        <div className="console-brand">
          <p>Social Copilot</p>
          <h1>记忆文件</h1>
        </div>

        <nav className="folder-nav" aria-label="记忆文件夹列表">
          <button
            type="button"
            className={`folder-item folder-item-settings ${selectedFolderId === 'settings' ? 'active' : ''}`}
            onClick={() => setSelectedFolderId('settings')}
          >
            <span>系统设置</span>
            <em>配置</em>
          </button>
          {folders.map((folder) => (
            <button
              key={folder.id}
              type="button"
              className={`folder-item ${folder.id === selectedFolderId ? 'active' : ''}`}
              onClick={() => setSelectedFolderId(folder.id as MemorySectionOverview['id'])}
            >
              <span>{folder.name}</span>
              <em>{memoryCounts.get(folder.id as MemorySectionOverview['id']) ?? 0}</em>
            </button>
          ))}
        </nav>
      </aside>

      <main className="console-main">
        <header className="console-header">
          {isSettingsView ? (
            <div>
              <p className="console-kicker">Settings</p>
              <h2>System Settings</h2>
            </div>
          ) : (
            <div />
          )}
        </header>

        {!isSettingsView && <div className={`console-status console-status-${statusTone}`}>{statusMessage}</div>}

        {!settings && <section className="console-card"><p>加载中...</p></section>}

        {settings && (
          <>
            {!isSettingsView && (
              <MemoryLibraryPanel
                sectionId={selectedFolderId as Awaited<ReturnType<typeof window.electronAPI.memoryFiles.getOverview>>[number]['id']}
                ownerUserId={settings.evermemos.ownerUserId}
                ownerDisplayName={ownerDisplayName}
                refreshToken={memoryRefreshToken}
                onRefresh={() => refreshMemoryLibrary()}
              />
            )}

            {isSettingsView && (
              <>
            <section className="console-card settings">
              <h3>账号管理</h3>
              <p className="settings-tip">
                切换账号后，所有数据（画像、好友、记忆等）将按账号隔离存储。建议把当前账号的显示名设置成你的微信昵称，尽量与导入的旧聊天里"本人"名称一致，否则历史聊天导入时可能把自己识别成好友。切换账号会自动刷新数据。
              </p>
              <div className="settings-row">
                <label htmlFor="account-switch">当前账号</label>
                <select
                  id="account-switch"
                  value={settings.evermemos.ownerUserId}
                  onChange={(event) => handleAccountSwitch(event.target.value)}
                >
                  {(settings.evermemos.availableAccounts ?? [
                    { userId: 'captain1307', displayName: 'Me' },
                    { userId: '🌟', displayName: '🌟' }
                  ]).map((account) => (
                    <option key={account.userId} value={account.userId}>
                      {account.displayName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="settings-row">
                <label>账号 ID</label>
                <span className="settings-value">{settings.evermemos.ownerUserId}</span>
              </div>
              <div className="settings-actions-inline">
                <button
                  type="button"
                  onClick={() => setShowNewAccountModal(true)}
                >
                  新建账号
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => handleDeleteAccount(settings.evermemos.ownerUserId)}
                  disabled={(settings.evermemos.availableAccounts?.length ?? 1) <= 1}
                >
                  删除当前账号
                </button>
              </div>
            </section>

            <section className="console-card settings">
              <h3>Assistant 模型</h3>
              <div className="settings-row">
                <label htmlFor="assistant-base-url">API 地址</label>
                <input
                  id="assistant-base-url"
                  type="text"
                  value={settings.modelProviders.assistant.baseUrl}
                  onChange={(event) =>
                    updateModelProvider('assistant', (previous) => ({
                      ...previous,
                      baseUrl: event.target.value
                    }))
                  }
                />
              </div>
              <div className="settings-row">
                <label htmlFor="assistant-api-key">API Key</label>
                <input
                  id="assistant-api-key"
                  type="password"
                  value={settings.modelProviders.assistant.apiKey}
                  onChange={(event) =>
                    updateModelProvider('assistant', (previous) => ({
                      ...previous,
                      apiKey: event.target.value
                    }))
                  }
                />
              </div>
              <div className="settings-row">
                <label htmlFor="assistant-timeout">请求超时(秒)</label>
                <input
                  id="assistant-timeout"
                  type="number"
                  min={ASSISTANT_TIMEOUT_MIN_MS / 1000}
                  max={ASSISTANT_TIMEOUT_MAX_MS / 1000}
                  step={1}
                  value={assistantTimeoutMsToSeconds(settings.modelProviders.assistant.requestTimeoutMs)}
                  onChange={(event) =>
                    updateModelProvider('assistant', (previous) => ({
                      ...previous,
                      requestTimeoutMs: assistantTimeoutSecondsToMs(
                        Number.parseInt(event.target.value || `${ASSISTANT_TIMEOUT_DEFAULT_MS / 1000}`, 10)
                      )
                    }))
                  }
                />
              </div>
              <div className="settings-row settings-row-model-select">
                <label htmlFor="assistant-model-name">模型名称</label>
                <div className="settings-model-select-group">
                  <input
                    id="assistant-model-name"
                    type="text"
                    list="assistant-model-options"
                    value={settings.modelProviders.assistant.modelName}
                    onChange={(event) =>
                      updateModelProvider('assistant', (previous) => ({
                        ...previous,
                        modelName: event.target.value
                      }))
                    }
                    placeholder="可手动输入模型名"
                  />
                  <datalist id="assistant-model-options">
                    {modelLists.assistant.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </datalist>
                  <button
                    type="button"
                    className="settings-inline-btn"
                    onClick={() => void loadModelOptions('assistant')}
                    disabled={modelListLoading.assistant}
                  >
                    {modelListLoading.assistant ? '拉取中...' : '拉取模型'}
                  </button>
                  <button
                    type="button"
                    className="settings-inline-btn"
                    onClick={() => void testProviderConnection('assistant', 'Assistant', settings.modelProviders.assistant.baseUrl, settings.modelProviders.assistant.apiKey, settings.modelProviders.assistant.modelName, settings.modelProviders.assistant.streamStrategy)}
                    disabled={providerConnectionTesting.Assistant === true}
                  >
                    {providerConnectionTesting.Assistant ? '测试中...' : '测试连接'}
                  </button>
                </div>
                {providerFeedback.assistant && (
                  <div className={`settings-feedback settings-feedback-${providerFeedback.assistant.tone}`}>
                    {providerFeedback.assistant.message}
                  </div>
                )}
              </div>
              <div className="settings-row">
                <label htmlFor="assistant-stream-strategy">输出策略</label>
                <select
                  id="assistant-stream-strategy"
                  value={settings.modelProviders.assistant.streamStrategy}
                  onChange={(event) =>
                    updateModelProvider('assistant', (previous) => ({
                      ...previous,
                      streamStrategy: event.target.value as AppSettings['modelProviders']['assistant']['streamStrategy']
                    }))
                  }
                >
                  <option value="non_stream">非流式输出（推荐）</option>
                  <option value="stream">流式输出</option>
                </select>
              </div>
              <div className="settings-row settings-row-model-select">
                <label htmlFor="assistant-persona-skill">外置人格</label>
                <div className="settings-model-select-group">
                  <select
                    id="assistant-persona-skill"
                    value={settings.modelProviders.assistant.personaSkillId}
                    onChange={(event) =>
                      updateModelProvider('assistant', (previous) => ({
                        ...previous,
                        personaSkillId: event.target.value
                      }))
                    }
                  >
                    <option value="">不启用</option>
                    {assistantPersonaSkills.map((skill) => (
                      <option key={skill.skillId} value={skill.skillId}>
                        {skill.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="settings-inline-btn"
                    onClick={() => void loadAssistantPersonaSkills()}
                    disabled={assistantPersonaSkillsLoading}
                  >
                    {assistantPersonaSkillsLoading ? '刷新中...' : '刷新人格'}
                  </button>
                </div>
              </div>
              <p className="settings-tip">
                支持 OpenAI-compatible `/models` 或 `/v1/models`。模型名既可拉取后选择，也可直接手动输入。例如 cliproxy 请填写 `http://localhost:8317/v1`。
              </p>
              <p className="settings-tip">
                这里设置默认人格风格。建议卡片里可以临时切换不同人格做对比，不会改动这里的默认值。
              </p>
            </section>

            <section className="console-card settings">
              <h3>视觉模型</h3>
              <div className="settings-row">
                <label htmlFor="vision-base-url">API 地址</label>
                <input
                  id="vision-base-url"
                  type="text"
                  value={settings.modelProviders.vision.baseUrl}
                  onChange={(event) =>
                    updateModelProvider('vision', (previous) => ({
                      ...previous,
                      baseUrl: event.target.value
                    }))
                  }
                />
              </div>
              <div className="settings-row">
                <label htmlFor="vision-api-key">API Key</label>
                <input
                  id="vision-api-key"
                  type="password"
                  value={settings.modelProviders.vision.apiKey}
                  onChange={(event) =>
                    updateModelProvider('vision', (previous) => ({
                      ...previous,
                      apiKey: event.target.value
                    }))
                  }
                />
              </div>
              <div className="settings-row settings-row-model-select">
                <label htmlFor="vision-model-name">模型名称</label>
                <div className="settings-model-select-group">
                  <input
                    id="vision-model-name"
                    type="text"
                    list="vision-model-options"
                    value={settings.modelProviders.vision.modelName}
                    onChange={(event) =>
                      updateModelProvider('vision', (previous) => ({
                        ...previous,
                        modelName: event.target.value
                      }))
                    }
                    placeholder="可手动输入模型名"
                  />
                  <datalist id="vision-model-options">
                    {modelLists.vision.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </datalist>
                  <button
                    type="button"
                    className="settings-inline-btn"
                    onClick={() => void loadModelOptions('vision')}
                    disabled={modelListLoading.vision}
                  >
                    {modelListLoading.vision ? '拉取中...' : '拉取模型'}
                  </button>
                  <button
                    type="button"
                    className="settings-inline-btn"
                    onClick={() => void testVisionProviderConnection('vision', '视觉模型', settings.modelProviders.vision.baseUrl, settings.modelProviders.vision.apiKey, settings.modelProviders.vision.modelName, settings.modelProviders.vision.maxTokens, settings.modelProviders.vision.disableThinking, settings.modelProviders.vision.streamStrategy)}
                    disabled={providerConnectionTesting['视觉模型'] === true}
                  >
                    {providerConnectionTesting['视觉模型'] ? '测试中...' : '测试连接'}
                  </button>
                </div>
                {providerFeedback.vision && (
                  <div className={`settings-feedback settings-feedback-${providerFeedback.vision.tone}`}>
                    {providerFeedback.vision.message}
                  </div>
                )}
              </div>
              <div className="settings-row">
                <label htmlFor="vision-stream-strategy">输出策略</label>
                <select
                  id="vision-stream-strategy"
                  value={settings.modelProviders.vision.streamStrategy}
                  onChange={(event) =>
                    updateModelProvider('vision', (previous) => ({
                      ...previous,
                      streamStrategy: event.target.value as AppSettings['modelProviders']['vision']['streamStrategy']
                    }))
                  }
                >
                  <option value="stream">流式输出（推荐）</option>
                  <option value="non_stream">非流式输出</option>
                </select>
              </div>
              <div className="settings-row">
                <label htmlFor="vision-max-tokens">Max Tokens</label>
                <input
                  id="vision-max-tokens"
                  type="number"
                  min={64}
                  max={32768}
                  step={256}
                  value={settings.modelProviders.vision.maxTokens}
                  onChange={(event) =>
                    updateModelProvider('vision', (previous) => ({
                      ...previous,
                      maxTokens: Math.max(64, Math.min(32768, parseInt(event.target.value, 10) || 8000))
                    }))
                  }
                />
              </div>
              <p className="settings-tip">
                若目标服务不支持列模型，可直接手动输入模型名，再点"测试连接"走实际调用探测。
              </p>
            </section>

            <section className="console-card settings">
              <h3>EverMemOS 接入</h3>
              <div className="settings-row">
                <label htmlFor="evermemos-enabled">启用增强链路</label>
                <select
                  id="evermemos-enabled"
                  value={settings.evermemos.enabled ? 'enabled' : 'disabled'}
                  onChange={(event) =>
                    updateSettings((previous) => ({
                      ...previous,
                      evermemos: {
                        ...previous.evermemos,
                        enabled: event.target.value === 'enabled'
                      }
                    }))
                  }
                >
                  <option value="disabled">关闭（仅原 Social Copilot）</option>
                  <option value="enabled">开启（失败自动回退）</option>
                </select>
              </div>
              <div className="settings-row">
                <label htmlFor="evermemos-api">EverMemOS API</label>
                <input
                  id="evermemos-api"
                  type="text"
                  value={settings.evermemos.apiBaseUrl}
                  onChange={(event) =>
                    updateSettings((previous) => ({
                      ...previous,
                      evermemos: {
                        ...previous.evermemos,
                        apiBaseUrl: event.target.value
                      }
                    }))
                  }
                />
              </div>
              <div className="settings-row">
                <label htmlFor="evermemos-timeout">请求超时(ms)</label>
                <input
                  id="evermemos-timeout"
                  type="number"
                  min={1000}
                  max={60000}
                  step={500}
                  value={settings.evermemos.requestTimeoutMs}
                  onChange={(event) =>
                    updateSettings((previous) => ({
                      ...previous,
                      evermemos: {
                        ...previous.evermemos,
                        requestTimeoutMs: Number.parseInt(event.target.value || '12000', 10)
                      }
                    }))
                  }
                />
              </div>
              <div className="settings-row">
                <label htmlFor="evermemos-backfill-chunk-size">回填分批大小</label>
                <input
                  id="evermemos-backfill-chunk-size"
                  type="number"
                  min={1}
                  max={200}
                  step={1}
                  value={settings.evermemos.backfillChunkSize}
                  onChange={(event) =>
                    updateSettings((previous) => ({
                      ...previous,
                      evermemos: {
                        ...previous.evermemos,
                        backfillChunkSize: Number.parseInt(event.target.value || '20', 10)
                      }
                    }))
                  }
                />
              </div>
              <div className="settings-row">
                <label htmlFor="evermemos-backfill-message-budget-seconds">每条消息预算 (秒)</label>
                <input
                  id="evermemos-backfill-message-budget-seconds"
                  type="number"
                  min={1}
                  max={120}
                  step={1}
                  value={settings.evermemos.backfillChunkMessageBudgetSeconds}
                  onChange={(event) =>
                    updateSettings((previous) => ({
                      ...previous,
                      evermemos: {
                        ...previous.evermemos,
                        backfillChunkMessageBudgetSeconds: Number.parseInt(
                          event.target.value || '3',
                          10
                        )
                      }
                    }))
                  }
                />
              </div>
              <p className="settings-tip">
                历史回填按线性公式计算超时：单个 chunk 超时 = 回填分批大小 × 每条消息预算秒数。默认 3 秒/条，所以 10 条约 30 秒，20 条约 60 秒；整次顺序回填的理论总预算会再乘以 chunk 数。
              </p>
              <div className="settings-row">
                <label htmlFor="evermemos-llm-base-url">EverMemOS 模型地址</label>
                <input
                  id="evermemos-llm-base-url"
                  type="text"
                  value={settings.evermemos.llm.baseUrl}
                  onChange={(event) =>
                    updateSettings((previous) => ({
                      ...previous,
                      evermemos: {
                        ...previous.evermemos,
                        llm: {
                          ...previous.evermemos.llm,
                          baseUrl: event.target.value
                        }
                      }
                    }))
                  }
                />
              </div>
              <div className="settings-row">
                <label htmlFor="evermemos-llm-api-key">EverMemOS API Key</label>
                <input
                  id="evermemos-llm-api-key"
                  type="password"
                  value={settings.evermemos.llm.apiKey}
                  onChange={(event) =>
                    updateSettings((previous) => ({
                      ...previous,
                      evermemos: {
                        ...previous.evermemos,
                        llm: {
                          ...previous.evermemos.llm,
                          apiKey: event.target.value
                        }
                      }
                    }))
                  }
                />
              </div>
              <div className="settings-row settings-row-model-select">
                <label htmlFor="evermemos-llm-model">EverMemOS 模型名称</label>
                <div className="settings-model-select-group">
                  <input
                    id="evermemos-llm-model"
                    type="text"
                    list="evermemos-model-options"
                    value={settings.evermemos.llm.model}
                    onChange={(event) =>
                      updateSettings((previous) => ({
                        ...previous,
                        evermemos: {
                          ...previous.evermemos,
                          llm: {
                            ...previous.evermemos.llm,
                            model: event.target.value
                          }
                        }
                      }))
                    }
                    placeholder="可手动输入模型名"
                  />
                  <datalist id="evermemos-model-options">
                    {Array.from(new Set([...modelLists.assistant, ...modelLists.vision])).map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </datalist>
                  <button
                    type="button"
                    className="settings-inline-btn"
                    onClick={async () => {
                      const baseUrl = settings.evermemos.llm.baseUrl.trim()
                      if (!baseUrl) {
                        updateProviderFeedback('evermemos', 'EverMemOS 模型地址不能为空', 'error')
                        return
                      }
                      setProviderConnectionTesting((previous) => ({ ...previous, EverMemOS: true }))
                      try {
                        const models = await window.electronAPI.settings.listModels(baseUrl, settings.evermemos.llm.apiKey)
                        setModelLists((previous) => ({ ...previous, assistant: Array.from(new Set([...previous.assistant, ...models])) }))
                        if (models.length > 0 && !models.includes(settings.evermemos.llm.model)) {
                          updateSettings((previous) => ({
                            ...previous,
                            evermemos: {
                              ...previous.evermemos,
                              llm: {
                                ...previous.evermemos.llm,
                                model: models[0]
                              }
                            }
                          }))
                        }
                        updateProviderFeedback(
                          'evermemos',
                          models.length > 0 ? `已拉取 ${models.length} 个 EverMemOS 模型` : 'EverMemOS 模型列表为空',
                          models.length > 0 ? 'success' : 'info'
                        )
                      } catch (error) {
                        const message = error instanceof Error ? error.message : '模型列表拉取失败'
                        updateProviderFeedback('evermemos', `EverMemOS 模型列表拉取失败: ${message}`, 'error')
                      } finally {
                        setProviderConnectionTesting((previous) => ({ ...previous, EverMemOS: false }))
                      }
                    }}
                    disabled={providerConnectionTesting.EverMemOS === true}
                  >
                    {providerConnectionTesting.EverMemOS ? '拉取中...' : '拉取模型'}
                  </button>
                  <button
                    type="button"
                    className="settings-inline-btn"
                    onClick={() => void testProviderConnection('evermemos', 'EverMemOS 模型', settings.evermemos.llm.baseUrl, settings.evermemos.llm.apiKey, settings.evermemos.llm.model)}
                    disabled={providerConnectionTesting['EverMemOS 模型'] === true}
                  >
                    {providerConnectionTesting['EverMemOS 模型'] ? '测试中...' : '测试连接'}
                  </button>
                </div>
                {providerFeedback.evermemos && (
                  <div className={`settings-feedback settings-feedback-${providerFeedback.evermemos.tone}`}>
                    {providerFeedback.evermemos.message}
                  </div>
                )}
              </div>
              <div className="settings-row">
                <label htmlFor="evermemos-vectorize-base-url">Vectorize 地址</label>
                <input
                  id="evermemos-vectorize-base-url"
                  type="text"
                  value={settings.evermemos.vectorize.baseUrl}
                  onChange={(event) =>
                    updateSettings((previous) => ({
                      ...previous,
                      evermemos: {
                        ...previous.evermemos,
                        vectorize: {
                          ...previous.evermemos.vectorize,
                          baseUrl: event.target.value
                        }
                      }
                    }))
                  }
                />
              </div>
              <div className="settings-row">
                <label htmlFor="evermemos-vectorize-api-key">Vectorize API Key</label>
                <input
                  id="evermemos-vectorize-api-key"
                  type="password"
                  value={settings.evermemos.vectorize.apiKey}
                  onChange={(event) =>
                    updateSettings((previous) => ({
                      ...previous,
                      evermemos: {
                        ...previous.evermemos,
                        vectorize: {
                          ...previous.evermemos.vectorize,
                          apiKey: event.target.value
                        }
                      }
                    }))
                  }
                />
              </div>
              <div className="settings-row settings-row-model-select">
                <label htmlFor="evermemos-vectorize-model">Vectorize 模型</label>
                <div className="settings-model-select-group">
                  <input
                    id="evermemos-vectorize-model"
                    type="text"
                    list="evermemos-vectorize-model-options"
                    value={settings.evermemos.vectorize.model}
                    onChange={(event) =>
                      updateSettings((previous) => ({
                        ...previous,
                        evermemos: {
                          ...previous.evermemos,
                          vectorize: {
                            ...previous.evermemos.vectorize,
                            model: event.target.value
                          }
                        }
                      }))
                    }
                    placeholder="可手动输入模型名"
                  />
                  <datalist id="evermemos-vectorize-model-options">
                    {Array.from(new Set([...modelLists.assistant, ...modelLists.vision])).map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </datalist>
                  <button
                    type="button"
                    className="settings-inline-btn"
                    onClick={async () => {
                      const baseUrl = settings.evermemos.vectorize.baseUrl.trim()
                      if (!baseUrl) {
                        updateProviderFeedback('evermemosVectorize', 'Vectorize 地址不能为空', 'error')
                        return
                      }
                      setProviderConnectionTesting((previous) => ({ ...previous, 'EverMemOS Vectorize': true }))
                      try {
                        const models = await window.electronAPI.settings.listModels(baseUrl, settings.evermemos.vectorize.apiKey)
                        setModelLists((previous) => ({ ...previous, assistant: Array.from(new Set([...previous.assistant, ...models])) }))
                        if (models.length > 0 && !models.includes(settings.evermemos.vectorize.model)) {
                          updateSettings((previous) => ({
                            ...previous,
                            evermemos: {
                              ...previous.evermemos,
                              vectorize: {
                                ...previous.evermemos.vectorize,
                                model: models[0]
                              }
                            }
                          }))
                        }
                        updateProviderFeedback(
                          'evermemosVectorize',
                          models.length > 0 ? `已拉取 ${models.length} 个 Vectorize 模型` : 'Vectorize 模型列表为空',
                          models.length > 0 ? 'success' : 'info'
                        )
                      } catch (error) {
                        const message = error instanceof Error ? error.message : '模型列表拉取失败'
                        updateProviderFeedback('evermemosVectorize', `Vectorize 模型列表拉取失败: ${message}`, 'error')
                      } finally {
                        setProviderConnectionTesting((previous) => ({ ...previous, 'EverMemOS Vectorize': false }))
                      }
                    }}
                    disabled={providerConnectionTesting['EverMemOS Vectorize'] === true}
                  >
                    {providerConnectionTesting['EverMemOS Vectorize'] ? '拉取中...' : '拉取模型'}
                  </button>
                  <button
                    type="button"
                    className="settings-inline-btn"
                    onClick={() => void testProviderConnection('evermemosVectorize', 'EverMemOS Vectorize 模型', settings.evermemos.vectorize.baseUrl, settings.evermemos.vectorize.apiKey, settings.evermemos.vectorize.model)}
                    disabled={providerConnectionTesting['EverMemOS Vectorize 模型'] === true}
                  >
                    {providerConnectionTesting['EverMemOS Vectorize 模型'] ? '测试中...' : '测试连接'}
                  </button>
                </div>
                {providerFeedback.evermemosVectorize && (
                  <div className={`settings-feedback settings-feedback-${providerFeedback.evermemosVectorize.tone}`}>
                    {providerFeedback.evermemosVectorize.message}
                  </div>
                )}
              </div>
              <div className="settings-row">
                <label htmlFor="evermemos-rerank-base-url">Rerank 地址</label>
                <input
                  id="evermemos-rerank-base-url"
                  type="text"
                  value={settings.evermemos.rerank.baseUrl}
                  onChange={(event) =>
                    updateSettings((previous) => ({
                      ...previous,
                      evermemos: {
                        ...previous.evermemos,
                        rerank: {
                          ...previous.evermemos.rerank,
                          baseUrl: event.target.value
                        }
                      }
                    }))
                  }
                />
              </div>
              <div className="settings-row">
                <label htmlFor="evermemos-rerank-api-key">Rerank API Key</label>
                <input
                  id="evermemos-rerank-api-key"
                  type="password"
                  value={settings.evermemos.rerank.apiKey}
                  onChange={(event) =>
                    updateSettings((previous) => ({
                      ...previous,
                      evermemos: {
                        ...previous.evermemos,
                        rerank: {
                          ...previous.evermemos.rerank,
                          apiKey: event.target.value
                        }
                      }
                    }))
                  }
                />
              </div>
              <div className="settings-row settings-row-model-select">
                <label htmlFor="evermemos-rerank-model">Rerank 模型</label>
                <div className="settings-model-select-group">
                  <input
                    id="evermemos-rerank-model"
                    type="text"
                    list="evermemos-rerank-model-options"
                    value={settings.evermemos.rerank.model}
                    onChange={(event) =>
                      updateSettings((previous) => ({
                        ...previous,
                        evermemos: {
                          ...previous.evermemos,
                          rerank: {
                            ...previous.evermemos.rerank,
                            model: event.target.value
                          }
                        }
                      }))
                    }
                    placeholder="可手动输入模型名"
                  />
                  <datalist id="evermemos-rerank-model-options">
                    {Array.from(new Set([...modelLists.assistant, ...modelLists.vision])).map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </datalist>
                  <button
                    type="button"
                    className="settings-inline-btn"
                    onClick={async () => {
                      const baseUrl = settings.evermemos.rerank.baseUrl.trim()
                      if (!baseUrl) {
                        updateProviderFeedback('evermemosRerank', 'Rerank 地址不能为空', 'error')
                        return
                      }
                      setProviderConnectionTesting((previous) => ({ ...previous, 'EverMemOS Rerank': true }))
                      try {
                        const models = await window.electronAPI.settings.listModels(baseUrl, settings.evermemos.rerank.apiKey)
                        setModelLists((previous) => ({ ...previous, assistant: Array.from(new Set([...previous.assistant, ...models])) }))
                        if (models.length > 0 && !models.includes(settings.evermemos.rerank.model)) {
                          updateSettings((previous) => ({
                            ...previous,
                            evermemos: {
                              ...previous.evermemos,
                              rerank: {
                                ...previous.evermemos.rerank,
                                model: models[0]
                              }
                            }
                          }))
                        }
                        updateProviderFeedback(
                          'evermemosRerank',
                          models.length > 0 ? `已拉取 ${models.length} 个 Rerank 模型` : 'Rerank 模型列表为空',
                          models.length > 0 ? 'success' : 'info'
                        )
                      } catch (error) {
                        const message = error instanceof Error ? error.message : '模型列表拉取失败'
                        updateProviderFeedback('evermemosRerank', `Rerank 模型列表拉取失败: ${message}`, 'error')
                      } finally {
                        setProviderConnectionTesting((previous) => ({ ...previous, 'EverMemOS Rerank': false }))
                      }
                    }}
                    disabled={providerConnectionTesting['EverMemOS Rerank'] === true}
                  >
                    {providerConnectionTesting['EverMemOS Rerank'] ? '拉取中...' : '拉取模型'}
                  </button>
                  <button
                    type="button"
                    className="settings-inline-btn"
                    onClick={() => void testProviderConnection('evermemosRerank', 'EverMemOS Rerank 模型', settings.evermemos.rerank.baseUrl, settings.evermemos.rerank.apiKey, settings.evermemos.rerank.model)}
                    disabled={providerConnectionTesting['EverMemOS Rerank 模型'] === true}
                  >
                    {providerConnectionTesting['EverMemOS Rerank 模型'] ? '测试中...' : '测试连接'}
                  </button>
                </div>
                {providerFeedback.evermemosRerank && (
                  <div className={`settings-feedback settings-feedback-${providerFeedback.evermemosRerank.tone}`}>
                    {providerFeedback.evermemosRerank.message}
                  </div>
                )}
              </div>
              <p className="settings-tip">
                开启后会优先调用 EverMemOS /api/v1/copilot/process-chat，失败时自动回退到原有建议链路，不影响原功能。
              </p>
            </section>

            <section className="console-card settings">
              <h3>视觉监测设置</h3>
              <div className="settings-row">
                <label htmlFor="visual-monitor-api">视觉监测 API</label>
                <input
                  id="visual-monitor-api"
                  type="text"
                  value={settings.visualMonitor.apiBaseUrl}
                  onChange={(event) =>
                    updateSettings((previous) => ({
                      ...previous,
                      visualMonitor: {
                        ...previous.visualMonitor,
                        apiBaseUrl: event.target.value
                      }
                    }))
                  }
                />
              </div>
              <div className="settings-row">
                <label htmlFor="monitored-app-name">监测前台 App</label>
                <input
                  id="monitored-app-name"
                  type="text"
                  value={settings.visualMonitor.monitoredAppName}
                  onChange={(event) =>
                    updateSettings((previous) => ({
                      ...previous,
                      visualMonitor: {
                        ...previous.visualMonitor,
                        monitoredAppName: event.target.value
                      }
                    }))
                  }
                />
              </div>
              <div className="settings-row">
                <label htmlFor="visual-monitor-testing-mode">调试截图模式</label>
                <select
                  id="visual-monitor-testing-mode"
                  value={settings.visualMonitor.testingMode ? 'enabled' : 'disabled'}
                  onChange={(event) =>
                    updateSettings((previous) => ({
                      ...previous,
                      visualMonitor: {
                        ...previous.visualMonitor,
                        testingMode: event.target.value === 'enabled'
                      }
                    }))
                  }
                >
                  <option value="disabled">关闭</option>
                  <option value="enabled">开启（仅保留有效聊天截图）</option>
                </select>
              </div>
              <div className="settings-row">
                <label htmlFor="monitor-capture-sensitivity">截图灵敏度</label>
                <select
                  id="monitor-capture-sensitivity"
                  value={settings.visualMonitor.captureSensitivity}
                  onChange={(event) =>
                    updateCaptureSensitivity(event.target.value as AppSettings['visualMonitor']['captureSensitivity'])
                  }
                >
                  <option value="high">高灵敏度（适合高频聊天，不适合包含动图场景）</option>
                  <option value="medium">中灵敏度（推荐日常使用）</option>
                  <option value="low">低灵敏度（更保守，尽量压重复）</option>
                </select>
              </div>
              <div className="settings-row">
                <label htmlFor="monitor-capture-scope">截图区域</label>
                <select
                  id="monitor-capture-scope"
                  value={settings.visualMonitor.captureScope}
                  onChange={(event) =>
                    updateCaptureScope(event.target.value as AppSettings['visualMonitor']['captureScope'])
                  }
                >
                  <option value="roi">ROI 聊天区域</option>
                  <option value="full_window">整个应用窗口</option>
                </select>
              </div>
              {settings.visualMonitor.captureScope === 'roi' && (
                <>
                  <div className="settings-row">
                    <label htmlFor="monitor-roi-strategy">ROI 模式</label>
                    <select
                      id="monitor-roi-strategy"
                      value={settings.visualMonitor.roiStrategy}
                      onChange={(event) =>
                        updateRoiStrategy(event.target.value as AppSettings['visualMonitor']['roiStrategy'])
                      }
                    >
                      <option value="hybrid">Hybrid（自动优先）</option>
                      <option value="manual">Manual（手动框选）</option>
                      <option value="auto">Auto（自动识别）</option>
                    </select>
                  </div>
                  <div className="settings-row">
                    <label htmlFor="auto-roi-left">Auto 左边界</label>
                    <div className="settings-slider-control">
                      <input
                        id="auto-roi-left"
                        type="range"
                        min={0}
                        max={0.6}
                        step={0.01}
                        value={settings.visualMonitor.autoRoi.coarseLeftRatio}
                        onChange={(event) => updateAutoRoi('coarseLeftRatio', Number(event.target.value))}
                      />
                      <span>{settings.visualMonitor.autoRoi.coarseLeftRatio.toFixed(2)}</span>
                    </div>
                  </div>
                  <div className="settings-row">
                    <label htmlFor="auto-roi-top">Auto 顶边界</label>
                    <div className="settings-slider-control">
                      <input
                        id="auto-roi-top"
                        type="range"
                        min={0}
                        max={0.3}
                        step={0.01}
                        value={settings.visualMonitor.autoRoi.coarseTopRatio}
                        onChange={(event) => updateAutoRoi('coarseTopRatio', Number(event.target.value))}
                      />
                      <span>{settings.visualMonitor.autoRoi.coarseTopRatio.toFixed(2)}</span>
                    </div>
                  </div>
                  <div className="settings-row">
                    <label htmlFor="auto-roi-width">Auto 宽度</label>
                    <div className="settings-slider-control">
                      <input
                        id="auto-roi-width"
                        type="range"
                        min={0.4}
                        max={0.95}
                        step={0.01}
                        value={settings.visualMonitor.autoRoi.coarseWidthRatio}
                        onChange={(event) => updateAutoRoi('coarseWidthRatio', Number(event.target.value))}
                      />
                      <span>{settings.visualMonitor.autoRoi.coarseWidthRatio.toFixed(2)}</span>
                    </div>
                  </div>
                  <div className="settings-row">
                    <label htmlFor="auto-roi-height">Auto 高度</label>
                    <div className="settings-slider-control">
                      <input
                        id="auto-roi-height"
                        type="range"
                        min={0.6}
                        max={1}
                        step={0.01}
                        value={settings.visualMonitor.autoRoi.coarseHeightRatio}
                        onChange={(event) => updateAutoRoi('coarseHeightRatio', Number(event.target.value))}
                      />
                      <span>{settings.visualMonitor.autoRoi.coarseHeightRatio.toFixed(2)}</span>
                    </div>
                  </div>
                  <div className="settings-row">
                    <label>当前手动 ROI</label>
                    <input
                      type="text"
                      value={
                        settings.visualMonitor.manualRoi
                          ? `${settings.visualMonitor.manualRoi.x},${settings.visualMonitor.manualRoi.y},${settings.visualMonitor.manualRoi.w},${settings.visualMonitor.manualRoi.h}`
                          : '未设置'
                      }
                      readOnly
                    />
                  </div>
                  <div className="settings-actions-inline">
                    <button type="button" onClick={() => void openOverlay()}>
                      启动 Overlay 框选
                    </button>
                    <button type="button" onClick={() => void resetManualRoi()}>
                      重置手动 ROI
                    </button>
                  </div>
                </>
              )}
              <div className="settings-row">
                <label htmlFor="window-gate-confirm-samples">前台确认次数</label>
                <div className="settings-slider-control">
                  <input
                    id="window-gate-confirm-samples"
                    type="range"
                    min={1}
                    max={5}
                    step={1}
                    value={settings.visualMonitor.windowGate.confirmationSamples}
                    onChange={(event) =>
                      updateWindowGate('confirmationSamples', Number.parseInt(event.target.value, 10))
                    }
                  />
                  <span>{settings.visualMonitor.windowGate.confirmationSamples}</span>
                </div>
              </div>
              <div className="settings-row">
                <label htmlFor="window-gate-confirm-interval">确认间隔(ms)</label>
                <div className="settings-slider-control">
                  <input
                    id="window-gate-confirm-interval"
                    type="range"
                    min={0}
                    max={500}
                    step={10}
                    value={settings.visualMonitor.windowGate.confirmationIntervalMs}
                    onChange={(event) =>
                      updateWindowGate('confirmationIntervalMs', Number.parseInt(event.target.value, 10))
                    }
                  />
                  <span>{settings.visualMonitor.windowGate.confirmationIntervalMs}</span>
                </div>
              </div>
              <div className="settings-row">
                <label htmlFor="monitor-hash-similarity-skip">截图跳过阈值</label>
                <input
                  id="monitor-hash-similarity-skip"
                  type="number"
                  min={0}
                  max={1}
                  step={0.001}
                  value={settings.visualMonitor.captureTuning.hashSimilaritySkip}
                  onChange={(event) =>
                    updateVisualMonitorCaptureTuning(
                      'hashSimilaritySkip',
                      Number.parseFloat(event.target.value) || 0,
                      { previewBackend: true }
                    )
                  }
                />
              </div>
              <div className="settings-row">
                <label htmlFor="monitor-ssim-change">截图变化阈值</label>
                <input
                  id="monitor-ssim-change"
                  type="number"
                  min={0}
                  max={1}
                  step={0.001}
                  value={settings.visualMonitor.captureTuning.ssimChange}
                  onChange={(event) =>
                    updateVisualMonitorCaptureTuning(
                      'ssimChange',
                      Number.parseFloat(event.target.value) || 0,
                      { previewBackend: true }
                    )
                  }
                />
              </div>
              <div className="settings-row">
                <label htmlFor="monitor-kept-frame-dedup">缓存截图去重阈值</label>
                <input
                  id="monitor-kept-frame-dedup"
                  type="number"
                  min={0}
                  max={1}
                  step={0.001}
                  value={settings.visualMonitor.captureTuning.keptFrameDedupSimilarityThreshold}
                  onChange={(event) =>
                    updateVisualMonitorCaptureTuning(
                      'keptFrameDedupSimilarityThreshold',
                      Number.parseFloat(event.target.value) || 0,
                      { previewBackend: true }
                    )
                  }
                />
              </div>
              <div className="settings-row">
                <label htmlFor="monitor-chat-record-window">聊天记录截屏辅助去重窗(秒)</label>
                <input
                  id="monitor-chat-record-window"
                  type="number"
                  min={CHAT_RECORD_CAPTURE_DEDUP_WINDOW_MIN_MS / 1000}
                  max={CHAT_RECORD_CAPTURE_DEDUP_WINDOW_MAX_MS / 1000}
                  step={1}
                  value={chatRecordCaptureDedupWindowMsToSeconds(
                    settings.visualMonitor.captureTuning.chatRecordCaptureDedupWindowMs
                  )}
                  onChange={(event) =>
                    updateVisualMonitorCaptureTuning(
                      'chatRecordCaptureDedupWindowMs',
                      chatRecordCaptureDedupWindowSecondsToMs(Number.parseFloat(event.target.value))
                    )
                  }
                />
              </div>
              <p className="settings-tip">
                中灵敏度是推荐日常使用的默认档；高灵敏度更适合高频聊天会话，但不适合包含动图的场景；低灵敏度更保守，适合噪声较多的场景。ROI 支持 Manual / Auto / Hybrid，整个应用窗口会直接截前台窗口。开启调试截图模式后，只保留真正进入聊天记录提取链路的有效截图，不保留被跳过的原始缓存。截图阈值实时同步到后端，聊天记录去重时间窗在保存设置后生效。
              </p>
            </section>

            <section className="console-card settings">
              <h3>存储路径</h3>
              <div className="settings-row">
                <label htmlFor="storage-root">根目录</label>
                <input
                  id="storage-root"
                  type="text"
                  value={settings.storagePaths.rootDir}
                  onChange={(event) => {
                    const rootDir = event.target.value
                    updateSettings((previous) => ({
                      ...previous,
                      storagePaths: {
                        rootDir,
                        cacheDir: `${rootDir}/cache`,
                        chatRecordsDir: `${rootDir}/chat_records`,
                        memoryLibraryDir: `${rootDir}/memory_library`
                      }
                    }))
                  }}
                />
              </div>
              <div className="settings-row">
                <label htmlFor="storage-cache">缓存目录</label>
                <input
                  id="storage-cache"
                  type="text"
                  value={settings.storagePaths.cacheDir}
                  onChange={(event) =>
                    updateSettings((previous) => ({
                      ...previous,
                      storagePaths: {
                        ...previous.storagePaths,
                        cacheDir: event.target.value
                      }
                    }))
                  }
                />
              </div>
              <div className="settings-row">
                <label htmlFor="storage-chat">聊天记录目录</label>
                <input
                  id="storage-chat"
                  type="text"
                  value={settings.storagePaths.chatRecordsDir}
                  onChange={(event) =>
                    updateSettings((previous) => ({
                      ...previous,
                      storagePaths: {
                        ...previous.storagePaths,
                        chatRecordsDir: event.target.value
                      }
                    }))
                  }
                />
              </div>
              <div className="settings-row">
                <label htmlFor="storage-memory">记忆库目录</label>
                <input
                  id="storage-memory"
                  type="text"
                  value={settings.storagePaths.memoryLibraryDir}
                  onChange={(event) =>
                    updateSettings((previous) => ({
                      ...previous,
                      storagePaths: {
                        ...previous.storagePaths,
                        memoryLibraryDir: event.target.value
                      }
                    }))
                  }
                />
              </div>
            </section>

            <section className="console-card settings-save-row">
              <button type="button" className="save-btn" onClick={() => void saveSettings()} disabled={isSaving}>
                {isSaving ? '保存中...' : '保存设置'}
              </button>
            </section>
              </>
            )}
          </>
        )}

        {/* New Account Modal */}
        {showNewAccountModal && (
          <div className="modal-overlay" onClick={() => setShowNewAccountModal(false)}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              <h3>新建账号</h3>
              <p>请输入新账号的显示名称：</p>
              <input
                type="text"
                autoFocus
                value={newAccountName}
                onChange={(e) => setNewAccountName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateNewAccount()
                  if (e.key === 'Escape') {
                    setShowNewAccountModal(false)
                    setNewAccountName('')
                  }
                }}
                placeholder="例如：张三"
              />
              <div className="modal-actions">
                <button
                  type="button"
                  onClick={() => {
                    setShowNewAccountModal(false)
                    setNewAccountName('')
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="save-btn"
                  onClick={handleCreateNewAccount}
                  disabled={!newAccountName.trim()}
                >
                  创建
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
