import { app, BrowserWindow, shell, screen, ipcMain } from 'electron'
import { execFile } from 'child_process'
import { join } from 'path'
import { promisify } from 'util'
import { registerIpcHandlers, unregisterIpcHandlers, initializeApplication } from './ipc-handlers'
import { ensureSocialClawEnvLoaded } from '../services/project-env'
import { ensureWechatForeground } from './wechat-foreground'
import {
  collapseAssistantBoundsFromExpanded,
  clampToWorkArea,
  createAssistantWindowProfile,
  expandAssistantBoundsFromCollapsed,
  isAssistantWindowExpandedBounds,
  createMainWindowProfile,
  getDefaultAssistantPosition
} from './window-profiles'
import { clampRoiRect, isRoiRectValid, type RoiRect } from './roi-overlay-utils'
import { createDipToScreenPointMapper, dipRectToScreenRect } from './coordinate-utils'
import type { AppSettings } from '../models/schemas'

ensureSocialClawEnvLoaded(__dirname)

let mainWindow: BrowserWindow | null = null
let assistantWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let assistantExclusionSyncTimer: NodeJS.Timeout | null = null

const DEFAULT_VISUAL_MONITOR_API_BASE_URL = 'http://127.0.0.1:18777'
const OVERLAY_MIN_SELECTION_SIZE = 10
const ASSISTANT_EXCLUSION_SYNC_DELAY_MS = 180
const VISUAL_MONITOR_START_COMMAND =
  'uvicorn social_copilot.visual_monitor.app:app --host 127.0.0.1 --port 18777 --reload'
const execFileAsync = promisify(execFile)

interface RoiStatusEvent {
  type: 'manual_applied' | 'manual_reset' | 'overlay_cancelled' | 'error' | 'hint'
  message: string
  roi?: RoiRect
}

interface RoiActionResult {
  success: boolean
  message: string
  roi?: RoiRect
}

interface AssistantWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Gets the initial main window position.
 * Uses saved position from settings if available, otherwise centers the console.
 */
async function getInitialMainWindowPosition(): Promise<{ x: number; y: number }> {
  const mainProfile = createMainWindowProfile()
  const primaryDisplay = screen.getPrimaryDisplay()
  const workArea = primaryDisplay.workAreaSize

  const defaultPosition = clampToWorkArea(
    {
      x: Math.floor((workArea.width - mainProfile.width) / 2),
      y: Math.floor((workArea.height - mainProfile.height) / 2)
    },
    { width: mainProfile.width, height: mainProfile.height },
    workArea
  )

  try {
    const { getMemoryManager } = await import('./ipc-handlers')
    const memoryManager = getMemoryManager()

    if (memoryManager) {
      const settings = await memoryManager.loadSettings()
      if (settings.floatingWindow?.position) {
        return clampToWorkArea(
          settings.floatingWindow.position,
          { width: mainProfile.width, height: mainProfile.height },
          workArea
        )
      }
    }
  } catch (error) {
    console.warn('Failed to load saved window position:', error)
  }

  return defaultPosition
}

/**
 * Applies the same external link policy to all renderer windows.
 */
function applyWindowOpenPolicy(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function emitRoiStatus(event: RoiStatusEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('roi:status', event)
  }
}

async function loadSettingsOrDefaults(): Promise<AppSettings | null> {
  try {
    const { getMemoryManager } = await import('./ipc-handlers')
    const memoryManager = getMemoryManager()
    if (!memoryManager) {
      return null
    }
    return memoryManager.loadSettings()
  } catch (error) {
    console.warn('Failed to load settings for ROI operation:', error)
    return null
  }
}

async function saveSettingsIfAvailable(settings: AppSettings): Promise<void> {
  try {
    const { getMemoryManager } = await import('./ipc-handlers')
    const memoryManager = getMemoryManager()
    if (memoryManager) {
      await memoryManager.saveSettings(settings)
    }
  } catch (error) {
    console.warn('Failed to persist settings change:', error)
  }
}

async function getVisualMonitorApiBaseUrl(): Promise<string> {
  const settings = await loadSettingsOrDefaults()
  return settings?.visualMonitor?.apiBaseUrl ?? DEFAULT_VISUAL_MONITOR_API_BASE_URL
}

