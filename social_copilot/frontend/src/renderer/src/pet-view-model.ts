export type AssistantState = 'idle' | 'connecting' | 'monitoring' | 'error'
export type PetSurfaceMode = 'pet' | 'whispers' | 'folio'
export type PetMood = 'dormant' | 'attentive' | 'ready' | 'caution'
export type PetAccentTone = 'paper' | 'jade' | 'gold' | 'coral' | 'plum'
export type SocialRiskLevel = 'low' | 'medium' | 'high'
export type SurfacePreference = 'auto' | 'folio'

export interface PetSuggestion {
  content: string
  reason: string
  toneLabel?: string
}

export interface PetViewModelInput {
  assistantState: AssistantState
  surfacePreference: SurfacePreference
  suggestionEnabled: boolean
  currentAppName: string | null
  currentContact: string | null
  currentSessionKey: string | null
  socialRisk: SocialRiskLevel
  suggestions: PetSuggestion[]
}

export interface PetViewModel {
  surfaceMode: PetSurfaceMode
  petMood: PetMood
  accentTone: PetAccentTone
  contextLabel: string
  headline: string
  subheadline: string
  toneLabel: string
}

function buildContextLabel(currentAppName: string | null, currentContact: string | null): string {
  if (currentAppName && currentContact) {
    return `${currentAppName} · ${currentContact}`
  }
  if (currentAppName) {
    return currentAppName
  }
  if (currentContact) {
    return currentContact
  }
  return '未进入会话'
}

function deriveSurfaceMode(input: PetViewModelInput): PetSurfaceMode {
  if (input.surfacePreference === 'folio') {
    return 'folio'
  }
  if (input.assistantState === 'monitoring' && input.suggestionEnabled && input.suggestions.length > 0) {
    return 'whispers'
  }
  return 'pet'
}

function derivePetMood(input: PetViewModelInput): PetMood {
  if (input.assistantState === 'error' || input.socialRisk === 'high') {
    return 'caution'
  }
  if (input.assistantState === 'monitoring' && input.suggestionEnabled && input.suggestions.length > 0) {
    return 'ready'
  }
  const hasActiveChatContext = Boolean(input.currentAppName || input.currentContact || input.currentSessionKey)
  if ((input.assistantState === 'monitoring' || input.assistantState === 'connecting') && hasActiveChatContext) {
    return 'attentive'
  }
  return 'dormant'
}

function deriveAccentTone(mood: PetMood, input: PetViewModelInput): PetAccentTone {
  if (mood === 'caution') {
    return input.assistantState === 'error' ? 'plum' : 'coral'
  }
  if (mood === 'ready') {
    return 'gold'
  }
  if (mood === 'attentive') {
    return 'jade'
  }
  return 'paper'
}

export function buildPetViewModel(input: PetViewModelInput): PetViewModel {
  const leadSuggestion = input.suggestions[0]
  const surfaceMode = deriveSurfaceMode(input)
  const petMood = derivePetMood(input)
  const accentTone = deriveAccentTone(petMood, input)

  if (!leadSuggestion) {
    return {
      surfaceMode,
      petMood,
      accentTone,
      contextLabel: buildContextLabel(input.currentAppName, input.currentContact),
      headline: input.assistantState === 'connecting' ? '正在准备建议' : '等待聊天应用',
      subheadline: input.assistantState === 'connecting' ? '正在同步当前会话' : '进入聊天后显示建议',
      toneLabel: input.assistantState === 'connecting' ? '连接中' : '待机'
    }
  }

  return {
    surfaceMode,
    petMood,
    accentTone,
    contextLabel: buildContextLabel(input.currentAppName, input.currentContact),
    headline: leadSuggestion.content,
    subheadline: leadSuggestion.reason,
    toneLabel: leadSuggestion.toneLabel ?? (input.socialRisk === 'high' ? '先别回这个' : '可以推进')
  }
}
