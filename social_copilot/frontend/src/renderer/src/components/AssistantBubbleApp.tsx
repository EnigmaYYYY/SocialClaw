import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  RealtimeSuggestionAdapter,
  type AdapterStatus,
  type PendingSessionConfirmationUpdate
} from '../../../services/realtime-suggestion-adapter'
import {
  buildPetViewModel,
  type PetSuggestion,
  type SocialRiskLevel,
  type SurfacePreference
} from '../pet-view-model'

type AssistantState = AdapterStatus
const COLLAPSED_WINDOW_SIZE = 80

interface DragState {
  active: boolean
  dragging: boolean
  moved: boolean
  startMouseX: number
  startMouseY: number
  startWindowX: number
  startWindowY: number
}

interface AssistantWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

interface SuggestionViewItem extends PetSuggestion {
  id: string
  timeLabel: string
}

interface PendingSessionConfirmationView extends PendingSessionConfirmationUpdate {
  inputValue: string
}

const SUGGESTION_CARD_ACTION_LABELS = {
  copy: '复制',
  regenerate: '重新生成',
  skip: '跳过',
  expand: '展开'
} as const

const ENABLE_FOREGROUND_PROMPT_AUTO_OPEN = true

export function resolveSurfacePreferenceForAssistantActivation(hasSuggestions: boolean): SurfacePreference {
  return hasSuggestions ? 'auto' : 'folio'
}

export function shouldShowSuggestionCardShortcut(hasSuggestions: boolean): boolean {
  return hasSuggestions
}

export function getVisibleSuggestionCardSuggestions<T>(suggestions: T[], limit = 3): T[] {
  return suggestions.slice(0, limit)
}

export function getSuggestionCardActionLabels(): typeof SUGGESTION_CARD_ACTION_LABELS {
  return SUGGESTION_CARD_ACTION_LABELS
}

export function shouldAutoExpandForSuggestionUpdate(suggestionCount: number): boolean {
  return suggestionCount > 0
}

export function shouldAutoOpenPromptForForegroundApp(
  currentAppName: string | null,
  suggestionEnabled: boolean,
  lastPromptedApp: string | null
): boolean {
  if (!ENABLE_FOREGROUND_PROMPT_AUTO_OPEN) {
    return false
  }

  if (!currentAppName || suggestionEnabled) {
    return false
  }

  return lastPromptedApp !== currentAppName
}

export function resolveAssistantActivationIntent(
  expanded: boolean,
  surfaceMode: 'pet' | 'whispers' | 'folio',
  hasSuggestions: boolean
): 'collapse' | 'open_suggestion' | 'open_folio' {
  if (expanded && (surfaceMode === 'whispers' || surfaceMode === 'folio')) {
    return 'collapse'
  }
  return hasSuggestions ? 'open_suggestion' : 'open_folio'
}

type PetExpressionSpeed = 'snap' | 'fast' | 'normal' | 'smooth' | 'slow' | 'drift'

interface EyePose {
  w: number
  h: number
  br: string
  tx?: number
  ty?: number
  sx?: number
  sy?: number
  rot?: number
}

type PetExpressionName =
  | 'normal'
  | 'lookLeft'
  | 'lookRight'
  | 'lookUp'
  | 'lookDown'
  | 'squint'
  | 'blink'
  | 'halfBlink'
  | 'surprised'
  | 'wow'
  | 'sparkle'
  | 'wink'
  | 'winkR'
  | 'flattered'
  | 'nervous'
  | 'happy'
  | 'superHappy'
  | 'giggle'
  | 'curious'
  | 'thinking'
  | 'hmm'
  | 'sad'
  | 'angry'
  | 'love'
  | 'smug'
  | 'confused'
  | 'softSmile'
  | 'focus'
  | 'pout'
  | 'peekL'
  | 'peekR'
  | 'mischief'
  | 'worried'
  | 'sleepy'
  | 'drowsy'
  | 'dead'
  | 'content'
  | 'bliss'
  | 'daydream'
  | 'blank'

interface PetExpressionDefinition {
  left: EyePose
  right?: EyePose
  speed?: PetExpressionSpeed
}

interface PetMotionAction {
  steps: Array<{ delay: number; expression: PetExpressionName }>
  totalDuration: number
  disableTracking?: boolean
}

const EYE_SPEED = {
  snap: '0s',
  fast: '0.08s',
  normal: '0.18s',
  smooth: '0.3s',
  slow: '0.45s',
  drift: '0.6s'
} satisfies Record<PetExpressionSpeed, string>

const DEFAULT_EYE_POSE: EyePose = {
  w: 11,
  h: 19,
  br: '6px',
  tx: 0,
  ty: 0,
  sx: 1,
  sy: 1,
  rot: 0
}

