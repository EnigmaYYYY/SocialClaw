import { describe, expect, it, vi } from 'vitest'

import {
  ChatMonitorService,
  LEGACY_CHAT_MONITOR_UNAVAILABLE_MESSAGE
} from './chat-monitor'

describe('ChatMonitorService platform fallback', () => {
  it('returns unavailable status on non-macOS initialize', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

    try {
      const monitor = new ChatMonitorService()
      const status = await monitor.initialize()
      expect(status.mode).toBe('unavailable')
      expect(status.isMonitoring).toBe(false)
      expect(status.errorMessage).toBe(LEGACY_CHAT_MONITOR_UNAVAILABLE_MESSAGE)
    } finally {
      platformSpy.mockRestore()
    }
  })
})
