import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { loadReferenceData } from './db/reference'
import { startSyncLoop } from './db/sync'
import { startCoverageSync } from './db/coverage'
import { AppShell } from './layout/AppShell'
import { RequireRole } from './layout/RequireRole'
import { ADMIN_ROLES, CHIEF_ROLES } from './layout/roles'
import { SignIn } from './pages/SignIn'
import { NoWorkshop } from './pages/NoWorkshop'
import { EvaluatorHome } from './pages/EvaluatorHome'
import { CaptureActivity } from './pages/CaptureActivity'
import { MyEvaluations } from './pages/MyEvaluations'
import { Routing } from './pages/Routing'
import { Observations } from './pages/Observations'
import { Reports } from './pages/Reports'
import { DayEmail } from './pages/DayEmail'
import { Export } from './pages/Export'
import { Builder } from './pages/Builder'
import { AdminOverview } from './pages/admin/AdminOverview'
import { WorkshopHealth } from './pages/admin/WorkshopHealth'
import { EventList } from './pages/admin/EventList'
import { EventDetail } from './pages/admin/EventDetail'
import { ParticipantList } from './pages/admin/ParticipantList'
import { ParticipantDetail } from './pages/admin/ParticipantDetail'
import { EvaluatorList } from './pages/admin/EvaluatorList'
import { EvaluatorDetail } from './pages/admin/EvaluatorDetail'
import { Roster } from './pages/admin/Roster'
import { Records } from './pages/admin/Records'
import { Settings } from './pages/admin/Settings'
import { DataPage } from './pages/admin/DataPage'
import { Conversations } from './pages/Conversations'
import { Inbox } from './pages/Inbox'
import { Outgoing } from './pages/Outgoing'
import { Workbench } from './pages/Workbench'
import { DevFeedbackRoot } from './devfeedback/DevFeedbackRoot'

function Shell() {
  const { identity, status, memberships, membershipStatus } = useAuth()

  useEffect(() => {
    const stopSync = startSyncLoop()
    return stopSync
  }, [])

  // Reference data is loaded once the session question is settled, and AGAIN when
  // it changes, because since tl-01 the reference tables require an authenticated
  // membership-scoped session. Loading only on mount would leave a user who just
  // signed in looking at the bundled seed until they reloaded the page.
  useEffect(() => {
    if (status === 'checking') return
    let stopCoverage: (() => void) | null = null
    let cancelled = false
    // Coverage sync starts after reference data lands, so the workshop cache exists.
    void loadReferenceData().then(() => {
      if (cancelled) return
      stopCoverage = startCoverageSync()
    })
    return () => {
      cancelled = true
      stopCoverage?.()
    }
  }, [status])

  // Distinct from signed-out: we haven't resolved the stored session yet.
  // Showing the sign-in form here would flash it at an already-signed-in user,
  // and on a slow connection would look like a failed login.
  if (status === 'checking') {
    return (
      <main className="shell__content" style={{ maxWidth: 720 }}>
        <div className="card">
          <h1>Throughline</h1>
          <p className="muted small">Checking your session…</p>
        </div>
      </main>
    )
  }

  if (!identity) {
    return (
      <Routes>
        <Route path="*" element={<SignIn />} />
      </Routes>
    )
  }

  // Same reasoning one level down: an unsettled membership load must not render
  // as "you belong to nowhere". Only a settled, genuinely empty list does.
  if (membershipStatus === 'loading') {
    return (
      <main className="shell__content" style={{ maxWidth: 720 }}>
        <div className="card">
          <h1>Throughline</h1>
          <p className="muted small">Checking your session…</p>
        </div>
      </main>
    )
  }

  if (memberships.length === 0) {
    return (
      <Routes>
        <Route path="*" element={<NoWorkshop />} />
      </Routes>
    )
  }

  return (
    <Routes>
      {/* Narrow: the capture flow. One task at a time, phone-first, no sidebar. */}
      <Route element={<AppShell mode="narrow" />}>
        <Route path="/" element={<EvaluatorHome />} />
        <Route path="/capture/:clientId" element={<CaptureActivity />} />
        <Route path="/evaluations" element={<MyEvaluations />} />
        <Route path="/routing" element={<Routing />} />
        <Route path="/conversations" element={<Conversations />} />
      </Route>

      {/* Wide: list-and-detail work. Used by evaluators and by the chief alike,
          which is why width is declared per route rather than inferred from role. */}
      <Route element={<AppShell mode="wide" />}>
        <Route path="/observations" element={<Observations />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/reports/:participantId" element={<Reports />} />

        <Route element={<RequireRole roles={CHIEF_ROLES} />}>
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/day-email" element={<DayEmail />} />
          <Route path="/outgoing" element={<Outgoing />} />
          <Route path="/outgoing/:draftId" element={<Workbench />} />
          <Route path="/export" element={<Export />} />
          <Route path="/builder" element={<Builder />} />

          <Route path="/admin/overview" element={<AdminOverview />} />
          <Route path="/admin/workshop" element={<WorkshopHealth />} />
          <Route path="/admin/events" element={<EventList />} />
          <Route path="/admin/events/:activityId" element={<EventDetail />} />
          <Route path="/admin/participants" element={<ParticipantList />} />
          <Route path="/admin/participants/:participantId" element={<ParticipantDetail />} />
          <Route path="/admin/evaluators" element={<EvaluatorList />} />
          <Route path="/admin/evaluators/:email" element={<EvaluatorDetail />} />
        </Route>

        <Route element={<RequireRole roles={ADMIN_ROLES} />}>
          <Route path="/admin/roster" element={<Roster />} />
          <Route path="/admin/records" element={<Records />} />
          <Route path="/admin/settings" element={<Settings />} />
          <Route path="/admin/data" element={<DataPage />} />
          {/* The old single Admin page. Bookmarks and the docs both point at it. */}
          <Route path="/admin" element={<Navigate to="/admin/roster" replace />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <Shell />
          <DevFeedbackRoot />
        </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  )
}
