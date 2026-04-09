type AppSettings = Awaited<ReturnType<typeof window.electronAPI.settings.load>>

type UnifiedProfile = NonNullable<Awaited<ReturnType<typeof window.electronAPI.profile.loadContact>>>

export interface RealtimeSuggestion {
  content: string
  reason: string
}

interface QuotedMessagePayload {
  text: string
  sender_name?: string | null
}

export interface RealtimeSuggestionUpdate {
  suggestions: RealtimeSuggestion[]
  contactName: string | null
  sessionKey: string | null
  timestamp: number
}

export interface PendingSessionConfirmationUpdate {
  pendingId: string
  sessionKey: string
  sessionName: string
  suggestedSessionKey: string | null
  suggestedSessionName: string | null
  recentMessages: SuggestionMessage[]
  timestamp: number
}

export interface RealtimeSuggestionDebugState {
  baseUrl: string
  monitorRunning: boolean
  monitorLastError: string
  monitorLastFrontmostApp: string
  monitorLastGatePassed: boolean | null
  monitorLastDecisionReason: string
  monitorLastVisionMode: string
  activeSessionKey: string
  sessionSwitchCount: number
  perSessionInflight: Record<string, number>
  eventsLastCount: number
  eventsAccumulated: number
  lastEventsAt: number | null
  lastSuggestionsAt: number | null
  lastSuggestionError: string
  lastSessionName: string
  lastChatRecordFilePath: string
}

interface VisualMonitorEventRow {
  sender: 'user' | 'contact' | 'unknown'
  text: string
  quoted_message?: QuotedMessagePayload | null
  contact_name?: string | null
  conversation_title?: string | null
  window_id?: string | null
  session_key?: string | null
  content_type?: string | null
  non_text_description?: string | null
  non_text_signature?: string | null
  time_anchor?: string | null
  timestamp?: string
  event_id?: string
  frame_id?: string
}

interface EventsPollResponse {
  count: number
  events: VisualMonitorEventRow[]
}

interface AssistantSuggestionRow {
  content?: string
  reply?: string
  reason?: string
}

interface AssistantSuggestionResponse {
  count: number
  suggestions: AssistantSuggestionRow[]
}

interface EverMemOSProcessChatResponse {
  success?: boolean
  is_new_friend?: boolean
  profile_updated?: boolean
  user_profile_updated?: boolean
  contact_profile?: UnifiedProfile | null
  error?: string | null
}

type MonitorDebugPayload = {
  running?: boolean
  last_error?: string
  pipeline?: {
    last_frontmost_app?: string
    last_gate_passed?: boolean | null
    last_decision_reason?: string
    last_vision_mode?: string
    last_ocr_mode?: string
    active_session_key?: string
    session_switch_count?: number
    per_session_inflight?: Record<string, number>
  }
}

export type AdapterStatus = 'idle' | 'connecting' | 'monitoring' | 'error'

interface RealtimeSuggestionAdapterOptions {
  pollIntervalMs?: number
  suggestionCount?: number
}

const STOP_DRAIN_TIMEOUT_MS = 15_000
const STOP_DRAIN_POLL_INTERVAL_MS = 250

type SuggestionMessage = {
  message_id: string
  conversation_id: string
  sender_id: string
  sender_name: string
  sender_type: 'user' | 'contact' | 'unknown'
  content: string
  timestamp: string | null
  content_type: string | null
  reply_to: string | null
  quoted_message: QuotedMessagePayload | null
  metadata: {
    window_id: string | null
    non_text_description: string | null
    event_id: string | null
    frame_id: string | null
  }
}

interface SessionRoundState {
  awaitingUserAction: boolean
  pendingRecentMessages: SuggestionMessage[]
  requestInFlight: boolean
}

export class RealtimeSuggestionAdapter {
  private readonly pollIntervalMs: number
  private readonly suggestionCount: number

