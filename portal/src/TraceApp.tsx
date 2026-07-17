import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, Check, ChevronDown, ChevronRight, CircleAlert, CircleUserRound, Clock3,
  Columns2, Copy, Download, ExternalLink, Gamepad2, KeyRound, LayoutDashboard, ListFilter,
  LogOut, MessageSquareText, RotateCcw, Search, Server, Share2, ShieldCheck,
  TerminalSquare, Trash2, UserPlus, Users, X,
} from 'lucide-react'
import {
  ApiError, apiDelete, apiGet, apiPost, apiUrl, getRobloxGameMetadata, getRobloxPlayerHeadshots, projectPath, queryString, timeRange,
  type ActivityBucket, type AuthUser, type CursorPage, type ErrorDetail, type FeedbackEntry, type GroupedError,
  type IncomingProjectInvitation, type LogOccurrence, type LogSide, type ManagedProject, type PlayerSummary, type Project, type ProjectInvitation, type ProjectMember,
  type RobloxGameMetadata, type ServerJob, type Session, type Severity,
} from './api'
import './App.css'

type Page = 'overview' | 'players' | 'player' | 'logs' | 'feedback' | 'games' | 'team' | 'session' | 'error' | 'job'
type NavPage = 'overview' | 'players' | 'logs' | 'feedback' | 'games' | 'team'
type SessionOrigin = 'players' | 'logs' | 'feedback' | 'error' | 'job'
type LogMode = 'split' | 'client' | 'server'
type RobloxInvitePreview = { id: string; name: string; displayName: string; avatarUrl: string | null }

type Resource<T> = {
  data: T | null
  error: ApiError | null
  loading: boolean
  reload: () => void
}

const RESOURCE_CACHE_MS = 30_000
const RESOURCE_CACHE_LIMIT = 100
const INGESTION_DOMAIN = 'api.tracestack.gg'
const NAV_PATHS: Record<NavPage, string> = {
  overview: '/dashboard',
  players: '/players',
  logs: '/logs',
  feedback: '/feedback',
  games: '/games',
  team: '/team',
}
const exactNumberFormatter = new Intl.NumberFormat()
const compactNumberFormatter = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
})
const resourceCache = new Map<string, { data: unknown; expiresAt: number }>()
const resourceLoads = new Map<string, Promise<unknown>>()

type PortalRoute = {
  page: Page
  activeNav: NavPage
  fingerprint: string | null
  sessionId: string | null
  eventId: string | null
  jobId: string | null
}

function decodeRoutePart(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}

function readPortalRoute(): PortalRoute {
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/'
  const query = new URLSearchParams(window.location.search)
  const legacyHash = new URLSearchParams(window.location.hash.slice(1))
  const errorMatch = pathname.match(/^\/errors\/([^/]+)$/)
  const sessionMatch = pathname.match(/^\/sessions\/([^/]+)$/)
  const jobMatch = pathname.match(/^\/jobs\/([^/]+)$/)
  const navEntry = (Object.entries(NAV_PATHS) as Array<[NavPage, string]>).find(([, path]) => path === pathname)

  if (errorMatch) return { page: 'error', activeNav: 'overview', fingerprint: decodeRoutePart(errorMatch[1]), sessionId: null, eventId: null, jobId: null }
  if (sessionMatch) return { page: 'session', activeNav: 'logs', fingerprint: null, sessionId: decodeRoutePart(sessionMatch[1]), eventId: query.get('event'), jobId: null }
  if (jobMatch) return { page: 'job', activeNav: 'logs', fingerprint: null, sessionId: null, eventId: query.get('event'), jobId: decodeRoutePart(jobMatch[1]) }
  if (legacyHash.get('session')) return { page: 'session', activeNav: 'logs', fingerprint: null, sessionId: legacyHash.get('session'), eventId: legacyHash.get('event'), jobId: null }
  if (navEntry) return { page: navEntry[0], activeNav: navEntry[0], fingerprint: null, sessionId: null, eventId: null, jobId: null }
  return { page: 'overview', activeNav: 'overview', fingerprint: null, sessionId: null, eventId: null, jobId: null }
}

function writePortalRoute(path: string, replace = false) {
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === path) return
  window.history[replace ? 'replaceState' : 'pushState'](null, '', path)
}

function clearClientSessionState() {
  resourceCache.clear()
  resourceLoads.clear()
  localStorage.removeItem('trace-project-id')
  localStorage.removeItem('trace-pending-universe-id')
  localStorage.setItem('trace-explicitly-signed-out', 'true')
}

function readCachedResource<T>(key: string): T | null {
  const cached = resourceCache.get(key)
  if (!cached) return null
  if (cached.expiresAt <= Date.now()) {
    resourceCache.delete(key)
    return null
  }
  return cached.data as T
}

function loadResource<T>(key: string, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const pending = resourceLoads.get(key)
  if (pending) return pending as Promise<T>

  const request = load(new AbortController().signal)
    .then((data) => {
      if (resourceCache.size >= RESOURCE_CACHE_LIMIT) {
        const oldestKey = resourceCache.keys().next().value
        if (oldestKey) resourceCache.delete(oldestKey)
      }
      resourceCache.set(key, { data, expiresAt: Date.now() + RESOURCE_CACHE_MS })
      return data
    })
    .finally(() => resourceLoads.delete(key))
  resourceLoads.set(key, request)
  return request
}

function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  key: string,
  enabled = true,
): Resource<T> {
  const [data, setData] = useState<T | null>(() => readCachedResource<T>(key))
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [revision, setRevision] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    let active = true
    const cached = readCachedResource<T>(key)
    if (cached) {
      setData(cached)
      setError(null)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    loadResource(key, loadRef.current)
      .then((result) => {
        if (active) setData(result)
      })
      .catch((reason: unknown) => {
        if (active) setError(toApiError(reason))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [enabled, key, revision])

  return {
    data,
    error,
    loading,
    reload: () => {
      resourceCache.delete(key)
      setRevision((value) => value + 1)
    },
  }
}

function useDebouncedValue<T>(value: T, delay = 250) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return debounced
}

function toApiError(reason: unknown) {
  return reason instanceof ApiError
    ? reason
    : new ApiError(0, { error: { code: 'network_error', message: reason instanceof Error ? reason.message : 'The Trace API is unavailable.' } })
}

function TraceApp() {
  const initialQuery = useMemo(() => new URLSearchParams(window.location.search), [])
  const initialRoute = useMemo(() => readPortalRoute(), [])
  const oauthError = initialQuery.get('oauthError')
  if (initialQuery.get('signedIn') === 'true') localStorage.removeItem('trace-explicitly-signed-out')
  const explicitlySignedOut = localStorage.getItem('trace-explicitly-signed-out') === 'true'
  const startsOnManage = initialQuery.get('manage') === 'games' || initialQuery.has('claim')
  const [page, setPage] = useState<Page>(startsOnManage ? 'games' : initialRoute.page)
  const [activeNav, setActiveNav] = useState<NavPage>(startsOnManage ? 'games' : initialRoute.activeNav)
  const [sessionOrigin, setSessionOrigin] = useState<SessionOrigin>(initialRoute.sessionId ? 'logs' : 'players')
  const [selectedSessionId, setSelectedSessionId] = useState(initialRoute.sessionId)
  const [selectedEventId, setSelectedEventId] = useState(initialRoute.eventId)
  const [selectedFingerprint, setSelectedFingerprint] = useState<string | null>(initialRoute.fingerprint)
  const [selectedJobId, setSelectedJobId] = useState<string | null>(initialRoute.jobId)
  const [selectedPlayer, setSelectedPlayer] = useState<PlayerSummary | null>(null)
  const [playerSessionPagination, setPlayerSessionPagination] = useState<{ page: number; cursors: Array<string | null> }>({ page: 1, cursors: [null] })
  const [projectMenu, setProjectMenu] = useState(false)
  const [projectId, setProjectId] = useState(() => localStorage.getItem('trace-project-id'))
  const [notice, setNotice] = useState('')
  const noticeTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (startsOnManage) writePortalRoute('/games', true)
    else if (initialQuery.has('signedIn')) writePortalRoute('/dashboard', true)
    else if (oauthError) writePortalRoute('/', true)
    else if (initialRoute.sessionId && window.location.hash) {
      const event = initialRoute.eventId ? `?event=${encodeURIComponent(initialRoute.eventId)}` : ''
      writePortalRoute(`/sessions/${encodeURIComponent(initialRoute.sessionId)}${event}`, true)
    }
  }, [initialQuery, initialRoute.eventId, initialRoute.sessionId, oauthError, startsOnManage])

  useEffect(() => {
    const syncFromHistory = () => {
      const route = readPortalRoute()
      setPage(route.page)
      setActiveNav(route.activeNav)
      setSelectedFingerprint(route.fingerprint)
      setSelectedSessionId(route.sessionId)
      setSelectedEventId(route.eventId)
      setSelectedJobId(route.jobId)
      setProjectMenu(false)
      window.scrollTo({ top: 0, behavior: 'instant' })
    }
    window.addEventListener('popstate', syncFromHistory)
    return () => window.removeEventListener('popstate', syncFromHistory)
  }, [])

  const projectsResource = useResource(
    (signal) => apiGet<{ data: Project[] }>('/v1/projects', signal),
    'projects',
  )
  const projects = projectsResource.data?.data ?? []
  const project = projects.find((item) => item.id === projectId) ?? projects[0] ?? null
  const hasProject = Boolean(project)
  const effectivePage: Page = hasProject || page === 'team' ? page : 'games'
  const effectiveActiveNav: NavPage = hasProject || activeNav === 'team' ? activeNav : 'games'
  const meResource = useResource(
    (signal) => apiGet<{ user: AuthUser }>('/v1/auth/me', signal),
    'auth-me',
    Boolean(projectsResource.data),
  )

  useEffect(() => {
    if (project) {
      setProjectId(project.id)
      localStorage.setItem('trace-project-id', project.id)
      if (window.location.pathname === '/') writePortalRoute('/dashboard', true)
      return
    }
    if (!projectsResource.data) return
    setProjectId(null)
    localStorage.removeItem('trace-project-id')
    setPage((current) => current === 'team' ? 'team' : 'games')
    setActiveNav((current) => current === 'team' ? 'team' : 'games')
    if (!['/games', '/team'].includes(window.location.pathname)) writePortalRoute('/games', true)
  }, [project, projectsResource.data])

  const navigate = useCallback((next: NavPage) => {
    if (!hasProject && next !== 'games' && next !== 'team') return
    setPage(next)
    setActiveNav(next)
    setProjectMenu(false)
    writePortalRoute(NAV_PATHS[next])
    window.scrollTo({ top: 0, behavior: 'instant' })
    requestAnimationFrame(() => document.querySelector<HTMLElement>('main h1')?.focus())
  }, [hasProject])

  const openSession = (origin: SessionOrigin, sessionId: string, eventId?: string | null) => {
    setSessionOrigin(origin)
    setSelectedSessionId(sessionId)
    setSelectedEventId(eventId ?? null)
    setPage('session')
    writePortalRoute(`/sessions/${encodeURIComponent(sessionId)}${eventId ? `?event=${encodeURIComponent(eventId)}` : ''}`)
    window.scrollTo({ top: 0, behavior: 'instant' })
  }

  const openOccurrence = (origin: SessionOrigin, occurrence: LogOccurrence) => {
    if (occurrence.sessionId) openSession(origin, occurrence.sessionId, occurrence.id)
    else {
      setSessionOrigin(origin)
      setSelectedJobId(occurrence.serverJobId)
      setSelectedEventId(occurrence.id)
      setPage('job')
      writePortalRoute(`/jobs/${encodeURIComponent(occurrence.serverJobId)}?event=${encodeURIComponent(occurrence.id)}`)
      window.scrollTo({ top: 0, behavior: 'instant' })
    }
  }

  const openError = (fingerprint: string) => {
    setSelectedFingerprint(fingerprint)
    setPage('error')
    writePortalRoute(`/errors/${encodeURIComponent(fingerprint)}`)
    window.scrollTo({ top: 0, behavior: 'instant' })
  }

  const openPlayer = (player: PlayerSummary) => {
    setSelectedPlayer(player)
    setPlayerSessionPagination({ page: 1, cursors: [null] })
    setPage('player')
    setActiveNav('players')
    writePortalRoute('/players')
    window.scrollTo({ top: 0, behavior: 'instant' })
    requestAnimationFrame(() => document.querySelector<HTMLElement>('main h1')?.focus())
  }

  const announce = (message: string) => {
    setNotice(message)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(''), 2600)
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (hasProject && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        navigate('players')
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-player-search]')?.focus())
      }
      if (event.key === 'Escape') setProjectMenu(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [hasProject, navigate])

  if (explicitlySignedOut) return <SignIn oauthError={oauthError} />
  if (projectsResource.loading && !projectsResource.data) return <AppShell><PageStatus title="Connecting to Trace" copy="Loading your projects and access permissions…" loading /></AppShell>
  if (projectsResource.error) {
    const unauthenticated = projectsResource.error.status === 401
    return unauthenticated
      ? <SignIn oauthError={oauthError} />
      : <AppShell><PageStatus title="Could not load Trace" copy={apiErrorMessage(projectsResource.error)} action="Try again" onAction={projectsResource.reload} /></AppShell>
  }
  const contextualBack = () => {
    if (sessionOrigin === 'players' && selectedPlayer) {
      setPage('player')
      setActiveNav('players')
      writePortalRoute('/players')
      window.scrollTo({ top: 0, behavior: 'instant' })
    }
    else if (sessionOrigin === 'players') navigate('players')
    else if (sessionOrigin === 'error' && selectedFingerprint) {
      setPage('error')
      writePortalRoute(`/errors/${encodeURIComponent(selectedFingerprint)}`)
    }
    else if (sessionOrigin === 'job' && selectedJobId) {
      setPage('job')
      writePortalRoute(`/jobs/${encodeURIComponent(selectedJobId)}`)
    }
    else if (sessionOrigin === 'feedback') navigate('feedback')
    else navigate('logs')
  }

  return (
    <div className="app">
      <aside className="sidebar"><Brand /><PrimaryNav page={effectiveActiveNav} navigate={navigate} hasProject={hasProject} label="Primary navigation" /></aside>
      <main>
        <Topbar navigate={navigate} user={meResource.data?.user ?? null} canSearch={hasProject} />
        <div className="content">
          {!project ? effectivePage === 'team'
            ? <ManageGames projectsReload={projectsResource.reload} view="team" />
            : <ManageGames projectsReload={projectsResource.reload} firstRun />
            : <>
              {effectivePage === 'overview' && <Overview project={project} projects={projects} projectMenu={projectMenu} setProjectMenu={setProjectMenu} setProjectId={setProjectId} onOpenLogs={() => navigate('logs')} onOpenError={openError} />}
              {effectivePage === 'players' && <Players project={project} onOpenPlayer={openPlayer} />}
              {effectivePage === 'player' && selectedPlayer && <PlayerDetails project={project} player={selectedPlayer} pagination={playerSessionPagination} setPagination={setPlayerSessionPagination} onBack={() => navigate('players')} onOpenSession={(sessionId) => openSession('players', sessionId)} />}
              {effectivePage === 'logs' && <AllLogs project={project} onOpenError={openError} />}
              {effectivePage === 'feedback' && <Feedback project={project} onOpenSession={(sessionId) => openSession('feedback', sessionId)} />}
              {effectivePage === 'games' && <ManageGames projectsReload={projectsResource.reload} view="games" />}
              {effectivePage === 'team' && <ManageGames projectsReload={projectsResource.reload} view="team" />}
              {effectivePage === 'session' && selectedSessionId && <SessionLogs project={project} sessionId={selectedSessionId} selectedEventId={selectedEventId} setSelectedEventId={setSelectedEventId} onBack={contextualBack} backLabel={`Back to ${sessionOrigin === 'players' && selectedPlayer ? selectedPlayer.displayName : sessionOrigin === 'players' ? 'Players' : sessionOrigin === 'feedback' ? 'Feedback' : sessionOrigin === 'error' ? 'Error detail' : sessionOrigin === 'job' ? 'Server job' : 'Logs'}`} announce={announce} />}
              {effectivePage === 'error' && selectedFingerprint && <ErrorDetails project={project} fingerprint={selectedFingerprint} onBack={() => navigate('overview')} onOpenOccurrence={(occurrence) => openOccurrence('error', occurrence)} />}
              {effectivePage === 'job' && selectedJobId && <ServerJobDetails project={project} jobId={selectedJobId} selectedEventId={selectedEventId} onBack={contextualBack} onOpenSession={(sessionId, eventId) => openSession('job', sessionId, eventId)} />}
            </>}
        </div>
      </main>
      <MobileNav page={effectiveActiveNav} navigate={navigate} hasProject={hasProject} />
      <div className={`toast ${notice ? 'visible' : ''}`} role="status" aria-live="polite">{notice}</div>
    </div>
  )
}

