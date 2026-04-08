import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { ProfileLibraryPanel } from './ProfileLibraryPanel'

type MemorySectionId = Awaited<ReturnType<typeof window.electronAPI.memoryFiles.getOverview>>[number]['id']
type MemoryFileSection = Awaited<ReturnType<typeof window.electronAPI.memoryFiles.getSection>>
type MemoryFileDetail = Awaited<ReturnType<typeof window.electronAPI.memoryFiles.readItem>>
type MemoryFileListItem = MemoryFileSection['items'][number]
type ChatBubble = NonNullable<MemoryFileDetail['bubbles']>[number]

interface MemoryLibraryPanelProps {
  sectionId: MemorySectionId
  ownerUserId: string
  ownerDisplayName: string
  refreshToken: number
  onRefresh: () => Promise<void> | void
}

interface ContextMenuState {
  x: number
  y: number
  item: MemoryFileListItem
}

export function MemoryLibraryPanel({
  sectionId,
  ownerUserId,
  ownerDisplayName,
  refreshToken,
  onRefresh
}: MemoryLibraryPanelProps): JSX.Element {
  if (sectionId === 'long-term-memory') {
    return (
      <ProfileLibraryPanel
        ownerUserId={ownerUserId}
        ownerDisplayName={ownerDisplayName}
        refreshToken={refreshToken}
        onRefresh={onRefresh}
      />
    )
  }

  return (
    <FileMemoryLibraryPanel
      sectionId={sectionId}
      ownerUserId={ownerUserId}
      ownerDisplayName={ownerDisplayName}
      refreshToken={refreshToken}
      onRefresh={onRefresh}
    />
  )
}