  private timerId: number | null = null
  private running = false
  private suggestionsEnabled = false
  private settings: AppSettings | null = null
  private currentContactName: string | null = null
  private currentSessionKey: string | null = null
  private currentContactCacheKey: string | null = null
  private currentSkillIdOverride: string | null = null
  private sessionRounds = new Map<string, SessionRoundState>()
  private onSuggestionsCallback: ((update: RealtimeSuggestionUpdate) => void) | null = null
  private onPendingSessionConfirmationCallback: ((update: PendingSessionConfirmationUpdate) => void) | null = null
  private onStatusCallback: ((status: AdapterStatus) => void) | null = null
  private onErrorCallback: ((message: string) => void) | null = null
  private onDebugCallback: ((state: RealtimeSuggestionDebugState) => void) | null = null

  private debugState: RealtimeSuggestionDebugState = {
    baseUrl: '',
    monitorRunning: false,
    monitorLastError: '',
    monitorLastFrontmostApp: '',
    monitorLastGatePassed: null,
    monitorLastDecisionReason: '',
    monitorLastVisionMode: '',
    activeSessionKey: '',
    sessionSwitchCount: 0,
    perSessionInflight: {},
    eventsLastCount: 0,
    eventsAccumulated: 0,
    lastEventsAt: null,
    lastSuggestionsAt: null,
    lastSuggestionError: '',
    lastSessionName: '',
    lastChatRecordFilePath: ''
  }

  constructor(options: RealtimeSuggestionAdapterOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1200
    this.suggestionCount = options.suggestionCount ?? 3
  }

  onSuggestions(callback: (update: RealtimeSuggestionUpdate) => void): void {
    this.onSuggestionsCallback = callback
  }

  onPendingSessionConfirmation(callback: (update: PendingSessionConfirmationUpdate) => void): void {
    this.onPendingSessionConfirmationCallback = callback
  }

  onStatus(callback: (status: AdapterStatus) => void): void {
    this.onStatusCallback = callback
  }

  onError(callback: (message: string) => void): void {
    this.onErrorCallback = callback
  }

  onDebug(callback: (state: RealtimeSuggestionDebugState) => void): void {
    this.onDebugCallback = callback
  }

  async start(): Promise<void> {
    if (this.running) {
      this.suggestionsEnabled = true
      this.emitStatus('connecting')
      const baseUrl = this.settings?.visualMonitor.apiBaseUrl?.trim() || 'http://127.0.0.1:18777'
      try {
        await this.ensureMonitorStarted(baseUrl)
      } catch {
        // best-effort: monitor might already be running
      }
      this.emitStatus('monitoring')
      return
    }
    this.running = true
    this.suggestionsEnabled = true
    this.emitStatus('connecting')

    try {
      this.settings = await window.electronAPI.settings.load()
      const baseUrl = this.settings.visualMonitor.apiBaseUrl?.trim() || 'http://127.0.0.1:18777'
      this.patchDebug({ baseUrl, lastSuggestionError: '' })
      this.sessionRounds.clear()
      this.currentSessionKey = null
      this.currentContactName = null
      this.currentContactCacheKey = null
      try {
        await window.electronAPI.hotRun.updateSettings(this.settings)
      } catch (error) {
        const message = error instanceof Error ? error.message : '同步设置失败'
        this.patchDebug({ lastSuggestionError: message })
      }
      try {
        await window.electronAPI.assistantWindow.syncExclusion()
      } catch {
        // no-op: exclusion sync is best effort.
      }
      await this.ensureMonitorStarted(baseUrl)
      this.emitStatus('monitoring')
    } catch (error) {
      this.running = false
      const message = error instanceof Error ? error.message : '加载设置失败'
      this.patchDebug({ lastSuggestionError: message })
      this.emitError(message)
      this.emitStatus('error')
      return
    }

    this.timerId = window.setInterval(() => {
      void this.tick()
    }, this.pollIntervalMs)
    await this.tick()
  }

  async stop(): Promise<void> {
    await this.stopMonitoring()
    this.currentSessionKey = null
    this.currentContactName = null
    this.currentContactCacheKey = null
    this.currentSkillIdOverride = null
    this.emitStatus('idle')
  }

