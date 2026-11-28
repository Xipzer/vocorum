import { Profiler, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './display.ts'
import { installEmojiCopy } from './emoji.tsx'
import { installKeyboardDock } from './keyboard.ts'
import { native } from './native.ts'
import { rendered } from './perf.ts'
import { TitleBar } from './TitleBar.tsx'
import { UpdateCheck } from './UpdateCheck.tsx'
import './styles.css'
import './media.css'
import './composer.css'
import './card-edges.css'
import './theme-og.css'

installKeyboardDock()
installEmojiCopy()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TitleBar />
    <Profiler id="app" onRender={rendered}>
      <App />
    </Profiler>
    <UpdateCheck />
  </StrictMode>,
)

if ('serviceWorker' in navigator && window.isSecureContext && !native) {
  void navigator.serviceWorker.register('/sw.js').catch(() => {})
}
