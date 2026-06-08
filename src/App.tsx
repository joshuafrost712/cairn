import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Link, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { loadReferenceData } from './db/reference'
import { startSyncLoop } from './db/sync'
import { SyncStatusBar } from './components/SyncStatusBar'
import { SignIn } from './pages/SignIn'
import { EvaluatorHome } from './pages/EvaluatorHome'
import { CaptureActivity } from './pages/CaptureActivity'
import { MyEvaluations } from './pages/MyEvaluations'
import { Routing } from './pages/Routing'
import { Observations } from './pages/Observations'
import { Admin } from './pages/Admin'

function Header() {
  const { identity, signOut } = useAuth()
  const loc = useLocation()
  const onHome = loc.pathname === '/'
  return (
    <header className="app-header">
      <div>
        <span className="brand">Cairn</span>{' '}
        {!onHome && <Link className="small" to="/">Home</Link>}
        <div className="sub">OBT participant evaluation</div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <SyncStatusBar />
        {identity && (
          <div className="small">
            {identity.name} · <button className="ghost small" onClick={signOut}>Sign out</button>
          </div>
        )}
      </div>
    </header>
  )
}

function Shell() {
  const { identity } = useAuth()

  useEffect(() => {
    void loadReferenceData()
    const stop = startSyncLoop()
    return stop
  }, [])

  if (!identity) {
    return (
      <Routes>
        <Route path="*" element={<SignIn />} />
      </Routes>
    )
  }

  return (
    <>
      <Header />
      <Routes>
        <Route path="/" element={<EvaluatorHome />} />
        <Route path="/capture/:clientId" element={<CaptureActivity />} />
        <Route path="/evaluations" element={<MyEvaluations />} />
        <Route path="/routing" element={<Routing />} />
        <Route path="/observations" element={<Observations />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </AuthProvider>
  )
}
