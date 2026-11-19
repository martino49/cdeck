/// <reference types="vite/client" />
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { TOAST_CLASS, Toaster } from './lib/toast'
import './index.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
    <Toaster
      position="bottom-right"
      closeButton
      visibleToasts={3}
      toastOptions={{
        classNames: {
          toast: TOAST_CLASS,
          description: '!text-dim !text-sm',
          actionButton: '!rounded-[var(--radius-ctl)] !bg-accent !text-bg !border-accent',
          cancelButton: '!rounded-[var(--radius-ctl)] !bg-panel2 !border-line !text-dim'
        }
      }}
    />
  </React.StrictMode>
)
