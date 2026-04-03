import React from 'react'
import ReactDOM from 'react-dom/client'
import { MainConsoleApp } from './MainConsoleApp'
import './main-console.css'

const rootElement = document.getElementById('root')
if (rootElement === null) {
  throw new Error('Root element not found')
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <MainConsoleApp />
  </React.StrictMode>
)
