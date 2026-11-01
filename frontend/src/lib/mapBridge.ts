/**
 * 地图桥（mindtrip/06 §3.4）：组件不直接拿 MapController，用 window 事件解耦。
 *
 * MapPane 监听这些事件并调用当前适配器；三个适配器共享同一份契约。
 */
export interface FocusPlaceDetail {
  poiId: string
  zoom?: number
}

export interface LegFocusDetail {
  fromStopId: string
  toStopId: string
}

const FOCUS_EVENT = 'tp:focus-place'
const LEG_EVENT = 'tp:highlight-leg'
const LEG_CLEAR_EVENT = 'tp:clear-leg-highlight'
const FIT_EVENT = 'tp:fit-view'

export function focusPlaceOnMap(poiId: string, zoom = 14) {
  window.dispatchEvent(new CustomEvent<FocusPlaceDetail>(FOCUS_EVENT, { detail: { poiId, zoom } }))
}

export function onFocusPlace(handler: (detail: FocusPlaceDetail) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<FocusPlaceDetail>).detail)
  window.addEventListener(FOCUS_EVENT, listener)
  return () => window.removeEventListener(FOCUS_EVENT, listener)
}

export function highlightLegOnMap(fromStopId: string, toStopId: string) {
  window.dispatchEvent(new CustomEvent<LegFocusDetail>(LEG_EVENT, { detail: { fromStopId, toStopId } }))
}

export function onHighlightLeg(handler: (detail: LegFocusDetail) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<LegFocusDetail>).detail)
  window.addEventListener(LEG_EVENT, listener)
  return () => window.removeEventListener(LEG_EVENT, listener)
}

export function clearLegHighlightOnMap() {
  window.dispatchEvent(new CustomEvent(LEG_CLEAR_EVENT))
}

export function onClearLegHighlight(handler: () => void): () => void {
  const listener = () => handler()
  window.addEventListener(LEG_CLEAR_EVENT, listener)
  return () => window.removeEventListener(LEG_CLEAR_EVENT, listener)
}

export function fitMapView() {
  window.dispatchEvent(new CustomEvent(FIT_EVENT))
}

export function onFitMapView(handler: () => void): () => void {
  const listener = () => handler()
  window.addEventListener(FIT_EVENT, listener)
  return () => window.removeEventListener(FIT_EVENT, listener)
}
