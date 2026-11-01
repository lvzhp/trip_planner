import { create } from 'zustand'
import type {
  CandidatePlace,
  ContextTag,
  HighlightState,
  MapLayers,
  ModelSelection,
  PlaceSegment,
} from '../types'
import { storageGet, storageSet } from '../platform/storage'
import { syncThemeColor } from '../platform/runtime'

export type DrawerKind = 'version' | 'booking' | 'conflict' | null

/** stop 详情视图的段（docs/07 §6）。概览来自 Trip JSON；美食/打卡来自攻略管线；问答来自 turn 分流。 */
export type DetailTab = 'overview' | 'food' | 'spot' | 'qa'

/** 浮卡锚点：桌面锚 chip，移动端升 bottom sheet。 */
export interface PlaceCardState {
  poiId: string
  segment?: PlaceSegment | null
  mode: 'popover' | 'sheet'
  /** chip 的屏幕矩形（popover 翻转定位用） */
  anchor: { x: number; y: number; w: number; h: number } | null
  /** 从哪来：chip / 地图候选 / 收藏 / 卡片 */
  origin: 'chip' | 'candidate' | 'saved' | 'card'
}

export interface LegInfoState {
  fromStopId: string
  toStopId: string
}

export interface OpenDetailOpts {
  tab?: DetailTab
  /** 问答段定位到某条消息（事件 seq），滚动+高亮 */
  scrollToSeq?: number | null
  dayIndex?: number | null
  /**
   * 从某张卡片进入详情时，把该 activity 作为详情头与概览高亮的上下文（docs/07 §3）。
   * 不传 / 传 null 表示从地图 marker、对话存根等非卡片入口进来，详情以 stop 为主体。
   */
  activityId?: string | null
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = storageGet('tp:' + key)
    return raw == null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}
function write(key: string, value: unknown) {
  try {
    storageSet('tp:' + key, JSON.stringify(value))
  } catch {
    /* ignore quota */
  }
}

function themeColor(theme: 'light' | 'dark'): string {
  return theme === 'dark' ? '#0E1418' : '#1D6F5C'
}

export const SPLIT_PRESETS = { chat: 58, balanced: 40, map: 26 } as const
export type SplitPreset = keyof typeof SPLIT_PRESETS

