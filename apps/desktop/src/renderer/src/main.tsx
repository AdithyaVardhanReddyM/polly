import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/instrument-serif/400-italic.css'
import App from './App'
import './styles.css'
import './coder.css'
import { initTheme } from './theme'

initTheme()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
