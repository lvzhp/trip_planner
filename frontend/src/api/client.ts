import { runtime } from '../platform/runtime'
import type {
  AppConfig,
  CandidatePlace,
  GuideStage,
  ImportResult,
  IntegrationCheck,
  PlaceDetail,
  PlaceSearchResult,
  RouteLeg,
  RuntimeSettings,
  AskUserAnswer,
  ContextTag,
  ModelSelection,
  SavedPlace,
  SseEvent,
  Thread,
  ThreadComment,
  TripDetail,
  TripSummary,
  UserProfile,
  VersionItem,
} from '../types'

/**
 * 多端 API 根地址（platform/runtime.ts 统一解析）：
 * - 同域 H5 / 小程序 web-view：/api，走宿主同域请求（Vite 代理或后端托管）
 * - Capacitor 包：必须在 VITE_API_BASE / window.__TP_CONFIG__.apiBase 配绝对地址
 */
const BASE = runtime.apiBase

export class ApiError extends Error {
  status: number
  detail: unknown
  constructor(status: number, message: string, detail?: unknown) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(BASE + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  if (!resp.ok) {
    let detail: unknown = null
    let message = `HTTP ${resp.status}`
    try {
      detail = await resp.json()
      if (detail && typeof detail === 'object' && 'detail' in detail) {
        message = String((detail as { detail: unknown }).detail)
      }
    } catch {
      /* ignore */
    }
    throw new ApiError(resp.status, message, detail)
  }
  return (await resp.json()) as T
}

export const api = {
  config: () => request<AppConfig>('/config'),
  health: () => request<{ status: string; database: string; demoMode: boolean }>('/health'),
  trips: () => request<{ trips: TripSummary[] }>('/trips'),
  trip: (id: string) => request<TripDetail>(`/trips/${id}`),
  share: (id: string) => request<TripDetail>(`/share/${id}`),
  createTrip: (title?: string) =>
    request<TripDetail>('/trips', { method: 'POST', body: JSON.stringify({ title }) }),
  renameTrip: (id: string, title: string) =>
    request<TripDetail>(`/trips/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  eventsAfter: (id: string, afterSeq = 0) =>
    request<{ events: SseEvent[]; lastSeq: number }>(`/trips/${id}/events?after_seq=${afterSeq}`),
  versions: (id: string) =>
    request<{ versions: VersionItem[]; currentVersion: number }>(`/trips/${id}/versions`),
  version: (id: string, version: number) =>
    request<{ trip: TripDetail['trip']; derived: TripDetail['derived']; version: number }>(
      `/trips/${id}/versions/${version}`,
    ),
  restore: (id: string, version: number) =>
    request<TripDetail>(`/trips/${id}/restore`, {
      method: 'POST',
      body: JSON.stringify({ version }),
    }),
  settings: () => request<RuntimeSettings>('/settings'),
  updateSettings: (payload: {
    values?: Record<string, any>
    secrets?: Record<string, string>
    clearSecrets?: string[]
  }) =>
    request<{ settings: RuntimeSettings; reloadRequired: boolean }>('/settings', {
      method: 'PUT',
      body: JSON.stringify({
        values: payload.values || {},
        secrets: payload.secrets || {},
        clear_secrets: payload.clearSecrets || [],
      }),
    }),
  checkIntegrations: (payload: { provider?: string; model?: string } = {}) =>
    request<IntegrationCheck>('/settings/check', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  profile: () => request<UserProfile>('/profile'),
  updateProfile: (payload: { diet?: string[]; taste?: string[]; dismissed?: boolean; skip?: boolean }) =>
    request<UserProfile>('/profile', { method: 'PUT', body: JSON.stringify(payload) }),
  // ---- 地图旁路（docs/research/mindtrip/06 §13.3） ----
  place: (poiId: string, tripId?: string | null) =>
    request<PlaceDetail>(`/places/${encodeURIComponent(poiId)}${tripId ? `?trip_id=${encodeURIComponent(tripId)}` : ''}`),
  nearbyPlaces: (lng: number, lat: number, kind: string, radius = 3000, limit = 20, tripId?: string | null) => {
    const params = new URLSearchParams({
      lng: String(lng),
      lat: String(lat),
      kind,
      radius: String(radius),
      limit: String(limit),
    })
    if (tripId) params.set('trip_id', tripId)
    return request<{ items: CandidatePlace[]; message?: string | null; kind: string }>(
      `/places/nearby?${params.toString()}`,
    )
  },
  searchPlaces: (q: string, city?: string | null, limit = 8, tripId?: string | null) => {
    const params = new URLSearchParams({ q, limit: String(limit) })
    if (city) params.set('city', city)
    if (tripId) params.set('trip_id', tripId)
    return request<PlaceSearchResult>(`/places/search?${params.toString()}`)
  },
  placeFeedback: (poiId: string, vote: 'up' | 'down', note?: string) =>
    request<{ ok: boolean; recorded: boolean }>(`/places/${encodeURIComponent(poiId)}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ vote, note: note ?? null }),
    }),
  addStop: (tripId: string, body: {
    dayIndex: number
    atSeq?: number | null
    poiId?: string | null
    name: string
    category?: string | null
    city?: string | null
    address?: string | null
    lat?: number | null
    lng?: number | null
    amapPoiId?: string | null
    sourceRef?: string | null
    note?: string | null
  }) =>
    request<TripDetail>(`/trips/${tripId}/stops`, {
      method: 'POST',
      body: JSON.stringify({
        day_index: body.dayIndex,
        at_seq: body.atSeq ?? null,
        poi_id: body.poiId ?? null,
        name: body.name,
        category: body.category ?? null,
        city: body.city ?? null,
        address: body.address ?? null,
        lat: body.lat ?? null,
        lng: body.lng ?? null,
        amap_poi_id: body.amapPoiId ?? null,
        source_ref: body.sourceRef ?? null,
        note: body.note ?? null,
      }),
    }),
  deleteStop: (tripId: string, stopId: string) =>
    request<TripDetail>(`/trips/${tripId}/stops/${stopId}`, { method: 'DELETE' }),
  updateStopPoi: (tripId: string, stopId: string, body: {
    name?: string
    city?: string | null
    address?: string | null
    lat?: number | null
    lng?: number | null
    amapPoiId?: string | null
    sourceRef?: string | null
  }) =>
    request<TripDetail>(`/trips/${tripId}/stops/${stopId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: body.name ?? null,
        city: body.city ?? null,
        address: body.address ?? null,
        lat: body.lat ?? null,
        lng: body.lng ?? null,
        amap_poi_id: body.amapPoiId ?? null,
        source_ref: body.sourceRef ?? null,
      }),
    }),
  reorderStops: (tripId: string, dayIndex: number, stopIds: string[]) =>
    request<TripDetail & { patch?: Record<string, any> }>(`/trips/${tripId}/reorder`, {
      method: 'POST',
      body: JSON.stringify({ day_index: dayIndex, stop_ids: stopIds }),
    }),
  patchConstraints: (tripId: string, body: {
    destination?: string | null
    origin?: string | null
    startDate?: string | null
    endDate?: string | null
    travelers?: number | null
    budget?: number | null
    pace?: 'relaxed' | 'normal' | 'packed' | null
    syncDays?: 'shift' | 'trim' | null
  }) =>
    request<TripDetail & { patch?: Record<string, any> }>(`/trips/${tripId}/constraints`, {
      method: 'PATCH',
      body: JSON.stringify({
        destination: body.destination ?? null,
        origin: body.origin ?? null,
        start_date: body.startDate ?? null,
        end_date: body.endDate ?? null,
        travelers: body.travelers ?? null,
        budget: body.budget ?? null,
        pace: body.pace ?? null,
        sync_days: body.syncDays ?? null,
      }),
    }),
  routes: (tripId: string) => request<{ legs: RouteLeg[]; stored: boolean }>(`/trips/${tripId}/routes`),
  refreshRoutes: (tripId: string) =>
    request<{ legs: RouteLeg[]; enriched: number; message?: string | null }>(`/trips/${tripId}/routes/refresh`, {
      method: 'POST',
    }),
  saved: () => request<{ items: SavedPlace[] }>('/saved'),
  savePlace: (body: {
    poiId: string
    name?: string | null
    category?: string | null
    lat?: number | null
    lng?: number | null
    city?: string | null
    address?: string | null
    note?: string | null
  }) =>
    request<{ items: SavedPlace[] }>('/saved', {
      method: 'POST',
      body: JSON.stringify({
        poi_id: body.poiId,
        name: body.name ?? null,
        category: body.category ?? null,
        lat: body.lat ?? null,
        lng: body.lng ?? null,
        city: body.city ?? null,
        address: body.address ?? null,
        note: body.note ?? null,
      }),
    }),
  removeSaved: (poiId: string) =>
    request<{ items: SavedPlace[] }>(`/saved/${encodeURIComponent(poiId)}`, { method: 'DELETE' }),
  importLink: (tripId: string, body: { url?: string | null; text?: string | null; city?: string | null }) =>
    request<ImportResult>(`/import/link?trip_id=${encodeURIComponent(tripId)}`, {
      method: 'POST',
      body: JSON.stringify({ url: body.url ?? null, text: body.text ?? null, city: body.city ?? null }),
    }),
  importImages: (images: { filename?: string; mime?: string; dataBase64: string }[], mode: 'screenshot' | 'photo' = 'screenshot') =>
    request<ImportResult>('/import/images', {
      method: 'POST',
      body: JSON.stringify({
        images: images.map(img => ({ filename: img.filename ?? null, mime: img.mime ?? null, data_base64: img.dataBase64 })),
        mode,
      }),
    }),
  threads: (tripId: string) => request<{ threads: Thread[] }>(`/trips/${tripId}/threads`),
  createThread: (tripId: string, title: string) =>
    request<Thread>(`/trips/${tripId}/threads`, { method: 'POST', body: JSON.stringify({ title }) }),
  thread: (threadId: string) => request<Thread>(`/threads/${threadId}`),
  addComment: (threadId: string, body: string, author: 'me' | 'companion' = 'me') =>
    request<{ thread: Thread | null; comment: ThreadComment; reply: ThreadComment | null }>(
      `/threads/${threadId}/comments`,
      { method: 'POST', body: JSON.stringify({ body, author }) },
    ),
  exportIcsUrl: (tripId: string) => `${BASE}/trips/${tripId}/export.ics`,
  shareGuide: (tripId: string, stopId: string, filters: string[] = []) =>
    request<{ available: boolean; guide: import('../types').StopGuide | null }>(
      `/share/${tripId}/stops/${stopId}/guide?filters=${encodeURIComponent(filters.join(','))}`,
    ),
}

export interface SendMessageBody {
  content: string
  contextTags?: ContextTag[]
  askAnswers?: AskUserAnswer[]
  askId?: string | null
  model?: ModelSelection | null
}

/** Native SSE over fetch (EventSource cannot set headers or POST). */
export async function streamChat(
  tripId: string,
  body: SendMessageBody,
  handlers: {
    onEvent: (event: SseEvent) => void
    onOpen?: () => void
    signal?: AbortSignal
  },
): Promise<void> {
  const payload = {
    content: body.content,
    context_tags: (body.contextTags || []).map(tag => ({
      kind: tag.kind,
      id: tag.id ?? null,
      label: tag.label,
      day_index: tag.dayIndex ?? null,
    })),
    ask_answers: (body.askAnswers || []).map(a => ({
      question_index: a.questionIndex,
      option_ids: a.optionIds,
      note: a.note,
      free_text: a.freeText ?? null,
    })),
    ask_id: body.askId ?? null,
    model: body.model
      ? { provider: body.model.provider, model: body.model.model }
      : null,
  }
  const resp = await fetch(`${BASE}/trips/${tripId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal: handlers.signal,
  })
  if (!resp.ok || !resp.body) {
    let message = `HTTP ${resp.status}`
    try {
      const data = await resp.json()
      if (data?.detail) message = String(data.detail)
    } catch {
      /* ignore */
    }
    throw new ApiError(resp.status, message)
  }
  handlers.onOpen?.()
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const event = parseSseBlock(block)
      if (event) handlers.onEvent(event)
    }
  }
}

