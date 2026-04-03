import { describe, expect, it } from 'vitest'
import { buildPetViewModel } from './pet-view-model'

describe('pet view model', () => {
  it('keeps the companion in a quiet minimized state when no supported chat context is active', () => {
    const view = buildPetViewModel({
      assistantState: 'idle',
      surfacePreference: 'auto',
      suggestionEnabled: false,
      currentAppName: null,
      currentContact: null,
      currentSessionKey: null,
      socialRisk: 'low',
      suggestions: []
    })

    expect(view.surfaceMode).toBe('pet')
    expect(view.petMood).toBe('dormant')
    expect(view.accentTone).toBe('paper')
    expect(view.contextLabel).toBe('未进入会话')
    expect(view.headline).toBe('等待聊天应用')
  })

  it('switches into whisper mode when fresh suggestions arrive for the active chat', () => {
    const view = buildPetViewModel({
      assistantState: 'monitoring',
      surfacePreference: 'auto',
      suggestionEnabled: true,
      currentAppName: 'WeChat',
      currentContact: '林然',
      currentSessionKey: 'wechat-linran',
      socialRisk: 'medium',
      suggestions: [
        {
          content: '先接住她这句，再顺手补一句“我明白你的担心”。',
          reason: '先安抚再推进，更稳。',
          toneLabel: '先接住'
        }
      ]
    })

    expect(view.surfaceMode).toBe('whispers')
    expect(view.petMood).toBe('ready')
    expect(view.accentTone).toBe('gold')
    expect(view.contextLabel).toBe('WeChat · 林然')
    expect(view.toneLabel).toBe('先接住')
    expect(view.headline).toContain('先接住她这句')
  })

  it('stays dormant while background monitoring is running but no supported chat app is active', () => {
    const view = buildPetViewModel({
      assistantState: 'monitoring',
      surfacePreference: 'auto',
      suggestionEnabled: false,
      currentAppName: null,
      currentContact: null,
      currentSessionKey: null,
      socialRisk: 'low',
      suggestions: []
    })

    expect(view.surfaceMode).toBe('pet')
    expect(view.petMood).toBe('dormant')
    expect(view.headline).toBe('等待聊天应用')
  })

  it('opens the folio view for deeper review and highlights delicate situations', () => {
    const view = buildPetViewModel({
      assistantState: 'monitoring',
      surfacePreference: 'folio',
      suggestionEnabled: true,
      currentAppName: 'Discord',
      currentContact: '产品群',
      currentSessionKey: 'discord-product',
      socialRisk: 'high',
      suggestions: [
        {
          content: '这句先别直接发，容易显得过于防御。',
          reason: '群聊里情绪密度高，建议先降压。',
          toneLabel: '先别回这个'
        }
      ]
    })

    expect(view.surfaceMode).toBe('folio')
    expect(view.petMood).toBe('caution')
    expect(view.accentTone).toBe('coral')
    expect(view.contextLabel).toBe('Discord · 产品群')
    expect(view.toneLabel).toBe('先别回这个')
    expect(view.subheadline).toBe('群聊里情绪密度高，建议先降压。')
  })
})
