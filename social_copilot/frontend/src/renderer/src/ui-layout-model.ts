export type RoiMode = 'manual' | 'auto' | 'hybrid'

export interface MemoryFolderItem {
  id: string
  name: string
  count: number
  group: 'system' | 'project' | 'archive'
}

export interface SuggestionMessage {
  id: string
  content: string
  timeLabel: string
}

const MEMORY_FOLDERS: ReadonlyArray<MemoryFolderItem> = [
  { id: 'inbox', name: '收件箱', count: 12, group: 'system' },
  { id: 'today-messages', name: '今日消息', count: 4, group: 'system' },
  { id: 'long-term-memory', name: '长期记忆', count: 36, group: 'project' }
]

const INITIAL_SUGGESTIONS: ReadonlyArray<SuggestionMessage> = [
  {
    id: 'sg-1',
    content: '可以先认可对方的时间安排，再给一个你可执行的具体时间点。',
    timeLabel: '刚刚'
  },
  {
    id: 'sg-2',
    content: '语气保持轻松，建议一句话内给出明确回复，避免让对方继续猜测。',
    timeLabel: '1 分钟前'
  },
  {
    id: 'sg-3',
    content: '如果你暂时不确定，就先表达感谢并约定稍后确认，先稳住节奏。',
    timeLabel: '2 分钟前'
  }
]

const MODE_LABELS: Record<RoiMode, string> = {
  manual: 'Manual（手动框选）',
  auto: 'Auto（自动识别）',
  hybrid: 'Hybrid（自动优先）'
}

export function getMemoryFolderItems(): MemoryFolderItem[] {
  return MEMORY_FOLDERS.map((item) => ({ ...item }))
}

export function createInitialSuggestionMessages(): SuggestionMessage[] {
  return INITIAL_SUGGESTIONS.map((item) => ({ ...item }))
}

export function getModeLabel(mode: RoiMode): string {
  return MODE_LABELS[mode]
}

