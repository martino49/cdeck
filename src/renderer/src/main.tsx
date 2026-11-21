/// <reference types="vite/client" />
import './tauri-api'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { TOAST_CLASS, Toaster } from './lib/toast'
import { ErrorBoundary } from './lib/error-boundary'
import './index.css'

// Global error net so React crashes surface visibly instead of a blank screen.
window.addEventListener('error', (event) => {
  console.error('[uncaught]', event.message, event.filename, event.lineno)
})
window.addEventListener('unhandledrejection', (event) => {
  const r = (event as unknown as { reason?: unknown }).reason
  console.error('[unhandled rejection]', r)
})

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
    <Toaster
      position="bottom-right"
      closeButton
      visibleToasts={3}
      toastOptions={{
        classNames: {
          toast: TOAST_CLASS,
          description: '!text-dim !text-sm',
          actionButton: '!rounded-[var(--radius-ctl)] !bg-accent !text-bg !border-accent',
          cancelButton: '!rounded-[var(--radius-ctl)] !bg-panel2 !border-line !text-dim',
        },
      }}
    />
  </React.StrictMode>,
)