async function openRoiOverlayWindow(): Promise<void> {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.focus()
    return
  }
  const foregroundStatus = await ensureWechatForeground({
    platform: process.platform,
    runAppleScript: async (script: string) => {
      await execFileAsync('osascript', ['-e', script])
    },
    delay: wait
  })
  if (foregroundStatus.manualActionRequired) {
    emitRoiStatus({
      type: 'hint',
      message: foregroundStatus.message
    })
  }

  const display = screen.getPrimaryDisplay()
  const bounds = display.bounds

  overlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  if (process.platform === 'darwin') {
    overlayWindow.setWindowButtonVisibility(false)
  }

  overlayWindow.on('ready-to-show', () => {
    overlayWindow?.show()
    overlayWindow?.focus()
  })

  overlayWindow.on('closed', () => {
    overlayWindow = null
  })

  applyWindowOpenPolicy(overlayWindow)

  if (process.env.NODE_ENV === 'development') {
    await overlayWindow.loadURL('http://localhost:5173/overlay.html')
    return
  }

  await overlayWindow.loadFile(join(__dirname, '../renderer/overlay.html'))
}

function closeRoiOverlayWindow(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close()
  }
  overlayWindow = null
}

async function applyManualRoiToBackend(absoluteRoi: RoiRect): Promise<void> {
  const baseUrl = await getVisualMonitorApiBaseUrl()
  try {
    const response = await fetch(`${baseUrl}/monitor/roi/manual`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(absoluteRoi)
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`服务返回 ${response.status}: ${body}`)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : '未知错误'
    throw new Error(
      `无法连接视觉监测服务（${baseUrl}）。请先启动后端：${VISUAL_MONITOR_START_COMMAND}。原始错误: ${reason}`
    )
  }
}

async function resetManualRoiOnBackend(): Promise<void> {
  const baseUrl = await getVisualMonitorApiBaseUrl()
  try {
    const response = await fetch(`${baseUrl}/monitor/config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        monitor: {
          roi_strategy: {
            mode: 'hybrid'
          }
        }
      })
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`服务返回 ${response.status}: ${body}`)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : '未知错误'
    throw new Error(
      `无法连接视觉监测服务（${baseUrl}）。请先启动后端：${VISUAL_MONITOR_START_COMMAND}。原始错误: ${reason}`
    )
  }
}

function registerRoiIpcHandlers(): void {
  ipcMain.handle('roi:openOverlay', async () => {
    await openRoiOverlayWindow()
  })

  ipcMain.handle('roi:closeOverlay', async () => {
    closeRoiOverlayWindow()
    emitRoiStatus({
      type: 'overlay_cancelled',
      message: '已取消框选'
    })
  })

  ipcMain.handle('roi:applyManualSelection', async (_event, roi: RoiRect): Promise<RoiActionResult> => {
    try {
      if (!overlayWindow || overlayWindow.isDestroyed()) {
        throw new Error('Overlay 未打开，请重新启动框选')
      }

      if (!isRoiRectValid(roi)) {
        throw new Error('选区数据无效，请重新框选')
      }

      if (roi.w < OVERLAY_MIN_SELECTION_SIZE || roi.h < OVERLAY_MIN_SELECTION_SIZE) {
        throw new Error('选区太小，请重新框选更大的聊天区域')
      }

      const overlayBounds = overlayWindow.getBounds()
      const localClampedRoi = clampRoiRect(roi, overlayBounds.width, overlayBounds.height)
      const absoluteRoi: RoiRect = {
        x: Math.round(overlayBounds.x + localClampedRoi.x),
        y: Math.round(overlayBounds.y + localClampedRoi.y),
        w: Math.round(localClampedRoi.w),
        h: Math.round(localClampedRoi.h)
      }
      const absoluteRoiScreen = dipRectToScreenRect(absoluteRoi, createDipToScreenPointMapper(screen))

      await applyManualRoiToBackend(absoluteRoiScreen)

      const settings = await loadSettingsOrDefaults()
      if (settings) {
        settings.visualMonitor.captureScope = 'roi'
        settings.visualMonitor.roiStrategy = 'manual'
        settings.visualMonitor.manualRoi = absoluteRoi
        await saveSettingsIfAvailable(settings)
      }

      closeRoiOverlayWindow()
      emitRoiStatus({
        type: 'manual_applied',
        message: `手动框选已生效 (${absoluteRoi.x}, ${absoluteRoi.y}, ${absoluteRoi.w}, ${absoluteRoi.h})`,
        roi: absoluteRoi
      })

      return {
        success: true,
        message: '手动框选已生效',
        roi: absoluteRoi
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '手动框选提交失败'
      emitRoiStatus({
        type: 'error',
        message
      })
      return {
        success: false,
        message
      }
    }
  })

  ipcMain.handle('roi:resetManualRoi', async (): Promise<RoiActionResult> => {
    try {
      await resetManualRoiOnBackend()

      const settings = await loadSettingsOrDefaults()
      if (settings) {
        settings.visualMonitor.roiStrategy = 'hybrid'
        settings.visualMonitor.manualRoi = null
        await saveSettingsIfAvailable(settings)
      }

      emitRoiStatus({
        type: 'manual_reset',
        message: '已重置手动框选，当前 ROI 策略切换为 Hybrid'
      })

      return {
        success: true,
        message: '已重置手动框选'
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '重置手动框选失败'
      emitRoiStatus({
        type: 'error',
        message
      })
      return {
        success: false,
        message
      }
    }
  })

}

function unregisterRoiIpcHandlers(): void {
  ipcMain.removeHandler('roi:openOverlay')
  ipcMain.removeHandler('roi:closeOverlay')
  ipcMain.removeHandler('roi:applyManualSelection')
  ipcMain.removeHandler('roi:resetManualRoi')
}

function getPrimaryWorkArea() {
  return screen.getPrimaryDisplay().workAreaSize
}

function clampAssistantBounds(bounds: AssistantWindowBounds): AssistantWindowBounds {
  const workArea = getPrimaryWorkArea()
  const clampedPosition = clampToWorkArea(
    { x: bounds.x, y: bounds.y },
    { width: bounds.width, height: bounds.height },
    workArea
  )
  return {
    ...bounds,
    x: clampedPosition.x,
    y: clampedPosition.y
  }
}

function getAssistantWindowBounds(): AssistantWindowBounds | null {
  if (!assistantWindow || assistantWindow.isDestroyed()) {
    return null
  }
  const bounds = assistantWindow.getBounds()
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height
  }
}

function setAssistantPanelExpanded(expanded: boolean): AssistantWindowBounds | null {
  if (!assistantWindow || assistantWindow.isDestroyed()) {
    return null
  }

  const currentBounds = getAssistantWindowBounds()
  if (!currentBounds) {
    return null
  }

  const currentlyExpanded = isAssistantWindowExpandedBounds(currentBounds)

  if (expanded === currentlyExpanded) {
    return currentBounds
  }

  const targetBounds = expanded
    ? expandAssistantBoundsFromCollapsed(currentBounds)
    : collapseAssistantBoundsFromExpanded(currentBounds)
  const clamped = clampAssistantBounds(targetBounds)

  assistantWindow.setBounds(clamped, false)
  scheduleAssistantExclusionSync()
  return clamped
}

async function syncAssistantExclusionRegionToBackend(): Promise<void> {
  const baseUrl = await getVisualMonitorApiBaseUrl()
  try {
    const response = await fetch(`${baseUrl}/monitor/config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        monitor: {
          // Testing mode keeps full-frame artifacts for debugging, so assistant
          // window exclusion would only hide useful pixels and create black blocks.
          capture_exclusion_regions: []
        }
      })
    })
    if (!response.ok) {
      const body = await response.text()
      console.warn(`assistant exclusion sync failed ${response.status}: ${body}`)
    }
  } catch (error) {
    console.warn('assistant exclusion sync failed:', error)
  }
}