const PET_EXPRESSIONS: Record<PetExpressionName, PetExpressionDefinition> = {
  normal: { left: { w: 11, h: 19, br: '6px' } },
  lookLeft: { left: { w: 11, h: 19, br: '6px', tx: -4 } },
  lookRight: { left: { w: 11, h: 19, br: '6px', tx: 4 } },
  lookUp: { left: { w: 11, h: 19, br: '6px', ty: -5 } },
  lookDown: { left: { w: 11, h: 15, br: '6px', ty: 4 } },
  squint: { left: { w: 12, h: 6, br: '4px', ty: 1 } },
  blink: { left: { w: 12, h: 3, br: '3px' }, speed: 'snap' },
  halfBlink: { left: { w: 11, h: 10, br: '5px' }, speed: 'fast' },
  surprised: { left: { w: 13, h: 21, br: '7px' }, speed: 'fast' },
  wow: { left: { w: 16, h: 16, br: '8px' }, speed: 'fast' },
  sparkle: { left: { w: 12, h: 12, br: '3px', rot: 45 }, speed: 'fast' },
  wink: {
    left: { w: 13, h: 7, br: '7px 7px 3px 3px', ty: 1 },
    right: { w: 11, h: 19, br: '6px' },
    speed: 'fast'
  },
  winkR: {
    left: { w: 11, h: 19, br: '6px' },
    right: { w: 13, h: 7, br: '7px 7px 3px 3px', ty: 1 },
    speed: 'fast'
  },
  flattered: { left: { w: 14, h: 20, br: '7px', sy: 1.05 }, speed: 'fast' },
  nervous: { left: { w: 9, h: 14, br: '5px', ty: 1, sx: 0.9 }, speed: 'fast' },
  happy: { left: { w: 13, h: 7, br: '7px 7px 3px 3px', ty: 1 }, speed: 'smooth' },
  superHappy: { left: { w: 15, h: 5, br: '8px 8px 3px 3px', ty: 1, sx: 1.1 }, speed: 'smooth' },
  giggle: {
    left: { w: 13, h: 7, br: '7px 7px 3px 3px', ty: 1, rot: -8 },
    right: { w: 13, h: 7, br: '7px 7px 3px 3px', ty: 1, rot: 8 },
    speed: 'smooth'
  },
  curious: {
    left: { w: 9, h: 16, br: '5px', ty: -1 },
    right: { w: 13, h: 21, br: '7px', ty: -1 },
    speed: 'smooth'
  },
  thinking: { left: { w: 10, h: 17, br: '5px', ty: -3 }, speed: 'smooth' },
  hmm: {
    left: { w: 11, h: 16, br: '5px', ty: -1, rot: 8 },
    right: { w: 9, h: 13, br: '5px', rot: -8 },
    speed: 'smooth'
  },
  sad: { left: { w: 10, h: 16, br: '5px', ty: 3, sy: 0.9 }, speed: 'smooth' },
  angry: {
    left: { w: 12, h: 14, br: '3px 6px 6px 3px', ty: -2, rot: -12 },
    right: { w: 12, h: 14, br: '6px 3px 3px 6px', ty: -2, rot: 12 },
    speed: 'smooth'
  },
  love: { left: { w: 14, h: 13, br: '7px 1px 7px 1px', rot: 45, sx: 1.1 }, speed: 'smooth' },
  smug: {
    left: { w: 11, h: 7, br: '6px 6px 3px 3px', ty: 1 },
    right: { w: 9, h: 15, br: '5px', tx: 3 },
    speed: 'smooth'
  },
  confused: {
    left: { w: 11, h: 19, br: '6px', ty: -2 },
    right: { w: 9, h: 12, br: '5px', ty: 2, rot: 15 },
    speed: 'smooth'
  },
  softSmile: { left: { w: 12, h: 9, br: '6px 6px 3px 3px', ty: 1 }, speed: 'smooth' },
  focus: { left: { w: 9, h: 18, br: '4px', ty: -1 }, speed: 'smooth' },
  pout: { left: { w: 10, h: 11, br: '5px', ty: 2, sy: 0.85 }, speed: 'smooth' },
  peekL: {
    left: { w: 11, h: 6, br: '4px', ty: 1 },
    right: { w: 10, h: 17, br: '5px', tx: -3 },
    speed: 'smooth'
  },
  peekR: {
    left: { w: 10, h: 17, br: '5px', tx: 3 },
    right: { w: 11, h: 6, br: '4px', ty: 1 },
    speed: 'smooth'
  },
  mischief: {
    left: { w: 13, h: 14, br: '7px', rot: -5, ty: -1 },
    right: { w: 9, h: 10, br: '5px', rot: 10, ty: 1 },
    speed: 'smooth'
  },
  worried: {
    left: { w: 11, h: 16, br: '5px', ty: 1, rot: 5 },
    right: { w: 11, h: 16, br: '5px', ty: 1, rot: -5 },
    speed: 'smooth'
  },
  sleepy: { left: { w: 12, h: 4, br: '4px', ty: 2 }, speed: 'slow' },
  drowsy: { left: { w: 11, h: 10, br: '5px', ty: 1 }, speed: 'slow' },
  dead: { left: { w: 10, h: 3, br: '2px', ty: 3 }, speed: 'slow' },
  content: { left: { w: 13, h: 8, br: '7px 7px 4px 4px', sx: 1.05 }, speed: 'slow' },
  bliss: { left: { w: 14, h: 5, br: '7px 7px 2px 2px', ty: 1, sx: 1.1 }, speed: 'slow' },
  daydream: { left: { w: 13, h: 20, br: '7px', ty: -3, sx: 0.95 }, speed: 'drift' },
  blank: { left: { w: 8, h: 15, br: '4px' }, speed: 'drift' }
}

const PET_BASE_EXPRESSION: Record<ReturnType<typeof buildPetViewModel>['petMood'], PetExpressionName> = {
  dormant: 'sleepy',
  attentive: 'normal',
  ready: 'happy',
  caution: 'worried'
}

const PET_TRACKING_ENABLED: Record<ReturnType<typeof buildPetViewModel>['petMood'], boolean> = {
  dormant: false,
  attentive: true,
  ready: false,
  caution: false
}

const PET_IDLE_ACTIONS: Record<ReturnType<typeof buildPetViewModel>['petMood'], PetMotionAction[]> = {
  dormant: [
    { steps: [{ delay: 0, expression: 'drowsy' }, { delay: 700, expression: 'sleepy' }], totalDuration: 1700, disableTracking: true },
    { steps: [{ delay: 0, expression: 'daydream' }, { delay: 1200, expression: 'blank' }], totalDuration: 2300, disableTracking: true },
    { steps: [{ delay: 0, expression: 'halfBlink' }, { delay: 360, expression: 'sleepy' }], totalDuration: 1200, disableTracking: true }
  ],
  attentive: [
    { steps: [{ delay: 0, expression: 'lookLeft' }, { delay: 450, expression: 'lookRight' }, { delay: 900, expression: 'normal' }], totalDuration: 1500 },
    { steps: [{ delay: 0, expression: 'curious' }, { delay: 720, expression: 'hmm' }], totalDuration: 1700, disableTracking: true },
    { steps: [{ delay: 0, expression: 'peekL' }, { delay: 650, expression: 'peekR' }], totalDuration: 1600, disableTracking: true },
    { steps: [{ delay: 0, expression: 'focus' }, { delay: 820, expression: 'softSmile' }], totalDuration: 1700, disableTracking: true }
  ],
  ready: [
    { steps: [{ delay: 0, expression: 'happy' }, { delay: 420, expression: 'giggle' }], totalDuration: 1500, disableTracking: true },
    { steps: [{ delay: 0, expression: 'superHappy' }, { delay: 520, expression: 'sparkle' }, { delay: 920, expression: 'softSmile' }], totalDuration: 1800, disableTracking: true },
    { steps: [{ delay: 0, expression: 'flattered' }, { delay: 480, expression: 'love' }], totalDuration: 1700, disableTracking: true },
    { steps: [{ delay: 0, expression: 'content' }, { delay: 650, expression: 'softSmile' }], totalDuration: 1700, disableTracking: true }
  ],
  caution: [
    { steps: [{ delay: 0, expression: 'worried' }, { delay: 560, expression: 'thinking' }], totalDuration: 1700, disableTracking: true },
    { steps: [{ delay: 0, expression: 'confused' }, { delay: 620, expression: 'focus' }], totalDuration: 1700, disableTracking: true },
    { steps: [{ delay: 0, expression: 'nervous' }, { delay: 520, expression: 'peekR' }, { delay: 980, expression: 'softSmile' }], totalDuration: 1800, disableTracking: true },
    { steps: [{ delay: 0, expression: 'angry' }, { delay: 520, expression: 'blink' }, { delay: 700, expression: 'worried' }], totalDuration: 1600, disableTracking: true }
  ]
}