/** 攻略层 SSE（docs/07 §9）：与主对话流隔离，事件只有 stage + done，不进 turns。 */
export async function streamGuide(
  tripId: string,
  stopId: string,
  opts: { filters?: string[]; refresh?: boolean; model?: ModelSelection | null; signal?: AbortSignal },
  onStage: (stage: GuideStage) => void,
): Promise<void> {
  const q = new URLSearchParams()
  if (opts.filters?.length) q.set('filters', opts.filters.join(','))
  if (opts.refresh) q.set('refresh', 'true')
  if (opts.model?.provider) {
    q.set('provider', opts.model.provider)
    q.set('model', opts.model.model)
  }
  const resp = await fetch(`${BASE}/trips/${tripId}/stops/${stopId}/guide?${q.toString()}`, {
    headers: { Accept: 'text/event-stream' },
    signal: opts.signal,
  })
  if (!resp.ok || !resp.body) {
    let message = `HTTP ${resp.status}`
    try {
      const data = await resp.json()
      if (data?.detail) message = String(data.detail)
    } catch {
      /* ignore */
    }
    throw new ApiError(resp.status, message)
  }
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue
        try {
          const parsed = JSON.parse(line.slice(5).trimStart())
          if (parsed && typeof parsed === 'object' && parsed.stage) onStage(parsed as GuideStage)
        } catch {
          /* heartbeat or partial */
        }
      }
    }
  }
}

function parseSseBlock(block: string): SseEvent | null {
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (!dataLines.length) return null
  const raw = dataLines.join('\n')
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.type) {
      return parsed as SseEvent
    }
  } catch {
    /* malformed heartbeat or partial block */
  }
  return null
}