async function getFrontmostAppName(): Promise<string | null> {
  if (process.platform !== 'darwin') {
    return null
  }
  const script = 'tell application "System Events" to get name of first application process whose frontmost is true'
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 800 })
    const name = stdout.trim()
    return name || null
  } catch {
    return null
  }
}

function scheduleAssistantExclusionSync(): void {
  if (assistantExclusionSyncTimer) {
    clearTimeout(assistantExclusionSyncTimer)
  }
  assistantExclusionSyncTimer = setTimeout(() => {
    assistantExclusionSyncTimer = null
    void syncAssistantExclusionRegionToBackend()
  }, ASSISTANT_EXCLUSION_SYNC_DELAY_MS)
}

function registerAssistantWindowIpcHandlers(): void {
  ipcMain.handle('assistant:getBounds', (): AssistantWindowBounds | null => {
    return getAssistantWindowBounds()
  })

  ipcMain.handle('assistant:setPosition', (_event, position: { x: number; y: number }): AssistantWindowBounds | null => {
    if (!assistantWindow || assistantWindow.isDestroyed()) {
      return null
    }
    const currentBounds = assistantWindow.getBounds()
    const next = clampAssistantBounds({
      x: Math.round(position.x),
      y: Math.round(position.y),
      width: currentBounds.width,
      height: currentBounds.height
    })
    assistantWindow.setPosition(next.x, next.y)
    scheduleAssistantExclusionSync()
    return getAssistantWindowBounds()
  })

  ipcMain.handle('assistant:setExpanded', (_event, expanded: boolean): AssistantWindowBounds | null => {
    return setAssistantPanelExpanded(Boolean(expanded))
  })

  ipcMain.handle('assistant:getFrontmostApp', async (): Promise<string | null> => {
    return getFrontmostAppName()
  })

  ipcMain.handle('assistant:syncExclusion', async (): Promise<boolean> => {
    await syncAssistantExclusionRegionToBackend()
    return true
  })
}

