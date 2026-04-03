/**
 * ChatInputArea Component
 *
 * Provides text area for pasting chat logs and import button for .txt files
 * Validates: Requirements 7.1, 1.1, 1.2
 */
import { useState, useRef } from 'react'

interface ChatInputAreaProps {
  onSubmit: (chatLogs: string) => void
  onImport: () => Promise<string | null>
  isLoading: boolean
  disabled?: boolean
}

export function ChatInputArea({
  onSubmit,
  onImport,
  isLoading,
  disabled = false
}: ChatInputAreaProps): JSX.Element {
  const [chatText, setChatText] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const validateInput = (text: string): boolean => {
    if (!text || text.trim().length === 0) {
      setValidationError('请输入聊天记录，不能为空')
      return false
    }
    setValidationError(null)
    return true
  }

  const handleSubmit = (): void => {
    if (validateInput(chatText)) {
      onSubmit(chatText)
    }
  }

  const handleImport = async (): Promise<void> => {
    const content = await onImport()
    if (content !== null) {
      setChatText(content)
      setValidationError(null)
    }
  }

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setChatText(e.target.value)
    if (validationError) {
      setValidationError(null)
    }
  }

  return (
    <div className="chat-input-area">
      <h2>聊天记录输入</h2>
      <textarea
        ref={textareaRef}
        value={chatText}
        onChange={handleTextChange}
        placeholder="粘贴聊天记录或点击导入按钮..."
        disabled={disabled || isLoading}
        className={validationError ? 'error' : ''}
      />
      {validationError && <div className="validation-error">{validationError}</div>}
      <div className="input-actions">
        <button type="button" onClick={handleImport} disabled={disabled || isLoading}>
          导入文件
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={disabled || isLoading || !chatText.trim()}
          className="primary"
        >
          {isLoading ? '分析中...' : '分析'}
        </button>
      </div>
    </div>
  )
}