function FileMemoryLibraryPanel({
  sectionId,
  ownerUserId: _ownerUserId,
  ownerDisplayName: _ownerDisplayName,
  refreshToken,
  onRefresh
}: MemoryLibraryPanelProps): JSX.Element {
  const [section, setSection] = useState<MemoryFileSection | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [detail, setDetail] = useState<MemoryFileDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [deletingPaths, setDeletingPaths] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])

  useEffect(() => {
    let active = true
    const load = async (): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        const nextSection = await window.electronAPI.memoryFiles.getSection(sectionId)
        if (!active) {
          return
        }
        setSection(nextSection)
      } catch (loadError) {
        if (!active) {
          return
        }
        const message = loadError instanceof Error ? loadError.message : '加载记忆文件失败'
        setError(message)
        setSection(null)
        setSelectedPath(null)
        setDetail(null)
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [sectionId, refreshToken])

  const filteredItems = useMemo(() => {
    if (!section) {
      return []
    }
    const normalizedQuery = searchQuery.trim().toLowerCase()
    if (!normalizedQuery) {
      return section.items
    }
    return section.items.filter((item) =>
      [item.title, item.summary, item.titleMeta ?? '', item.relativePath, item.tags.join(' ')]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery)
    )
  }, [searchQuery, section])

  useEffect(() => {
    if (filteredItems.length === 0) {
      setSelectedPath(null)
      setDetail(null)
      return
    }
    setSelectedPath((current) => {
      if (current && filteredItems.some((item) => item.path === current)) {
        return current
      }
      return filteredItems[0]?.path ?? null
    })
  }, [filteredItems])

  useEffect(() => {
    setSelectedPaths((current) =>
      current.filter((path) => section?.items.some((item) => item.path === path))
    )
  }, [section])

  useEffect(() => {
    let active = true
    if (!selectedPath) {
      setDetail(null)
      return () => {
        active = false
      }
    }

    const loadDetail = async (): Promise<void> => {
      setDetailLoading(true)
      try {
        const nextDetail = await window.electronAPI.memoryFiles.readItem(selectedPath)
        if (!active) {
          return
        }
        setDetail(nextDetail)
      } catch (loadError) {
        if (!active) {
          return
        }
        const message = loadError instanceof Error ? loadError.message : '读取文件失败'
        setDetail({
          path: selectedPath,
          titleMeta: null,
          title: '读取失败',
          relativePath: selectedPath,
          updatedAt: new Date().toISOString(),
          sizeLabel: '--',
          tags: ['error'],
          content: message
        })
      } finally {
        if (active) {
          setDetailLoading(false)
        }
      }
    }

    void loadDetail()
    return () => {
      active = false
    }
  }, [selectedPath])

  useEffect(() => {
    if (!menu) {
      return undefined
    }
    const closeMenu = (): void => setMenu(null)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        closeMenu()
      }
    }
    window.addEventListener('click', closeMenu)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', closeMenu, true)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', closeMenu, true)
    }
  }, [menu])

  const openContextMenu = (
    event: Pick<MouseEvent, 'clientX' | 'clientY'> | ReactMouseEvent<HTMLButtonElement>,
    item: MemoryFileListItem
  ): void => {
    setSelectedPath(item.path)
    setMenu({
      x: event.clientX,
      y: event.clientY,
      item
    })
  }

  const deleteItems = async (items: MemoryFileListItem[]): Promise<void> => {
    if (items.length === 0) {
      return
    }
    const targetLabel = items.length === 1 ? `“${items[0]?.title ?? ''}”` : `选中的 ${items.length} 条记录`
    if (!window.confirm(`删除${targetLabel}？`)) {
      return
    }

    const paths = items.map((item) => item.path)
    setDeletingPaths(paths)
    setError(null)
    setMenu(null)
    try {
      const results = await Promise.allSettled(
        paths.map(async (path) => await window.electronAPI.memoryFiles.deleteItem(path))
      )
      const failedCount = results.filter((result) => result.status === 'rejected').length
      if (failedCount > 0) {
        setError(`有 ${failedCount} 条记录删除失败`)
      }
      setSelectedPaths((current) => current.filter((path) => !paths.includes(path)))
      await onRefresh()
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : '删除失败'
      setError(message)
    } finally {
      setDeletingPaths([])
    }
  }

  const handleDelete = async (item: MemoryFileListItem): Promise<void> => {
    await deleteItems([item])
  }

  const togglePathSelection = (path: string): void => {
    setSelectedPaths((current) =>
      current.includes(path) ? current.filter((item) => item !== path) : [...current, path]
    )
  }

  const toggleSelectionMode = (): void => {
    setSelectionMode((current) => {
      if (current) {
        setSelectedPaths([])
      }
      return !current
    })
    setMenu(null)
  }

  const handleBatchDelete = async (): Promise<void> => {
    if (!section) {
      return
    }
    const items = section.items.filter((item) => selectedPaths.includes(item.path))
    await deleteItems(items)
  }

  return (
    <div className="memory-library-shell">
      <section className="console-card memory-browser-card">
        {loading && <p style={{ padding: '16px' }}>正在加载记忆文件...</p>}
        {!loading && error && (
          <p style={{ padding: '16px' }}>
            记忆文件加载失败: <span>{error}</span>
          </p>
        )}
        {!loading && !error && section && (
          <div className="memory-browser-layout">
            {/* ── 左侧列表 ── */}
            <div className="memory-item-list" role="list" aria-label={`${section.title}列表`}>
              {/* 列表顶部 header */}
              <div className="chat-list-header">
                <div className="chat-list-header-row">
                  <span className="chat-list-section-title">{section.title}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button type="button" className="memory-refresh-btn" onClick={() => void onRefresh()}>
                      刷新
                    </button>
                    <button type="button" className="memory-refresh-btn" onClick={toggleSelectionMode}>
                      {selectionMode ? '取消' : '批量选择'}
                    </button>
                  </div>
                </div>
                <label className="chat-search-field">
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="搜索联系人、会话名、标签"
                  />
                </label>
                {selectionMode && selectedPaths.length > 0 && (
                  <button
                    type="button"
                    className="memory-refresh-btn danger"
                    onClick={() => void handleBatchDelete()}
                    disabled={deletingPaths.length > 0}
                  >
                    {`删除选中 (${selectedPaths.length})`}
                  </button>
                )}
              </div>

              {filteredItems.length === 0 ? (
                <p style={{ margin: '8px 14px', color: '#71717a', fontSize: 13 }}>
                  {searchQuery.trim() ? '没有匹配的记录。' : '当前栏目还没有可展示的记录。'}
                </p>
              ) : null}

              {filteredItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`memory-item-button ${item.path === selectedPath ? 'active' : ''} ${
                    selectedPaths.includes(item.path) ? 'selected' : ''
                  }`}
                  onClick={() => {
                    setMenu(null)
                    setSelectedPath(item.path)
                  }}
                  onMouseDown={(event) => {
                    if (event.button !== 2) return
                    event.preventDefault()
                    openContextMenu(event, item)
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    openContextMenu(event, item)
                  }}
                  disabled={deletingPaths.includes(item.path)}
                >
                  {selectionMode && (
                    <label
                      className="memory-item-floating-check"
                      onClick={(event) => event.stopPropagation()}
                      onMouseDown={(event) => event.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={selectedPaths.includes(item.path)}
                        onChange={() => togglePathSelection(item.path)}
                      />
                    </label>
                  )}
                  <div className="memory-item-title-row">
                    <strong>{item.title}</strong>
                    <div className="memory-item-head-actions">
                      <span>{formatTimestamp(item.updatedAt)}</span>
                    </div>
                  </div>
                  <div className="memory-tag-row">
                    {item.summary ? <em>{item.summary}</em> : null}
                    {item.titleMeta ? <em>{item.titleMeta}</em> : null}
                    <em>{item.sizeLabel}</em>
                    {deletingPaths.includes(item.path) ? <em>删除中...</em> : null}
                  </div>
                </button>
              ))}
            </div>

            {/* ── 右侧详情 ── */}
            <div className="memory-detail-panel">
              {!detail && <p>请选择一条记录查看详情。</p>}
              {detail && (
                <>
                  <div className="chat-detail-header">
                    <div className="chat-detail-header-left">
                      <span className="chat-detail-title">{detail.title}</span>
                      <span className="chat-detail-meta">
                        {[detail.titleMeta, detail.sizeLabel, formatTimestamp(detail.updatedAt)]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </div>
                    <div className="chat-detail-header-actions">
                      <button type="button" className="memory-refresh-btn" onClick={() => void onRefresh()}>
                        刷新
                      </button>
                      {(() => {
                        const listItem = filteredItems.find((item) => item.path === detail.path)
                        return listItem ? (
                          <button
                            type="button"
                            className="memory-refresh-btn danger"
                            onClick={() => void handleDelete(listItem)}
                          >
                            删除
                          </button>
                        ) : null
                      })()}
                    </div>
                  </div>
                  {detailLoading ? (
                    <p style={{ color: '#71717a', fontSize: 13 }}>正在读取详情...</p>
                  ) : detail.bubbles && detail.bubbles.length > 0 ? (
                    <ChatBubbleList bubbles={detail.bubbles} />
                  ) : (
                    <pre className="memory-detail-content">{detail.content}</pre>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </section>

      {menu && (
        <div
          className="memory-context-menu"
          style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
        >
          <button
            type="button"
            className="memory-context-action danger"
            onClick={() => void handleDelete(menu.item)}
          >
            删除
          </button>
        </div>
      )}
    </div>
  )
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '--'
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function formatBubbleTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date)
}

function ChatBubbleList({ bubbles }: { bubbles: ChatBubble[] }): JSX.Element {
  const items: JSX.Element[] = []
  let lastTs: number | null = null
  let lastSender = ''

  for (let i = 0; i < bubbles.length; i++) {
    const bubble = bubbles[i]
    if (!bubble) continue
    const tsMs = bubble.timestamp ? new Date(bubble.timestamp).getTime() : null

    // Time divider: show when gap >= 5 minutes or at start
    if (tsMs && !Number.isNaN(tsMs)) {
      if (lastTs === null || tsMs - lastTs >= 5 * 60 * 1000) {
        items.push(
          <div key={`divider-${i}`} className="chat-time-divider">
            {formatBubbleTime(bubble.timestamp!)}
          </div>
        )
      }
      lastTs = tsMs
    }

    const isMe = bubble.sender === 'user'
    const sameGroup = bubble.name === lastSender
    lastSender = bubble.name

    items.push(
      <div
        key={i}
        className={`chat-bubble ${isMe ? 'chat-bubble-me' : 'chat-bubble-other'}${sameGroup ? ' chat-bubble-grouped' : ''}`}
      >
        <div className={`chat-bubble-avatar${isMe ? ' chat-bubble-avatar-me' : ''}${sameGroup ? ' hidden' : ''}`}>
          {bubble.name.slice(0, 1)}
        </div>
        <div className="chat-bubble-body">
          {!sameGroup && !isMe ? <span className="chat-bubble-name">{bubble.name}</span> : null}
          <div className="chat-bubble-text">{bubble.text}</div>
        </div>
      </div>
    )
  }

  return <div className="chat-bubble-list">{items}</div>
}