function unregisterAssistantWindowIpcHandlers(): void {
  ipcMain.removeHandler('assistant:getBounds')
  ipcMain.removeHandler('assistant:setPosition')
  ipcMain.removeHandler('assistant:setExpanded')
  ipcMain.removeHandler('assistant:getFrontmostApp')
  ipcMain.removeHandler('assistant:syncExclusion')
}

/**
 * Creates the main console window and assistant bubble window.
 */
async function createWindows(): Promise<void> {
  const mainProfile = createMainWindowProfile()
  const assistantProfile = createAssistantWindowProfile('collapsed')
  const mainPosition = await getInitialMainWindowPosition()
  const workArea = getPrimaryWorkArea()

  mainWindow = new BrowserWindow({
    width: mainProfile.width,
    height: mainProfile.height,
    minWidth: mainProfile.minWidth,
    minHeight: mainProfile.minHeight,
    x: mainPosition.x,
    y: mainPosition.y,
    frame: mainProfile.frame,
    alwaysOnTop: mainProfile.alwaysOnTop,
    transparent: mainProfile.transparent,
    skipTaskbar: mainProfile.skipTaskbar,
    resizable: mainProfile.resizable,
    titleBarStyle: mainProfile.titleBarStyle,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const assistantPosition = getDefaultAssistantPosition(workArea, 'collapsed')
  assistantWindow = new BrowserWindow({
    width: assistantProfile.width,
    height: assistantProfile.height,
    x: assistantPosition.x,
    y: assistantPosition.y,
    frame: assistantProfile.frame,
    alwaysOnTop: assistantProfile.alwaysOnTop,
    transparent: assistantProfile.transparent,
    skipTaskbar: assistantProfile.skipTaskbar,
    resizable: assistantProfile.resizable,
    titleBarStyle: assistantProfile.titleBarStyle,
    show: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  assistantWindow.setAlwaysOnTop(true, 'floating')
  assistantWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Prevent macOS traffic-light controls from appearing on the assistant surface.
  if (process.platform === 'darwin') {
    assistantWindow.setWindowButtonVisibility(false)
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })
  assistantWindow.on('ready-to-show', () => {
    assistantWindow?.showInactive()
    scheduleAssistantExclusionSync()
  })

  mainWindow.on('moved', async () => {
    if (mainWindow) {
      const [x, y] = mainWindow.getPosition()
      try {
        const { getMemoryManager } = await import('./ipc-handlers')
        const memoryManager = getMemoryManager()
        if (memoryManager) {
          const settings = await memoryManager.loadSettings()
          settings.floatingWindow.position = { x, y }
          await memoryManager.saveSettings(settings)
        }
      } catch (error) {
        console.warn('Failed to save window position:', error)
      }
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
  assistantWindow.on('closed', () => {
    assistantWindow = null
  })

  applyWindowOpenPolicy(mainWindow)
  applyWindowOpenPolicy(assistantWindow)

  if (process.env.NODE_ENV === 'development') {
    void mainWindow.loadURL('http://localhost:5173')
    void assistantWindow.loadURL('http://localhost:5173/assistant.html')
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    void assistantWindow.loadFile(join(__dirname, '../renderer/assistant.html'))
  }
}

/**
 * Application startup flow
 * 1. Register IPC handlers
 * 2. Initialize application (check first run, Ollama connectivity)
 * 3. Create UI windows
 *
 * Validates: Requirements 1.1, 2.3, 9.1
 */
async function startApplication(): Promise<void> {
  // Step 1: Register IPC handlers before creating window
  registerIpcHandlers()
  registerRoiIpcHandlers()
  registerAssistantWindowIpcHandlers()

  // Step 2: Initialize application
  // This checks first run status, Ollama connectivity, and loads contacts
  try {
    const initResult = await initializeApplication()
    
    console.log('Application initialized:', {
      isFirstRun: initResult.isFirstRun,
      ollamaConnected: initResult.ollamaConnected,
      contactCount: initResult.contacts.length
    })

    // Log Ollama status (Requirement 9.1)
    if (!initResult.ollamaConnected) {
      console.warn('Ollama is not connected. AI features will be limited.')
    }
  } catch (error) {
    console.error('Failed to initialize application:', error)
    // Continue anyway - the UI will show appropriate error states
  }

  await createWindows()
}

app.whenReady().then(async () => {
  await startApplication()

  app.on('activate', async () => {
    if (mainWindow === null || assistantWindow === null) {
      await createWindows()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  if (assistantExclusionSyncTimer) {
    clearTimeout(assistantExclusionSyncTimer)
    assistantExclusionSyncTimer = null
  }
  // Clean up IPC handlers and pending operations
  closeRoiOverlayWindow()
  unregisterAssistantWindowIpcHandlers()
  unregisterRoiIpcHandlers()
  unregisterIpcHandlers()
})
