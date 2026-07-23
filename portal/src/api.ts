export type Severity = 'trace' | 'info' | 'warning' | 'error'
export type LogSide = 'client' | 'server'

export type Project = {
  id: string
  name: string
  robloxUniverseId: string | null
  iconUrl: string | null
}

export type AuthUser = {
  id: string
  email: string | null
  name: string | null
  robloxUserId: string | null
  robloxUsername: string | null
  robloxDisplayName: string | null
  robloxAvatarUrl: string | null
}

export type ManagedProject = Project & {
  role: 'owner' | 'admin' | 'member' | 'viewer'
  verifiedAt: string | null
  keyHint: string | null
  keyCreatedAt: string | null
  pendingInvitationCount: number
}

export type ProjectInvitation = {
  id: string
  robloxUserId: string
  robloxUsername: string
  role: 'admin' | 'member' | 'viewer'
  createdAt: string
  status: 'pending' | 'accepted' | 'revoked'
}

export type IncomingProjectInvitation = {
  id: string
  role: 'admin' | 'member' | 'viewer'
  createdAt: string
  project: Project
  invitedBy: {
    username: string | null
    displayName: string | null
  }
}

export type ProjectMember = {
  id: string
  role: 'owner' | 'admin' | 'member' | 'viewer'
  joinedAt: string
  robloxUserId: string | null
  robloxUsername: string | null
  robloxDisplayName: string | null
  robloxAvatarUrl: string | null
}

export type RobloxGameMetadata = {
  universeId: string | null
  name: string | null
  iconUrl: string | null
}

export type PlayerSummary = {
  robloxUserId: string
  username: string
  displayName: string
  avatarUrl: string | null
}

export type ServerJobSummary = {
  id: string
  robloxJobId: string
  placeId: string
  region: string | null
  startedAt: string
  endedAt: string | null
}

export type ServerJob = ServerJobSummary & {
  sessionCount: number
  eventCount: number
  errorCount: number
  warningCount: number
}

export type Session = {
  id: string
  projectId: string
  player: PlayerSummary
  serverJob: ServerJobSummary
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  device: string | null
  platform: string | null
  errorCount: number
  warningCount: number
}

export type Correlation = {
  kind: 'time_window'
  confidence: 'low'
  relatedOccurrenceId: string
  deltaMs: number
}

export type LogOccurrence = {
  id: string
  projectId: string
  occurredAt: string
  receivedAt: string
  severity: Severity
  side: LogSide
  message: string
  source: string | null
  stackTrace: string | null
  fingerprint: string | null
  serverJobId: string
  sessionId: string | null
  player: PlayerSummary | null
  attributes: Record<string, string | number | boolean | null>
  correlation?: Correlation
}

export type GroupedErrorSummary = {
  fingerprint: string
  severity: Severity
  side: LogSide
  title: string
  source: string | null
  count: number
  firstSeenAt: string
  lastSeenAt: string
}

export type GroupedError = GroupedErrorSummary & {
  affectedPlayerCount: number
  affectedServerCount: number
  latestOccurrenceId: string
}

export type ErrorDetail = {
  error: GroupedError
  latestOccurrence: LogOccurrence
}

export type ErrorMessageVariant = {
  message: string
  count: number
  firstSeenAt: string
  lastSeenAt: string
}

export type ActivityBucket = {
  startAt: string
  endAt: string
  clientCount: number
  serverCount: number
}

export type FeedbackEntry = {
  id: string
  message: string
  submittedAt: string
  sessionId: string | null
  player: PlayerSummary
  device: string | null
}

export type CursorPage<T> = {
  data: T[]
  nextCursor: string | null
}

type ApiErrorBody = {
  error?: {
    code?: string
    message?: string
    requestId?: string
  }
}

export class ApiError extends Error {
  status: number
  code: string
  requestId?: string

  constructor(status: number, body: ApiErrorBody) {
    super(body.error?.message ?? `Trace API request failed (${status}).`)
    this.name = 'ApiError'
    this.status = status
    this.code = body.error?.code ?? 'request_failed'
    this.requestId = body.error?.requestId
  }
}

