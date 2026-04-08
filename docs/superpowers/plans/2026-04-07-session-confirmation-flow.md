# Session Confirmation Flow Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pending-session confirmation workflow that prevents VLM title drift from splitting one conversation into multiple chat-record files, while stopping empty suggestion updates from auto-opening the expanded folio.

**Architecture:** Keep confirmed chat records in the existing per-app JSON files, add a dedicated pending-session cache area under the chat record root, and resolve pending sessions into canonical files only after confirmation or a strong automatic reuse match. The renderer gets a dedicated confirmation card, while suggestion-card auto-open only happens when real suggestions exist.

**Tech Stack:** Electron, TypeScript, Vitest, existing `chat-records` JSON persistence, renderer state in `AssistantBubbleApp`, preload IPC bridge.

---

### Task 1: Document the new storage and UI boundaries

**Files:**
- Modify: `/Users/enigma/Documents/Social_Copilot/SocialClaw/docs/superpowers/plans/2026-04-07-session-confirmation-flow.md`
- Inspect: `/Users/enigma/Documents/Social_Copilot/SocialClaw/social_copilot/frontend/src/main/chat-records.ts`
- Inspect: `/Users/enigma/Documents/Social_Copilot/SocialClaw/social_copilot/frontend/src/services/realtime-suggestion-adapter.ts`
- Inspect: `/Users/enigma/Documents/Social_Copilot/SocialClaw/social_copilot/frontend/src/renderer/src/components/AssistantBubbleApp.tsx`

- [ ] **Step 1: Freeze the data model**

Define these responsibilities in the code:

```ts
type SessionResolutionKind = 'confirmed' | 'pending_confirmation'

interface PendingSessionSnapshot {
  pendingId: string
  sessionKey: string
  sessionName: string
  suggestedSessionKey: string | null
  suggestedSessionName: string | null
  recentMessages: ChatRecordEntry[]
}
```

- [ ] **Step 2: Freeze the storage rule**

Confirmed sessions stay in:

```text
<chatRecordsDir>/<app>/<session>.json
```

Pending sessions go to:

```text
<chatRecordsDir>/.pending_sessions/<app>/<pending>.json
```

- [ ] **Step 3: Freeze the interaction rule**

The renderer must follow:

```text
pending confirmation card > suggestion card > prompt > folio
```

And:

```text
empty suggestion update != auto-open reason
```

### Task 2: Write failing tests for pending-session persistence

**Files:**
- Modify: `/Users/enigma/Documents/Social_Copilot/SocialClaw/social_copilot/frontend/src/main/chat-records.test.ts`
- Test: `/Users/enigma/Documents/Social_Copilot/SocialClaw/social_copilot/frontend/src/main/chat-records.test.ts`

- [ ] **Step 1: Write a failing test for unresolved titles being cached instead of written as confirmed chat files**

```ts
it('stores unresolved session titles in pending cache until user confirmation', async () => {
  // ingest a title that does not have an exact canonical match
  // expect result.pendingConfirmation to be populated
  // expect confirmed app directory to stay empty
  // expect .pending_sessions file to exist
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd /Users/enigma/Documents/Social_Copilot/SocialClaw/social_copilot/frontend && npm test -- src/main/chat-records.test.ts
```

Expected: FAIL because pending confirmation support does not exist yet.

- [ ] **Step 3: Write a failing test for confirming a pending session into an existing canonical file**

```ts
it('merges pending messages into the suggested canonical session and deletes the pending cache', async () => {
  // seed a confirmed file
  // ingest a fuzzy variant into pending
  // confirm with canonical title
  // expect canonical file to contain both old + pending messages
  // expect pending file removed
})
```

- [ ] **Step 4: Write a failing test for future fuzzy variants reusing the confirmed canonical file**

```ts
it('reuses a confirmed canonical session for later high-similarity title variants', async () => {
  // confirm once
  // ingest another fuzzy variant
  // expect direct append into canonical file without leaving a new pending cache
})
```

### Task 3: Write failing UI tests for no-auto-open and confirmation helpers

**Files:**
- Modify: `/Users/enigma/Documents/Social_Copilot/SocialClaw/social_copilot/frontend/src/renderer/src/components/AssistantBubbleApp.test.ts`
- Modify: `/Users/enigma/Documents/Social_Copilot/SocialClaw/social_copilot/frontend/src/services/realtime-suggestion-adapter.test.ts`

- [ ] **Step 1: Add a failing helper test for empty suggestion updates**

```ts
it('does not auto-expand for empty suggestion updates', () => {
  expect(shouldAutoExpandForSuggestionUpdate(0)).toBe(false)
  expect(shouldAutoExpandForSuggestionUpdate(3)).toBe(true)
})
```

- [ ] **Step 2: Add a failing adapter test for pending confirmation blocking suggestion requests**

```ts
it('emits pending confirmation instead of requesting suggestions for unresolved sessions', async () => {
  // mock ingestAndGetRecent to return pendingConfirmation
  // expect assistant suggestion endpoint not called
})
```

