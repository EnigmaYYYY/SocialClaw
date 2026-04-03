import { describe, expect, it, vi } from 'vitest'

import {
  WECHAT_ACTIVATE_DELAY_MS,
  WECHAT_MANUAL_FOCUS_MESSAGE,
  ensureWechatForeground
} from './wechat-foreground'

describe('ensureWechatForeground', () => {
  it('returns manual-focus hint on win32 without invoking AppleScript', async () => {
    const runAppleScript = vi.fn()
    const delay = vi.fn()

    const result = await ensureWechatForeground({
      platform: 'win32',
      runAppleScript,
      delay
    })

    expect(result.manualActionRequired).toBe(true)
    expect(result.message).toBe(WECHAT_MANUAL_FOCUS_MESSAGE)
    expect(runAppleScript).not.toHaveBeenCalled()
    expect(delay).not.toHaveBeenCalled()
  })

  it('activates via AppleScript on darwin', async () => {
    const runAppleScript = vi.fn().mockResolvedValue(undefined)
    const delay = vi.fn().mockResolvedValue(undefined)

    const result = await ensureWechatForeground({
      platform: 'darwin',
      runAppleScript,
      delay
    })

    expect(result.manualActionRequired).toBe(false)
    expect(result.message).toBe('')
    expect(runAppleScript).toHaveBeenCalledTimes(1)
    expect(delay).toHaveBeenCalledTimes(1)
    expect(delay).toHaveBeenCalledWith(WECHAT_ACTIVATE_DELAY_MS)
  })

  it('throws when all darwin activation scripts fail', async () => {
    const runAppleScript = vi.fn().mockRejectedValue(new Error('fail'))
    const delay = vi.fn().mockResolvedValue(undefined)

    await expect(
      ensureWechatForeground({
        platform: 'darwin',
        runAppleScript,
        delay
      })
    ).rejects.toThrow('无法激活 WeChat')
  })
})
