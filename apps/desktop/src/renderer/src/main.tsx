import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/instrument-serif/400-italic.css'
import App from './App'
import './styles.css'
import './coder.css'
import './stage.css'
import './design.css'
import './integrations.css'
import './builder.css'
import './team.css'
import { initTheme } from './theme'

initTheme()

// The Mac app draws its window buttons over the page; layouts make room for them.
if (window.polly && /Mac/i.test(navigator.userAgent)) document.documentElement.dataset.chrome = 'mac'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