function AppShell({ children }: { children: React.ReactNode }) {
  return <div className="app"><aside className="sidebar"><Brand /></aside><main><div className="content standalone-state">{children}</div></main></div>
}

function SignIn({ oauthError }: { oauthError: string | null }) {
  const errorCopy = oauthError
    ? oauthError === 'authorization_cancelled'
      ? 'Roblox sign-in was cancelled. Nothing was changed.'
      : 'Roblox could not complete sign-in. Please try again.'
    : null
  return (
    <div className="auth-layout">
      <svg className="auth-motion-field" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs>
          <linearGradient id="auth-ribbon-orange" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffb266" />
            <stop offset=".45" stopColor="#ff580f" />
            <stop offset="1" stopColor="#d93600" />
          </linearGradient>
          <linearGradient id="auth-ribbon-ember" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#6d2109" />
            <stop offset=".52" stopColor="#ff7a1a" />
            <stop offset="1" stopColor="#ff580f" />
          </linearGradient>
          <radialGradient id="auth-orb" cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="#ff580f" stopOpacity=".8" />
            <stop offset=".45" stopColor="#ff8a2a" stopOpacity=".32" />
            <stop offset="1" stopColor="#44200f" stopOpacity="0" />
          </radialGradient>
          <filter id="auth-soften" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="32" />
          </filter>
          <filter id="auth-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="10" result="blur" />
            <feColorMatrix in="blur" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 .72 0" result="glow" />
            <feMerge>
              <feMergeNode in="glow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <circle className="auth-motion-orb" cx="1105" cy="194" r="330" fill="url(#auth-orb)" />
        <g className="auth-ribbon auth-ribbon-back" filter="url(#auth-soften)">
          <path d="M1510 -130 C1220 22 1174 282 936 363 C704 443 438 311 202 498 C48 620 -72 710 -186 717" fill="none" stroke="url(#auth-ribbon-ember)" strokeWidth="154" strokeLinecap="round" />
        </g>
        <g className="auth-ribbon auth-ribbon-front" filter="url(#auth-glow)">
          <path d="M1542 -72 C1268 36 1225 235 1002 326 C757 426 526 344 312 480 C121 601 -17 699 -184 686" fill="none" stroke="url(#auth-ribbon-orange)" strokeWidth="92" strokeLinecap="round" />
        </g>
        <path className="auth-ribbon-highlight" d="M1512 -61 C1266 51 1223 214 1008 301 C774 396 559 332 351 452" fill="none" stroke="rgba(255,255,255,.48)" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <main className="auth-panel" aria-labelledby="sign-in-title">
        <div className="auth-lockup"><img src="/trace-logo.png" alt="" /><h1 id="sign-in-title">trace</h1></div>
        <p className="auth-tagline">Error observability for Roblox developers</p>
        {errorCopy && <div className="auth-error" role="alert">{errorCopy}</div>}
        <a className="primary-button roblox-sign-in" href={apiUrl('/v1/auth/roblox/start?intent=login')} onClick={() => localStorage.removeItem('trace-explicitly-signed-out')}>
          <span className="roblox-mark" aria-hidden="true"><i /></span>
          Continue with Roblox
          <ChevronRight size={18} aria-hidden="true" />
        </a>
        <p className="auth-footnote"><ShieldCheck size={14} aria-hidden="true" />Secure sign-in through Roblox OAuth</p>
      </main>
      <footer className="auth-footer"><span>Trace connects errors, sessions, players, and feedback.</span><span>Your Roblox password is never shared with Trace.</span></footer>
    </div>
  )
}

function Brand() {
  return <div className="brand"><img className="brand-logo" src="/trace-logo.png" alt="" /><strong>trace</strong></div>
}

function Topbar({ navigate, user, canSearch }: { navigate: (page: NavPage) => void; user: AuthUser | null; canSearch: boolean }) {
  const logOut = async () => {
    try {
      await apiPost<void>('/v1/auth/logout')
    } finally {
      clearClientSessionState()
      window.location.replace('/')
    }
  }
  return (
    <header className="topbar">
      <div className="mobile-brand"><Brand /></div>
      <button className="command-search" disabled={!canSearch} onClick={() => navigate('players')} aria-label={canSearch ? 'Search players, Command K' : 'Link a game to search players'}><Search size={17} aria-hidden="true" /><span>{canSearch ? 'Search players' : 'Search unlocks after setup'}</span><kbd>⌘ K</kbd></button>
      <div className="top-actions">
        <div className="account-chip">
          {user?.robloxAvatarUrl ? <img src={user.robloxAvatarUrl} alt="" /> : <div className="avatar" aria-hidden="true">{(user?.robloxUsername ?? 'T').slice(0, 2).toUpperCase()}</div>}
          <span><strong>{user?.robloxDisplayName ?? user?.name ?? 'Trace user'}</strong>{user?.robloxUsername && <small>@{user.robloxUsername}</small>}</span>
        </div>
        <button className="icon-button" aria-label="Sign out" onClick={() => void logOut()}><LogOut size={17} aria-hidden="true" /></button>
      </div>
    </header>
  )
}

function PrimaryNav({ page, navigate, hasProject, label }: { page: NavPage; navigate: (page: NavPage) => void; hasProject: boolean; label: string }) {
  const primaryItems = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'players', label: 'Players', icon: Users },
    { id: 'logs', label: 'Logs', icon: TerminalSquare },
    { id: 'feedback', label: 'Feedback', icon: MessageSquareText },
  ] as const
  const managementItems = [
    { id: 'games', label: 'Games', icon: Gamepad2 },
    { id: 'team', label: 'Team', icon: UserPlus },
  ] as const
  const renderItem = ({ id, label: itemLabel, icon: Icon }: (typeof primaryItems)[number] | (typeof managementItems)[number]) => {
    const disabled = !hasProject && id !== 'games' && id !== 'team'
    return <button key={id} disabled={disabled} title={disabled ? 'Link a game to unlock this page' : undefined} className={page === id ? 'active' : ''} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={18} aria-hidden="true" /><span>{itemLabel}</span></button>
  }
  return <>
    <nav className="primary-nav" aria-label={label}>{primaryItems.map(renderItem)}</nav>
    <nav className="management-nav" aria-label="Management navigation"><span className="nav-section-label">Manage</span>{managementItems.map(renderItem)}</nav>
  </>
}

function MobileNav({ page, navigate, hasProject }: { page: NavPage; navigate: (page: NavPage) => void; hasProject: boolean }) {
  const items = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'players', label: 'Players', icon: Users },
    { id: 'logs', label: 'Logs', icon: TerminalSquare },
    { id: 'feedback', label: 'Feedback', icon: MessageSquareText },
    { id: 'games', label: 'Games', icon: Gamepad2 },
    { id: 'team', label: 'Team', icon: UserPlus },
  ] as const
  return <div className="mobile-nav"><nav aria-label="Mobile navigation">{items.map(({ id, label, icon: Icon }) => {
    const disabled = !hasProject && id !== 'games' && id !== 'team'
    return <button key={id} disabled={disabled} className={page === id ? 'active' : ''} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={18} aria-hidden="true" /><span>{label}</span></button>
  })}</nav></div>
}

function PageTitle({ title, copy, action }: { title: string; copy?: string; action?: React.ReactNode }) {
  return <div className="page-title"><div><h1 tabIndex={-1}>{title}</h1>{copy && <p>{copy}</p>}</div>{action}</div>
}

