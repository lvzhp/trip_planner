export type ActivityType = 'visit' | 'meal' | 'stay' | 'long_transit' | 'free'
export type TransportMode = 'drive' | 'walk' | 'transit'
export type LongTransitMode = 'flight' | 'train' | 'self_drive'
export type TicketKind = 'attraction' | 'transport' | 'hotel' | 'none'
export type ChannelType = 'wechat_mp' | 'mini_program' | 'app' | 'web' | 'ota' | 'onsite'
/** 证据分级（new-plan 01 §4.2 / 02 §3.2）：只有 verified 会被当成硬约束 */
export type EvidenceStatus = 'verified' | 'clue' | 'unverified' | 'conflict'
export type ChannelStatus = Exclude<EvidenceStatus, 'conflict'>
export type SaleMode =
  | 'advance_days_at_time'
  | 'fixed_date'
  | 'rolling_daily'
  | 'lottery_or_reservation'
  | 'onsite_only'
export type ConflictSeverity = 'error' | 'warning'
export type Pace = 'relaxed' | 'normal' | 'intense'
export type EventType =
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'plan_patch'
  | 'message'
  | 'ask_user'
  /** 距离行（mindtrip/06 §13.2）：旧客户端跳过未知类型 */
  | 'route'
  /** 子 Agent 运行进度：started / step / finished（独立页面实时展示） */
  | 'subagent'

export interface PoiRef {
  name: string
  amapPoiId?: string | null
  lng?: number | null
  lat?: number | null
  city?: string | null
  sourceRef?: string | null
  seasonClosure?: SeasonClosure | null
}

export interface SeasonClosure {
  openFrom?: string | null
  openTo?: string | null
  note?: string | null
  sourceRef?: string | null
}

export interface Poi {
  name: string
  amapPoiId?: string | null
  lng: number | null
  lat: number | null
  city?: string | null
  address?: string | null
  sourceRef?: string | null
}

export interface TimeWindow {
  start: string
  end: string
}

export interface TransitLeg {
  mode: TransportMode
  minutes?: number | null
  distanceKm?: number | null
  sourceRef?: string | null
}

export interface FlightDetail {
  mode: 'flight'
  flightNo?: string | null
  airline?: string | null
  airportFrom?: string | null
  airportTo?: string | null
  depTime?: string | null
  arrTime?: string | null
  sourceRef?: string | null
}

export interface TrainDetail {
  mode: 'train'
  trainNo?: string | null
  stationFrom?: string | null
  stationTo?: string | null
  seatClass?: string | null
  depTime?: string | null
  arrTime?: string | null
  sourceRef?: string | null
}

export interface SelfDriveDetail {
  mode: 'self_drive'
  distanceKm?: number | null
  driveMinutes?: number | null
  waypointsPoi: PoiRef[]
  roadRefs: string[]
  roadCondition?: string | null
  seasonClosure?: SeasonClosure | null
  fuelStops: PoiRef[]
  parking?: string | null
  permitRequired?: boolean
  permitNote?: string | null
  sourceRef?: string | null
}

export type TransitDetail = FlightDetail | TrainDetail | SelfDriveDetail

export interface BookingChannel {
  name: string
  type: ChannelType
  detail?: string | null
  note?: string | null
  /** 是否是景区官方渠道 */
  official?: boolean | null
  /** verified 必须有官方域名或官方公告作为 evidenceUrl */
  status?: ChannelStatus
  evidenceUrl?: string | null
  howToFind?: string | null
  sourceRef?: string | null
}

export interface SaleRule {
  mode: SaleMode
  advanceDays?: number | null
  releaseTime?: string | null
  fixedDate?: string | null
  sourceRef?: string | null
}

export interface LimitedQuota {
  quote: string
  sourceRef?: string | null
}

export interface RecommendedPurchase {
  targetDate?: string | null
  session?: string | null
  leadTimeDays?: number | null
  note?: string | null
}

