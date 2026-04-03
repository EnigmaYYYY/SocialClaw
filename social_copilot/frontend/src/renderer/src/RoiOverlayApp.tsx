import { useEffect, useMemo, useState } from 'react'

interface Point2D {
  x: number
  y: number
}

interface RoiRect {
  x: number
  y: number
  w: number
  h: number
}

const MIN_ROI_SIZE = 10

function normalizeRoiRect(start: Point2D, end: Point2D): RoiRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    w: Math.abs(end.x - start.x),
    h: Math.abs(end.y - start.y)
  }
}

export function RoiOverlayApp(): JSX.Element {
  const [dragStart, setDragStart] = useState<Point2D | null>(null)
  const [dragCurrent, setDragCurrent] = useState<Point2D | null>(null)
  const [history, setHistory] = useState<RoiRect[]>([])
  const [statusMessage, setStatusMessage] = useState<string>('拖拽框选聊天区域，然后确认生效')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const previewRect = useMemo(() => {
    if (dragStart && dragCurrent) {
      return normalizeRoiRect(dragStart, dragCurrent)
    }
    return history[history.length - 1] ?? null
  }, [dragStart, dragCurrent, history])

  const canConfirm = Boolean(previewRect && previewRect.w >= MIN_ROI_SIZE && previewRect.h >= MIN_ROI_SIZE)

  const beginDrag = (event: React.MouseEvent<HTMLElement>): void => {
    if (isSubmitting) {
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    const start = {
      x: Math.round(event.clientX - rect.left),
      y: Math.round(event.clientY - rect.top)
    }
    setDragStart(start)
    setDragCurrent(start)
  }

  const updateDrag = (event: React.MouseEvent<HTMLElement>): void => {
    if (!dragStart) {
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    setDragCurrent({
      x: Math.round(event.clientX - rect.left),
      y: Math.round(event.clientY - rect.top)
    })
  }

  const finalizeDrag = (): void => {
    if (!dragStart || !dragCurrent) {
      setDragStart(null)
      setDragCurrent(null)
      return
    }

    const normalized = normalizeRoiRect(dragStart, dragCurrent)
    setDragStart(null)
    setDragCurrent(null)

    if (normalized.w < MIN_ROI_SIZE || normalized.h < MIN_ROI_SIZE) {
      setStatusMessage('选区太小，请重新框选更大的区域')
      return
    }

    setHistory((previous) => [...previous, normalized])
    setStatusMessage(`预览: x=${normalized.x}, y=${normalized.y}, w=${normalized.w}, h=${normalized.h}`)
  }

  const undoSelection = (): void => {
    setHistory((previous) => {
      if (previous.length === 0) {
        return previous
      }
      const next = previous.slice(0, -1)
      if (next.length === 0) {
        setStatusMessage('已撤销到空状态，请重新框选')
      } else {
        const latest = next[next.length - 1]
        setStatusMessage(`已撤销，当前预览: x=${latest.x}, y=${latest.y}, w=${latest.w}, h=${latest.h}`)
      }
      return next
    })
  }

  const resetSelection = (): void => {
    setHistory([])
    setDragStart(null)
    setDragCurrent(null)
    setStatusMessage('已重置，请重新框选')
  }

  const closeOverlay = async (): Promise<void> => {
    await window.electronAPI.roi.closeOverlay()
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        void closeOverlay()
        return
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        undoSelection()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const confirmSelection = async (): Promise<void> => {
    if (!previewRect || !canConfirm) {
      return
    }

    setIsSubmitting(true)
    try {
      const result = await window.electronAPI.roi.applyManualSelection(previewRect)
      setStatusMessage(result.message)
    } catch (error) {
      const message = error instanceof Error ? error.message : '框选提交失败'
      setStatusMessage(message)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main
      className="roi-overlay-shell"
      onMouseDown={beginDrag}
      onMouseMove={updateDrag}
      onMouseUp={finalizeDrag}
      onMouseLeave={finalizeDrag}
    >
      {previewRect && (
        <div
          className="roi-selection-preview"
          style={{
            left: `${previewRect.x}px`,
            top: `${previewRect.y}px`,
            width: `${previewRect.w}px`,
            height: `${previewRect.h}px`
          }}
        >
          <div className="roi-selection-label">
            x={previewRect.x} y={previewRect.y} w={previewRect.w} h={previewRect.h}
          </div>
        </div>
      )}

      <section
        className="roi-toolbar"
        onMouseDown={(event) => event.stopPropagation()}
        onMouseMove={(event) => event.stopPropagation()}
        onMouseUp={(event) => event.stopPropagation()}
      >
        <p className="roi-toolbar-title">ROI 框选预览确认</p>
        <p className="roi-toolbar-message">{statusMessage}</p>
        <div className="roi-toolbar-actions">
          <button type="button" onClick={undoSelection} disabled={history.length === 0 || isSubmitting}>
            撤销
          </button>
          <button type="button" onClick={resetSelection} disabled={history.length === 0 || isSubmitting}>
            重置
          </button>
          <button type="button" onClick={() => void closeOverlay()} disabled={isSubmitting}>
            取消
          </button>
          <button type="button" className="primary" onClick={() => void confirmSelection()} disabled={!canConfirm || isSubmitting}>
            {isSubmitting ? '提交中...' : '确认生效'}
          </button>
        </div>
      </section>
    </main>
  )
}