  async stopMonitoring(): Promise<void> {
    this.suggestionsEnabled = false
    this.sessionRounds.clear()
    let baseUrl = this.settings?.visualMonitor.apiBaseUrl?.trim() || ''
    if (!baseUrl) {
      try {
        const loadedSettings = await window.electronAPI.settings.load()
        this.settings = loadedSettings
        baseUrl = loadedSettings.visualMonitor.apiBaseUrl?.trim() || ''
      } catch {
        // best-effort shutdown with default endpoint
      }
    }
    const primaryBaseUrl = baseUrl || 'http://127.0.0.1:18777'
    const fallbackBaseUrl = 'http://127.0.0.1:18777'
    const stopTargets =
      primaryBaseUrl === fallbackBaseUrl ? [primaryBaseUrl] : [primaryBaseUrl, fallbackBaseUrl]

    let drainBaseUrl = primaryBaseUrl
    for (const target of stopTargets) {
      try {
        const response = await fetch(`${target}/monitor/stop`, { method: 'POST' })
        if (response.ok) {
          drainBaseUrl = target
          break
        }
      } catch {
        // best-effort shutdown
      }
    }
    try {
      await this.drainMonitorEventsUntilIdle(drainBaseUrl)
    } catch {
      // best-effort backlog drain
    }
    this.patchDebug({
      monitorRunning: false,
      monitorLastError: '',
      monitorLastDecisionReason: '',
    })
    this.running = false
    if (this.timerId !== null) {
      window.clearInterval(this.timerId)
      this.timerId = null
    }
    this.emitStatus('idle')
  }

  disableSuggestions(): void {
    this.suggestionsEnabled = false
    this.sessionRounds.clear()
    if (this.running) {
      this.emitStatus('monitoring')
    }
  }

  /**
   * User-triggered suggestion request.
   * Automatic rounds are driven by new ingested chat records; this method remains
   * as a manual nudge for the currently active session.
   */
  async triggerSuggestions(): Promise<void> {
    const sessionKey = this.currentSessionKey
    if (!this.running || !this.suggestionsEnabled || !this.settings || !sessionKey) {
      return
    }
    const baseUrl = this.settings.visualMonitor.apiBaseUrl?.trim() || 'http://127.0.0.1:18777'
    const gate = this.ensureSessionRound(sessionKey)
    gate.awaitingUserAction = false
    await this.maybeRequestSuggestions(baseUrl, sessionKey)
  }

  async acknowledgeCurrentRound(): Promise<void> {
    const sessionKey = this.currentSessionKey
    if (!this.running || !this.suggestionsEnabled || !this.settings || !sessionKey) {
      return
    }
    const gate = this.ensureSessionRound(sessionKey)
    gate.awaitingUserAction = false
    const baseUrl = this.settings.visualMonitor.apiBaseUrl?.trim() || 'http://127.0.0.1:18777'
    await this.maybeRequestSuggestions(baseUrl, sessionKey)
  }

  async rerollCurrentRound(skillIdOverride: string | null = this.currentSkillIdOverride): Promise<void> {
    const sessionKey = this.currentSessionKey
    if (!this.running || !this.suggestionsEnabled || !this.settings || !sessionKey) {
      return
    }
    this.currentSkillIdOverride = skillIdOverride

    const baseUrl = this.settings.visualMonitor.apiBaseUrl?.trim() || 'http://127.0.0.1:18777'
    const gate = this.ensureSessionRound(sessionKey)
    gate.awaitingUserAction = false

    const snapshot = await window.electronAPI.chatRecords.getRecentSessionMessages(sessionKey, 10)
    if (!snapshot || snapshot.recentMessages.length === 0) {
      return
    }

    this.currentContactName = snapshot.sessionName
    this.currentContactCacheKey = this.buildCanonicalContactCacheKey()
    this.patchDebug({
      lastSessionName: snapshot.sessionName,
      lastChatRecordFilePath: snapshot.filePath
    })

    gate.pendingRecentMessages = snapshot.recentMessages.map((row) => ({
      message_id: row.message_id,
      conversation_id: row.conversation_id,
      sender_id: row.sender_id,
      sender_name: row.sender_name,
      sender_type: row.sender_type,
      content: row.content,
      timestamp: row.timestamp ?? null,
      content_type: row.content_type ?? null,
      reply_to: row.reply_to ?? null,
      quoted_message: row.quoted_message ?? null,
      metadata: {
        window_id: row.metadata.window_id ?? null,
        non_text_description: row.metadata.non_text_description ?? null,
        event_id: row.metadata.event_id ?? null,
        frame_id: row.metadata.frame_id ?? null
      },
    }))
    await this.maybeRequestSuggestions(baseUrl, sessionKey)
  }

