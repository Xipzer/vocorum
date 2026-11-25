import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { installEmojiCopy } from './emoji.tsx'
import { installKeyboardDock } from './keyboard.ts'
import { native } from './native.ts'
import { TitleBar } from './TitleBar.tsx'
import { UpdateCheck } from './UpdateCheck.tsx'
import './styles.css'
import './media.css'
import './composer.css'
import './card-edges.css'

installKeyboardDock()
installEmojiCopy()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TitleBar />
    <App />
    <UpdateCheck />
  </StrictMode>,
)

if ('serviceWorker' in navigator && window.isSecureContext && !native) {
  void navigator.serviceWorker.register('/sw.js').catch(() => {})
}