const PET_HOVER_ACTIONS: Partial<Record<ReturnType<typeof buildPetViewModel>['petMood'], PetMotionAction>> = {
  attentive: { steps: [{ delay: 0, expression: 'curious' }], totalDuration: 900, disableTracking: true },
  ready: { steps: [{ delay: 0, expression: 'giggle' }], totalDuration: 900, disableTracking: true },
  caution: { steps: [{ delay: 0, expression: 'focus' }], totalDuration: 900, disableTracking: true }
}

function applyEyeTransition(
  leftEye: HTMLSpanElement,
  rightEye: HTMLSpanElement,
  speed: PetExpressionSpeed
): void {
  const duration = EYE_SPEED[speed]
  const easing =
    speed === 'snap' || speed === 'fast'
      ? 'linear'
      : speed === 'slow' || speed === 'drift'
        ? 'cubic-bezier(0.4, 0, 0.2, 1)'
        : 'cubic-bezier(0.25, 1, 0.5, 1)'
  const transition = `width ${duration} ${easing}, height ${duration} ${easing}, border-radius ${duration} ${easing}, transform ${duration} ${easing}`
  leftEye.style.transition = transition
  rightEye.style.transition = transition
}

function applyEyePose(element: HTMLSpanElement, pose: EyePose): void {
  const merged = { ...DEFAULT_EYE_POSE, ...pose }
  element.style.width = `${merged.w}px`
  element.style.height = `${merged.h}px`
  element.style.borderRadius = merged.br
  element.style.transform = `translate(${merged.tx}px, ${merged.ty}px) scale(${merged.sx}, ${merged.sy}) rotate(${merged.rot}deg)`
}

function applyPetExpressionToEyes(
  leftEye: HTMLSpanElement,
  rightEye: HTMLSpanElement,
  expressionName: PetExpressionName
): void {
  const expression = PET_EXPRESSIONS[expressionName]
  if (!expression) {
    return
  }
  applyEyeTransition(leftEye, rightEye, expression.speed ?? 'normal')
  applyEyePose(leftEye, expression.left)
  applyEyePose(rightEye, expression.right ?? expression.left)
  window.setTimeout(() => {
    leftEye.style.transition = ''
    rightEye.style.transition = ''
  }, 20)
}

export function isExpandedBounds(bounds: AssistantWindowBounds): boolean {
  return bounds.width > COLLAPSED_WINDOW_SIZE || bounds.height > COLLAPSED_WINDOW_SIZE
}

export function resolveAssistantExpandedFlag(
  bounds: AssistantWindowBounds | null,
  expandedState: boolean
): boolean {
  if (!bounds) {
    return expandedState
  }
  return isExpandedBounds(bounds)
}

function inferToneLabel(content: string, reason: string): string {
  const combined = `${content} ${reason}`.toLowerCase()
  if (/risk|cautious|careful|don't|do not/.test(combined)) {
    return '谨慎'
  }
  if (/empathy|understand|support|comfort/.test(combined)) {
    return '安抚'
  }
  if (/confirm|next step|plan|action/.test(combined)) {
    return '推进'
  }
  if (/light|casual|funny|joke/.test(combined)) {
    return '轻松'
  }
  if (/safe|stable|steady/.test(combined)) {
    return '稳妥'
  }
  return '建议'
}

function normalizeSupportedAppName(rawName: string | null): string | null {
  if (!rawName) {
    return null
  }
  if (/wechat|weixin/i.test(rawName)) {
    return 'WeChat'
  }
  if (/wecom|wxwork/i.test(rawName)) {
    return 'WeCom'
  }
  if (/discord/i.test(rawName)) {
    return 'Discord'
  }
  if (/telegram/i.test(rawName)) {
    return 'Telegram'
  }
  if (/slack/i.test(rawName)) {
    return 'Slack'
  }
  if (/whatsapp/i.test(rawName)) {
    return 'WhatsApp'
  }
  if (/mail|outlook|gmail/i.test(rawName)) {
    return 'Email'
  }
  return null
}

function inferAppName(
  sessionKey: string | null,
  contactName: string | null,
  frontmostAppName: string | null
): string | null {
  if (sessionKey?.startsWith('discord')) {
    return 'Discord'
  }
  if (sessionKey?.startsWith('telegram')) {
    return 'Telegram'
  }
  if (sessionKey?.startsWith('slack')) {
    return 'Slack'
  }
  if (sessionKey?.startsWith('whatsapp')) {
    return 'WhatsApp'
  }
  if (sessionKey?.startsWith('email')) {
    return 'Email'
  }
  if (contactName) {
    return 'WeChat'
  }
  return normalizeSupportedAppName(frontmostAppName)
}

function inferSocialRisk(
  assistantState: AssistantState,
  suggestion: SuggestionViewItem | undefined
): SocialRiskLevel {
  if (assistantState === 'error') {
    return 'high'
  }
  if (!suggestion) {
    return 'low'
  }

  const combined = `${suggestion.content} ${suggestion.reason} ${suggestion.toneLabel ?? ''}`.toLowerCase()
  if (/risk|sensitive|cautious|careful|don't|do not/.test(combined)) {
    return 'high'
  }
  if (/empathy|comfort|support|safe|stable|steady/.test(combined)) {
    return 'medium'
  }
  return 'low'
}