interface UiState {
  theme: 'light' | 'dark'
  density: 'compact' | 'cozy'
  splitRatio: number
  selectedStopId: string | null
  selectedActivityId: string | null
  selectedNonce: number
  activeDay: number
  mapDay: number | 'all'
  /** 从「按住说」/规划面板带到聊天页的首条指令；Workbench 加载完行程后消费 */
  pendingPrompt: string | null
  pendingPromptTripId: string | null
  panelCollapsed: boolean
  composerContext: ContextTag[]
  composerPlaceholder: string
  composerFocusNonce: number
  model: ModelSelection & { name?: string; providerName?: string }
  modelExplicit: boolean
  drawer: DrawerKind
  drawerNonce: number
  settingsOpen: boolean
  /** 微信内无法代码唤起转发时，弹出的「右上角分享」引导 */
  shareGuideOpen: boolean
  /** stop 详情视图（docs/07 §5）：null=列表模式，非 null=详情模式 */
  detailStopId: string | null
  detailTab: DetailTab
  detailScrollSeq: number | null
  detailNonce: number
  /** 打开详情前的移动端抽屉档位，返回时恢复（docs/07 §11） */
  sheetBeforeDetail: 0 | 1 | 2
  mobileSheet: 0 | 1 | 2
  mobileTab: 'cards' | 'chat'
  bookingDone: string[]
  // ---- 地图优先层（docs/research/mindtrip/06）----
  /** 对话折叠：地图必须 ≥65%，对话可折叠成一条窄栏 */
  chatCollapsed: boolean
  chatWidth: number
  /** 本轮高亮集合（§3）：来自最新 assistant turn 的 place segments，不进 trip */
  highlight: HighlightState
  /** 候选点层（§4）：临时数据，加入行程前不落库 */
  candidates: CandidatePlace[]
  keepPreviousCandidates: boolean
  pendingAddPoiIds: string[]
  hoverStopId: string | null
  layers: MapLayers
  showDistances: boolean
  placeCard: PlaceCardState | null
  placeReturnFocus: HTMLElement | null
  /** 距离行点开时高亮的那一段 */
  legInfo: LegInfoState | null
  /** 用户最后一次手动平移/缩放（5s 内不抢视野） */
  lastUserPanAt: number
  itineraryOpen: boolean
  itineraryWidth: number
  importOpen: boolean
  threadsOpen: boolean
  setTheme: (theme: 'light' | 'dark') => void
  toggleTheme: () => void
  toggleDensity: () => void
  setSplitRatio: (ratio: number) => void
  applyPreset: (preset: SplitPreset) => void
  selectStop: (stopId: string | null, activityId?: string | null, dayIndex?: number) => void
  setActiveDay: (dayIndex: number, filterMap?: boolean) => void
  setMapDay: (day: number | 'all') => void
  setPendingPrompt: (text: string, tripId?: string | null) => void
  consumePendingPrompt: (tripId?: string | null) => string | null
  setPanelCollapsed: (collapsed: boolean) => void
  togglePanel: () => void
  addContextTag: (tag: ContextTag) => void
  removeContextTag: (index: number) => void
  clearContextTags: () => void
  setComposerPlaceholder: (text: string) => void
  focusComposer: () => void
  setModel: (model: ModelSelection & { name?: string; providerName?: string }, explicit?: boolean) => void
  openDrawer: (drawer: DrawerKind) => void
  closeDrawer: () => void
  openSettings: () => void
  closeSettings: () => void
  openShareGuide: () => void
  closeShareGuide: () => void
  /** 打开/切换 stop 详情（docs/07 §5、§11）。移动端自动升 full 档并记住原档位。 */
  openStopDetail: (stopId: string, opts?: OpenDetailOpts) => void
  closeStopDetail: () => void
  setDetailTab: (tab: DetailTab) => void
  setMobileSheet: (level: 0 | 1 | 2) => void
  cycleMobileSheet: () => void
  setMobileTab: (tab: 'cards' | 'chat') => void
  toggleBooking: (id: string) => void
  resetBooking: () => void
  // ---- 地图优先层 actions ----
  toggleChat: () => void
  setChatCollapsed: (collapsed: boolean) => void
  setChatWidth: (width: number) => void
  setHighlight: (turnId: string | null, poiIds: string[]) => void
  clearHighlight: () => void
  setHighlightFocus: (index: number) => void
  setCandidates: (list: CandidatePlace[]) => void
  appendCandidates: (list: CandidatePlace[]) => void
  markCandidateAdded: (poiId: string, added: boolean, opts?: { stopId?: string | null; dayIndex?: number | null }) => void
  removeCandidate: (poiId: string) => void
  setKeepPreviousCandidates: (keep: boolean) => void
  setPendingAdd: (poiId: string, pending: boolean) => void
  setHoverStopId: (poiId: string | null) => void
  toggleLayer: (layer: keyof MapLayers) => void
  setShowDistances: (show: boolean) => void
  openPlace: (poiId: string, opts?: Partial<Omit<PlaceCardState, 'poiId'>>) => void
  closePlace: () => void
  setLegInfo: (leg: LegInfoState | null) => void
  noteUserPan: () => void
  openItinerary: () => void
  closeItinerary: () => void
  setItineraryWidth: (width: number) => void
  openImport: () => void
  closeImport: () => void
  openThreads: () => void
  closeThreads: () => void
  /** 子 Agent 独立视图：非 null 时对话区整体切换成该子 Agent 的运行详情 */
  activeSubagentId: string | null
  openSubagent: (key: string) => void
  closeSubagent: () => void
}