export interface Ticket {
  kind: TicketKind
  priceRange?: [number, number] | null
  currency?: string
  leadTimeDays?: number | null
  realNameRequired?: boolean
  channels: BookingChannel[]
  recommendedPurchase?: RecommendedPurchase | null
  note?: string | null
  sourceRef?: string | null
  /** 开售规则；开售日由服务端按游玩日 − advanceDays 算进 bookingTimeline */
  saleRule?: SaleRule | null
  /** 稀缺度只记证据里有的（限流公告、售罄报道） */
  limitedQuota?: LimitedQuota | null
}

export interface OpeningPeriod {
  days: string[]
  open: string
  close: string
  lastEntry?: string | null
}

export interface SeasonalOpening {
  from: string
  to: string
  regular: OpeningPeriod[]
}

/** 景区营业时间（02 §3）。status 不是 verified 时卡片显示「营业时间待核实」 */
export interface OpeningHours {
  status: EvidenceStatus
  regular: OpeningPeriod[]
  closedDays: string[]
  closedDates: string[]
  seasonal: SeasonalOpening[]
  reservationRequired?: boolean | null
  note?: string | null
  evidence?: { url?: string | null; publishedAt?: string | null; quote?: string | null }[]
  sourceRefs: string[]
  authority?: number | null
}

export interface Activity {
  activityId: string
  seq: number
  type: ActivityType
  title: string
  timeWindow: TimeWindow
  note?: string | null
  tips: string[]
  transitFromPrev?: TransitLeg | null
  transitDetail?: TransitDetail | null
  ticket?: Ticket | null
  sourceRefs: string[]
}

export interface Stop {
  stopId: string
  seq: number
  poi: Poi
  activities: Activity[]
  /** 营业时间：模型只写 sourceRefs，值由服务端从来源登记簿回填 */
  openingHours?: OpeningHours | null
  dayIndex?: number
}

export interface Rhythm {
  wake: string
  sleep: string
}

export interface Day {
  dayIndex: number
  date?: string | null
  theme?: string | null
  rhythm: Rhythm
  stops: Stop[]
}

export interface Budget {
  total?: number | null
  level: 'low' | 'mid' | 'high'
  perPersonEst?: number | null
}

export interface PermitRequirement {
  name: string
  whereToApply?: string | null
  leadTimeDays?: number | null
  appliesTo: string[]
  sourceRef?: string | null
}

export interface VehiclePlan {
  pickup?: { poi?: string; date?: string; time?: string } | null
  dropoff?: { poi?: string; date?: string; time?: string } | null
  rentalChannel?: BookingChannel | null
  permits: PermitRequirement[]
}

export interface DateRange {
  start?: string | null
  end?: string | null
  note?: string | null
}

export interface Constraints {
  origin?: string | null
  /** 目的地（参数条 chips：京都 / 11月2–6 / 2人 / ¥8k / 轻松） */
  destination?: string | null
  dateRange?: DateRange | null
  travelers: number
  budget: Budget
  transportMode?: 'flight' | 'train' | 'self_drive' | null
  vehicle?: VehiclePlan | null
  pace: Pace
  diet: string[]
  mustGo: PoiRef[]
  mustAvoid: PoiRef[]
  assumptions: string[]
}

export interface Revision {
  version: number
  turnSeq?: number | null
  summary?: string | null
  userRequest?: string | null
  opCount: number
  changedStopIds: string[]
  changedActivityIds: string[]
  createdAt?: string | null
}

export interface Trip {
  tripId: string
  title?: string | null
  version: number
  constraints: Constraints
  days: Day[]
  revisionLog: Revision[]
  createdAt?: string | null
  updatedAt?: string | null
}

export interface Conflict {
  id?: string | null
  type: string
  severity: ConflictSeverity
  dayIndex?: number | null
  stopId?: string | null
  activityId?: string | null
  message: string
  suggestedFix?: string | null
  askUser?: AskUser | null
}

export interface DerivedWindow {
  firstStart?: string | null
  lastEnd?: string | null
  totalHours: number
  transitHours: number
}

