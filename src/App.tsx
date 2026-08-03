import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Splash } from './components/Splash'
import { loadReferenceData } from './db/reference'
import { startSyncLoop } from './db/sync'
import { startCoverageSync } from './db/coverage'
import { refreshDirectory, synthesizeLocalDirectory } from './db/directory'
import { mirrorActiveWorkshop } from './db/settings'
import { AppShell } from './layout/AppShell'
import { RequireRole } from './layout/RequireRole'
import { RequireRoleAnywhere } from './layout/RequireRoleAnywhere'
import { ADMIN_ROLES, CHIEF_ROLES, useHasWorkshopRole, useScopedWorkshopId } from './layout/roles'
import { syncDrafts } from './db/draftSync'
import { enforceTokenHygiene } from './routing/config'
import { enforceRelayHygiene } from './relay/config'
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
import { Assignments } from './pages/admin/Assignments'
import { Records } from './pages/admin/Records'
import { Setup } from './pages/admin/Setup'
import { AdminConversations } from './pages/admin/AdminConversations'
import { DataPage } from './pages/admin/DataPage'
import { Conversations } from './pages/Conversations'
import { Inbox } from './pages/Inbox'
import { Outgoing } from './pages/Outgoing'
import { Workbench } from './pages/Workbench'
import { Workshops } from './pages/Workshops'
import { DevFeedbackRoot } from './devfeedback/DevFeedbackRoot'

/**
 * tl-19: the public landing and tour, lazily loaded.
 *
 * The only lazy route in the app, and the reason is the budget rather than the
 * page weight in the abstract: it is the one route that needs an animation library
 * and a stylesheet nothing else uses, and it is the one route an evaluator on a
 * workshop phone never opens. Splitting it keeps both out of the shell that every
 * device precaches. `test/welcomeChunk.test.ts` guards the boundary.
 */
const Welcome = lazy(() => import('./pages/Welcome').then((m) => ({ default: m.Welcome })))

/**
 * The two routes that exist whether or not anybody is signed in.
 *
 * `/welcome` is registered in every branch, not just the signed-out one, because
 * it is a link Joshua sends to people and a page he presents from a laptop that is
 * already logged in; a tour only reachable by signing out is not a pitch page.
 * `/signin` sends an already-signed-in visitor home instead of offering a second
 * sign-in form.
 */
function publicRoutes(signedIn: boolean) {
  return [
    <Route
      key="welcome"
      path="/welcome"
      element={
        <Suspense fallback={<Splash />}>
          <Welcome />
        </Suspense>
      }
    />,
    <Route
      key="signin"
      path="/signin"
      element={signedIn ? <Navigate to="/" replace /> : <SignIn />}
    />,
  ]
}

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
    // tl-21: the relay's token is the same kind of thing on the same device, held for the
    // same role, and cleared by the same rule. It buys less — the relay is on loopback and
    // needs somebody at the keyboard — but a credential whose owner has been demoted has
    // no reason to still be there, and two hygiene rules that disagreed would be worse
    // than either.
    if (enforceRelayHygiene(adminSomewhere)) {
      console.info('[cairn] cleared the local relay token: this account administers no workshop')
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
  // and on a slow connection would look like a failed login. Since tl-19 the same
  // reasoning covers the landing page, which must not flash either — hence one
  // branded splash shared with the Welcome chunk's Suspense fallback.
  if (status === 'checking') return <Splash />

  // Signed out, every path lands on the landing page rather than on a bare form.
  // A first-time visitor arriving at a deep link has no idea what this is, and the
  // originally requested path is deliberately not preserved through sign-in
  // (out of scope, and /welcome is the better destination for a stranger anyway).
  if (!identity) {
    return (
      <Routes>
        {publicRoutes(false)}
        <Route path="*" element={<Navigate to="/welcome" replace />} />
      </Routes>
    )
  }

  // Same reasoning one level down: an unsettled membership load must not render
  // as "you belong to nowhere". Only a settled, genuinely empty list does.
  if (membershipStatus === 'loading') return <Splash />

  if (memberships.length === 0) {
    return (
      <Routes>
        {publicRoutes(true)}
        <Route path="*" element={<NoWorkshop />} />
      </Routes>
    )
  }

  return (
    <Routes>
      {publicRoutes(true)}

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

        {/* tl-17: the cross-workshop overview. Gated on holding an admin role in
            ANY membership rather than in the active workshop, because this is the
            page you open precisely when the active workshop is the wrong one. See
            RequireRoleAnywhere for why that is a separate component. */}
        <Route element={<RequireRoleAnywhere roles={ADMIN_ROLES} orPlatformOwner />}>
          <Route path="/workshops" element={<Workshops />} />
        </Route>

        <Route element={<RequireRole roles={ADMIN_ROLES} />}>
          {/* tl-07: the Setup hub. One surface owns the whole workshop definition,
              and each section is its own route so a link can point at one. The
              editors that used to live at /builder, /admin/roster and
              /admin/settings are sections of it now; their old paths redirect
              below rather than rendering a second copy.

              ADMIN_ROLES, where /builder was CHIEF_ROLES: authoring what a
              workshop asks and who is in it is an administrator's act. A chief
              evaluator keeps every review surface and loses the authoring one. */}
          <Route path="/admin/setup" element={<Setup />} />
          <Route path="/admin/setup/:section" element={<Setup />} />
          <Route path="/admin/records" element={<Records />} />
          {/* tl-05: the conversation queue is an administrator's surface. The
              evaluator-facing /conversations shows the same rows narrowed to the
              ones assigned to the person looking. */}
          <Route path="/admin/conversations" element={<AdminConversations />} />
          <Route path="/admin/data" element={<DataPage />} />
          {/* tl-03: routing is an administrator's surface. It used to sit in the
              capture group where every signed-in user could open it, which is how
              an evaluator's phone ended up holding a token with write access to a
              private repo. */}
          <Route path="/admin/routing" element={<Routing />} />
          {/* tl-18: the pipeline gauge. Admin, not chief: it lists other
              evaluators' stuck work and links to routing. */}
          <Route path="/admin/sync-health" element={<SyncHealth />} />
          {/* The old paths. Every one of these is in somebody's bookmarks, an
              installed PWA's cache, or a doc, and the catch-all would send them
              home with no explanation. They land on the section that replaced
              them instead. */}
          <Route path="/admin" element={<Navigate to="/admin/setup" replace />} />
          <Route path="/admin/roster" element={<Navigate to="/admin/setup/participants" replace />} />
          <Route path="/admin/settings" element={<Navigate to="/admin/setup" replace />} />
        </Route>
      </Route>

      {/* An installed PWA can hold a cached deep link to the old path, and the
          catch-all would send it home with no explanation. Redirecting to the new
          path instead means an admin lands on the page and an evaluator is
          bounced home by RequireRole — the correct answer for each. */}
      <Route path="/routing" element={<Navigate to="/admin/routing" replace />} />

      {/* /builder is outside the ADMIN_ROLES block on purpose: a chief evaluator
          following an old link should be redirected to the hub and bounced home by
          its gate, which reads as "not yours any more", rather than falling through
          to the catch-all as if the link were nonsense. */}
      <Route path="/builder" element={<Navigate to="/admin/setup/calendar" replace />} />

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