function createStatusSummary(
  assistantState: AssistantState,
  suggestionEnabled: boolean,
  risk: SocialRiskLevel,
  hasSuggestions: boolean,
  currentAppName: string | null,
  gatePassed: boolean | null
): {
  signal: string
  posture: string
  strategy: string
} {
  if (assistantState === 'connecting') {
    return {
      signal: '正在准备建议',
      posture: '同步上下文',
      strategy: '请稍候'
    }
  }

  if (assistantState === 'error') {
    return {
      signal: '连接波动',
      posture: '谨慎模式',
      strategy: '先不要依赖建议'
    }
  }

  if (assistantState === 'monitoring' && !suggestionEnabled) {
    return {
      signal: '建议已暂停',
      posture: '仅监控',
      strategy: '可随时恢复建议'
    }
  }

  if (assistantState === 'monitoring' && hasSuggestions) {
    return {
      signal: risk === 'high' ? '风险偏高' : '有可用建议',
      posture: risk === 'high' ? '先降压' : '可顺势回复',
      strategy: risk === 'high' ? '先别回太满' : '先发最稳的一句'
    }
  }

  if (assistantState === 'monitoring') {
    return {
      signal: currentAppName ? `当前应用 ${currentAppName}` : '等待聊天应用',
      posture: gatePassed ? '等待新消息' : '等待进入可识别会话',
      strategy: currentAppName ? '当前暂无建议' : '打开受支持聊天应用后开始工作'
    }
  }

  return {
    signal: '等待聊天应用',
    posture: '待机',
    strategy: '打开聊天后显示建议'
  }
}
function reorderSuggestions(
  suggestions: SuggestionViewItem[],
  highlightedIndex: number
): Array<SuggestionViewItem & { originalIndex: number }> {
  if (suggestions.length === 0) {
    return []
  }

  const safeIndex = Math.min(Math.max(highlightedIndex, 0), suggestions.length - 1)
  const head = { ...suggestions[safeIndex], originalIndex: safeIndex }
  const rest = suggestions
    .map((suggestion, index) => ({ ...suggestion, originalIndex: index }))
    .filter((suggestion) => suggestion.originalIndex !== safeIndex)
  return [head, ...rest]
}