export interface DayDerived {
  dayIndex: number
  window: DerivedWindow
  loadHours: number
  conflicts: Conflict[]
}

export interface BookingItem {
  id?: string | null
  orderBy?: string | null
  activityId?: string | null
  dayIndex?: number | null
  title: string
  kind: TicketKind
  mode?: string | null
  channelHint?: string | null
  channelStatus?: ChannelStatus | null
  priceRange?: [number, number] | null
  leadTimeDays?: number | null
  realNameRequired: boolean
  /** 开售日由代码计算，只来自官方核实的规则（01 §5.3） */
  saleDate?: string | null
  saleTime?: string | null
  saleHint?: string | null
}

export interface BudgetSummary {
  ticketsTotal: number
  /** @deprecated 住宿收缩为区域级（01 §10），恒为 0，预算不含住宿 */
  hotelsTotal: number
  foodEstTotal: number
  transitEstTotal: number
  grandTotal: number
  perPerson: number
  budgetTotal?: number | null
  overBudgetBy: number
  /** 预算不含住宿（01 §9.5） */
  lodgingIncluded?: boolean
}

export interface Derived {
  days: DayDerived[]
  bookingTimeline: BookingItem[]
  budgetSummary: BudgetSummary
  conflicts: Conflict[]
  ok: boolean
  today: string
}

export interface AskUserOption {
  id: string
  label: string
  noteHint?: string | null
}

export interface AskUserQuestion {
  question: string
  multi: boolean
  options: AskUserOption[]
  noteHint?: string | null
  /** 输入控件：chips（默认）/ city（城市选择器）/ date（日期选择器） */
  input?: 'chips' | 'city' | 'date'
}

export interface AskUser {
  askId?: string | null
  intro?: string | null
  questions: AskUserQuestion[]
  allowNote: boolean
  allowSkip: boolean
  at?: string | null
}

export interface AskUserAnswer {
  questionIndex: number
  optionIds: string[]
  note: string
  freeText?: string | null
  /** 选择器（城市/日期）里填的值 */
  value?: string | null
}

export interface ContextTag {
  kind: 'stop' | 'activity' | 'day' | 'rhythm' | 'assumption' | 'conflict'
  id?: string | null
  label: string
  dayIndex?: number | null
}

export interface SseEvent {
  seq: number
  type: EventType
  payload: Record<string, any>
  tripId?: string
  turnId?: string
  createdAt?: string
}

export interface TripDetail {
  trip: Trip
  derived: Derived
  events: SseEvent[]
  routeLegs?: RouteLeg[]
  lastSeq: number
  readonly: boolean
}

export interface TripSummary {
  tripId: string
  title: string
  version: number
  origin?: string | null
  dest?: string | null
  dateStart?: string | null
  dateEnd?: string | null
  days: number
  transportMode?: string | null
  updatedAt?: string | null
  errorCount: number
  warningCount: number
  done: boolean
  routePoints?: [number, number][]
}

export interface ModelSelection {
  provider: string
  model: string
}

export interface ProviderModel {
  id: string
  name: string
  desc: string
}

export interface ProviderGroup {
  id: string
  provider: string
  available: boolean
  models: ProviderModel[]
}

export interface AppConfig {
  appName: string
  demoMode: boolean
  agentMode?: 'demo' | 'real'
  mapProvider?: 'amap' | 'leaflet' | 'svg'
  amapJsKey: string
  amapJsSecurityCode: string
  amapWebConfigured: boolean
  tavilyConfigured: boolean
  llmConfigured: boolean
  demoToday: string
  defaultModel: { provider: string; model: string }
  providers: ProviderGroup[]
  readonlyShare?: boolean
}

export interface VersionItem {
  version: number
  title?: string | null
  summary?: string | null
  userRequest?: string | null
  opCount: number
  createdAt?: string | null
  changedStopIds: string[]
  changedActivityIds: string[]
  available: boolean
}

export interface DiffEntry {
  op?: 'add' | 'del' | 'mod'
  activityId?: string
  stopId?: string
  dayIndex?: number
  title?: string
  field?: string
  before?: string
  after?: string
  label?: string
}