  async confirmPendingSession(pendingId: string, confirmedSessionName: string): Promise<void> {
    if (!this.running || !this.suggestionsEnabled || !this.settings) {
      return
    }
    const snapshot = await window.electronAPI.chatRecords.confirmPendingSession(pendingId, confirmedSessionName, 10)
    const sessionKey = snapshot.sessionKey
    this.currentSessionKey = sessionKey
    this.currentContactName = snapshot.sessionName
    this.currentContactCacheKey = this.buildCanonicalContactCacheKey()
    this.patchDebug({
      lastSessionName: snapshot.sessionName,
      lastChatRecordFilePath: snapshot.filePath
    })

    const gate = this.ensureSessionRound(sessionKey)
    gate.awaitingUserAction = false
    gate.pendingRecentMessages = snapshot.recentMessages.map((row) => ({
      message_id: row.message_id,
      conversation_id: row.conversation_id,
      sender_id: row.sender_id,
      sender_name: row.sender_name,
      sender_type: row.sender_type,
      content: row.content,
      timestamp: row.timestamp ?? null,
      content_type: row.content_type ?? null,
      reply_to: row.reply_to ?? null,
      quoted_message: row.quoted_message ?? null,
      metadata: {
        window_id: row.metadata.window_id ?? null,
        non_text_description: row.metadata.non_text_description ?? null,
        event_id: row.metadata.event_id ?? null,
        frame_id: row.metadata.frame_id ?? null
      }
    }))
    this.onSuggestionsCallback?.({
      suggestions: [],
      contactName: snapshot.sessionName,
      sessionKey: snapshot.sessionKey,
      timestamp: Date.now()
    })
    const baseUrl = this.settings.visualMonitor.apiBaseUrl?.trim() || 'http://127.0.0.1:18777'
    await this.maybeRequestSuggestions(baseUrl, sessionKey)
  }

  private ensureSessionRound(sessionKey: string): SessionRoundState {
    let state = this.sessionRounds.get(sessionKey)
    if (!state) {
      state = { awaitingUserAction: false, pendingRecentMessages: [], requestInFlight: false }
      this.sessionRounds.set(sessionKey, state)
    }
    return state
  }

  private clearRoundForSession(sessionKey: string | null): void {
    if (!sessionKey) {
      return
    }
    const state = this.sessionRounds.get(sessionKey)
    if (!state) {
      return
    }
    state.awaitingUserAction = false
    state.pendingRecentMessages = []
    state.requestInFlight = false
  }

  private async tick(): Promise<void> {
    if (!this.running || !this.settings || !this.suggestionsEnabled) {
      return
    }
    const baseUrl = this.settings.visualMonitor.apiBaseUrl?.trim() || 'http://127.0.0.1:18777'
    this.patchDebug({ baseUrl })

    try {
      const events = await this.fetchEvents(baseUrl)
      this.patchDebug({
        eventsLastCount: events.length,
        eventsAccumulated: this.debugState.eventsAccumulated + events.length,
        lastEventsAt: Date.now()
      })

      await this.fetchMonitorDebug(baseUrl)
      if (this.suggestionsEnabled && this.debugState.monitorRunning) {
        this.emitStatus('monitoring')
      }
      if (events.length === 0) {
        return
      }

      await this.ingestEventsIntoChatRecords(events)
    } catch (error) {
      this.emitStatus('error')
      const message = error instanceof Error ? error.message : '实时建议获取失败'
      this.patchDebug({
        lastSuggestionError: message
      })
      this.emitError(message)
    }
  }

  private async requestAndEmitSuggestions(
    baseUrl: string,
    sessionKey: string,
    recentMessages: SuggestionMessage[]
  ): Promise<void> {
    if (!this.running || !this.suggestionsEnabled) {
      return
    }
    const suggestions = await this.requestSuggestions(baseUrl, recentMessages)
    if (suggestions.length === 0) {
      return
    }
    if (!this.running || !this.suggestionsEnabled || this.currentSessionKey !== sessionKey) {
      return
    }
    const gate = this.ensureSessionRound(sessionKey)
    gate.awaitingUserAction = true
    gate.pendingRecentMessages = []
    this.patchDebug({
      lastSuggestionsAt: Date.now(),
      lastSuggestionError: ''
    })
    this.emitStatus('monitoring')
    this.onSuggestionsCallback?.({
      suggestions,
      contactName: this.currentContactName,
      sessionKey,
      timestamp: Date.now()
    })
  }

