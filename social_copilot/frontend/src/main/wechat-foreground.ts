export const WECHAT_ACTIVATE_DELAY_MS = 180
export const WECHAT_MANUAL_FOCUS_MESSAGE =
  '当前系统不支持自动激活微信。请先手动切到微信窗口，再进行 ROI 框选。'

export interface EnsureWechatForegroundResult {
  manualActionRequired: boolean
  message: string
}

export interface EnsureWechatForegroundOptions {
  platform: NodeJS.Platform
  runAppleScript: (script: string) => Promise<void>
  delay: (ms: number) => Promise<void>
}

const ACTIVATION_SCRIPTS = [
  'tell application id "com.tencent.xinWeChat" to activate',
  'tell application "WeChat" to activate',
  'tell application "微信" to activate',
  'tell application "System Events" to set frontmost of process "WeChat" to true',
  'tell application "System Events" to set frontmost of process "微信" to true'
]

export async function ensureWechatForeground(
  options: EnsureWechatForegroundOptions
): Promise<EnsureWechatForegroundResult> {
  if (options.platform !== 'darwin') {
    return {
      manualActionRequired: true,
      message: WECHAT_MANUAL_FOCUS_MESSAGE
    }
  }

  for (const script of ACTIVATION_SCRIPTS) {
    try {
      await options.runAppleScript(script)
      await options.delay(WECHAT_ACTIVATE_DELAY_MS)
      return {
        manualActionRequired: false,
        message: ''
      }
    } catch {
      continue
    }
  }

  throw new Error('无法激活 WeChat，请确认微信桌面端已启动')
}