const API_BASE = (import.meta.env.VITE_TRACE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '/api'

export function apiUrl(path: string) {
  return `${API_BASE}${path}`
}

export function queryString(values: Record<string, string | number | null | undefined>) {
  const search = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  })
  const result = search.toString()
  return result ? `?${result}` : ''
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    credentials: 'include',
    ...init,
    cache: init.method === 'GET' ? 'default' : 'no-store',
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })

  if (!response.ok) {
    let body: ApiErrorBody = {}
    try {
      body = await response.json() as ApiErrorBody
    } catch {
      // The status still provides a useful fallback when a proxy fails.
    }
    throw new ApiError(response.status, body)
  }

  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return apiRequest<T>(path, { method: 'GET', signal })
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
}

export function apiDelete(path: string): Promise<void> {
  return apiRequest<void>(path, { method: 'DELETE' })
}

export async function getRobloxGameMetadata(projectId: string, universeId: string | null, signal?: AbortSignal): Promise<RobloxGameMetadata> {
  try {
    return await apiGet<RobloxGameMetadata>(projectPath(projectId, '/roblox-metadata'), signal)
  } catch (error) {
    if (!import.meta.env.DEV || !universeId) throw error
  }

  const encodedId = encodeURIComponent(universeId)
  const [gameResponse, iconResponse] = await Promise.all([
    fetch(`/roblox-games/v1/games?universeIds=${encodedId}`, { signal }),
    fetch(`/roblox-thumbnails/v1/games/icons?universeIds=${encodedId}&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false`, { signal }),
  ])
  const games = gameResponse.ok ? await gameResponse.json() as { data?: Array<{ id?: number; name?: string }> } : null
  const icons = iconResponse.ok ? await iconResponse.json() as { data?: Array<{ state?: string; imageUrl?: string }> } : null
  const game = games?.data?.[0]
  const icon = icons?.data?.[0]
  return {
    universeId,
    name: game?.id && game.name && !game.name.startsWith('[') ? game.name : null,
    iconUrl: icon?.state === 'Completed' ? icon.imageUrl ?? null : null,
  }
}

export async function getRobloxPlayerHeadshot(projectId: string, robloxUserId: string): Promise<string | null> {
  try {
    const response = await apiGet<{ imageUrl: string | null }>(projectPath(projectId, `/players/${robloxUserId}/headshot`))
    return response.imageUrl
  } catch (error) {
    if (!import.meta.env.DEV) throw error
  }

  const response = await fetch(`/roblox-thumbnails/v1/users/avatar-headshot?userIds=${encodeURIComponent(robloxUserId)}&size=150x150&format=Png&isCircular=false`)
  if (!response.ok) return null
  const body = await response.json() as { data?: Array<{ state?: string; imageUrl?: string }> }
  const thumbnail = body.data?.[0]
  return thumbnail?.state === 'Completed' ? thumbnail.imageUrl ?? null : null
}

export async function getRobloxPlayerHeadshots(
  projectId: string,
  robloxUserIds: string[],
  signal?: AbortSignal,
): Promise<Record<string, string | null>> {
  if (robloxUserIds.length === 0) return {}
  try {
    const response = await apiGet<{ data: Record<string, string | null> }>(
      projectPath(projectId, `/player-headshots${queryString({ ids: robloxUserIds.join(',') })}`),
      signal,
    )
    return response.data
  } catch (error) {
    if (!import.meta.env.DEV || !(error instanceof ApiError) || error.status !== 404) throw error
    const entries = await Promise.all(
      robloxUserIds.map(async (robloxUserId) => [
        robloxUserId,
        await getRobloxPlayerHeadshot(projectId, robloxUserId),
      ] as const),
    )
    return Object.fromEntries(entries)
  }
}

export function projectPath(projectId: string, resource: string) {
  return `/v1/projects/${encodeURIComponent(projectId)}${resource}`
}

export function timeRange(hours: number) {
  const hour = 60 * 60 * 1_000
  const currentHour = Math.floor(Date.now() / hour) * hour
  const from = new Date(currentHour - (hours - 1) * hour)
  const to = new Date(currentHour + hour)
  return { from: from.toISOString(), to: to.toISOString() }
}