  private async maybeRequestSuggestions(baseUrl: string, sessionKey: string): Promise<void> {
    if (!this.running || !this.suggestionsEnabled) {
      return
    }
    const gate = this.ensureSessionRound(sessionKey)
    if (gate.awaitingUserAction || gate.requestInFlight || gate.pendingRecentMessages.length === 0) {
      return
    }
    const recentMessages = [...gate.pendingRecentMessages]
    gate.pendingRecentMessages = []
    gate.requestInFlight = true
    try {
      await this.requestAndEmitSuggestions(baseUrl, sessionKey, recentMessages)
    } finally {
      gate.requestInFlight = false
    }
    if (!gate.awaitingUserAction && gate.pendingRecentMessages.length > 0) {
      await this.maybeRequestSuggestions(baseUrl, sessionKey)
    }
  }

  private async requestSuggestions(
    baseUrl: string,
    recentMessages: SuggestionMessage[]
  ): Promise<RealtimeSuggestion[]> {
    await this.syncProfilesViaEverMemOS(recentMessages)
    const [userProfile, contactProfile] = await Promise.all([
      window.electronAPI.profile.loadUser().catch(() => null),
      this.loadCurrentContactProfile()
    ])
    const suggestions = await this.requestSuggestionsViaVisualMonitor(
      baseUrl,
      recentMessages,
      userProfile,
      contactProfile
    )
    return dedupeSuggestions(suggestions).slice(0, this.suggestionCount)
  }

