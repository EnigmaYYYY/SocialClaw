import React from 'react'
import ReactDOM from 'react-dom/client'
import { RoiOverlayApp } from './RoiOverlayApp'
import './overlay.css'

const rootElement = document.getElementById('overlay-root')

if (rootElement === null) {
  throw new Error('Overlay root element not found')
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <RoiOverlayApp />
  </React.StrictMode>
)