export const useUiStore = create<UiState>((set, get) => ({
  theme: read('theme', 'light'),
  density: read('density', 'compact'),
  splitRatio: read('splitRatio', SPLIT_PRESETS.balanced),
  selectedStopId: null,
  selectedActivityId: null,
  selectedNonce: 0,
  activeDay: 1,
  mapDay: 1,
  pendingPrompt: null,
  pendingPromptTripId: null,
  panelCollapsed: false,
  composerContext: [],
  composerPlaceholder: '对整个行程说话，或用「改这里」定位到某个节点…',
  composerFocusNonce: 0,
  model: read('model', { provider: 'mock', model: 'trace-mock-v1', name: 'Trace Mock Planner', providerName: 'Mock' }),
  modelExplicit: read('modelExplicit', false),
  drawer: null,
  drawerNonce: 0,
  settingsOpen: false,
  shareGuideOpen: false,
  detailStopId: null,
  detailTab: 'overview',
  detailScrollSeq: null,
  detailNonce: 0,
  sheetBeforeDetail: 1,
  mobileSheet: 1,
  mobileTab: 'cards',
  bookingDone: read<string[]>('bookingDone', []),
  chatCollapsed: read('chatCollapsed', false),
  chatWidth: read('chatWidth', 360),
  highlight: { turnId: null, poiIds: [], focusedIndex: -1, autoFit: true },
  candidates: [],
  keepPreviousCandidates: read('keepPreviousCandidates', false),
  pendingAddPoiIds: [],
  hoverStopId: null,
  layers: read<MapLayers>('layers', { trip: true, nearby: true, saved: false }),
  showDistances: read('showDistances', true),
  placeCard: null,
  placeReturnFocus: null,
  legInfo: null,
  lastUserPanAt: 0,
  itineraryOpen: false,
  itineraryWidth: read('itineraryWidth', 440),
  importOpen: false,
  threadsOpen: false,

  setTheme: theme => {
    document.documentElement.setAttribute('data-theme', theme)
    syncThemeColor(themeColor(theme))
    write('theme', theme)
    set({ theme })
  },
  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', next)
    syncThemeColor(themeColor(next))
    write('theme', next)
    set({ theme: next })
  },
  toggleDensity: () => {
    const next = get().density === 'cozy' ? 'compact' : 'cozy'
    document.documentElement.setAttribute('data-density', next)
    write('density', next)
    set({ density: next })
  },
  setSplitRatio: ratio => {
    const clamped = Math.min(72, Math.max(18, ratio))
    write('splitRatio', clamped)
    set({ splitRatio: clamped })
  },
  applyPreset: preset => {
    const ratio = SPLIT_PRESETS[preset]
    write('splitRatio', ratio)
    set({ splitRatio: ratio })
  },
  selectStop: (stopId, activityId = null, dayIndex) =>
    set(state => ({
      selectedStopId: stopId,
      selectedActivityId: activityId,
      activeDay: dayIndex ?? state.activeDay,
      selectedNonce: state.selectedNonce + 1,
    })),
  setActiveDay: (dayIndex, filterMap = true) =>
    set({ activeDay: dayIndex, mapDay: filterMap ? dayIndex : get().mapDay }),
  setMapDay: day => set({ mapDay: day }),
  setPendingPrompt: (text, tripId) =>
    set({ pendingPrompt: text.trim() || null, pendingPromptTripId: tripId || null }),
  consumePendingPrompt: tripId => {
    const { pendingPrompt, pendingPromptTripId } = get()
    if (!pendingPrompt) return null
    if (tripId && pendingPromptTripId && tripId !== pendingPromptTripId) return null
    set({ pendingPrompt: null, pendingPromptTripId: null })
    return pendingPrompt
  },
  setPanelCollapsed: collapsed => set({ panelCollapsed: collapsed }),
  togglePanel: () => set(state => ({ panelCollapsed: !state.panelCollapsed })),
  addContextTag: tag =>
    set(state => {
      const exists = state.composerContext.some(
        t => t.kind === tag.kind && t.id === tag.id && t.label === tag.label,
      )
      if (exists) return state
      return {
        composerContext: [...state.composerContext, tag],
        composerFocusNonce: state.composerFocusNonce + 1,
      }
    }),
  removeContextTag: index =>
    set(state => ({ composerContext: state.composerContext.filter((_, i) => i !== index) })),
  clearContextTags: () => set({ composerContext: [] }),
  setComposerPlaceholder: text => set({ composerPlaceholder: text }),
  focusComposer: () => set(state => ({ composerFocusNonce: state.composerFocusNonce + 1 })),
  setModel: (model, explicit = true) => {
    write('model', model)
    if (explicit) write('modelExplicit', true)
    set({ model, modelExplicit: explicit ? true : get().modelExplicit })
  },
  openDrawer: drawer => set(state => ({ drawer, drawerNonce: state.drawerNonce + 1 })),
  closeDrawer: () => set({ drawer: null }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  openShareGuide: () => set({ shareGuideOpen: true }),
  closeShareGuide: () => set({ shareGuideOpen: false }),
  openStopDetail: (stopId, opts = {}) =>
    set(state => {
      const reopening = state.detailStopId === stopId
      return {
        detailStopId: stopId,
        detailTab: opts.tab ?? (reopening ? state.detailTab : 'overview'),
        detailScrollSeq: opts.scrollToSeq ?? null,
        detailNonce: state.detailNonce + 1,
        activeDay: opts.dayIndex ?? state.activeDay,
        selectedStopId: stopId,
        selectedActivityId: opts.activityId ?? null,
        panelCollapsed: false,
        mobileTab: 'cards',
        // 移动端自动升 full：详情底部有输入框，键盘弹起后 half 档物理上不可用
        // （docs/07 §11）。返回时恢复原档位。
        sheetBeforeDetail: reopening ? state.sheetBeforeDetail : state.mobileSheet,
        mobileSheet: 2,
      }
    }),
  closeStopDetail: () =>
    set(state => ({
      detailStopId: null,
      detailTab: 'overview',
      detailScrollSeq: null,
      mobileSheet: state.sheetBeforeDetail,
    })),
  setDetailTab: tab => set(state => ({ detailTab: tab, detailNonce: state.detailNonce + 1 })),
  setMobileSheet: level => set({ mobileSheet: level }),
  cycleMobileSheet: () => set(state => ({ mobileSheet: ((state.mobileSheet + 1) % 3) as 0 | 1 | 2 })),
  setMobileTab: tab => set({ mobileTab: tab }),
  toggleBooking: id =>
    set(state => {
      const next = state.bookingDone.includes(id)
        ? state.bookingDone.filter(x => x !== id)
        : [...state.bookingDone, id]
      write('bookingDone', next)
      return { bookingDone: next }
    }),
  resetBooking: () => {
    write('bookingDone', [])
    set({ bookingDone: [] })
  },
  toggleChat: () => set(state => {
    write('chatCollapsed', !state.chatCollapsed)
    return { chatCollapsed: !state.chatCollapsed }
  }),
  setChatCollapsed: collapsed => {
    write('chatCollapsed', collapsed)
    set({ chatCollapsed: collapsed })
  },
  setChatWidth: width => {
    // 对话 320–380px：再宽就会永久挤占地图（§0.2 不变量 1）
    const clamped = Math.min(380, Math.max(320, Math.round(width)))
    write('chatWidth', clamped)
    set({ chatWidth: clamped })
  },
  setHighlight: (turnId, poiIds) =>
    set({
      highlight: {
        turnId,
        poiIds: [...new Set(poiIds.filter(Boolean))],
        focusedIndex: -1,
        autoFit: true,
      },
    }),
  clearHighlight: () =>
    set({ highlight: { turnId: null, poiIds: [], focusedIndex: -1, autoFit: false } }),
  setHighlightFocus: index => set(state => ({ highlight: { ...state.highlight, focusedIndex: index } })),
  setCandidates: list => set({ candidates: dedupeCandidates(list) }),
  appendCandidates: list => set(state => ({ candidates: dedupeCandidates([...state.candidates, ...list]) })),
  markCandidateAdded: (poiId, added, opts) =>
    set(state => ({
      candidates: state.candidates.map(item =>
        item.poiId === poiId || (opts?.stopId && item.poiId === opts.stopId)
          ? { ...item, added, stopId: opts?.stopId ?? item.stopId, dayIndex: opts?.dayIndex ?? item.dayIndex }
          : item,
      ),
    })),
  removeCandidate: poiId => set(state => ({ candidates: state.candidates.filter(item => item.poiId !== poiId) })),
  setKeepPreviousCandidates: keep => {
    write('keepPreviousCandidates', keep)
    set({ keepPreviousCandidates: keep })
  },
  setPendingAdd: (poiId, pending) =>
    set(state => ({
      pendingAddPoiIds: pending
        ? [...new Set([...state.pendingAddPoiIds, poiId])]
        : state.pendingAddPoiIds.filter(id => id !== poiId),
    })),
  setHoverStopId: poiId => set({ hoverStopId: poiId }),
  toggleLayer: layer =>
    set(state => {
      const next = { ...state.layers, [layer]: !state.layers[layer] }
      write('layers', next)
      return { layers: next }
    }),
  setShowDistances: show => {
    write('showDistances', show)
    set({ showDistances: show })
  },
  openPlace: (poiId, opts = {}) =>
    set({
      placeCard: {
        poiId,
        segment: opts.segment ?? null,
        mode: opts.mode ?? 'popover',
        anchor: opts.anchor ?? null,
        origin: opts.origin ?? 'chip',
      },
      placeReturnFocus: opts.segment ? (document.activeElement as HTMLElement | null) : get().placeReturnFocus,
    }),
  closePlace: () => set({ placeCard: null }),
  setLegInfo: leg => set({ legInfo: leg }),
  noteUserPan: () => set({ lastUserPanAt: Date.now() }),
  openItinerary: () => set({ itineraryOpen: true, importOpen: false }),
  closeItinerary: () => set({ itineraryOpen: false }),
  setItineraryWidth: width => {
    const clamped = Math.min(560, Math.max(360, Math.round(width)))
    write('itineraryWidth', clamped)
    set({ itineraryWidth: clamped })
  },
  openImport: () => set({ importOpen: true, itineraryOpen: false }),
  closeImport: () => set({ importOpen: false }),
  openThreads: () => set({ threadsOpen: true, itineraryOpen: false, importOpen: false }),
  closeThreads: () => set({ threadsOpen: false }),
  activeSubagentId: null,
  openSubagent: key => set({ activeSubagentId: key }),
  closeSubagent: () => set({ activeSubagentId: null }),
}))

function dedupeCandidates(list: CandidatePlace[]): CandidatePlace[] {
  const seen = new Set<string>()
  const out: CandidatePlace[] = []
  for (const item of list) {
    if (!item?.poiId || seen.has(item.poiId)) continue
    seen.add(item.poiId)
    out.push(item)
  }
  return out
}

export function initThemeFromStore() {
  const { theme, density } = useUiStore.getState()
  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.setAttribute('data-density', density)
  syncThemeColor(themeColor(theme))
}