export function AssistantBubbleApp(): JSX.Element {
  const [assistantState, setAssistantState] = useState<AssistantState>('idle')
  const [expanded, setExpanded] = useState(false)
  const [surfacePreference, setSurfacePreference] = useState<SurfacePreference>('auto')
  const [suggestionEnabled, setSuggestionEnabled] = useState(false)
  const [promptVisible, setPromptVisible] = useState(false)
  const [suggestions, setSuggestions] = useState<SuggestionViewItem[]>([])
  const [highlightedSuggestionIndex, setHighlightedSuggestionIndex] = useState(0)
  const [currentContact, setCurrentContact] = useState<string | null>(null)
  const [currentSessionKey, setCurrentSessionKey] = useState<string | null>(null)
  const [pendingSessionConfirmation, setPendingSessionConfirmation] = useState<PendingSessionConfirmationView | null>(null)
  const [frontmostAppName, setFrontmostAppName] = useState<string | null>(null)
  const [frontmostGatePassed, setFrontmostGatePassed] = useState<boolean | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const adapterRef = useRef<RealtimeSuggestionAdapter | null>(null)
  const windowBoundsRef = useRef<AssistantWindowBounds | null>(null)
  const orbWrapperRef = useRef<HTMLSpanElement | null>(null)
  const eyeLeftRef = useRef<HTMLSpanElement | null>(null)
  const eyeRightRef = useRef<HTMLSpanElement | null>(null)
  const dragStateRef = useRef<DragState>({
    active: false,
    dragging: false,
    moved: false,
    startMouseX: 0,
    startMouseY: 0,
    startWindowX: 0,
    startWindowY: 0
  })
  const lastPromptedAppRef = useRef<string | null>(null)
  const motionTimersRef = useRef<number[]>([])
  const blinkTimerRef = useRef<number | null>(null)
  const idleTimerRef = useRef<number | null>(null)
  const mouseTrackingEnabledRef = useRef(false)
  const actionRunningRef = useRef(false)
  const baseExpressionRef = useRef<PetExpressionName>('normal')
  const lastInteractionRef = useRef<number>(Date.now())

  const orderedSuggestions = useMemo(
    () => reorderSuggestions(suggestions, highlightedSuggestionIndex),
    [highlightedSuggestionIndex, suggestions]
  )
  const visibleSuggestionCards = useMemo(
    () => getVisibleSuggestionCardSuggestions(suggestions),
    [suggestions]
  )
  const activeSuggestion = orderedSuggestions[0]
  const suggestionCardActionLabels = getSuggestionCardActionLabels()
  const currentAppName = useMemo(
    () => inferAppName(currentSessionKey, currentContact, frontmostAppName),
    [currentContact, currentSessionKey, frontmostAppName]
  )
  const socialRisk = useMemo(
    () => inferSocialRisk(assistantState, activeSuggestion),
    [activeSuggestion, assistantState]
  )

  const petView = useMemo(
    () =>
      buildPetViewModel({
        assistantState,
        surfacePreference,
        suggestionEnabled,
        currentAppName,
        currentContact,
        currentSessionKey,
        socialRisk,
        suggestions: orderedSuggestions
      }),
    [
      assistantState,
      currentAppName,
      currentContact,
      currentSessionKey,
      orderedSuggestions,
      socialRisk,
      suggestionEnabled,
      surfacePreference
    ]
  )

  const statusSummary = useMemo(
    () =>
      createStatusSummary(
        assistantState,
        suggestionEnabled,
        socialRisk,
        Boolean(activeSuggestion),
        currentAppName,
        frontmostGatePassed
      ),
    [activeSuggestion, assistantState, currentAppName, frontmostGatePassed, socialRisk, suggestionEnabled]
  )

  const applyWindowBounds = useCallback((bounds: AssistantWindowBounds | null) => {
    if (!bounds) {
      return
    }
    windowBoundsRef.current = bounds
    setExpanded(isExpandedBounds(bounds))
  }, [])

  type CollapseReason = 'init' | 'manual' | 'stop' | 'shutdown'

  const syncExpandedState = useCallback(
    async (nextExpanded: boolean, collapseReason?: CollapseReason) => {
      if (!nextExpanded && !collapseReason) {
        return
      }
      try {
        const bounds = await window.electronAPI.assistantWindow.setExpanded(nextExpanded)
        if (!bounds) {
          return
        }
        applyWindowBounds(bounds)
      } catch (error) {
        console.error('Failed to sync assistant expanded state:', error)
      }
    },
    [applyWindowBounds]
  )

  const clearMotionTimers = useCallback(() => {
    motionTimersRef.current.forEach((timerId) => window.clearTimeout(timerId))
    motionTimersRef.current = []
  }, [])

  const applyExpression = useCallback((expressionName: PetExpressionName) => {
    const leftEye = eyeLeftRef.current
    const rightEye = eyeRightRef.current
    if (!leftEye || !rightEye) {
      return
    }
    applyPetExpressionToEyes(leftEye, rightEye, expressionName)
  }, [])

  const restoreBaseExpression = useCallback(() => {
    actionRunningRef.current = false
    applyExpression(baseExpressionRef.current)
    mouseTrackingEnabledRef.current = PET_TRACKING_ENABLED[petView.petMood]
  }, [applyExpression, petView.petMood])

  const playPetAction = useCallback(
    (action: PetMotionAction | undefined) => {
      if (!action) {
        return
      }
      clearMotionTimers()
      actionRunningRef.current = true
      mouseTrackingEnabledRef.current = action.disableTracking ? false : PET_TRACKING_ENABLED[petView.petMood]
      action.steps.forEach((step) => {
        const timerId = window.setTimeout(() => {
          applyExpression(step.expression)
        }, step.delay)
        motionTimersRef.current.push(timerId)
      })
      const resetTimerId = window.setTimeout(() => {
        restoreBaseExpression()
      }, action.totalDuration)
      motionTimersRef.current.push(resetTimerId)
    },
    [applyExpression, clearMotionTimers, petView.petMood, restoreBaseExpression]
  )

  useEffect(() => {
    baseExpressionRef.current = PET_BASE_EXPRESSION[petView.petMood]
    mouseTrackingEnabledRef.current = PET_TRACKING_ENABLED[petView.petMood]
    lastInteractionRef.current = Date.now()
    clearMotionTimers()
    restoreBaseExpression()
  }, [clearMotionTimers, petView.petMood, restoreBaseExpression])

  useEffect(() => {
    const scheduleBlink = () => {
      const delay =
        petView.petMood === 'dormant'
          ? 2600 + Math.random() * 3200
          : 1800 + Math.random() * 4200
      blinkTimerRef.current = window.setTimeout(() => {
        if (actionRunningRef.current) {
          scheduleBlink()
          return
        }
        const trackingBeforeBlink = PET_TRACKING_ENABLED[petView.petMood]
        mouseTrackingEnabledRef.current = false
        applyExpression('blink')
        const restoreTimerId = window.setTimeout(() => {
          applyExpression(baseExpressionRef.current)
          mouseTrackingEnabledRef.current = trackingBeforeBlink
          scheduleBlink()
        }, petView.petMood === 'dormant' ? 150 : 90)
        motionTimersRef.current.push(restoreTimerId)
      }, delay)
    }

    scheduleBlink()
    return () => {
      if (blinkTimerRef.current !== null) {
        window.clearTimeout(blinkTimerRef.current)
        blinkTimerRef.current = null
      }
    }
  }, [applyExpression, petView.petMood])

  useEffect(() => {
    const scheduleIdleAction = () => {
      idleTimerRef.current = window.setTimeout(() => {
        const idleForMs = Date.now() - lastInteractionRef.current
        if (!actionRunningRef.current && idleForMs > 2200 && Math.random() < 0.42) {
          const pool = PET_IDLE_ACTIONS[petView.petMood]
          const action = pool[Math.floor(Math.random() * pool.length)]
          playPetAction(action)
        }
        scheduleIdleAction()
      }, petView.petMood === 'dormant' ? 5200 : 4200)
    }

    scheduleIdleAction()
    return () => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current)
        idleTimerRef.current = null
      }
    }
  }, [petView.petMood, playPetAction])

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (!mouseTrackingEnabledRef.current || actionRunningRef.current) {
        return
      }
      const orbWrapper = orbWrapperRef.current
      const leftEye = eyeLeftRef.current
      const rightEye = eyeRightRef.current
      if (!orbWrapper || !leftEye || !rightEye) {
        return
      }
      const rect = orbWrapper.getBoundingClientRect()
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const offsetX = Math.max(-2, Math.min(2, ((event.clientX - centerX) / window.innerWidth) * 6))
      const offsetY = Math.max(-2, Math.min(2, ((event.clientY - centerY) / window.innerHeight) * 6))
      leftEye.style.transform = `translate(${offsetX}px, ${offsetY}px)`
      rightEye.style.transform = `translate(${offsetX}px, ${offsetY}px)`
    }

    window.addEventListener('mousemove', handleMouseMove)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
    }
  }, [])

  const handleGlobalMouseMove = useCallback((event: MouseEvent) => {
    const dragState = dragStateRef.current
    if (!dragState.active) {
      return
    }

    const deltaX = event.screenX - dragState.startMouseX
    const deltaY = event.screenY - dragState.startMouseY

    if (!dragState.dragging) {
      const movement = Math.hypot(deltaX, deltaY)
      if (movement < 8) {
        return
      }
      dragState.dragging = true
      dragState.moved = true
    }

    void window.electronAPI.assistantWindow
      .setPosition({
        x: dragState.startWindowX + deltaX,
        y: dragState.startWindowY + deltaY
      })
      .then((bounds) => {
        if (bounds) {
          windowBoundsRef.current = bounds
        }
      })
  }, [])

  const handleGlobalMouseUp = useCallback(() => {
    const dragState = dragStateRef.current
    dragState.active = false
    dragState.dragging = false
    window.removeEventListener('mousemove', handleGlobalMouseMove)
    window.removeEventListener('mouseup', handleGlobalMouseUp)
  }, [handleGlobalMouseMove])

  const stopDragging = useCallback(() => {
    dragStateRef.current.active = false
    dragStateRef.current.dragging = false
    window.removeEventListener('mousemove', handleGlobalMouseMove)
    window.removeEventListener('mouseup', handleGlobalMouseUp)
  }, [handleGlobalMouseMove, handleGlobalMouseUp])

  const handleBubbleMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (event.button !== 0) {
        return
      }

      event.preventDefault()
      const bounds = windowBoundsRef.current
      if (!bounds) {
        return
      }

      dragStateRef.current = {
        active: true,
        dragging: false,
        moved: false,
        startMouseX: event.screenX,
        startMouseY: event.screenY,
        startWindowX: bounds.x,
        startWindowY: bounds.y
      }

      window.addEventListener('mousemove', handleGlobalMouseMove)
      window.addEventListener('mouseup', handleGlobalMouseUp)
    },
    [handleGlobalMouseMove, handleGlobalMouseUp]
  )

  const collapseToPet = useCallback(async (): Promise<void> => {
    setSurfacePreference('auto')
    await syncExpandedState(false, 'manual')
  }, [syncExpandedState])

  const openSuggestionCard = useCallback(async (): Promise<void> => {
    setPromptVisible(false)
    setSurfacePreference('auto')
    await syncExpandedState(true)
  }, [syncExpandedState])

  const openFolio = useCallback(async (): Promise<void> => {
    setSurfacePreference('folio')
    await syncExpandedState(true)
  }, [syncExpandedState])

  const regenerateSuggestions = useCallback(async (): Promise<void> => {
    const adapter = adapterRef.current
    if (!adapter) {
      return
    }
    setSuggestions([])
    setErrorMessage(null)
    await adapter.rerollCurrentRound()
  }, [])

  const postponePendingSessionConfirmation = useCallback(async (): Promise<void> => {
    setPendingSessionConfirmation(null)
    await collapseToPet()
  }, [collapseToPet])

  const submitPendingSessionConfirmation = useCallback(async () => {
    const adapter = adapterRef.current
    if (!adapter || !pendingSessionConfirmation) {
      return
    }
    const confirmedSessionName = pendingSessionConfirmation.inputValue.trim()
    if (!confirmedSessionName) {
      setErrorMessage('请先确认或修正会话名称')
      return
    }
    setErrorMessage(null)
    setPendingSessionConfirmation(null)
    await collapseToPet()
    await adapter.confirmPendingSession(pendingSessionConfirmation.pendingId, confirmedSessionName)
  }, [collapseToPet, pendingSessionConfirmation])

  const confirmSuggestedPendingSession = useCallback(async () => {
    const adapter = adapterRef.current
    if (!adapter || !pendingSessionConfirmation?.suggestedSessionName) {
      return
    }
    setErrorMessage(null)
    setPendingSessionConfirmation(null)
    await collapseToPet()
    await adapter.confirmPendingSession(
      pendingSessionConfirmation.pendingId,
      pendingSessionConfirmation.suggestedSessionName
    )
  }, [collapseToPet, pendingSessionConfirmation])

  useEffect(() => {
    if (suggestions.length === 0 && highlightedSuggestionIndex !== 0) {
      setHighlightedSuggestionIndex(0)
      return
    }
    if (highlightedSuggestionIndex >= suggestions.length && suggestions.length > 0) {
      setHighlightedSuggestionIndex(0)
    }
  }, [highlightedSuggestionIndex, suggestions.length])

  useEffect(() => {
    let disposed = false
    const adapter = new RealtimeSuggestionAdapter()
    adapterRef.current = adapter

    adapter.onStatus((status) => {
      if (disposed) {
        return
      }
      setAssistantState(status)
    })
    adapter.onError((message) => {
      if (disposed) {
        return
      }
      setErrorMessage(message)
      console.error('RealtimeSuggestionAdapter error:', message)
    })
    adapter.onDebug((debugState) => {
      if (disposed) {
        return
      }
      setFrontmostAppName(debugState.monitorLastFrontmostApp || null)
      setFrontmostGatePassed(debugState.monitorLastGatePassed)
    })
    adapter.onPendingSessionConfirmation((pending) => {
      if (disposed) {
        return
      }
      setSuggestionEnabled(true)
      setPromptVisible(false)
      setSuggestions([])
      setHighlightedSuggestionIndex(0)
      setErrorMessage(null)
      setCurrentContact(pending.sessionName)
      setCurrentSessionKey(null)
      setSurfacePreference('auto')
      setPendingSessionConfirmation({
        ...pending,
        inputValue: pending.suggestedSessionName ?? pending.sessionName
      })
      void syncExpandedState(true)
    })
    adapter.onSuggestions((update) => {
      if (disposed) {
        return
      }
      const mappedSuggestions = update.suggestions.map((item, index) => ({
        id: `sg-${update.timestamp}-${index}`,
        content: item.content,
        reason: item.reason,
        timeLabel: '刚刚',
        toneLabel: inferToneLabel(item.content, item.reason)
      }))

      setSuggestionEnabled(true)
      setHighlightedSuggestionIndex(0)
      setErrorMessage(null)
      setCurrentContact(update.contactName)
      setCurrentSessionKey(update.sessionKey)
      if (mappedSuggestions.length === 0) {
        setPendingSessionConfirmation(null)
        setSuggestions([])
        return
      }
      setPendingSessionConfirmation(null)
      setPromptVisible(false)
      setSurfacePreference('auto')
      setSuggestions(mappedSuggestions)
      if (shouldAutoExpandForSuggestionUpdate(mappedSuggestions.length)) {
        void syncExpandedState(true)
      }
    })
    void window.electronAPI.assistantWindow.getBounds().then((bounds) => {
      if (!disposed && bounds) {
        windowBoundsRef.current = bounds
      }
    })
    void syncExpandedState(false, 'init')
    return () => {
      disposed = true
      void adapter.stop()
      adapterRef.current = null
      clearMotionTimers()
      if (blinkTimerRef.current !== null) {
        window.clearTimeout(blinkTimerRef.current)
        blinkTimerRef.current = null
      }
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current)
        idleTimerRef.current = null
      }
      stopDragging()
    }
  }, [clearMotionTimers, stopDragging, syncExpandedState])

  useEffect(() => {
    if (!currentAppName) {
      lastPromptedAppRef.current = null
      return
    }
  }, [currentAppName])

  useEffect(() => {
    let disposed = false

    const pollForegroundApp = async (): Promise<void> => {
      if (disposed || suggestionEnabled) {
        return
      }
      try {
        const appName = await window.electronAPI.assistantWindow.getFrontmostApp()
        if (disposed) {
          return
        }
        const normalized = normalizeSupportedAppName(appName)
        setFrontmostAppName(normalized)
        setFrontmostGatePassed(normalized ? true : null)
      } catch {
        if (!disposed) {
          setFrontmostAppName(null)
          setFrontmostGatePassed(null)
        }
      }
    }

    void pollForegroundApp()
    const timerId = window.setInterval(() => {
      void pollForegroundApp()
    }, 1000)

    return () => {
      disposed = true
      window.clearInterval(timerId)
    }
  }, [suggestionEnabled])

  useEffect(() => {
    if (!shouldAutoOpenPromptForForegroundApp(currentAppName, suggestionEnabled, lastPromptedAppRef.current)) {
      return
    }

    lastPromptedAppRef.current = currentAppName
    setPromptVisible(true)
    void syncExpandedState(true)
  }, [currentAppName, suggestionEnabled, syncExpandedState])

  const startAssistant = useCallback(async (): Promise<void> => {
    const adapter = adapterRef.current
    if (!adapter) {
      return
    }
    setErrorMessage(null)
    setSuggestionEnabled(true)
    setPromptVisible(false)
    setSurfacePreference('auto')
    await syncExpandedState(true)
    try {
      await adapter.start()
    } catch (error) {
      setSuggestionEnabled(false)
      const message = error instanceof Error ? error.message : '启动建议失败'
      setErrorMessage(message)
    }
  }, [syncExpandedState])

  const stopAssistant = useCallback(async (): Promise<void> => {
    const adapter = adapterRef.current
    if (!adapter) {
      return
    }
    await adapter.stopMonitoring()
    setSuggestionEnabled(false)
    setPromptVisible(false)
    setSuggestions([])
    setCurrentContact(null)
    setCurrentSessionKey(null)
    setFrontmostAppName(null)
    setFrontmostGatePassed(null)
    lastPromptedAppRef.current = null
    setErrorMessage(null)
    setSurfacePreference('auto')
    await syncExpandedState(false, 'stop')
  }, [syncExpandedState])

  const shutdownAssistant = useCallback(async (): Promise<void> => {
    const adapter = adapterRef.current
    if (!adapter) {
      return
    }
    await adapter.stop()
    setSuggestionEnabled(false)
    setSuggestions([])
    setCurrentContact(null)
    setCurrentSessionKey(null)
    setFrontmostAppName(null)
    setFrontmostGatePassed(null)
    lastPromptedAppRef.current = null
    setErrorMessage(null)
    setSurfacePreference('auto')
    await syncExpandedState(false, 'shutdown')
  }, [syncExpandedState])

  const skipCurrentRound = useCallback(async (): Promise<void> => {
    const adapter = adapterRef.current
    if (!adapter) {
      return
    }
    setSuggestions([])
    await adapter.rerollCurrentRound()
  }, [])

  const copySuggestion = async (content: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content)
      setSuggestions([])
      const adapter = adapterRef.current
      if (adapter) {
        await adapter.acknowledgeCurrentRound()
      }
    } catch (error) {
      console.error('Failed to copy suggestion:', error)
    }
  }

  const handlePetActivate = useCallback(() => {
    const dragState = dragStateRef.current
    if (dragState.moved) {
      dragState.moved = false
      return
    }

    lastInteractionRef.current = Date.now()
    const clickPool = PET_IDLE_ACTIONS[petView.petMood]
    playPetAction(clickPool[Math.floor(Math.random() * clickPool.length)])

    const activationIntent = resolveAssistantActivationIntent(
      resolveAssistantExpandedFlag(windowBoundsRef.current, expanded),
      petView.surfaceMode,
      orderedSuggestions.length > 0
    )

    if (activationIntent === 'collapse') {
      void collapseToPet()
      return
    }

    if (activationIntent === 'open_suggestion') {
      void openSuggestionCard()
      return
    }

    setPromptVisible(false)
    setSurfacePreference(resolveSurfacePreferenceForAssistantActivation(false))
    void syncExpandedState(true)
  }, [
    collapseToPet,
    expanded,
    openSuggestionCard,
    orderedSuggestions.length,
    petView.petMood,
    petView.surfaceMode,
    playPetAction,
    syncExpandedState
  ])

  const showPendingStage = expanded && Boolean(pendingSessionConfirmation)
  const showWhisperStage = expanded && !showPendingStage && petView.surfaceMode === 'whispers' && Boolean(activeSuggestion)
  const showPromptStage = expanded && !showPendingStage && promptVisible && !activeSuggestion && surfacePreference === 'auto'
  const showFolioStage = expanded && !showPendingStage && !showWhisperStage && !showPromptStage

  return (
    <main className={`assistant-shell tone-${petView.accentTone} surface-${petView.surfaceMode}`}>
      {showPendingStage && pendingSessionConfirmation && (
        <section className="assistant-pending-stage" aria-label="会话名称确认">
          <article className="assistant-pending-card">
            <header className="assistant-note-meta">
              <span className="assistant-tone-chip">会话确认</span>
              <span className="assistant-context-chip">先确认再归档</span>
            </header>
            <p className="assistant-whisper-copy">
              识别到的会话名是“{pendingSessionConfirmation.sessionName}”。
            </p>
            <p className="assistant-whisper-reason">
              {pendingSessionConfirmation.suggestedSessionName
                ? `已匹配到一个高相似候选：${pendingSessionConfirmation.suggestedSessionName}。确认后会把缓存消息归并进对应聊天记录。`
                : '这批消息先进入临时缓存，确认后才会写入正式聊天记录文件。'}
            </p>
            <label className="assistant-pending-field">
              <span>确认后的会话名称</span>
              <input
                type="text"
                value={pendingSessionConfirmation.inputValue}
                onChange={(event) =>
                  setPendingSessionConfirmation((current) => (
                    current
                      ? {
                        ...current,
                        inputValue: event.target.value
                      }
                      : current
                  ))
                }
                placeholder="输入最终会话名称"
              />
            </label>
            <footer className="assistant-whisper-footer">
              <div className="assistant-inline-actions">
                <button type="button" onClick={() => void submitPendingSessionConfirmation()}>
                  确认
                </button>
                <button
                  type="button"
                  disabled={!pendingSessionConfirmation.suggestedSessionName}
                  onClick={() => void confirmSuggestedPendingSession()}
                >
                  保存更正
                </button>
                <button type="button" onClick={() => void postponePendingSessionConfirmation()}>
                  稍后
                </button>
              </div>
            </footer>
          </article>
        </section>
      )}

      {showWhisperStage && activeSuggestion && (
        <section className="assistant-whisper-stage" aria-label="建议卡片">
          <article className="assistant-whisper-card">
            <header className="assistant-note-meta">
              <span className="assistant-tone-chip">{petView.toneLabel}</span>
              <span className="assistant-context-chip">{petView.contextLabel}</span>
            </header>

            <div className="assistant-whisper-suggestion-list">
              {visibleSuggestionCards.map((suggestion) => (
                <section key={suggestion.id} className="assistant-whisper-suggestion">
                  <div className="assistant-whisper-suggestion-meta">
                    <span className="assistant-ledger-chip">{suggestion.toneLabel}</span>
                    <span className="assistant-whisper-time">{suggestion.timeLabel}</span>
                  </div>
                  <p className="assistant-whisper-copy">{suggestion.content}</p>
                  <p className="assistant-whisper-reason">{suggestion.reason}</p>
                  <div className="assistant-inline-actions assistant-whisper-actions">
                    <button type="button" onClick={() => void copySuggestion(suggestion.content)}>
                      {suggestionCardActionLabels.copy}
                    </button>
                  </div>
                </section>
              ))}
            </div>

            <footer className="assistant-whisper-footer">
              <div className="assistant-inline-actions">
                <button type="button" onClick={() => void regenerateSuggestions()}>
                  {suggestionCardActionLabels.regenerate}
                </button>
                <button type="button" onClick={() => void skipCurrentRound()}>
                  {suggestionCardActionLabels.skip}
                </button>
                <button type="button" onClick={() => void openFolio()}>
                  {suggestionCardActionLabels.expand}
                </button>
              </div>
            </footer>
          </article>
        </section>
      )}

      {showPromptStage && (
        <section className="assistant-prompt-stage" aria-label="开始建议提示">
          <article className="assistant-prompt-card">
            <header className="assistant-note-meta">
              <span className="assistant-tone-chip">{currentAppName ?? '聊天应用'}</span>
              <span className="assistant-context-chip">社交助手</span>
            </header>
            <p className="assistant-whisper-copy">要开始这一轮聊天建议吗？</p>
            <p className="assistant-whisper-reason">开始后会为当前会话提供建议。</p>
            <footer className="assistant-whisper-footer">
              <span className="assistant-whisper-time">可随时收起</span>
              <div className="assistant-inline-actions">
                <button type="button" onClick={() => void startAssistant()}>
                  开始建议
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPromptVisible(false)
                    void collapseToPet()
                  }}
                >
                  稍后
                </button>
              </div>
            </footer>
          </article>
        </section>
      )}

      {showFolioStage && (
        <section className="assistant-folio" aria-label="社交助手详情">
          <header className="assistant-folio-header">
            <div>
              <p className="assistant-folio-kicker">SocialClaw</p>
              <h1>{petView.contextLabel}</h1>
            </div>
            <button type="button" className="assistant-icon-button" onClick={() => void collapseToPet()}>
              收起
            </button>
          </header>

          <div className="assistant-folio-scroll">
            <section className="assistant-social-read">
              <article className="assistant-read-card">
                <span className="assistant-read-label">信号</span>
                <strong>{statusSummary.signal}</strong>
              </article>
              <article className="assistant-read-card">
                <span className="assistant-read-label">姿态</span>
                <strong>{statusSummary.posture}</strong>
              </article>
            </section>

            {activeSuggestion ? (
              <>
                <section className="assistant-primary-note">
                  <header className="assistant-note-meta">
                    <span className="assistant-tone-chip">{petView.toneLabel}</span>
                    <span className="assistant-context-chip">
                      {socialRisk === 'high' ? '高敏感场景' : socialRisk === 'medium' ? '稳一点' : '可顺势回复'}
                    </span>
                  </header>
                  <h2>{petView.headline}</h2>
                  <p>{petView.subheadline}</p>
                </section>

                <section className="assistant-suggestion-ledger">
                  <header className="assistant-section-header">
                    <div>
                      <p className="assistant-section-kicker">可发版本</p>
                      <h3>这一轮的候选说法</h3>
                    </div>
                    <div className="assistant-inline-actions">
                      <button type="button" className="assistant-link-button" onClick={() => void regenerateSuggestions()}>
                        {suggestionCardActionLabels.regenerate}
                      </button>
                      {shouldShowSuggestionCardShortcut(Boolean(activeSuggestion)) && (
                        <button type="button" className="assistant-link-button" onClick={() => void openSuggestionCard()}>
                          查看建议卡片
                        </button>
                      )}
                    </div>
                  </header>

                  <div className="assistant-suggestion-list">
                    {orderedSuggestions.map((message) => {
                      const active = message.originalIndex === highlightedSuggestionIndex
                      return (
                        <button
                          key={message.id}
                          type="button"
                          className={`assistant-ledger-entry ${active ? 'active' : ''}`}
                          onClick={() => setHighlightedSuggestionIndex(message.originalIndex)}
                        >
                          <span className="assistant-ledger-chip">{message.toneLabel}</span>
                          <strong>{message.content}</strong>
                          <span>{message.reason}</span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              </>
            ) : (
              <section className="assistant-folio-empty">
                <p className="assistant-section-kicker">当前状态</p>
                <h2>{petView.headline}</h2>
                <p>{errorMessage ?? statusSummary.strategy}</p>
                <div className="assistant-empty-actions">
                  {(assistantState === 'idle' || assistantState === 'error' || (assistantState === 'monitoring' && !suggestionEnabled)) && (
                    <>
                      <button type="button" onClick={() => void startAssistant()}>
                        {assistantState === 'monitoring' && !suggestionEnabled ? '恢复建议' : '开始建议'}
                      </button>
                      <button type="button" onClick={() => void stopAssistant()}>
                        停止监控
                      </button>
                    </>
                  )}
                  {assistantState === 'connecting' && (
                    <button type="button" onClick={() => void shutdownAssistant()}>
                      取消
                    </button>
                  )}
                </div>
              </section>
            )}

            {errorMessage && <p className="assistant-inline-warning">连接异常：{errorMessage}</p>}

            <section className="assistant-context-ledger">
              <p className="assistant-section-kicker">当前上下文</p>
              <div className="assistant-ledger-grid">
                <div>
                  <span>策略提示</span>
                  <strong>{statusSummary.strategy}</strong>
                </div>
                <div>
                  <span>会话</span>
                  <strong>{currentContact ?? currentAppName ?? '等待连接'}</strong>
                </div>
              </div>
            </section>
          </div>

          <footer className="assistant-folio-footer">
            <button type="button" onClick={() => activeSuggestion && void copySuggestion(activeSuggestion.content)} disabled={!activeSuggestion}>
              复制当前
            </button>
            <button type="button" onClick={() => void openSuggestionCard()} disabled={!activeSuggestion}>
              建议卡片
            </button>
            <button type="button" onClick={() => void skipCurrentRound()} disabled={!activeSuggestion}>
              略过本轮
            </button>
            <button type="button" onClick={() => void stopAssistant()}>
              停止监控
            </button>
          </footer>
        </section>
      )}

      <button
        className={`assistant-pet mood-${petView.petMood}`}
        type="button"
        onMouseDown={(event) => void handleBubbleMouseDown(event)}
        onClick={handlePetActivate}
        onMouseEnter={() => {
          lastInteractionRef.current = Date.now()
          playPetAction(PET_HOVER_ACTIONS[petView.petMood])
        }}
        aria-label="展开或收起社交助手"
      >
        {orderedSuggestions.length > 0 && petView.surfaceMode === 'pet' && (
          <span className="assistant-pet-badge">{Math.min(orderedSuggestions.length, 9)}</span>
        )}

        <span className="assistant-pet-shadow" />
        <span ref={orbWrapperRef} className="assistant-orb-wrapper">
          <span className="assistant-orb-inner-fluid">
            <span className="assistant-orb-fluid-blob blob-1" />
            <span className="assistant-orb-fluid-blob blob-2" />
          </span>
          <span className="assistant-orb-glass-shell" />
          <span className="assistant-orb-eyes">
            <span ref={eyeLeftRef} className="assistant-orb-eye left" />
            <span ref={eyeRightRef} className="assistant-orb-eye right" />
          </span>
          <span className="assistant-orb-blush left" />
          <span className="assistant-orb-blush right" />
          <span className="assistant-orb-bubble bubble-1" />
          <span className="assistant-orb-bubble bubble-2" />
        </span>
      </button>
    </main>
  )
}