export interface PlanPatchPayload {
  version: number
  ops: Record<string, any>[]
  trip: Trip
  derived: Derived
  changed: { dayIndexes?: number[]; stopIds?: string[]; activityIds?: string[] }
  diff: DiffEntry[]
  reason?: string | null
}


export interface SecretState {
  configured: boolean
  hint: string | null
}

// ---------------------------------------------------------------------------
// 攻略层（docs/07 §6、§9）—— stop 详情的美食/打卡段，永不写回 Trip JSON
// ---------------------------------------------------------------------------

export interface GuideItem {
  name: string
  amapPoiId?: string | null
  lng?: number | null
  lat?: number | null
  distanceM?: number | null
  highlight?: string | null
  bestTime?: string | null
  sourceRef?: string | null
}

export interface GuideSection {
  narrative: string[]
  items: GuideItem[]
}

export interface StopGuide {
  tripId: string
  stopId: string
  poiHash: string
  filterHash: string
  profileHash: string
  food: GuideSection
  spot: GuideSection
  source: 'real' | 'mock'
  notConfigured?: string | null
  generatedAt?: string | null
}

export type GuideStageKind = 'searching' | 'writing' | 'done' | 'error'

export interface GuideStage {
  stage: GuideStageKind
  label: string
  detail?: StopGuide | null
  error?: string | null
}

export interface UserProfile {
  diet: string[]
  taste: string[]
  dismissed: boolean
  updatedAt?: string | null
  exists: boolean
  options?: { diet: string[]; taste: string[] }
}

export interface RuntimeSettings {
  values: Record<string, any>
  secrets: Record<string, SecretState>
  llmConfigured: boolean
  mapProvider: 'amap' | 'leaflet' | 'svg'
  mapProviderSetting: 'auto' | 'amap' | 'leaflet' | 'svg'
  providerCatalog: ProviderGroup[]
  demoMode: boolean
}

export interface IntegrationResult {
  service: string
  label: string
  ok: boolean
  status: string
  message: string
  latencyMs: number
  details?: any
}

export interface IntegrationCheck {
  ok: boolean
  results: IntegrationResult[]
  provider: string
  model: string
}


// ---------------------------------------------------------------------------
// 地图优先那一层（docs/research/mindtrip/06）
// ---------------------------------------------------------------------------

export type PlaceCategory =
  | 'place'
  | 'stay'
  | 'meal'
  | 'sight'
  | 'shopping'
  | 'transit'
  | 'unknown'

export interface TextSegment {
  type: 'text'
  text: string
}

/** 行内地点 chip（§1.3）。`poiId` 在行程内时等于 stopId。 */
export interface PlaceSegment {
  type: 'place'
  poiId: string
  stopId?: string | null
  name: string
  fullName?: string
  category: PlaceCategory
  added: boolean
  hasCoords: boolean
  /** 引用的地点已不在行程（chip 变灰，点击提示） */
  missing?: boolean
  city?: string | null
  address?: string | null
  lat?: number | null
  lng?: number | null
  dayIndex?: number | null
}

/** 路程 chip（§1.4）：`A → B · 步行 18 分钟`。 */
export interface RouteSegment {
  type: 'route'
  fromPoiId: string
  toPoiId: string
  fromName?: string
  toName?: string
  mode: string
  distanceM?: number | null
  durationMin?: number | null
}

export type MessageSegment = TextSegment | PlaceSegment | RouteSegment

/** 候选点（§4.3）：不落库，由最新一轮对话/搜索/导入派生。 */
export interface CandidatePlace {
  poiId: string
  name: string
  category: PlaceCategory
  lat?: number | null
  lng?: number | null
  city?: string | null
  address?: string | null
  source: 'chat' | 'search' | 'nearby' | 'import' | 'saved'
  rating?: number | null
  priceLevel?: number | null
  added?: boolean
  stopId?: string | null
  dayIndex?: number | null
}