- [ ] **Step 3: Run tests to verify RED state**

Run:

```bash
cd /Users/enigma/Documents/Social_Copilot/SocialClaw/social_copilot/frontend && npm test -- src/main/chat-records.test.ts src/renderer/src/components/AssistantBubbleApp.test.ts src/services/realtime-suggestion-adapter.test.ts
```

Expected: FAIL on the newly added assertions.

### Task 4: Implement main-process pending-session storage and confirmation APIs

**Files:**
- Modify: `/Users/enigma/Documents/Social_Copilot/SocialClaw/social_copilot/frontend/src/main/chat-records.ts`
- Modify: `/Users/enigma/Documents/Social_Copilot/SocialClaw/social_copilot/frontend/src/main/ipc-handlers.ts`
- Modify: `/Users/enigma/Documents/Social_Copilot/SocialClaw/social_copilot/frontend/src/preload/index.ts`

- [ ] **Step 1: Add pending-session file types and directory helpers**

Create helpers for:

```ts
getPendingSessionsRoot(recordsDir)
loadPendingSessionFile(...)
writePendingSessionFile(...)
deletePendingSessionFile(...)
```

- [ ] **Step 2: Add candidate matching**

Use existing title metadata first:

```ts
exact canonical_title_key
exact title_aliases
```

Then use a bounded fuzzy score for:

```ts
suggested canonical session
pending-session clustering
```

- [ ] **Step 3: Extend ingest flow**

For each grouped session:

```ts
if exact/strong reuse -> append to confirmed file
else -> append to pending cache and return pendingConfirmation
```

- [ ] **Step 4: Add confirm API**

Implement a function like:

```ts
confirmPendingSession(
  recordsDir,
  pendingId,
  confirmedSessionName,
  ownerUserId,
  ownerDisplayName,
  limit,
  options
)
```

It must:

```text
load pending cache -> resolve target canonical file -> merge messages -> add aliases -> delete pending cache
```

- [ ] **Step 5: Exclude pending files from normal session discovery**

`collectChatRecordFiles()` must skip `.pending_sessions`.

### Task 5: Wire preload, adapter, and renderer confirmation UI

**Files:**
- Modify: `/Users/enigma/Documents/Social_Copilot/SocialClaw/social_copilot/frontend/src/preload/index.ts`
- Modify: `/Users/enigma/Documents/Social_Copilot/SocialClaw/social_copilot/frontend/src/services/realtime-suggestion-adapter.ts`
- Modify: `/Users/enigma/Documents/Social_Copilot/SocialClaw/social_copilot/frontend/src/services/realtime-suggestion-adapter.test.ts`
- Modify: `/Users/enigma/Documents/Social_Copilot/SocialClaw/social_copilot/frontend/src/renderer/src/components/AssistantBubbleApp.tsx`
- Modify: `/Users/enigma/Documents/Social_Copilot/SocialClaw/social_copilot/frontend/src/renderer/src/components/AssistantBubbleApp.test.ts`
- Modify: `/Users/enigma/Documents/Social_Copilot/SocialClaw/social_copilot/frontend/src/renderer/src/assistant.css`

- [ ] **Step 1: Add preload IPC methods**

Expose:

```ts
chatRecords.confirmPendingSession(...)
```

- [ ] **Step 2: Add adapter confirmation events**

Expose:

```ts
onPendingSessionConfirmation(...)
confirmPendingSession(...)
```

- [ ] **Step 3: Stop auto-opening on empty suggestion updates**

Renderer behavior:

```ts
if (update.suggestions.length === 0) {
  sync session metadata only
  do not call syncExpandedState(true)
}
```

- [ ] **Step 4: Add a dedicated confirmation card**

It must provide:

```text
detected title
suggested canonical title if available
manual input override
确认 / 保存更正 / 稍后
```

- [ ] **Step 5: After confirmation, request the normal suggestion round**

The adapter should refresh current session context from the confirmed canonical file and continue the suggestion pipeline using the merged chat history.

### Task 6: Verify and document

**Files:**
- Modify: `/Users/enigma/Documents/Social_Copilot/.codex/session_history.md`

- [ ] **Step 1: Run targeted tests**

Run:

```bash
cd /Users/enigma/Documents/Social_Copilot/SocialClaw/social_copilot/frontend && npm test -- src/main/chat-records.test.ts src/renderer/src/components/AssistantBubbleApp.test.ts src/services/realtime-suggestion-adapter.test.ts
```

Expected: PASS for the targeted files.

- [ ] **Step 2: Run the broader JavaScript test suite**

Run:

```bash
cd /Users/enigma/Documents/Social_Copilot/SocialClaw/social_copilot/frontend && npm test
```

Expected: any remaining failures must be called out explicitly as pre-existing if unchanged.

- [ ] **Step 3: Update session history**

Record:

```text
session confirmation flow
pending cache merge/delete rule
empty suggestion update no longer auto-opens folio
```
