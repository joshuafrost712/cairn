import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ensurePersistentStorage } from './db/persistence'

// Before render, and not awaited: an unsynced capture is only as durable as the
// browser's eviction policy allows, and the request costs nothing to make.
ensurePersistentStorage()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