export interface PlaceSource {
  provider: 'amap' | 'dianping' | 'official' | 'ugc'
  url?: string | null
  fetchedAt?: string | null
}

export interface PlaceActivity {
  title: string
  type: string
  start?: string | null
  end?: string | null
  note?: string | null
  tips: string[]
}

export interface PlaceTransfer {
  fromStopId: string
  toStopId: string
  fromName?: string | null
  toName?: string | null
  mode: string
  distanceM?: number | null
  durationMin?: number | null
  source?: string | null
}

export interface PlaceReview {
  author?: string | null
  text: string
  score?: number | null
}

/** 地点浮卡 / Sheet / 详情模板（§2.3 + P2 模板扩展）。 */
export interface PlaceDetail {
  poiId: string
  name: string
  category: PlaceCategory
  city?: string | null
  address?: string | null
  lat?: number | null
  lng?: number | null
  rating?: number | null
  reviewCount?: number | null
  priceLevel?: number | null
  priceText?: string | null
  photos: string[]
  summary?: string | null
  source?: PlaceSource | null
  openNow?: boolean | null
  businessTime?: string | null
  reservationRequired?: boolean | null
  facilities?: string[]
  reviews?: PlaceReview[]
  stopId?: string | null
  dayIndex?: number | null
  inTrip?: boolean
  /** 高德 POI 名（可能与行程展示名不同） */
  sourceName?: string | null
  /** 行程事实（不估算）：游玩时长 / 预约 / 门票 / 活动 / 相邻转场 */
  visitDurationMin?: number | null
  ticketUnitText?: string | null
  ticketTotalText?: string | null
  activities?: PlaceActivity[]
  transferFrom?: PlaceTransfer | null
  transferTo?: PlaceTransfer | null
  /** 坐标是否经过高德 POI 校正 */
  coordinateVerified?: boolean | null
  missing?: string[]
  fetchedAt?: string | null
}

/** 相邻 stop 之间的一段路程（§5）。无数据时 distanceM/durationMin 为空 → 「距离待算」。 */
export interface RouteLeg {
  legId: string
  tripId?: string | null
  dayIndex?: number | null
  fromStopId: string
  toStopId: string
  fromName?: string | null
  toName?: string | null
  mode: 'walk' | 'drive' | 'bike' | 'transit' | 'train' | 'flight' | 'ferry'
  distanceM?: number | null
  durationMin?: number | null
  polyline?: [number, number][] | null
  source?: 'amap' | 'estimate' | null
  fetchedAt?: string | null
  disclaimer?: boolean
}

export interface HighlightState {
  turnId: string | null
  poiIds: string[]
  focusedIndex: number
  autoFit: boolean
}

export interface MapLayers {
  trip: boolean
  nearby: boolean
  saved: boolean
}

export interface SavedPlace {
  poiId: string
  name: string
  category?: PlaceCategory | null
  lat?: number | null
  lng?: number | null
  city?: string | null
  address?: string | null
  note?: string | null
  createdAt?: string | null
}

export interface ImportItem {
  poiId?: string | null
  name: string
  category?: PlaceCategory
  city?: string | null
  address?: string | null
  lat?: number | null
  lng?: number | null
  located: boolean
  duplicate: boolean
  inTripDay?: number | null
  amapPoiId?: string | null
}

export interface ImportResult {
  jobId: string
  kind: 'link' | 'text' | 'images'
  sourceUrl?: string | null
  title?: string | null
  items: ImportItem[]
  failures: string[]
  message?: string | null
  fetchedAt?: string | null
}

export interface ThreadComment {
  commentId: string
  threadId: string
  author: 'me' | 'companion' | 'assistant'
  body: string
  mentionsAssistant: boolean
  createdAt?: string | null
}

export interface Thread {
  threadId: string
  tripId: string
  title: string
  createdAt?: string | null
  comments: ThreadComment[]
}

export interface PlaceSearchResult {
  items: CandidatePlace[]
  available: boolean
  message?: string | null
  source?: string | null
}
