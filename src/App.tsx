import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { loadReferenceData } from './db/reference'
import { startSyncLoop } from './db/sync'
import { startCoverageSync } from './db/coverage'
import { refreshDirectory, synthesizeLocalDirectory } from './db/directory'
import { mirrorActiveWorkshop } from './db/settings'
import { AppShell } from './layout/AppShell'
import { RequireRole } from './layout/RequireRole'
import { ADMIN_ROLES, CHIEF_ROLES, useHasWorkshopRole, useScopedWorkshopId } from './layout/roles'
import { syncDrafts } from './db/draftSync'
import { enforceTokenHygiene } from './routing/config'
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
import { SyncHealth } from './pages/admin/SyncHealth'
import { Progress } from './pages/admin/Progress'
import { EventList } from './pages/admin/EventList'
import { EventDetail } from './pages/admin/EventDetail'
import { ParticipantList } from './pages/admin/ParticipantList'
import { ParticipantDetail } from './pages/admin/ParticipantDetail'
import { EvaluatorList } from './pages/admin/EvaluatorList'
import { EvaluatorDetail } from './pages/admin/EvaluatorDetail'
import { Roster } from './pages/admin/Roster'
import { Assignments } from './pages/admin/Assignments'
import { Records } from './pages/admin/Records'
import { Settings } from './pages/admin/Settings'
import { DataPage } from './pages/admin/DataPage'
import { Conversations } from './pages/Conversations'
import { Inbox } from './pages/Inbox'
import { Outgoing } from './pages/Outgoing'
import { Workbench } from './pages/Workbench'
import { DevFeedbackRoot } from './devfeedback/DevFeedbackRoot'

function Shell() {
  const { identity, status, memberships, membershipStatus, isLocalMode } = useAuth()
  const scopedWorkshopId = useScopedWorkshopId()
  const isChief = useHasWorkshopRole(CHIEF_ROLES)
  const selfEmail = identity?.email ?? null
  const selfName = identity?.name ?? null

  useEffect(() => {
    const stopSync = startSyncLoop()
    return stopSync
  }, [])

  // tl-03 token hygiene. After tl-04 only an administrator's device has any use
  // for a routing PAT, so a token found on anybody else's is a credential left
  // behind — by a demotion, or by the months when this page was reachable by every
  // signed-in user. Waits for memberships to settle, because 'loading' looks
  // exactly like "holds no admin role" and clearing on that would delete a real
  // administrator's token on every cold start.
  useEffect(() => {
    // Judged only against a signed-in account. A signed-out device is a separate
    // question and answering it here would make every sign-out cost Joshua his
    // PAT, which is friction bought for no security: the token is only reachable
    // from a page the gate already closes.
    if (!identity || membershipStatus !== 'ready') return
    const adminSomewhere = memberships.some((m) => ADMIN_ROLES.includes(m.role))
    if (enforceTokenHygiene(adminSomewhere)) {
      console.info('[cairn] cleared a routing token: this account administers no workshop')
    }
  }, [identity, memberships, membershipStatus])

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

  // The two caches that are scoped to ONE workshop rather than to the account:
  // the people directory (who can hold an assignment) and the settings mirror
  // (which verification threshold this workshop's gate runs at). Keyed on the
  // active workshop, so switching scenario moves both rather than leaving the
  // previous workshop's rota and rule in place.
  //
  // loadReferenceData mirrors the settings too, on its own path, because it is
  // the one that knows when fresh rows have landed. Both are idempotent.
  useEffect(() => {
    if (status !== 'signedIn' || !scopedWorkshopId) return
    let cancelled = false
    void (async () => {
      // Mirror FIRST, before the directory fetch that can take up to eight
      // seconds. loadReferenceData also mirrors, but with the RAW stored
      // workshop id rather than this resolved one, and on a cold start that id
      // can be null or stale, in which case it mirrors the compiled-in default
      // and the verification gate quietly runs at 2 in a workshop configured for
      // 3. This is the write that corrects it, so it must not queue behind a
      // network round trip.
      await mirrorActiveWorkshop(scopedWorkshopId)
      if (cancelled) return
      if (isLocalMode) {
        // No workshop_member table to read in this mode, so the board is built
        // from the evaluators this device has actually seen.
        await synthesizeLocalDirectory(
          scopedWorkshopId,
          selfEmail ? { email: selfEmail, name: selfName ?? selfEmail } : null,
        )
      } else {
        await refreshDirectory(scopedWorkshopId)
      }
      if (cancelled) return
      // Again after the pull, in case loadReferenceData landed fresh rows while
      // the directory fetch was in flight. Idempotent.
      await mirrorActiveWorkshop(scopedWorkshopId)
      if (cancelled || !isChief) return
      // Outgoing documents, so "has that gone out yet" reads the same on every
      // chief's device. Gated on the role because doc_draft is chief-only by
      // policy, and an evaluator's device asking would be a request that can
      // only ever come back empty.
      await syncDrafts(scopedWorkshopId)
    })()
    return () => {
      cancelled = true
    }
  }, [status, scopedWorkshopId, isLocalMode, isChief, selfEmail, selfName])

  // Distinct from signed-out: we haven't resolved the stored session yet.
  // Showing the sign-in form here would flash it at an already-signed-in user,
  // and on a slow connection would look like a failed login.
  if (status === 'checking') {
    return (
      <main className="shell__content" style={{ maxWidth: 720 }}>
        <div className="card">
          <h1>Honest Eval</h1>
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
          <h1>Honest Eval</h1>
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
          <Route path="/admin/progress" element={<Progress />} />
          {/* CHIEF_ROLES, not ADMIN_ROLES, because that set is exactly the one
              report_assignment's write policy names. A chief evaluator who can
              rebalance the rota in the database should be able to reach the page
              that does it; gating the UI more tightly than the data hides a
              capability the person legitimately holds. */}
          <Route path="/admin/assignments" element={<Assignments />} />
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
          {/* tl-03: routing is an administrator's surface. It used to sit in the
              capture group where every signed-in user could open it, which is how
              an evaluator's phone ended up holding a token with write access to a
              private repo. */}
          <Route path="/admin/routing" element={<Routing />} />
          {/* tl-18: the pipeline gauge. Admin, not chief: it lists other
              evaluators' stuck work and links to routing. */}
          <Route path="/admin/sync-health" element={<SyncHealth />} />
          {/* The old single Admin page. Bookmarks and the docs both point at it. */}
          <Route path="/admin" element={<Navigate to="/admin/roster" replace />} />
        </Route>
      </Route>

      {/* An installed PWA can hold a cached deep link to the old path, and the
          catch-all would send it home with no explanation. Redirecting to the new
          path instead means an admin lands on the page and an evaluator is
          bounced home by RequireRole — the correct answer for each. */}
      <Route path="/routing" element={<Navigate to="/admin/routing" replace />} />

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