function Overview({ project, projects, projectMenu, setProjectMenu, setProjectId, onOpenLogs, onOpenError }: {
  project: Project
  projects: Project[]
  projectMenu: boolean
  setProjectMenu: (open: boolean) => void
  setProjectId: (id: string) => void
  onOpenLogs: () => void
  onOpenError: (fingerprint: string) => void
}) {
  const [timeRangeValue, setTimeRangeValue] = useState('8')
  const [severity, setSeverity] = useState('all')
  const [side, setSide] = useState('all')
  const hours = Number(timeRangeValue)
  const range = useMemo(() => timeRange(hours), [hours])
  const filters = queryString({
    ...range,
    severity: severity === 'all' ? 'error,warning' : severity,
    side: side === 'all' ? undefined : side,
  })
  const activity = useResource(
    (signal) => apiGet<{ data: ActivityBucket[] }>(projectPath(project.id, `/activity${queryString({ ...range, bucket: hours <= 24 ? 'hour' : 'day', severity: severity === 'all' ? 'error,warning' : severity, side: side === 'all' ? undefined : side })}`), signal),
    `${project.id}:${timeRangeValue}:${severity}:${side}:activity`,
  )
  const grouped = useResource(
    (signal) => apiGet<CursorPage<GroupedError>>(projectPath(project.id, `/errors${filters}`), signal),
    `${project.id}:${timeRangeValue}:${severity}:${side}:errors`,
  )
  const [additionalErrors, setAdditionalErrors] = useState<GroupedError[]>([])
  const [errorCursor, setErrorCursor] = useState<string | null>(null)
  const [loadingMoreErrors, setLoadingMoreErrors] = useState(false)
  const [paginationError, setPaginationError] = useState<ApiError | null>(null)
  const filtersChanged = timeRangeValue !== '8' || severity !== 'all' || side !== 'all'
  const dashboardErrors = [...(grouped.data?.data ?? []), ...additionalErrors]

  useEffect(() => {
    setAdditionalErrors([])
    setErrorCursor(grouped.data?.nextCursor ?? null)
    setPaginationError(null)
  }, [grouped.data])

  const loadMoreErrors = async () => {
    if (!errorCursor || loadingMoreErrors) return
    setLoadingMoreErrors(true)
    setPaginationError(null)
    try {
      const separator = filters ? '&' : '?'
      const result = await apiGet<CursorPage<GroupedError>>(projectPath(project.id, `/errors${filters}${separator}cursor=${encodeURIComponent(errorCursor)}`))
      setAdditionalErrors((current) => [...current, ...result.data])
      setErrorCursor(result.nextCursor)
    } catch (reason) {
      setPaginationError(toApiError(reason))
    } finally {
      setLoadingMoreErrors(false)
    }
  }

  return (
    <>
      <PageTitle title="Dashboard" action={<ProjectSwitcher project={project} projects={projects} open={projectMenu} setOpen={setProjectMenu} setProjectId={setProjectId} />} />
      <div className="filter-bar" aria-label="Dashboard filters">
        <LabeledSelect label="Time range" value={timeRangeValue} onChange={setTimeRangeValue} options={[['1', 'Last hour'], ['8', 'Last 8 hours'], ['24', 'Last 24 hours'], ['72', 'Last 3 days']]} />
        <LabeledSelect label="Severity" value={severity} onChange={setSeverity} options={[['all', 'All'], ['error', 'Error'], ['warning', 'Warning']]} />
        <LabeledSelect label="Log source" value={side} onChange={setSide} options={[['all', 'All'], ['client', 'Client'], ['server', 'Server']]} />
        {filtersChanged && <button className="clear-button" onClick={() => { setTimeRangeValue('8'); setSeverity('all'); setSide('all') }}>Reset filters</button>}
      </div>
      <section className="chart-section" aria-labelledby="error-activity-title">
        <div className="section-heading">
          <div><h2 id="error-activity-title">Error activity</h2><p>Client and server events for the selected range</p></div>
          <div className="chart-legend" aria-label="Chart legend">{side !== 'server' && <span><i className="client" />Client</span>}{side !== 'client' && <span><i className="server" />Server</span>}</div>
        </div>
        {activity.error ? <InlineError error={activity.error} retry={activity.reload} /> : <ErrorChart data={activity.data?.data ?? []} loading={activity.loading} side={side} />}
      </section>
      <section className="data-section" aria-labelledby="common-errors-title">
        <div className="section-heading"><div><h2 id="common-errors-title">Errors and warnings by count</h2><p>Most frequent events first</p></div><button className="text-button" onClick={onOpenLogs}>Open all logs</button></div>
        {grouped.error ? <InlineError error={grouped.error} retry={grouped.reload} /> : grouped.loading && !grouped.data ? <RowsLoading /> : dashboardErrors.length ? (
          <div className="error-table">
            <div className="table-head error-grid"><span>Count</span><span>Severity</span><span>Type</span><span>First seen</span><span>Message</span></div>
            {dashboardErrors.map((error) => (
              <button className="error-grid" key={error.fingerprint} onClick={() => onOpenError(error.fingerprint)} aria-label={`Open error detail. ${exactNumberFormatter.format(error.count)} occurrences. Severity ${error.severity}. Type ${error.side}. Message: ${error.title}.`}>
                <strong className="event-count" title={`${exactNumberFormatter.format(error.count)} occurrences`}>{formatCount(error.count)}</strong><SeverityBadge level={error.severity} /><span className="secondary">{labelSide(error.side)}</span><time className="secondary first-seen">{formatDate(error.firstSeenAt)}</time><span className={`event-message ${error.severity}`}><strong>{error.title}</strong><code>{error.source ?? 'Unknown source'}</code></span>
              </button>
            ))}
          </div>
        ) : <PageStatus compact title="No matching events" copy="No events were recorded for these filters and time range." />}
        {paginationError && <InlineError error={paginationError} retry={loadMoreErrors} />}
        {errorCursor && <div className="load-more"><button onClick={loadMoreErrors} disabled={loadingMoreErrors}>{loadingMoreErrors ? 'Loading…' : 'Load more events'}</button></div>}
      </section>
    </>
  )
}

function ProjectSwitcher({ project, projects, open, setOpen, setProjectId }: { project: Project; projects: Project[]; open: boolean; setOpen: (open: boolean) => void; setProjectId: (id: string) => void }) {
  const [metadata, setMetadata] = useState<Record<string, RobloxGameMetadata>>({})
  useEffect(() => {
    const controller = new AbortController()
    Promise.all(projects.map(async (item) => {
      try {
        const result = await getRobloxGameMetadata(item.id, item.robloxUniverseId, controller.signal)
        return [item.id, result] as const
      } catch {
        return null
      }
    })).then((results) => {
      if (!controller.signal.aborted) setMetadata(Object.fromEntries(results.filter((result) => result !== null)))
    })
    return () => controller.abort()
  }, [projects])

  const enrich = (item: Project): Project => ({
    ...item,
    name: metadata[item.id]?.name ?? item.name,
    iconUrl: metadata[item.id]?.iconUrl ?? item.iconUrl,
  })
  const displayProject = enrich(project)
  return (
    <div className="game-switch-wrap">
      <button className="game-switch" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ProjectIcon project={displayProject} />
        <span><small>Viewing game</small><strong>{displayProject.name}</strong></span><ChevronDown size={17} aria-hidden="true" />
      </button>
      {open && <div className="game-menu" role="group" aria-label="Choose a game"><p>Integrated games</p>{projects.map((item) => {
        const displayItem = enrich(item)
        return <button aria-pressed={project.id === item.id} key={item.id} onClick={() => { setProjectId(item.id); setOpen(false) }}><ProjectIcon project={displayItem} /><span><strong>{displayItem.name}</strong><small>{item.robloxUniverseId ? `Universe ${item.robloxUniverseId}` : 'Roblox experience ID not set'}</small></span>{project.id === item.id && <Check size={16} aria-hidden="true" />}</button>
      })}</div>}
    </div>
  )
}

function ProjectIcon({ project }: { project: Project }) {
  const [imageFailed, setImageFailed] = useState(false)
  useEffect(() => setImageFailed(false), [project.iconUrl])
  if (project.iconUrl && !imageFailed) return <img className="game-icon project-image" src={project.iconUrl} alt="" onError={() => setImageFailed(true)} />
  return <span className="game-icon game-icon-fallback" aria-hidden="true"><Gamepad2 size={18} /></span>
}

function ProjectTab({ project, selected, onSelect }: { project: ManagedProject; selected: boolean; onSelect: () => void }) {
  const metadata = useResource(
    (signal) => getRobloxGameMetadata(project.id, project.robloxUniverseId, signal),
    `${project.id}:team-tab-metadata`,
    Boolean(project.robloxUniverseId) && !project.iconUrl,
  )
  const displayProject = {
    ...project,
    name: metadata.data?.name ?? project.name,
    iconUrl: metadata.data?.iconUrl ?? project.iconUrl,
  }
  return <button role="tab" aria-selected={selected} onClick={onSelect}><ProjectIcon project={displayProject} /><span><strong>{displayProject.name}</strong><small>{project.role === 'owner' ? 'Owner' : 'Admin'}</small></span>{selected && <Check size={16} aria-hidden="true" />}</button>
}

function GameIdentity({ project, enrich = false }: { project: Project; enrich?: boolean }) {
  const metadata = useResource(
    (signal) => getRobloxGameMetadata(project.id, project.robloxUniverseId, signal),
    `${project.id}:managed-game-metadata`,
    enrich && Boolean(project.robloxUniverseId) && !project.iconUrl,
  )
  const displayProject = {
    ...project,
    name: metadata.data?.name ?? project.name,
    iconUrl: metadata.data?.iconUrl ?? project.iconUrl,
  }
  return <div className="game-identity"><ProjectIcon project={displayProject} /><span><strong>{displayProject.name}</strong><small>{project.robloxUniverseId ? `Universe ${project.robloxUniverseId}` : 'Roblox experience'}</small></span></div>
}