  private async syncProfilesViaEverMemOS(
    recentMessages: SuggestionMessage[]
  ): Promise<void> {
    const evermemos = this.settings?.evermemos
    if (!evermemos?.enabled) {
      return
    }

    const ownerUserId = evermemos.ownerUserId.trim()
    const sessionKey = this.currentSessionKey?.trim() || ''
    const displayName = this.currentContactName?.trim() || ''
    const apiBaseUrl = evermemos.apiBaseUrl.trim().replace(/\/$/, '')
    if (!ownerUserId || !sessionKey || !displayName || !apiBaseUrl) {
      return
    }

    const timeoutMs = Number.isFinite(evermemos.requestTimeoutMs) ? evermemos.requestTimeoutMs : 12000
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(`${apiBaseUrl}/api/v1/copilot/process-chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          owner_user_id: ownerUserId,
          session_key: sessionKey,
          display_name: displayName,
          messages: recentMessages.map((row) => ({
            message_id: row.message_id,
            conversation_id: row.conversation_id,
            sender_id: row.sender_id,
            sender_name: row.sender_name,
            sender_type: row.sender_type,
            content: row.content,
            timestamp: row.timestamp,
            content_type: row.content_type,
            reply_to: row.reply_to,
            metadata: row.metadata
          })),
          // 不传 incoming_message，避免触发 EverMemOS 的回复生成
          // 回复已由 Visual Monitor 的 SocialReplyAssistant 生成
          force_profile_update: false
        }),
        signal: controller.signal
      })

      if (!response.ok) {
        const body = await response.text()
        throw new Error(`EverMemOS profile sync failed ${response.status}: ${body}`)
      }

      const result = (await response.json()) as EverMemOSProcessChatResponse
      if (!result.success) {
        throw new Error(String(result.error ?? 'EverMemOS profile sync failed'))
      }

      await this.syncEverMemOSContactProfile(result.contact_profile)

      // Update backfill progress so these messages won't be re-processed
      const latestTimestamp = recentMessages
        .map((m) => m.timestamp)
        .filter((t): t is string => Boolean(t))
        .sort()
        .pop()
      if (latestTimestamp && sessionKey) {
        await window.electronAPI.profileAdmin.updateBackfillProgress(sessionKey, latestTimestamp)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'EverMemOS profile sync failed'
      this.patchDebug({ lastSuggestionError: `${message} (profile sync fallback)` })
    } finally {
      window.clearTimeout(timeoutId)
    }
  }

  private async requestSuggestionsViaVisualMonitor(
    baseUrl: string,
    recentMessages: SuggestionMessage[],
    userProfile: UnifiedProfile | null,
    contactProfile: UnifiedProfile | null
  ): Promise<RealtimeSuggestion[]> {
    const payload = {
      messages: recentMessages.map((row) => ({
        sender: row.sender_type,
        text: row.content,
        contact_name: row.sender_type === 'contact' ? row.sender_name : null,
        timestamp: row.timestamp ?? null,
        quoted_message: row.quoted_message ?? null
      })),
      suggestion_count: this.suggestionCount,
      user_profile: userProfile,
      contact_profile: contactProfile,
      skill_id_override: this.currentSkillIdOverride
    }

    const response = await fetch(`${baseUrl}/assistant/suggestions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`assistant suggestions failed ${response.status}: ${body}`)
    }
    const result = (await response.json()) as AssistantSuggestionResponse
    return result.suggestions
      .map((item) => ({
        content: (item.content ?? item.reply ?? '').trim(),
        reason: (item.reason ?? '').trim()
      }))
      .filter((item) => item.content.length > 0 && item.reason.length > 0)
      .slice(0, this.suggestionCount)
  }

  private async loadCurrentContactProfile(): Promise<UnifiedProfile | null> {
    const contactId = this.buildCanonicalContactCacheKey()
    if (!contactId) {
      return null
    }
    return window.electronAPI.profile.loadContact(contactId)
  }

  private async syncEverMemOSContactProfile(
    profile: UnifiedProfile | null | undefined
  ): Promise<void> {
    if (!profile) {
      return
    }

    const nextCacheKey =
      profile.target_user_id?.trim() ||
      profile.conversation_id?.trim() ||
      profile.profile_id?.trim() ||
      this.currentSessionKey?.trim() ||
      this.currentContactName?.trim() ||
      null

    if (nextCacheKey) {
      this.currentContactCacheKey = nextCacheKey
    }
  }

  private buildCanonicalContactCacheKey(): string | null {
    const profileDerived = this.currentContactCacheKey?.trim()
    if (profileDerived) {
      return profileDerived
    }
    const sessionKey = this.currentSessionKey?.trim()
    if (sessionKey) {
      return sessionKey
    }
    const contactName = this.currentContactName?.trim()
    return contactName || null
  }

  private async fetchEvents(baseUrl: string): Promise<VisualMonitorEventRow[]> {
    const response = await fetch(`${baseUrl}/events/poll?limit=80`)
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`事件拉取失败 ${response.status}: ${body}`)
    }
    const payload = (await response.json()) as EventsPollResponse
    if (!Array.isArray(payload.events)) {
      return []
    }

    return payload.events
      .map((event) => ({
        sender: normalizeSender(event.sender),
        text: String(event.text ?? '').trim(),
        quoted_message: normalizeQuotedMessage(event.quoted_message),
        contact_name: normalizeOptionalText(event.contact_name),
        conversation_title: normalizeOptionalText(event.conversation_title),
        window_id: normalizeOptionalText(event.window_id),
        session_key: normalizeOptionalText(event.session_key),
        content_type: normalizeOptionalText(event.content_type),
        non_text_description: normalizeOptionalText(event.non_text_description),
        non_text_signature: normalizeOptionalText(event.non_text_signature),
        time_anchor: normalizeOptionalText(event.time_anchor),
        timestamp: normalizeOptionalText(event.timestamp) ?? undefined,
        event_id: normalizeOptionalText(event.event_id) ?? undefined,
        frame_id: normalizeOptionalText(event.frame_id) ?? undefined
      }))
      .filter((event) => event.text.length > 0 || Boolean(event.non_text_description))
  }

  private async ensureMonitorStarted(baseUrl: string): Promise<void> {
    const response = await fetch(`${baseUrl}/monitor/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`视觉监控启动失败 ${response.status}: ${body}`)
    }
  }

  private async fetchMonitorDebug(baseUrl: string): Promise<void> {
    const response = await fetch(`${baseUrl}/monitor/debug`)
    if (!response.ok) {
      return
    }
    const payload = (await response.json()) as MonitorDebugPayload
    this.patchDebug({
      monitorRunning: Boolean(payload.running),
      monitorLastError: String(payload.last_error ?? ''),
      monitorLastFrontmostApp: String(payload.pipeline?.last_frontmost_app ?? ''),
      monitorLastGatePassed:
        typeof payload.pipeline?.last_gate_passed === 'boolean' ? payload.pipeline.last_gate_passed : null,
      monitorLastDecisionReason: String(payload.pipeline?.last_decision_reason ?? ''),
      monitorLastVisionMode: String(payload.pipeline?.last_vision_mode ?? payload.pipeline?.last_ocr_mode ?? ''),
      activeSessionKey: String(payload.pipeline?.active_session_key ?? ''),
      sessionSwitchCount: Number(payload.pipeline?.session_switch_count ?? 0),
      perSessionInflight: normalizePerSessionInflight(payload.pipeline?.per_session_inflight)
    })
  }

  private emitStatus(status: AdapterStatus): void {
    this.onStatusCallback?.(status)
  }

  private emitError(message: string): void {
    this.onErrorCallback?.(message)
  }

  private patchDebug(patch: Partial<RealtimeSuggestionDebugState>): void {
    this.debugState = { ...this.debugState, ...patch }
    this.onDebugCallback?.(this.debugState)
  }

  private async ingestEventsIntoChatRecords(events: VisualMonitorEventRow[]): Promise<void> {
    const persisted = await window.electronAPI.chatRecords.ingestAndGetRecent(events, 10)
    if (persisted.pendingConfirmation) {
      if (this.currentSessionKey) {
        this.clearRoundForSession(this.currentSessionKey)
      }
      this.currentSessionKey = null
      this.currentContactName = null
      this.currentContactCacheKey = null
      this.patchDebug({
        lastSessionName: persisted.pendingConfirmation.sessionName,
        lastChatRecordFilePath: persisted.pendingConfirmation.filePath
      })
      this.onPendingSessionConfirmationCallback?.({
        pendingId: persisted.pendingConfirmation.pendingId,
        sessionKey: persisted.pendingConfirmation.sessionKey,
        sessionName: persisted.pendingConfirmation.sessionName,
        suggestedSessionKey: persisted.pendingConfirmation.suggestedSessionKey,
        suggestedSessionName: persisted.pendingConfirmation.suggestedSessionName,
        recentMessages: persisted.pendingConfirmation.recentMessages.map((row) => ({
          message_id: row.message_id,
          conversation_id: row.conversation_id,
          sender_id: row.sender_id,
          sender_name: row.sender_name,
          sender_type: row.sender_type,
          content: row.content,
          timestamp: row.timestamp ?? null,
          content_type: row.content_type ?? null,
          reply_to: row.reply_to ?? null,
          quoted_message: row.quoted_message ?? null,
          metadata: {
            window_id: row.metadata.window_id ?? null,
            non_text_description: row.metadata.non_text_description ?? null,
            event_id: row.metadata.event_id ?? null,
            frame_id: row.metadata.frame_id ?? null
          }
        })),
        timestamp: Date.now()
      })
      return
    }
    const suggestionSession = persisted.latestUpdatedSession ?? persisted.currentSession
    if (!suggestionSession) {
      return
    }

    const sessionChanged = this.currentSessionKey !== suggestionSession.sessionKey
    if (this.currentSessionKey && this.currentSessionKey !== suggestionSession.sessionKey) {
      this.clearRoundForSession(this.currentSessionKey)
    }
    this.currentSessionKey = suggestionSession.sessionKey
    this.currentContactName = suggestionSession.sessionName
    this.currentContactCacheKey = this.buildCanonicalContactCacheKey()
    this.patchDebug({
      lastSessionName: suggestionSession.sessionName,
      lastChatRecordFilePath: suggestionSession.filePath
    })

    if (sessionChanged) {
      this.onSuggestionsCallback?.({
        suggestions: [],
        contactName: suggestionSession.sessionName,
        sessionKey: suggestionSession.sessionKey,
        timestamp: Date.now()
      })
    }

    const recentMessages: SuggestionMessage[] = suggestionSession.recentMessages.map((row) => ({
      message_id: row.message_id,
      conversation_id: row.conversation_id,
      sender_id: row.sender_id,
      sender_name: row.sender_name,
      sender_type: row.sender_type,
      content: row.content,
      timestamp: row.timestamp ?? null,
      content_type: row.content_type ?? null,
      reply_to: row.reply_to ?? null,
      quoted_message: row.quoted_message ?? null,
      metadata: {
        window_id: row.metadata.window_id ?? null,
        non_text_description: row.metadata.non_text_description ?? null,
        event_id: row.metadata.event_id ?? null,
        frame_id: row.metadata.frame_id ?? null
      },
    }))

    const gate = this.ensureSessionRound(suggestionSession.sessionKey)
    if (sessionChanged) {
      gate.awaitingUserAction = false
      gate.pendingRecentMessages = recentMessages
      await this.maybeRequestSuggestions(
        this.settings?.visualMonitor.apiBaseUrl?.trim() || 'http://127.0.0.1:18777',
        suggestionSession.sessionKey
      )
      return
    }

    const hasAnyNewRows = persisted.updatedSessions.some((session) => session.appendedCount > 0)
    if (!hasAnyNewRows) {
      return
    }
    gate.pendingRecentMessages = recentMessages
    await this.maybeRequestSuggestions(
      this.settings?.visualMonitor.apiBaseUrl?.trim() || 'http://127.0.0.1:18777',
      suggestionSession.sessionKey
    )
  }

  private async drainMonitorEventsUntilIdle(baseUrl: string): Promise<void> {
    const deadline = Date.now() + STOP_DRAIN_TIMEOUT_MS
    while (Date.now() < deadline) {
      let events: VisualMonitorEventRow[] = []
      try {
        events = await this.fetchEvents(baseUrl)
      } catch {
        events = []
      }

      this.patchDebug({
        eventsLastCount: events.length,
        eventsAccumulated: this.debugState.eventsAccumulated + events.length,
        lastEventsAt: events.length > 0 ? Date.now() : this.debugState.lastEventsAt
      })

      if (events.length > 0) {
        await this.ingestEventsIntoChatRecords(events)
      }

      try {
        await this.fetchMonitorDebug(baseUrl)
      } catch {
        // best-effort refresh while draining stop backlog
      }

      const inflight = Object.values(this.debugState.perSessionInflight).reduce(
        (sum, count) => sum + (Number.isFinite(count) ? count : 0),
        0
      )
      if (!this.debugState.monitorRunning && inflight <= 0 && events.length === 0) {
        break
      }

      await waitForMs(STOP_DRAIN_POLL_INTERVAL_MS)
    }
  }
}

function normalizeSender(sender: unknown): 'user' | 'contact' | 'unknown' {
  if (sender === 'user' || sender === 'contact' || sender === 'unknown') {
    return sender
  }
  return 'unknown'
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizePerSessionInflight(input: unknown): Record<string, number> {
  if (!input || typeof input !== 'object') {
    return {}
  }
  const payload = input as Record<string, unknown>
  const result: Record<string, number> = {}
  for (const [key, value] of Object.entries(payload)) {
    const count = Number(value)
    if (!Number.isFinite(count) || count < 0) {
      continue
    }
    result[key] = Math.floor(count)
  }
  return result
}

function normalizeQuotedMessage(value: unknown): QuotedMessagePayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const payload = value as Record<string, unknown>
  const text = normalizeOptionalText(payload.text)
  if (!text) {
    return null
  }
  return {
    text,
    sender_name: normalizeOptionalText(payload.sender_name)
  }
}

function dedupeSuggestions(suggestions: RealtimeSuggestion[]): RealtimeSuggestion[] {
  const seen = new Set<string>()
  const result: RealtimeSuggestion[] = []
  for (const suggestion of suggestions) {
    const content = suggestion.content.trim()
    const reason = suggestion.reason.trim()
    if (!content || !reason) {
      continue
    }
    const key = `${content}\n${reason}`.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push({ content, reason })
  }
  return result
}

function waitForMs(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, durationMs)
  })
}
