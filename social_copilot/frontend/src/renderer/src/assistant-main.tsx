import React from 'react'
import ReactDOM from 'react-dom/client'
import { AssistantBubbleApp } from './components/AssistantBubbleApp'
import './assistant.css'

const rootElement = document.getElementById('assistant-root')

if (rootElement === null) {
  throw new Error('Assistant root element not found')
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <AssistantBubbleApp />
  </React.StrictMode>
)
