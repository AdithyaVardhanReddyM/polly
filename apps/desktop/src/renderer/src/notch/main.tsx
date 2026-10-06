import React from 'react'
import ReactDOM from 'react-dom/client'
import { init } from './controller'
import { Island } from './Island'
import { useNotch } from './store'
import './notch.css'

void init()

// In a plain browser (the web build) there is no helper: expose the store so the
// island's states can be previewed by setting them from the console.
if (!window.polly) Object.assign(window, { notchStore: useNotch })

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Island />
  </React.StrictMode>
)