function ErrorChart({ data, loading, side }: { data: ActivityBucket[]; loading: boolean; side: string }) {
  const showClient = side !== 'server'
  const showServer = side !== 'client'
  const chartRef = useRef<HTMLDivElement>(null)
  const [chartSize, setChartSize] = useState({ width: 700, height: 220 })
  const [tooltip, setTooltip] = useState<{ index: number; x: number; y: number } | null>(null)
  const visibleData = data.map((bucket) => ({
    time: formatChartTime(bucket.startAt, data.length),
    client: bucket.clientCount,
    server: bucket.serverCount,
  }))
  const highest = Math.max(1, ...visibleData.flatMap((item) => [showClient ? item.client : 0, showServer ? item.server : 0]))
  const max = Math.max(5, Math.ceil(highest / 5) * 5)
  const { width, height } = chartSize
  const top = 18
  const bottom = 32
  const point = (index: number, value: number) => {
    const x = 36 + index * ((width - 54) / Math.max(1, visibleData.length - 1))
    const y = top + (max - value) * ((height - top - bottom) / max)
    return [x, y] as const
  }
  const line = (key: 'client' | 'server') => visibleData.map((item, index) => point(index, item[key]).join(',')).join(' ')

  useEffect(() => {
    const element = chartRef.current
    if (!element) return
    const resize = () => {
      const styles = getComputedStyle(element)
      setChartSize({
        width: Math.max(280, Math.round(element.clientWidth - Number.parseFloat(styles.paddingLeft) - Number.parseFloat(styles.paddingRight))),
        height: Math.max(180, Math.round(element.clientHeight - Number.parseFloat(styles.paddingTop) - Number.parseFloat(styles.paddingBottom))),
      })
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const ticks = [0, Math.round(max / 3), Math.round(max * 2 / 3), max]
  return (
    <div className={`chart-wrap ${loading ? 'is-loading' : ''}`} ref={chartRef}>
      {visibleData.length ? <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Client and server event activity" onPointerLeave={() => setTooltip(null)}>
        {ticks.map((tick) => { const [, y] = point(0, tick); return <g key={tick}><line x1="36" x2={width - 18} y1={y} y2={y} className="chart-grid" /><text x="4" y={y + 4}>{tick}</text></g> })}
        {showClient && <polygon points={`36,${height - bottom} ${line('client')} ${width - 18},${height - bottom}`} className="chart-area" />}
        {showClient && <polyline points={line('client')} className="chart-line client" />}
        {showServer && <polyline points={line('server')} className="chart-line server" />}
        {visibleData.map((item, index) => {
          const [clientX, clientY] = point(index, item.client)
          const [serverX, serverY] = point(index, item.server)
          const showLabel = visibleData.length <= 12 || index % Math.ceil(visibleData.length / 8) === 0 || index === visibleData.length - 1
          const step = visibleData.length > 1 ? (width - 54) / (visibleData.length - 1) : width - 54
          const hitStart = index === 0 ? 18 : clientX - step / 2
          const hitEnd = index === visibleData.length - 1 ? width : clientX + step / 2
          const tooltipY = Math.min(showClient ? clientY : height, showServer ? serverY : height)
          return <g key={`${item.time}-${index}`}>{showLabel && <text x={clientX} y={height - 8} textAnchor="middle">{item.time}</text>}{showClient && <circle cx={clientX} cy={clientY} r="5" className="chart-dot client" />}{showServer && <circle cx={serverX} cy={serverY} r="5" className="chart-dot server" />}<rect className="chart-hit-area" x={hitStart} y={top} width={Math.max(1, hitEnd - hitStart)} height={height - top - bottom} tabIndex={0} role="button" aria-label={`${item.time}. ${showClient ? `${item.client} client events. ` : ''}${showServer ? `${item.server} server events.` : ''}`} onPointerEnter={() => setTooltip({ index, x: clientX, y: tooltipY })} onPointerMove={() => setTooltip({ index, x: clientX, y: tooltipY })} onFocus={() => setTooltip({ index, x: clientX, y: tooltipY })} onBlur={() => setTooltip(null)} /></g>
        })}
      </svg> : <div className="chart-empty">{loading ? 'Loading activity…' : 'No activity in this range'}</div>}
      {tooltip && visibleData[tooltip.index] && <div className="chart-tooltip" style={{ left: `${Math.min(width - 78, Math.max(78, tooltip.x))}px`, top: `${Math.max(100, tooltip.y)}px` }}><strong>{visibleData[tooltip.index].time}</strong>{showClient && <span><i className="client" />Client <b>{visibleData[tooltip.index].client}</b></span>}{showServer && <span><i className="server" />Server <b>{visibleData[tooltip.index].server}</b></span>}</div>}
      <table className="sr-only"><caption>Chart data for the selected filters</caption><thead><tr><th>Time</th>{showClient && <th>Client events</th>}{showServer && <th>Server events</th>}</tr></thead><tbody>{visibleData.map((item, index) => <tr key={index}><td>{item.time}</td>{showClient && <td>{item.client}</td>}{showServer && <td>{item.server}</td>}</tr>)}</tbody></table>
    </div>
  )
}

function Players({ project, onOpenPlayer }: { project: Project; onOpenPlayer: (player: PlayerSummary) => void }) {
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebouncedValue(query.trim())
  const search = useResource(
    async (signal) => {
      const path = projectPath(project.id, `/players${queryString({ query: debouncedQuery || undefined, limit: 50 })}`)
      try {
        return await apiGet<{ data: PlayerSummary[] }>(path, signal)
      } catch (error) {
        // Older API deployments require a query. "%" preserves the default
        // directory until the optional-query endpoint has been deployed.
        if (!debouncedQuery && error instanceof ApiError && error.status === 400) {
          return apiGet<{ data: PlayerSummary[] }>(projectPath(project.id, `/players${queryString({ query: '%', limit: 50 })}`), signal)
        }
        throw error
      }
    },
    `${project.id}:${debouncedQuery}:players`,
  )
  const headshotIds = useMemo(
    () => (search.data?.data ?? []).filter((player) => !player.avatarUrl).map((player) => player.robloxUserId),
    [search.data],
  )
  const headshots = useResource(
    (signal) => getRobloxPlayerHeadshots(project.id, headshotIds, signal),
    `${project.id}:${headshotIds.join(',')}:headshots`,
    headshotIds.length > 0,
  )

  return (
    <>
      <PageTitle title="Player investigation" copy="Review a player’s sessions and open the evidence captured in each one." />
      <form className="search-field" role="search" onSubmit={(event) => event.preventDefault()}>
        <label htmlFor="player-search">Player username or Roblox user ID</label>
        <div><Search size={19} aria-hidden="true" /><input data-player-search id="player-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Username or Roblox user ID" autoComplete="off" />{query && <button type="button" aria-label="Clear player search" onClick={() => setQuery('')}><X size={17} /></button>}</div>
      </form>
      {search.error ? <InlineError error={search.error} retry={search.reload} /> : search.loading ? <RowsLoading /> : search.data?.data.length ? (
        <>
          <section className="player-browser" aria-labelledby="player-list-title">
            <div className="section-heading"><div><h2 id="player-list-title">{debouncedQuery ? 'Matching players' : 'Recent players'}</h2><p>{debouncedQuery ? `Players matching “${debouncedQuery.slice(0, 80)}”` : `Players retained for ${project.name}`}</p></div><span className="result-count">{search.data.data.length} shown</span></div>
            <div className="player-results" aria-label={debouncedQuery ? 'Player search results' : 'Recent players'}>
              {search.data.data.map((player) => (
                <button key={player.robloxUserId} onClick={() => onOpenPlayer(player)} aria-label={`View ${player.displayName}, @${player.username}`}>
                  <PlayerAvatar player={player} headshot={player.avatarUrl ?? headshots.data?.[player.robloxUserId] ?? null} />
                  <span className="player-result-copy">
                    <strong title={player.displayName}>{player.displayName}</strong>
                    <small><span title={`@${player.username}`}>@{player.username}</span><i aria-hidden="true">·</i><span className="player-result-id">ID {player.robloxUserId}</span></small>
                  </span>
                  <ChevronRight className="player-result-arrow" size={17} aria-hidden="true" />
                </button>
              ))}
            </div>
          </section>
        </>
      ) : <PageStatus compact title={debouncedQuery ? 'No player found' : 'No retained players'} copy={debouncedQuery ? `No retained player matches “${debouncedQuery.slice(0, 80)}”.` : `No player sessions have been retained for ${project.name} yet.`} />}
    </>
  )
}

function PlayerDetails({ project, player, pagination, setPagination, onBack, onOpenSession }: { project: Project; player: PlayerSummary; pagination: { page: number; cursors: Array<string | null> }; setPagination: React.Dispatch<React.SetStateAction<{ page: number; cursors: Array<string | null> }>>; onBack: () => void; onOpenSession: (sessionId: string) => void }) {
  const sessionsSectionRef = useRef<HTMLElement>(null)
  const pageCursor = pagination.cursors[pagination.page - 1] ?? null
  const sessionsResource = useResource(
    (signal) => apiGet<CursorPage<Session>>(projectPath(project.id, `/players/${player.robloxUserId}/sessions${queryString({ limit: 25, cursor: pageCursor })}`), signal),
    `${project.id}:${player.robloxUserId}:sessions:${pageCursor ?? 'first'}`,
  )
  const headshots = useResource(
    (signal) => getRobloxPlayerHeadshots(project.id, player.avatarUrl ? [] : [player.robloxUserId], signal),
    `${project.id}:${player.robloxUserId}:player-headshot`,
    !player.avatarUrl,
  )
  const sessions = sessionsResource.data?.data ?? []
  const totalErrors = sessions.reduce((sum, session) => sum + session.errorCount, 0)
  const scrollToSessions = () => requestAnimationFrame(() => sessionsSectionRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' }))
  const nextPage = () => {
    const cursor = sessionsResource.data?.nextCursor
    if (!cursor || sessionsResource.loading) return
    setPagination((current) => {
      const cursors = [...current.cursors]
      cursors[current.page] = cursor
      return { page: current.page + 1, cursors }
    })
    scrollToSessions()
  }
  const previousPage = () => {
    if (pagination.page === 1 || sessionsResource.loading) return
    setPagination((current) => ({ ...current, page: current.page - 1 }))
    scrollToSessions()
  }

  return (
    <>
      <BackButton onClick={onBack} label="Back to Players" />
      <section className="player-profile player-detail-profile" aria-labelledby="player-name">
        <div className="player-identity"><PlayerAvatar player={player} headshot={player.avatarUrl ?? headshots.data?.[player.robloxUserId] ?? null} /><div><h1 id="player-name" tabIndex={-1}>{player.displayName}</h1><p>@{player.username} · Roblox ID {player.robloxUserId}</p></div></div>
        <dl className="player-stats"><div><dt>Sessions on page</dt><dd>{sessionsResource.data ? sessions.length : '—'}</dd></div><div><dt>Errors on page</dt><dd>{sessionsResource.data ? totalErrors : '—'}</dd></div><div><dt>Oldest on page</dt><dd>{sessions.at(-1) ? formatShortDate(sessions.at(-1)!.startedAt) : '—'}</dd></div><div><dt>Latest device</dt><dd>{sessions[0]?.device ?? sessions[0]?.platform ?? '—'}</dd></div></dl>
      </section>
      <section className="data-section player-sessions-section" aria-labelledby="recent-sessions-title" ref={sessionsSectionRef}>
        <div className="section-heading"><div><h2 id="recent-sessions-title">Recent sessions</h2><p>Retained activity for {project.name} · Page {pagination.page}</p></div></div>
        {sessionsResource.error ? <InlineError error={sessionsResource.error} retry={sessionsResource.reload} /> : sessionsResource.loading && !sessionsResource.data ? <RowsLoading /> : sessions.length ? <div className="session-table">
          <div className="table-head session-grid"><span>Session start</span><span>Game / server</span><span>Duration</span><span>Device</span><span>Errors</span></div>
          {sessions.map((session) => <button className="session-grid" key={session.id} onClick={() => onOpenSession(session.id)} aria-label={`Open session. Started ${formatDate(session.startedAt)}. ${project.name}. ${session.errorCount} errors.`}><span><strong>{formatDate(session.startedAt)}</strong><small>{session.endedAt ? 'Ended' : 'Active now'}</small><small className="mobile-session-context">{project.name} · {session.serverJob.region ?? 'Unknown region'} · {session.device ?? session.platform ?? 'Unknown device'}</small></span><span><strong>{project.name}</strong><small>{session.serverJob.region ?? 'Unknown region'} · {shortId(session.serverJob.robloxJobId)}</small></span><span>{formatDuration(session.durationMs)}</span><span>{session.device ?? session.platform ?? 'Unknown'}</span><span><b className={session.errorCount > 5 ? 'error-count hot' : 'error-count'}>{session.errorCount}</b></span></button>)}
        </div> : <PageStatus compact title="No retained sessions" copy="This player has no sessions in the current retention window." />}
        {sessionsResource.data && (pagination.page > 1 || sessionsResource.data.nextCursor) && <Pagination page={pagination.page} hasNext={Boolean(sessionsResource.data.nextCursor)} loading={sessionsResource.loading} onPrevious={previousPage} onNext={nextPage} label="Player session pages" />}
      </section>
    </>
  )
}

function PlayerAvatar({ headshot }: { player: PlayerSummary; headshot: string | null }) {
  const [failedHeadshot, setFailedHeadshot] = useState<string | null>(null)
  const [loadedHeadshot, setLoadedHeadshot] = useState<string | null>(null)
  const failed = Boolean(headshot && failedHeadshot === headshot)
  const loaded = Boolean(headshot && loadedHeadshot === headshot)
  const canLoad = Boolean(headshot && !failed)

  return (
    <div className={`player-avatar player-avatar-media${loaded ? ' is-loaded' : ''}`}>
      <span className={`player-avatar-placeholder${failed ? ' is-static' : ''}`} aria-hidden="true" />
      {canLoad && <img className="player-avatar-image" src={headshot!} alt="" loading="lazy" decoding="async" onLoad={() => setLoadedHeadshot(headshot)} onError={() => setFailedHeadshot(headshot)} />}
    </div>
  )
}

function Feedback({ project, onOpenSession }: { project: Project; onOpenSession: (sessionId: string) => void }) {
  const [pagination, setPagination] = useState<{ page: number; cursors: Array<string | null> }>({ page: 1, cursors: [null] })
  const cursor = pagination.cursors[pagination.page - 1] ?? null
  const resource = useResource(
    (signal) => apiGet<CursorPage<FeedbackEntry>>(projectPath(project.id, `/feedback${queryString({ limit: 25, cursor })}`), signal),
    `${project.id}:feedback:${cursor ?? 'first'}`,
  )
  const entries = useMemo(() => resource.data?.data ?? [], [resource.data])
  const playerIds = useMemo(() => [...new Set(entries.map((entry) => entry.player.robloxUserId))], [entries])
  const headshots = useResource(
    (signal) => getRobloxPlayerHeadshots(project.id, playerIds, signal),
    `${project.id}:feedback-headshots:${playerIds.join(',')}`,
    playerIds.length > 0,
  )
  const nextPage = () => {
    const nextCursor = resource.data?.nextCursor
    if (!nextCursor || resource.loading) return
    setPagination((current) => {
      const cursors = [...current.cursors]
      cursors[current.page] = nextCursor
      return { page: current.page + 1, cursors }
    })
    window.scrollTo({ top: 0, behavior: 'instant' })
  }

  return <div className="feedback-page">
    <PageTitle title="Feedback" copy={`Player-submitted feedback for ${project.name}, connected to the session where it was sent.`} />
    <section className="data-section feedback-section" aria-labelledby="feedback-list-title">
      <div className="section-heading"><div><h2 id="feedback-list-title">Recent responses</h2><p>Newest first · Page {pagination.page}</p></div>{resource.data && <span className="result-count">{entries.length} {entries.length === 1 ? 'response' : 'responses'}</span>}</div>
      {resource.error ? <InlineError error={resource.error} retry={resource.reload} /> : resource.loading && !resource.data ? <RowsLoading /> : entries.length ? <div className="feedback-table" role="table" aria-label="Player feedback">
        <div className="feedback-table-head feedback-row" role="row"><span role="columnheader">Player</span><span role="columnheader">Device</span><span role="columnheader">Submitted</span><span role="columnheader">Comment</span><span role="columnheader">Session</span></div>
        {entries.map((entry) => <article className="feedback-row" role="row" key={entry.id}>
          <div className="feedback-player" role="cell">
            <PlayerAvatar player={entry.player} headshot={headshots.data?.[entry.player.robloxUserId] ?? null} />
            <div className="feedback-player-copy"><strong title={entry.player.displayName}>{entry.player.displayName}</strong><small title={`@${entry.player.username}`}>@{entry.player.username}</small></div>
          </div>
          <span className="feedback-device-cell" role="cell">{entry.device ?? 'Unknown'}</span>
          <time className="feedback-time" role="cell" dateTime={entry.submittedAt}>{formatDate(entry.submittedAt)}</time>
          <p className="feedback-message" role="cell">{entry.message}</p>
          <div className="feedback-session-cell" role="cell">
            {entry.sessionId ? <button className="feedback-session-button" onClick={() => onOpenSession(entry.sessionId!)}>Open session <ChevronRight size={15} aria-hidden="true" /></button> : <span className="feedback-session-expired">Expired</span>}
          </div>
        </article>)}
      </div> : <PageStatus compact title="No feedback yet" copy="Player responses will appear here after the updated Roblox scripts are published." />}
      {resource.data && (pagination.page > 1 || resource.data.nextCursor) && <Pagination page={pagination.page} hasNext={Boolean(resource.data.nextCursor)} loading={resource.loading} onPrevious={() => setPagination((current) => ({ ...current, page: Math.max(1, current.page - 1) }))} onNext={nextPage} label="Feedback pages" />}
    </section>
  </div>
}

function ManageGames({ projectsReload, firstRun = false, view = 'games' }: { projectsReload: () => void; firstRun?: boolean; view?: 'games' | 'team' }) {
  const [universeId, setUniverseId] = useState('')
  const [preview, setPreview] = useState<(RobloxGameMetadata & { available: boolean }) | null>(null)
  const [working, setWorking] = useState(false)
  const [actionError, setActionError] = useState<ApiError | null>(null)
  const [createdKey, setCreatedKey] = useState<{ projectId: string; projectName: string; universeId: string; value: string } | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [inviteUsername, setInviteUsername] = useState('')
  const [inviteRole, setInviteRole] = useState<'admin' | 'member' | 'viewer'>('viewer')
  const [respondingInvitationId, setRespondingInvitationId] = useState<string | null>(null)
  const [leavingProjectId, setLeavingProjectId] = useState<string | null>(null)
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null)
  const [keyRotationProject, setKeyRotationProject] = useState<string | null>(null)
  const [projectToRemove, setProjectToRemove] = useState<ManagedProject | null>(null)
  const debouncedInviteUsername = useDebouncedValue(inviteUsername.trim(), 450)
  const managed = useResource(
    (signal) => apiGet<{ data: ManagedProject[] }>('/v1/manage/projects', signal),
    'managed-projects',
  )
  const projects = managed.data?.data ?? []
  const joinedProjects = projects.filter((project) => project.role !== 'owner')
  const manageableProjects = projects.filter((project) => project.role === 'owner' || project.role === 'admin')
  const activeManagementProject = manageableProjects.find((project) => project.id === selectedProjectId) ?? manageableProjects[0] ?? null
  const activeManagementProjectId = activeManagementProject?.id ?? null
  const activeOwnerProjectId = activeManagementProject?.role === 'owner' ? activeManagementProject.id : null
  const inviteLookupReady = /^[A-Za-z0-9_]{3,20}$/.test(debouncedInviteUsername)
  const invitePreview = useResource(
    (signal) => apiGet<RobloxInvitePreview>(`/v1/manage/roblox-users/${encodeURIComponent(debouncedInviteUsername)}`, signal),
    `roblox-invite-preview:${debouncedInviteUsername.toLowerCase()}`,
    view === 'team' && Boolean(activeOwnerProjectId) && inviteLookupReady,
  )
  const invitations = useResource(
    (signal) => apiGet<{ data: ProjectInvitation[] }>(`/v1/manage/projects/${activeOwnerProjectId}/invitations`, signal),
    `project-invitations:${activeOwnerProjectId}`,
    Boolean(activeOwnerProjectId),
  )
  const members = useResource(
    (signal) => apiGet<{ data: ProjectMember[] }>(`/v1/manage/projects/${activeManagementProjectId}/members`, signal),
    `project-members:${activeManagementProjectId}`,
    view === 'team' && Boolean(activeManagementProjectId),
  )
  const incomingInvitations = useResource(
    (signal) => apiGet<{ data: IncomingProjectInvitation[] }>('/v1/invitations', signal),
    'incoming-project-invitations',
    view === 'team',
  )

  const previewUniverse = async () => {
    if (!/^\d{1,20}$/.test(universeId.trim())) {
      setActionError(new ApiError(400, { error: { code: 'invalid_universe_id', message: 'Enter a numeric Roblox universe ID.' } }))
      return
    }
    setWorking(true)
    setActionError(null)
    try {
      setPreview(await apiGet<RobloxGameMetadata & { available: boolean }>(`/v1/manage/universes/${universeId.trim()}`))
    } catch (error) {
      setActionError(toApiError(error))
    } finally {
      setWorking(false)
    }
  }

  const linkProject = async () => {
    const id = preview?.universeId ?? universeId.trim()
    if (!id || !preview?.available) return
    setWorking(true)
    setActionError(null)
    try {
      const result = await apiPost<{
        project: Project & { role: 'owner' }
        ingestionKey: string
      }>('/v1/manage/projects', { universeId: id })
      setCreatedKey({ projectId: result.project.id, projectName: result.project.name, universeId: id, value: result.ingestionKey })
      setUniverseId('')
      setPreview(null)
      managed.reload()
      if (!firstRun) projectsReload()
    } catch (error) {
      setActionError(toApiError(error))
    } finally {
      setWorking(false)
    }
  }

  const sendInvitation = async () => {
    if (!activeOwnerProjectId || !invitePreview.data) return
    setWorking(true)
    setActionError(null)
    try {
      await apiPost(`/v1/manage/projects/${activeOwnerProjectId}/invitations`, { username: invitePreview.data.name, role: inviteRole })
      setInviteUsername('')
      invitations.reload()
      managed.reload()
    } catch (error) {
      setActionError(toApiError(error))
    } finally {
      setWorking(false)
    }
  }

  const revokeInvitation = async (invitationId: string) => {
    if (!activeOwnerProjectId) return
    try {
      await apiDelete(`/v1/manage/projects/${activeOwnerProjectId}/invitations/${invitationId}`)
      invitations.reload()
      managed.reload()
    } catch (error) {
      setActionError(toApiError(error))
    }
  }

  const respondToInvitation = async (invitationId: string, response: 'accept' | 'decline') => {
    setRespondingInvitationId(invitationId)
    setActionError(null)
    try {
      await apiPost<void>(`/v1/invitations/${invitationId}/${response}`)
      incomingInvitations.reload()
      managed.reload()
      if (response === 'accept') projectsReload()
    } catch (error) {
      setActionError(toApiError(error))
    } finally {
      setRespondingInvitationId(null)
    }
  }

  const leaveTeam = async (project: ManagedProject) => {
    if (leavingProjectId !== project.id) {
      setLeavingProjectId(project.id)
      return
    }
    setWorking(true)
    setActionError(null)
    try {
      await apiDelete(`/v1/projects/${project.id}/membership`)
      setLeavingProjectId(null)
      managed.reload()
      projectsReload()
    } catch (error) {
      setActionError(toApiError(error))
    } finally {
      setWorking(false)
    }
  }

  const removeMember = async (member: ProjectMember) => {
    if (!activeManagementProjectId) return
    if (removingMemberId !== member.id) {
      setRemovingMemberId(member.id)
      return
    }
    setWorking(true)
    setActionError(null)
    try {
      await apiDelete(`/v1/manage/projects/${activeManagementProjectId}/members/${member.id}`)
      setRemovingMemberId(null)
      members.reload()
      invitations.reload()
      managed.reload()
    } catch (error) {
      setActionError(toApiError(error))
    } finally {
      setWorking(false)
    }
  }

  const rotateKey = async (project: ManagedProject) => {
    if (keyRotationProject !== project.id) {
      setKeyRotationProject(project.id)
      return
    }
    setWorking(true)
    setActionError(null)
    try {
      const result = await apiPost<{ ingestionKey: string }>(`/v1/manage/projects/${project.id}/keys/rotate`)
      setCreatedKey({ projectId: project.id, projectName: project.name, universeId: project.robloxUniverseId ?? '', value: result.ingestionKey })
      setKeyRotationProject(null)
      managed.reload()
    } catch (error) {
      setActionError(toApiError(error))
    } finally {
      setWorking(false)
    }
  }

  const deleteProject = async () => {
    if (!projectToRemove) return
    setWorking(true)
    setActionError(null)
    try {
      await apiDelete(`/v1/manage/projects/${projectToRemove.id}`)
      setProjectToRemove(null)
      setSelectedProjectId(null)
      managed.reload()
      projectsReload()
    } catch (error) {
      const apiError = toApiError(error)
      setActionError(apiError.status === 404 && apiError.code === 'request_failed'
        ? new ApiError(404, { error: { code: 'remove_game_unavailable', message: 'Game removal is not available on the connected Trace API yet. Deploy the latest API and try again.' } })
        : apiError)
      setProjectToRemove(null)
    } finally {
      setWorking(false)
    }
  }

  const visibleInvitations = invitations.data?.data.filter((invitation) => invitation.status === 'pending') ?? []
  return <div className="manage-page">
    <PageTitle
      title={firstRun ? 'Connect your first game' : view === 'team' ? 'Team' : 'Games'}
      copy={firstRun ? 'Verify one Roblox experience, install Trace, and your first sessions will appear here.' : view === 'team' ? 'Manage your game access and the people on your teams.' : 'Link experiences, install Trace, and rotate isolated ingestion credentials.'}
    />

    {actionError && <InlineError error={actionError} retry={() => setActionError(null)} title="Could not complete this action" />}
    {projectToRemove && <GameRemovalDialog project={projectToRemove} working={working} onCancel={() => setProjectToRemove(null)} onConfirm={() => void deleteProject()} />}

    {view === 'team' && (incomingInvitations.error ? <InlineError error={incomingInvitations.error} retry={incomingInvitations.reload} /> : incomingInvitations.loading && !incomingInvitations.data ? <RowsLoading /> : Boolean(incomingInvitations.data?.data.length) && <section className="incoming-invitations" aria-labelledby="incoming-invitations-title">
      <div className="section-heading"><div><h2 id="incoming-invitations-title">Invitations</h2><p>Choose whether to join these games in Trace.</p></div><span className="result-count">{incomingInvitations.data!.data.length} pending</span></div>
      <div className="incoming-invitation-list">{incomingInvitations.data!.data.map((invitation) => <article key={invitation.id}>
        <GameIdentity project={invitation.project} enrich />
        <div className="incoming-invitation-meta"><span className={`role-badge role-${invitation.role}`}>{invitation.role}</span><span>Invited by {invitation.invitedBy.displayName ?? (invitation.invitedBy.username ? `@${invitation.invitedBy.username}` : 'the game owner')}</span><time dateTime={invitation.createdAt}>{formatShortDate(invitation.createdAt)}</time></div>
        <div className="incoming-invitation-actions"><button className="secondary-button" disabled={Boolean(respondingInvitationId)} onClick={() => void respondToInvitation(invitation.id, 'decline')}><X size={16} aria-hidden="true" />Decline</button><button className="primary-button" disabled={Boolean(respondingInvitationId)} onClick={() => void respondToInvitation(invitation.id, 'accept')}><Check size={16} aria-hidden="true" />{respondingInvitationId === invitation.id ? 'Responding…' : 'Accept'}</button></div>
      </article>)}</div>
    </section>)}

    {view === 'team' && joinedProjects.length > 0 && <section className="team-memberships" aria-labelledby="team-memberships-title">
      <div className="section-heading"><div><h2 id="team-memberships-title">Your access</h2><p>Games you joined through a team invitation.</p></div></div>
      <div className="team-membership-list">{joinedProjects.map((project) => <article key={project.id}>
        <GameIdentity project={project} enrich />
        <div className="team-membership-meta"><span className={`role-badge role-${project.role}`}>{project.role}</span><span>Universe {project.robloxUniverseId}</span></div>
        <button className={leavingProjectId === project.id ? 'danger-button' : 'quiet-button'} disabled={working} onClick={() => void leaveTeam(project)}>{leavingProjectId === project.id ? 'Confirm leave' : 'Leave team'}</button>
      </article>)}</div>
    </section>}

    {view === 'games' && createdKey && <section className="credential-reveal" aria-labelledby="credential-title">
      <div className="credential-heading"><span className="credential-icon"><KeyRound size={20} aria-hidden="true" /></span><div><h2 id="credential-title">Save this key for {createdKey.projectName}</h2><p>Trace only shows the complete key once. Add these values to Roblox before leaving this page.</p></div></div>
      <div className="credential-values">
        <CopyBlock label="Secret name" value="TraceKey" />
        <CopyBlock label="Secret value" value={createdKey.value} secret />
        <CopyBlock label="Allowed domain" value={INGESTION_DOMAIN} />
      </div>
      <div className="credential-actions"><a className="primary-button" href={`https://create.roblox.com/dashboard/creations/experiences/${encodeURIComponent(createdKey.universeId)}/secrets`} target="_blank" rel="noreferrer">Open Roblox secrets <ExternalLink size={15} aria-hidden="true" /></a>{firstRun && <button className="secondary-button" onClick={projectsReload}>I’ve saved the key</button>}</div>
    </section>}

    {view === 'games' && <section className="setup-workspace" aria-labelledby="link-game-title">
      <div className="setup-intro">
        <span className="setup-step">Setup</span>
        <h2 id="link-game-title">Link a Roblox experience</h2>
        <p>Enter any universe ID. Trace marks the game verified after its first authenticated telemetry request arrives.</p>
      </div>
      <div className="universe-form">
        <label htmlFor="universe-id">Universe ID</label>
        <div><input id="universe-id" inputMode="numeric" value={universeId} onChange={(event) => { setUniverseId(event.target.value.replace(/\D/g, '').slice(0, 20)); setPreview(null); setActionError(null) }} placeholder="For example, 1234567890" /><button className="secondary-button" disabled={working || !universeId} onClick={() => void previewUniverse()}>{working ? 'Checking…' : 'Find game'}</button></div>
        <small>Use the universe ID, not a place ID.</small>
      </div>
      {preview && <div className="game-preview">
        <GameIdentity project={{ id: preview.universeId ?? '', name: preview.name ?? 'Roblox experience', robloxUniverseId: preview.universeId, iconUrl: preview.iconUrl }} />
        <div><span>{preview.available ? 'Ready to link' : 'Already linked'}</span><strong>{preview.available ? 'Verification begins when telemetry arrives' : `Universe ${preview.universeId}`}</strong></div>
        <button className="primary-button" disabled={working || !preview.available} onClick={() => void linkProject()}><Gamepad2 size={17} aria-hidden="true" />{working ? 'Linking…' : 'Link game'}</button>
      </div>}
    </section>}

    {view === 'games' && (managed.error ? <InlineError error={managed.error} retry={managed.reload} /> : managed.loading && !managed.data ? <RowsLoading /> : projects.length > 0 && <section className="managed-games" aria-labelledby="managed-games-title">
      <div className="section-heading"><div><h2 id="managed-games-title">Your games</h2><p>Each universe has its own isolated data and ingestion key.</p></div><span className="result-count">{projects.length} linked</span></div>
      <div className="managed-game-list">{projects.map((project) => <article key={project.id}>
        <GameIdentity project={project} enrich />
        <div className="managed-game-meta"><span className={`role-badge role-${project.role}`}>{project.role}</span><span className={`verification-status ${project.verifiedAt ? 'verified' : 'pending'}`}>{project.verifiedAt ? <><Check size={13} aria-hidden="true" />Verified</> : <><Clock3 size={13} aria-hidden="true" />Awaiting data</>}</span><span>{project.keyHint ? `Key ${project.keyHint}` : 'Active ingestion key'}</span></div>
        <div className="managed-game-actions">{project.robloxUniverseId && (project.role === 'owner' || project.role === 'admin') && <a className="secondary-button" href={`https://create.roblox.com/dashboard/creations/experiences/${encodeURIComponent(project.robloxUniverseId)}/secrets`} target="_blank" rel="noreferrer">Manage Secrets <ExternalLink size={15} aria-hidden="true" /></a>}{(project.role === 'owner' || project.role === 'admin') && <button className={keyRotationProject === project.id ? 'danger-button' : 'quiet-button'} disabled={working} onClick={() => void rotateKey(project)}><RotateCcw size={15} aria-hidden="true" />{keyRotationProject === project.id ? 'Confirm rotation' : 'Rotate key'}</button>}{project.role === 'owner' && <button className="quiet-button remove-game-button" disabled={working} onClick={() => setProjectToRemove(project)}><Trash2 size={15} aria-hidden="true" />Remove game</button>}</div>
      </article>)}</div>
    </section>)}

    {view === 'team' && (managed.error ? <InlineError error={managed.error} retry={managed.reload} /> : managed.loading && !managed.data ? <RowsLoading /> : manageableProjects.length > 0 ? <section className="team-access" aria-labelledby="team-access-title">
      <div className="section-heading"><div><h2 id="team-access-title">Manage members</h2><p>Owners can remove any lower role. Admins can remove members and viewers.</p></div></div>
      {manageableProjects.length > 1 && <div className="owner-project-tabs" role="tablist" aria-label="Choose game">{manageableProjects.map((project) => <ProjectTab project={project} selected={activeManagementProjectId === project.id} key={project.id} onSelect={() => { setSelectedProjectId(project.id); setRemovingMemberId(null) }} />)}</div>}
      {activeManagementProject?.role === 'owner' && <div className="invite-form">
        <label>Roblox username<input value={inviteUsername} onChange={(event) => setInviteUsername(event.target.value.slice(0, 20))} placeholder="Exact username" autoComplete="off" /><small>Use their username, not their display name.</small></label>
        <LabeledSelect label="Access level" value={inviteRole} onChange={(value) => setInviteRole(value as typeof inviteRole)} options={[["viewer", "Viewer"], ["member", "Member"], ["admin", "Admin"]]} />
        <button className="primary-button" disabled={working || !invitePreview.data} onClick={() => void sendInvitation()}><UserPlus size={17} aria-hidden="true" />Send invite</button>
        {inviteLookupReady && <div className={`invite-user-preview ${invitePreview.loading ? 'loading' : ''}`} aria-live="polite">
          {invitePreview.loading && !invitePreview.data ? <><span className="invite-avatar-skeleton" aria-hidden="true" /><span><strong>Finding Roblox account…</strong><small>Checking the exact username</small></span></> : invitePreview.error ? <><span className="invite-avatar-fallback"><CircleUserRound size={22} aria-hidden="true" /></span><span><strong>Account not found</strong><small>Check the spelling and use the Roblox username.</small></span></> : invitePreview.data && <>{invitePreview.data.avatarUrl ? <img src={invitePreview.data.avatarUrl} alt="" /> : <span className="invite-avatar-fallback"><CircleUserRound size={22} aria-hidden="true" /></span>}<span><strong>{invitePreview.data.displayName}</strong><small>@{invitePreview.data.name} · Roblox ID {invitePreview.data.id}</small></span><Check className="invite-user-confirmed" size={18} aria-label="Roblox account found" /></>}
        </div>}
      </div>}
      {activeManagementProject?.role === 'owner' && (invitations.error ? <InlineError error={invitations.error} retry={invitations.reload} /> : visibleInvitations.length > 0 && <div className="invitation-list">{visibleInvitations.map((invitation) => <div key={invitation.id}><span><strong>@{invitation.robloxUsername}</strong><small>{invitation.role} · waiting for their response</small></span><button onClick={() => void revokeInvitation(invitation.id)}>Revoke</button></div>)}</div>)}
      <div className="member-list-heading"><strong>Members</strong><span>{members.data?.data.length ?? 0}</span></div>
      {members.error ? <InlineError error={members.error} retry={members.reload} /> : members.loading && !members.data ? <RowsLoading /> : members.data?.data.length ? <div className="member-list">{members.data.data.map((member) => {
        const canRemove = activeManagementProject?.role === 'owner' ? member.role !== 'owner' : member.role === 'member' || member.role === 'viewer'
        const displayName = member.robloxDisplayName ?? member.robloxUsername ?? 'Roblox user'
        return <div key={member.id}>
          <div className="member-identity">{member.robloxAvatarUrl ? <img src={member.robloxAvatarUrl} alt="" /> : <span><CircleUserRound size={20} aria-hidden="true" /></span>}<div><strong>{displayName}</strong><small>{member.robloxUsername ? `@${member.robloxUsername}` : 'Roblox account'} · joined {formatShortDate(member.joinedAt)}</small></div></div>
          <div className="member-actions"><span className={`role-badge role-${member.role}`}>{member.role}</span>{canRemove && <button className={removingMemberId === member.id ? 'danger-button' : 'quiet-button'} disabled={working} onClick={() => void removeMember(member)}>{removingMemberId === member.id ? 'Confirm removal' : 'Remove'}</button>}</div>
        </div>
      })}</div> : <p className="team-empty">No team members found.</p>}
    </section> : joinedProjects.length === 0 && <PageStatus compact title="No team access" copy={incomingInvitations.data?.data.length ? 'Accept an invitation above to join a game.' : 'Join a game through an invitation to manage your team access here.'} />)}

    {view === 'games' && <section className="installation-checklist" aria-labelledby="installation-title">
      <div><span className="setup-step">Roblox install</span><h2 id="installation-title">Install Trace in Studio</h2><p>Download the model once, then add each game’s individual secret.</p></div>
      <ol>
        <li><strong>Add the secret</strong><span>Use <b>Manage Secrets</b> beside the game. Create <code>TraceKey</code>, paste its one-time key, and set the domain to <code>{INGESTION_DOMAIN}</code>. Rotate the key if it was not saved.</span></li>
        <li><strong>Download Trace</strong><span>Download the ready-to-import Roblox model. No file syncing is required.<a className="inline-install-action" href="/Trace.rbxm" download="Trace.rbxm"><Download size={14} aria-hidden="true" />Download Trace.rbxm</a></span></li>
        <li><strong>Install and publish</strong><span>Drag <code>Trace.rbxm</code> into Roblox Studio, keep its included service structure, enable HTTP requests, and publish.</span></li>
        <li><strong>Confirm the first session</strong><span>Join a fresh server. Data should appear within the first transport window.</span></li>
      </ol>
    </section>}
  </div>
}

function AllLogs({ project, onOpenError }: { project: Project; onOpenError: (fingerprint: string) => void }) {
  const [query, setQuery] = useState('')
  const [timeRangeValue, setTimeRangeValue] = useState('24')
  const [severity, setSeverity] = useState('all')
  const [side, setSide] = useState('all')
  const [page, setPage] = useState(1)
  const [pageCursors, setPageCursors] = useState<Array<string | null>>([null])
  const range = useMemo(() => timeRange(Number(timeRangeValue)), [timeRangeValue])
  const filters = queryString({
    ...range,
    severity: severity === 'all' ? 'error,warning' : severity,
    side: side === 'all' ? undefined : side,
    limit: 25,
  })
  const path = projectPath(project.id, `/errors${filters}`)
  const pageCursor = pageCursors[page - 1] ?? null
  const requestPath = `${path}${pageCursor ? `${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(pageCursor)}` : ''}`
  const groupsResource = useResource(
    (signal) => apiGet<CursorPage<GroupedError>>(requestPath, signal),
    `${project.id}:${requestPath}:grouped-logs`,
  )
  const groups = groupsResource.data?.data ?? []
  const nextCursor = groupsResource.data?.nextCursor ?? null

  useEffect(() => {
    setPage(1)
    setPageCursors([null])
  }, [path])

  const nextPage = () => {
    if (!nextCursor || groupsResource.loading) return
    setPageCursors((current) => {
      const updated = [...current]
      updated[page] = nextCursor
      return updated
    })
    setPage((current) => current + 1)
    window.scrollTo({ top: 0 })
  }
  const previousPage = () => {
    if (page === 1 || groupsResource.loading) return
    setPage((current) => current - 1)
    window.scrollTo({ top: 0 })
  }
  const needle = query.trim().toLowerCase()
  const filtered = groups.filter((group) => !needle || `${group.title} ${group.source ?? ''}`.toLowerCase().includes(needle))
  const occurrenceCount = filtered.reduce((sum, group) => sum + group.count, 0)

  return (
    <>
      <PageTitle title="Logs" copy="Review grouped errors and warnings, then open a group to inspect individual occurrences." />
      <div className="logs-toolbar">
        <div className="compact-search"><label htmlFor="log-search">Filter loaded groups</label><div><Search size={18} /><input id="log-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Message or source" />{query && <button aria-label="Clear group filter" onClick={() => setQuery('')}><X size={16} /></button>}</div></div>
        <LabeledSelect label="Time range" value={timeRangeValue} onChange={setTimeRangeValue} options={[['8', 'Last 8 hours'], ['24', 'Last 24 hours'], ['72', 'Last 3 days']]} />
        <LabeledSelect label="Severity" value={severity} onChange={setSeverity} options={[['all', 'All'], ['error', 'Error'], ['warning', 'Warning']]} />
        <LabeledSelect label="Log source" value={side} onChange={setSide} options={[['all', 'All'], ['client', 'Client'], ['server', 'Server']]} />
      </div>
      <div className="log-summary" aria-live="polite"><strong>{exactNumberFormatter.format(filtered.length)}</strong> grouped events on page {page} <span>·</span> <b title={`${exactNumberFormatter.format(occurrenceCount)} occurrences`} aria-label={exactNumberFormatter.format(occurrenceCount)}>{formatCount(occurrenceCount)}</b> occurrences represented</div>
      {groupsResource.error && <InlineError error={groupsResource.error} retry={groupsResource.reload} />}
      {groupsResource.loading && !groupsResource.data ? <RowsLoading /> : filtered.length ? <div className="error-table">
        <div className="table-head error-grid"><span>Count</span><span>Severity</span><span>Type</span><span>Last seen</span><span>Message</span></div>
        {filtered.map((group) => <button className="error-grid" onClick={() => onOpenError(group.fingerprint)} key={group.fingerprint} aria-label={`Open grouped event. ${exactNumberFormatter.format(group.count)} occurrences. Severity ${group.severity}. Type ${group.side}. Message: ${group.title}.`}><strong className="event-count" title={`${exactNumberFormatter.format(group.count)} occurrences`}>{formatCount(group.count)}</strong><SeverityBadge level={group.severity} /><span className="secondary">{labelSide(group.side)}</span><time className="secondary first-seen">{formatDate(group.lastSeenAt)}</time><span className={`event-message ${group.severity}`}><strong>{group.title}</strong><code>{group.source ?? 'Unknown source'}</code></span></button>)}
      </div> : !groupsResource.error ? <PageStatus compact title="No grouped events match" copy="Try a broader text, time, severity, or source filter." /> : null}
      {(page > 1 || nextCursor) && <Pagination page={page} hasNext={Boolean(nextCursor)} loading={groupsResource.loading} onPrevious={previousPage} onNext={nextPage} label="Grouped logs pages" />}
    </>
  )
}

function SessionLogs({ project, sessionId, selectedEventId, setSelectedEventId, onBack, backLabel, announce }: {
  project: Project
  sessionId: string
  selectedEventId: string | null
  setSelectedEventId: (id: string | null) => void
  onBack: () => void
  backLabel: string
  announce: (message: string) => void
}) {
  const [mode, setMode] = useState<LogMode>('split')
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState('all')
  const [shareFallback, setShareFallback] = useState('')
  const session = useResource((signal) => apiGet<Session>(projectPath(project.id, `/sessions/${sessionId}`), signal), `${project.id}:${sessionId}:detail`)
  const timeline = useResource(
    (signal) => apiGet<CursorPage<LogOccurrence>>(projectPath(project.id, `/sessions/${sessionId}/timeline${selectedEventId ? queryString({ around: selectedEventId, before: 100, after: 100 }) : '?limit=500'}`), signal),
    `${project.id}:${sessionId}:timeline`,
  )
  const events = useMemo(() => timeline.data?.data ?? [], [timeline.data])
  const selected = events.find((event) => event.id === selectedEventId) ?? events.find((event) => event.severity === 'error') ?? events[0] ?? null

  useEffect(() => {
    if (!selected && events.length) setSelectedEventId(events[0].id)
  }, [events, selected, setSelectedEventId])

  useEffect(() => {
    const suffix = selectedEventId ? `?event=${encodeURIComponent(selectedEventId)}` : ''
    writePortalRoute(`/sessions/${encodeURIComponent(sessionId)}${suffix}`, true)
  }, [sessionId, selectedEventId])

  const filtered = events.filter((event) => (level === 'all' || event.severity === level) && (!query || `${event.message} ${event.source ?? ''} ${event.stackTrace ?? ''}`.toLowerCase().includes(query.toLowerCase())))
  const clientEvents = filtered.filter((event) => event.side === 'client')
  const serverEvents = filtered.filter((event) => event.side === 'server')
  const sessionData = session.data

  const copyEvidence = async () => {
    if (!selected || !sessionData) return
    const text = `${formatPreciseTime(selected.occurredAt)} · ${selected.severity.toUpperCase()} · ${selected.source ?? 'Unknown source'}\n${selected.message}\nSession: ${project.name} · ${sessionData.player.username} · ${shortId(sessionData.serverJob.robloxJobId)}`
    try { await navigator.clipboard.writeText(text); announce('Evidence copied to clipboard') } catch { announce('Clipboard access is unavailable in this browser') }
  }
  const exportEvidence = () => {
    if (!selected || !sessionData) return
    const url = URL.createObjectURL(new Blob([JSON.stringify({ session: sessionData, project, event: selected }, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `trace-${selected.id}.json`
    link.click()
    URL.revokeObjectURL(url)
    announce('Evidence exported as JSON')
  }
  const shareEvidence = async () => {
    const shareUrl = `${window.location.origin}/sessions/${encodeURIComponent(sessionId)}${selected ? `?event=${encodeURIComponent(selected.id)}` : ''}`
    try { await navigator.clipboard.writeText(shareUrl); setShareFallback(''); announce('Share link copied to clipboard') } catch { setShareFallback(shareUrl); announce('Copy the share link shown with the selected evidence') }
  }

  if (session.error) return <><BackButton onClick={onBack} label={backLabel} /><InlineError error={session.error} retry={session.reload} /></>
  if (timeline.error) return <><BackButton onClick={onBack} label={backLabel} /><InlineError error={timeline.error} retry={timeline.reload} /></>
  if (!sessionData || !timeline.data) return <><BackButton onClick={onBack} label={backLabel} /><RowsLoading /></>

  return (
    <div className="session-page">
      <BackButton onClick={onBack} label={backLabel} />
      <PageTitle title="Session logs" copy={`${sessionData.player.username} · ${project.name} · ${sessionData.serverJob.region ?? 'Unknown region'} · ${shortId(sessionData.serverJob.robloxJobId)}`} action={<div className="session-duration"><Clock3 size={16} />{formatDuration(sessionData.durationMs)}</div>} />
      <div className="session-toolbar">
        <div className="view-toggle" aria-label="Log view"><button aria-pressed={mode === 'split'} onClick={() => setMode('split')}><Columns2 size={16} />Split</button><button aria-pressed={mode === 'client'} onClick={() => setMode('client')}><CircleUserRound size={16} />Client</button><button aria-pressed={mode === 'server'} onClick={() => setMode('server')}><Server size={16} />Server</button></div>
        <div className="session-actions"><button aria-expanded={findOpen} onClick={() => setFindOpen(!findOpen)}><Search size={16} />Find</button><LabeledSelect label="Level" value={level} onChange={setLevel} options={[['all', 'All'], ['error', 'Error'], ['warning', 'Warning']]} compact icon={<ListFilter size={16} aria-hidden="true" />} /><button onClick={() => setSelectedEventId(events.find((event) => event.severity === 'error')?.id ?? events[0]?.id ?? null)}><Clock3 size={16} />First error</button></div>
      </div>
      {findOpen && <div className="session-find"><label htmlFor="session-find">Find in this session</label><input autoFocus id="session-find" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search message, source, or stack" /><button aria-label="Close find" onClick={() => { setFindOpen(false); setQuery('') }}><X size={17} /></button></div>}
      {selected ? <section className="evidence-strip" aria-labelledby="selected-evidence-title">
        <div><span>Selected evidence</span><h2 id="selected-evidence-title">{selected.message}</h2><p>{formatPreciseTime(selected.occurredAt)} · {selected.source ?? 'Unknown source'}{selected.correlation ? ` · correlated within ${Math.round(selected.correlation.deltaMs)} ms (${selected.correlation.confidence} confidence)` : ''}</p>{selected.stackTrace && <pre>{selected.stackTrace}</pre>}</div>
        <div><button onClick={copyEvidence}><Copy size={16} />Copy</button><button onClick={exportEvidence}><Download size={16} />Export JSON</button><button onClick={shareEvidence}><Share2 size={16} />Share</button></div>
        {shareFallback && <label className="share-fallback">Share link<input readOnly value={shareFallback} onFocus={(event) => event.currentTarget.select()} /></label>}
      </section> : <PageStatus compact title="No events in this session" copy="No timeline events match the current filters." />}
      <div className={`log-viewers mode-${mode}`}>{(mode === 'split' || mode === 'client') && <LogPane type="client" events={clientEvents} session={sessionData} selectedEventId={selected?.id ?? null} onSelect={setSelectedEventId} />}{(mode === 'split' || mode === 'server') && <LogPane type="server" events={serverEvents} session={sessionData} selectedEventId={selected?.id ?? null} onSelect={setSelectedEventId} />}</div>
    </div>
  )
}

function LogPane({ type, events, session, selectedEventId, onSelect }: { type: LogSide; events: LogOccurrence[]; session: Session; selectedEventId: string | null; onSelect: (id: string) => void }) {
  return <section className={`log-pane ${type}`} aria-label={`${type} logs`}><header><span className="pane-icon">{type === 'client' ? <CircleUserRound size={17} /> : <Server size={17} />}</span><div><strong>{type === 'client' ? 'Client logs' : 'Server logs'}</strong><small>{type === 'client' ? `${session.player.username} · ${session.device ?? session.platform ?? 'Unknown device'}` : `${session.serverJob.region ?? 'Unknown region'} · ${shortId(session.serverJob.robloxJobId)}`}</small></div></header><div className="log-lines">{events.length ? events.map((event, index) => <button aria-pressed={selectedEventId === event.id} className={selectedEventId === event.id ? 'selected' : ''} key={event.id} onClick={() => onSelect(event.id)} title={event.source ?? undefined}><span className="line-number">{index + 1}</span><span className="log-time">{formatPreciseTime(event.occurredAt)}</span><span className={`log-level ${event.severity}`}>{event.severity === 'trace' ? '↳' : event.severity}</span><span className="log-text">{event.message}</span></button>) : <div className="log-empty">No {type} events match these filters.</div>}</div></section>
}

function parseErrorTitle(title: string, fallbackSource: string | null) {
  const match = title.match(/^(.*?):(\d+):\s*(.+)$/s)
  return match
    ? { source: match[1], line: match[2], message: match[3] }
    : { source: fallbackSource, line: null, message: title }
}

function ErrorCodeBlock({ error, occurrence }: { error: GroupedError; occurrence: LogOccurrence }) {
  const parsed = parseErrorTitle(error.title, error.source)
  return (
    <section className={`error-console ${error.severity}`} aria-labelledby="error-detail-title">
      <header>
        <div><CircleAlert size={16} aria-hidden="true" /><strong>{labelSeverity(error.severity)}</strong><span>{labelSide(error.side)}</span></div>
        <time dateTime={occurrence.occurredAt}>Latest · {formatDate(occurrence.occurredAt)}</time>
      </header>
      <div className="error-console-body">
        <span className="error-console-mark" aria-hidden="true">!</span>
        <div>
          {(parsed.source || parsed.line) && <code className="error-code-location"><span>{parsed.source ?? 'Unknown source'}</span>{parsed.line && <><b>:</b><em>{parsed.line}</em></>}</code>}
          <h1 id="error-detail-title" tabIndex={-1}>{parsed.message}</h1>
        </div>
      </div>
    </section>
  )
}

function HighlightedStackLine({ line }: { line: string }) {
  const match = line.match(/^(.*?)(,\s*line\s+|:)(\d+)(.*)$/)
  if (!match) return <code><span className="stack-path">{line}</span></code>
  return <code><span className="stack-path">{match[1]}</span><span className="stack-separator">{match[2]}</span><span className="stack-line-number">{match[3]}</span><span className="stack-tail">{match[4]}</span></code>
}

function StackTracePanel({ trace }: { trace: string }) {
  const [copied, setCopied] = useState(false)
  const lines = trace.trim().split('\n')
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(timer)
  }, [copied])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(trace)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <section className="stack-panel" aria-labelledby="stack-trace-title">
      <header><div><h2 id="stack-trace-title">Latest stack trace</h2><p>Most recent retained call site</p></div><button type="button" onClick={() => void copy()}>{copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}{copied ? 'Copied' : 'Copy stack'}</button></header>
      <ol className="stack-lines">{lines.map((line, index) => <li key={`${index}:${line}`}><HighlightedStackLine line={line} /></li>)}</ol>
    </section>
  )
}

function ErrorDetails({ project, fingerprint, onBack, onOpenOccurrence }: { project: Project; fingerprint: string; onBack: () => void; onOpenOccurrence: (occurrence: LogOccurrence) => void }) {
  const [page, setPage] = useState(1)
  const [pageCursors, setPageCursors] = useState<Array<string | null>>([null])
  const pageCursor = pageCursors[page - 1] ?? null
  const detail = useResource((signal) => apiGet<ErrorDetail>(projectPath(project.id, `/errors/${fingerprint}`), signal), `${project.id}:${fingerprint}:error-detail`)
  const occurrenceQuery = queryString({ limit: 25, cursor: pageCursor })
  const occurrences = useResource((signal) => apiGet<CursorPage<LogOccurrence>>(projectPath(project.id, `/errors/${fingerprint}/occurrences${occurrenceQuery}`), signal), `${project.id}:${fingerprint}:occurrences:${pageCursor ?? 'first'}`)
  useEffect(() => {
    setPage(1)
    setPageCursors([null])
  }, [fingerprint, project.id])

  const nextPage = () => {
    const cursor = occurrences.data?.nextCursor
    if (!cursor || occurrences.loading) return
    setPageCursors((current) => {
      const updated = [...current]
      updated[page] = cursor
      return updated
    })
    setPage((current) => current + 1)
    window.scrollTo({ top: 0 })
  }
  const previousPage = () => {
    if (page === 1 || occurrences.loading) return
    setPage((current) => current - 1)
    window.scrollTo({ top: 0 })
  }
  if (detail.error) return <><BackButton onClick={onBack} label="Back to Dashboard" /><InlineError error={detail.error} retry={detail.reload} /></>
  if (!detail.data) return <><BackButton onClick={onBack} label="Back to Dashboard" /><RowsLoading /></>
  const error = detail.data.error
  return (
    <div className="error-detail-page">
      <BackButton onClick={onBack} label="Back to Dashboard" />
      <ErrorCodeBlock error={error} occurrence={detail.data.latestOccurrence} />
      <dl className="detail-stats"><div><dt>Occurrences</dt><dd>{error.count}</dd></div><div><dt>Affected players</dt><dd>{error.affectedPlayerCount}</dd></div><div><dt>Server jobs</dt><dd>{error.affectedServerCount}</dd></div><div><dt>First seen</dt><dd>{formatDate(error.firstSeenAt)}</dd></div><div><dt>Last seen</dt><dd>{formatDate(error.lastSeenAt)}</dd></div></dl>
      {detail.data.latestOccurrence.stackTrace && <StackTracePanel trace={detail.data.latestOccurrence.stackTrace} />}
      <section className="data-section"><div className="section-heading"><div><h2>Occurrences</h2><p>Newest occurrences in the selected retention window · Page {page}</p></div></div>{occurrences.error ? <InlineError error={occurrences.error} retry={occurrences.reload} /> : !occurrences.data ? <RowsLoading /> : occurrences.data.data.length ? <><OccurrenceList occurrences={occurrences.data.data} onOpen={onOpenOccurrence} />{(page > 1 || occurrences.data.nextCursor) && <Pagination page={page} hasNext={Boolean(occurrences.data.nextCursor)} loading={occurrences.loading} onPrevious={previousPage} onNext={nextPage} label="Occurrence pages" />}</> : <PageStatus compact title="No retained occurrences" copy="The grouped error exists, but its raw occurrences have expired." />}</section>
    </div>
  )
}

function ServerJobDetails({ project, jobId, selectedEventId, onBack, onOpenSession }: { project: Project; jobId: string; selectedEventId: string | null; onBack: () => void; onOpenSession: (sessionId: string, eventId?: string) => void }) {
  const [jobEventId, setJobEventId] = useState(selectedEventId)
  const job = useResource((signal) => apiGet<ServerJob>(projectPath(project.id, `/server-jobs/${jobId}`), signal), `${project.id}:${jobId}:job-detail`)
  const logs = useResource((signal) => apiGet<CursorPage<LogOccurrence>>(projectPath(project.id, `/server-jobs/${jobId}/logs?limit=500`), signal), `${project.id}:${jobId}:job-logs`)
  const sessions = useResource((signal) => apiGet<CursorPage<Session>>(projectPath(project.id, `/server-jobs/${jobId}/sessions?limit=100`), signal), `${project.id}:${jobId}:job-sessions`)
  const headshotIds = useMemo(
    () => [...new Set((sessions.data?.data ?? []).filter((session) => !session.player.avatarUrl).map((session) => session.player.robloxUserId))],
    [sessions.data],
  )
  const headshots = useResource(
    (signal) => getRobloxPlayerHeadshots(project.id, headshotIds, signal),
    `${project.id}:${headshotIds.join(',')}:job-headshots`,
    headshotIds.length > 0,
  )
  const selectedOccurrence = logs.data?.data.find((occurrence) => occurrence.id === jobEventId) ?? null
  if (job.error) return <><BackButton onClick={onBack} label="Back" /><InlineError error={job.error} retry={job.reload} /></>
  if (!job.data) return <><BackButton onClick={onBack} label="Back" /><RowsLoading /></>
  return (
    <>
      <BackButton onClick={onBack} label="Back" />
      <PageTitle title="Server job" copy={`${project.name} · ${job.data.region ?? 'Unknown region'} · ${shortId(job.data.robloxJobId)}`} />
      <dl className="detail-stats"><div><dt>Events</dt><dd>{job.data.eventCount}</dd></div><div><dt>Errors</dt><dd>{job.data.errorCount}</dd></div><div><dt>Warnings</dt><dd>{job.data.warningCount}</dd></div><div><dt>Sessions</dt><dd>{job.data.sessionCount}</dd></div><div><dt>Duration</dt><dd>{formatDurationBetween(job.data.startedAt, job.data.endedAt)}</dd></div></dl>
      {selectedOccurrence && <section className="stack-panel"><h2>{selectedOccurrence.message}</h2><p>{formatDate(selectedOccurrence.occurredAt)} · {selectedOccurrence.source ?? 'Unknown source'}</p>{selectedOccurrence.stackTrace && <pre>{selectedOccurrence.stackTrace}</pre>}</section>}
      <section className="data-section"><div className="section-heading"><div><h2>Job logs</h2><p>Events emitted by this Roblox server instance</p></div></div>{logs.error ? <InlineError error={logs.error} retry={logs.reload} /> : !logs.data ? <RowsLoading /> : logs.data.data.length ? <OccurrenceList occurrences={logs.data.data} selectedId={jobEventId} onOpen={(occurrence) => { setJobEventId(occurrence.id); if (occurrence.sessionId) onOpenSession(occurrence.sessionId, occurrence.id) }} /> : <PageStatus compact title="No retained job logs" copy="No events remain for this server job." />}</section>
      <section className="data-section"><div className="section-heading"><div><h2>Player sessions</h2><p>Sessions observed in this server job</p></div></div>{sessions.error ? <InlineError error={sessions.error} retry={sessions.reload} /> : !sessions.data ? <RowsLoading /> : sessions.data.data.length ? <div className="session-table">{sessions.data.data.map((session) => <button className="simple-session-row" key={session.id} onClick={() => onOpenSession(session.id)}><PlayerAvatar player={session.player} headshot={session.player.avatarUrl ?? headshots.data?.[session.player.robloxUserId] ?? null} /><span><strong>{session.player.displayName}</strong><small>@{session.player.username} · {formatDate(session.startedAt)}</small></span><b>{session.errorCount} errors</b></button>)}</div> : <PageStatus compact title="No player sessions" copy="This job has no retained player sessions." />}</section>
    </>
  )
}

function OccurrenceList({ occurrences, selectedId, onOpen }: { occurrences: LogOccurrence[]; selectedId?: string | null; onOpen: (occurrence: LogOccurrence) => void }) {
  return <div className="occurrence-list"><div className="occurrence-list-header"><span>Occurred</span><span>Level</span><span>Side</span><span>Source</span><span>Player / job</span></div>{occurrences.map((occurrence) => <button key={occurrence.id} className={selectedId === occurrence.id ? 'selected' : ''} onClick={() => onOpen(occurrence)} aria-label={`Open ${labelSeverity(occurrence.severity)} occurrence from ${formatDate(occurrence.occurredAt)}`}><time>{formatDate(occurrence.occurredAt)}</time><SeverityBadge level={occurrence.severity} /><span>{labelSide(occurrence.side)}</span><code>{occurrence.source ?? 'Unknown source'}</code><strong>{occurrence.player ? `@${occurrence.player.username}` : shortId(occurrence.serverJobId)}</strong></button>)}</div>
}

function Pagination({ page, hasNext, loading, onPrevious, onNext, label }: { page: number; hasNext: boolean; loading: boolean; onPrevious: () => void; onNext: () => void; label: string }) {
  return <nav className="pagination" aria-label={label}><button onClick={onPrevious} disabled={page === 1 || loading}>Previous</button><span aria-current="page">Page {page}</span><button onClick={onNext} disabled={!hasNext || loading}>Next</button></nav>
}

function BackButton({ onClick, label }: { onClick: () => void; label: string }) {
  return <button className="back-button" onClick={onClick}><ArrowLeft size={17} />{label}</button>
}

function SeverityBadge({ level }: { level: Severity }) {
  return <span className={`severity-badge ${level}`}>{labelSeverity(level)}</span>
}

function LabeledSelect({ label, value, onChange, options, compact, icon }: { label: string; value: string; onChange: (value: string) => void; options: Array<string | [string, string]>; compact?: boolean; icon?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const normalizedOptions = options.map((option) => Array.isArray(option) ? option : [option, option] as [string, string])
  const selectedLabel = normalizedOptions.find(([optionValue]) => optionValue === value)?.[1] ?? value
  const menuId = `select-${label.toLowerCase().replace(/\s+/g, '-')}-menu`

  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false) }
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus() } }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus())
    return () => { document.removeEventListener('pointerdown', closeOnOutsideClick); document.removeEventListener('keydown', closeOnEscape) }
  }, [open])

  const moveOptionFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const optionElements = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')]
    const currentIndex = optionElements.indexOf(document.activeElement as HTMLElement)
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? optionElements.length - 1 : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + optionElements.length) % optionElements.length
    optionElements[nextIndex]?.focus()
  }

  return <div className={`select-control ${compact ? 'compact' : ''}`} ref={rootRef}><span className="select-label">{label}</span><button ref={triggerRef} className="select-trigger" type="button" aria-label={`${label}: ${selectedLabel}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(!open)} onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) } }}>{icon}<span>{selectedLabel}</span><ChevronDown size={15} aria-hidden="true" /></button>{open && <div className="select-menu" id={menuId} role="listbox" aria-label={label} onKeyDown={moveOptionFocus}>{normalizedOptions.map(([optionValue, optionLabel]) => <button type="button" role="option" aria-selected={optionValue === value} key={optionValue} onClick={() => { onChange(optionValue); setOpen(false); triggerRef.current?.focus() }}><span className="select-check">{optionValue === value && <Check size={16} aria-hidden="true" />}</span><span>{optionLabel}</span></button>)}</div>}</div>
}

function CopyBlock({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
  }

  return <div className={`copy-block ${secret ? 'secret-value' : ''}`}><span>{label}</span><code title={value}>{value}</code><button type="button" onClick={() => void copy()} aria-label={`Copy ${label.toLowerCase()}`}>{copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}<span>{copied ? 'Copied' : 'Copy'}</span></button></div>
}

function GameRemovalDialog({ project, working, onCancel, onConfirm }: { project: ManagedProject; working: boolean; onCancel: () => void; onConfirm: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])

  return <dialog className="remove-game-dialog" ref={dialogRef} onCancel={(event) => { event.preventDefault(); if (!working) onCancel() }} aria-labelledby="remove-game-title" aria-describedby="remove-game-description">
    <div className="remove-game-icon"><Trash2 size={20} aria-hidden="true" /></div>
    <div className="remove-game-copy"><h2 id="remove-game-title">Remove {project.name}?</h2><p id="remove-game-description">This permanently deletes the game and all of its Trace data.</p></div>
    <div className="remove-game-impact"><strong>This will delete</strong><span>All logs, sessions, errors, feedback, team access, and ingestion keys</span><span>You’ll need to link the game and install a new key to use Trace again</span></div>
    <div className="remove-game-actions"><button className="secondary-button" autoFocus disabled={working} onClick={onCancel}>Cancel</button><button className="danger-button" disabled={working} onClick={onConfirm}><Trash2 size={15} aria-hidden="true" />{working ? 'Removing…' : 'Permanently remove game'}</button></div>
  </dialog>
}

function InlineError({ error, retry, title }: { error: ApiError; retry: () => void; title?: string }) {
  return <div className="api-error" role="alert"><div><strong>{title ?? (error.status === 403 ? 'Project access denied' : error.status === 401 ? 'Session expired' : 'Could not load this data')}</strong><p>{apiErrorMessage(error)}</p></div><button onClick={retry}><RotateCcw size={16} />Try again</button></div>
}

function PageStatus({ title, copy, action, onAction, loading, compact }: { title: string; copy: string; action?: string; onAction?: () => void; loading?: boolean; compact?: boolean }) {
  return <div className={`empty-state ${compact ? 'compact-state' : ''}`}>{loading ? <span className="loading-spinner" /> : <Search size={24} aria-hidden="true" />}<h2>{title}</h2><p>{copy}</p>{action && onAction && <button onClick={onAction}>{action}</button>}</div>
}

function RowsLoading() {
  return <div className="rows-loading" aria-label="Loading"><span /><span /><span /></div>
}

function apiErrorMessage(error: ApiError) {
  const request = error.requestId ? ` Request ${error.requestId}.` : ''
  if (error.status === 0) return `The read API could not be reached.${request}`
  return `${error.message}${request}`
}

function labelSeverity(value: Severity) {
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

function labelSide(value: LogSide) {
  return value === 'client' ? 'Client' : 'Server'
}

function formatCount(value: number) {
  return value >= 10_000 ? compactNumberFormatter.format(value) : exactNumberFormatter.format(value)
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value))
}

function formatPreciseTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }).format(new Date(value))
}

function formatChartTime(value: string, count: number) {
  return new Intl.DateTimeFormat(undefined, count > 24 ? { month: 'short', day: 'numeric' } : { hour: 'numeric' }).format(new Date(value))
}

function formatDuration(milliseconds: number | null) {
  if (milliseconds === null) return 'Active'
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return hours ? `${hours}h ${minutes}m` : `${minutes}m ${remainder}s`
}

function formatDurationBetween(start: string, end: string | null) {
  return formatDuration(end ? new Date(end).getTime() - new Date(start).getTime() : null)
}

function shortId(value: string) {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
}

export default TraceApp
