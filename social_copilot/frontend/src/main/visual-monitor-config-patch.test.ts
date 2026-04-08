import { describe, expect, it } from 'vitest'

import { DEFAULT_APP_SETTINGS } from '../models/schemas'
import { buildVisualMonitorConfigPatchPayload } from './visual-monitor-config-patch'

describe('buildVisualMonitorConfigPatchPayload', () => {
  it('passes assistant persona skill config to visual monitor and disables auto selection', () => {
    const settings = JSON.parse(JSON.stringify(DEFAULT_APP_SETTINGS)) as any
    settings.modelProviders.assistant.personaSkillId = 'tong-jincheng-skill'
    settings.modelProviders.assistant.streamStrategy = 'stream'

    const payload = buildVisualMonitorConfigPatchPayload({
      settings,
      runDir: '/tmp/socialclaw-run'
    })
    const monitorPayload = payload.monitor as any

    expect(monitorPayload.assistant.default_skill_id).toBe('tong-jincheng-skill')
    expect(monitorPayload.assistant.skill_selection_enabled).toBe(false)
    expect(monitorPayload.assistant.stream_strategy).toBe('stream')
  })

  it('passes vision stream strategy to visual monitor config', () => {
    const settings = JSON.parse(JSON.stringify(DEFAULT_APP_SETTINGS)) as any
    settings.modelProviders.vision.streamStrategy = 'non_stream'

    const payload = buildVisualMonitorConfigPatchPayload({
      settings,
      runDir: '/tmp/socialclaw-run'
    })
    const monitorPayload = payload.monitor as any

    expect(monitorPayload.vision.litellm.stream_strategy).toBe('non_stream')
  })
})
