import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import { useTripStore } from '../stores/tripStore'
import { useUiStore } from '../stores/uiStore'
import { usePlaceStore } from '../stores/placeStore'
import { Icon } from '../lib/icons'
import { toast } from '../lib/toast'
import { focusPlaceOnMap, fitMapView } from '../lib/mapBridge'
import { ConstraintsChips } from './ConstraintsChips'
import type { MapLayers } from '../types'

const CATEGORY_RING: { kind: string; label: string; icon: string }[] = [
  { kind: 'eat', label: '吃', icon: '🍴' },
  { kind: 'stay', label: '住', icon: '🛏' },
  { kind: 'play', label: '玩', icon: '📷' },
  { kind: 'transport', label: '交通', icon: '🚉' },
  { kind: 'shopping', label: '购物', icon: '🛍' },
]

/**
 * 地图工具栏（mindtrip/06 §4.5）：
 * 图层开关、本轮高亮胶囊、行程计数、Distances 开关、Day 过滤、参数 chips、加地点。
 */
export function MapToolbar({ viewCenter }: { viewCenter: () => { lng: number; lat: number } | null }) {
  const trip = useTripStore(s => s.trip)
  const layers = useUiStore(s => s.layers)
  const toggleLayer = useUiStore(s => s.toggleLayer)
  const showDistances = useUiStore(s => s.showDistances)
  const setShowDistances = useUiStore(s => s.setShowDistances)
  const highlight = useUiStore(s => s.highlight)
  const clearHighlight = useUiStore(s => s.clearHighlight)
  const mapDay = useUiStore(s => s.mapDay)
  const setMapDay = useUiStore(s => s.setMapDay)
  const setActiveDay = useUiStore(s => s.setActiveDay)
  const openItinerary = useUiStore(s => s.openItinerary)
  const importOpen = useUiStore(s => s.openImport)
  const openThreads = useUiStore(s => s.openThreads)
  const appendCandidates = useUiStore(s => s.appendCandidates)
  const keepPrevious = useUiStore(s => s.keepPreviousCandidates)
  const setKeepPrevious = useUiStore(s => s.setKeepPreviousCandidates)
  const setPlaceReturnFocus = useUiStore(s => s.setHoverStopId)
  const saved = usePlaceStore(s => s.saved)
  const tripId = useTripStore(s => s.tripId)
  const routeLegs = useTripStore(s => s.routeLegs)
  const hasAmapRoutes = routeLegs.some(leg => leg.source === 'amap')
  const [addOpen, setAddOpen] = useState(false)
  const [nearbyBusy, setNearbyBusy] = useState<string | null>(null)
  const cycleTimer = useRef<number[]>([])

  const stops = useMemo(() => (trip?.days || []).reduce((sum, day) => sum + day.stops.length, 0), [trip?.days])
  const highlightCount = highlight.poiIds.length
  const overLimit = highlightCount > 20

  useEffect(() => () => {
    cycleTimer.current.forEach(id => window.clearTimeout(id))
  }, [])

  const cycleHighlight = (reverse: boolean) => {
    const ids = highlight.poiIds.slice(0, 20)
    if (!ids.length) return
    // 如果当前在按天过滤，先回到「全部」，否则被 flyTo 的点还处于隐藏状态
    if (mapDay !== 'all') {
      setMapDay('all')
      window.setTimeout(() => cycleThrough(ids, reverse), 160)
      return
    }
    cycleThrough(ids, reverse)
  }

  const cycleThrough = (ids: string[], reverse: boolean) => {
    cycleTimer.current.forEach(id => window.clearTimeout(id))
    cycleTimer.current = []
    ids.forEach((id, index) => {
      const target = reverse ? ids.length - 1 - index : index
      const timer = window.setTimeout(() => focusPlaceOnMap(ids[target], 15), index * 600)
      cycleTimer.current.push(timer)
    })
    const back = window.setTimeout(() => fitMapView(), ids.length * 600 + 160)
    cycleTimer.current.push(back)
  }

  const searchNearby = async (kind: string) => {
    const center = viewCenter()
    setAddOpen(false)
    if (!center) {
      toast('地图还没准备好，稍后再试', 'info')
      return
    }
    setNearbyBusy(kind)
    try {
      const result = await api.nearbyPlaces(center.lng, center.lat, kind, 3000, 20, tripId)
      if (!result.items?.length) {
        toast(result.message || '附近没找到，换个分类或扩大范围', 'info')
        return
      }
      appendCandidates(result.items)
      if (!useUiStore.getState().layers.nearby) toggleLayer('nearby')
      toast(`附近找到 ${result.items.length} 个候选点，点地图标记可加入`, 'checkCircle')
    } catch (err) {
      toast(err instanceof Error ? err.message : '附近搜索失败', 'xCircle')
    } finally {
      setNearbyBusy(null)
    }
  }

  const layerButton = (key: keyof MapLayers, label: string) => (
    <button
      key={key}
      type="button"
      className={layers[key] ? 'active' : ''}
      aria-pressed={layers[key]}
      onClick={() => {
        if (key === 'saved' && !layers.saved) void usePlaceStore.getState().load()
        toggleLayer(key)
      }}
    >
      {label}
      {key === 'saved' && saved.length > 0 && <span className="lt-count">{saved.length}</span>}
    </button>
  )

  return (
    <>
      <div className="map-toolbar">
      <div className="mt-row">
        <div className="mt-layers" role="group" aria-label="图层">
          {layerButton('trip', '行程')}
          {layerButton('nearby', '附近')}
          {layerButton('saved', '收藏')}
        </div>

        <button
          type="button"
          className="mt-count"
          onClick={openItinerary}
          title="打开行程文档（快捷键 I）"
          aria-label={`行程 ${stops} 个地点，打开行程文档`}
        >
          <Icon name="route" />
          行程 <strong key={stops} className="mt-count-num">{stops}</strong>
        </button>

        <label className="mt-keep" title="新的一轮对话是否保留上一轮的候选点（默认关闭，避免越积越多）">
          <input
            type="checkbox"
            checked={keepPrevious}
            onChange={event => setKeepPrevious(event.target.checked)}
          />
          保留上轮
        </label>

        <label className="mt-switch">
          <input
            type="checkbox"
            checked={showDistances}
            onChange={event => setShowDistances(event.target.checked)}
          />
          <span className="mt-switch-track" aria-hidden="true">
            <span />
          </span>
          <span className="mt-switch-label">Distances</span>
        </label>

        <label className="mt-day">
          <Icon name="calendar" />
          <select
            aria-label="按天过滤地图"
            value={String(mapDay)}
            onChange={event => {
              const value = event.target.value
              if (value === 'all') {
                setMapDay('all')
                return
              }
              const dayIndex = Number(value)
              setMapDay(dayIndex)
              setActiveDay(dayIndex, false)
            }}
          >
            <option value="all">全部</option>
            {(trip?.days || []).map(day => (
              <option key={day.dayIndex} value={day.dayIndex}>
                Day {day.dayIndex}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ConstraintsChips />

      <div className="mt-note">
        {hasAmapRoutes ? '路线与距离由高德规划 · 仅供参考' : '路线尚未走高德规划 · 仅供参考'}
      </div>

      {highlightCount > 0 && (
        <div className="mt-highlight" role="status">
          <button
            type="button"
            className="mth-main"
            title="逐个飞点；Shift+点击反向"
            onClick={event => cycleHighlight(event.shiftKey)}
          >
            <Icon name="sparkle" />
            本轮 {highlightCount > 20 ? '20+' : highlightCount} 个地点
            {overLimit && <em>缩放查看</em>}
          </button>
          <button type="button" className="mth-clear" aria-label="清除本轮高亮" onClick={clearHighlight}>
            <Icon name="x" />
          </button>
        </div>
      )}
      </div>

      <div className="map-fab-stack">
        <button
          type="button"
          className="map-fab"
          title="行程文档（I）"
          aria-label="打开行程文档"
          onClick={openItinerary}
        >
          <Icon name="route" />
        </button>
        <button
          type="button"
          className="map-fab"
          title="导入链接 / 截图"
          aria-label="导入链接或截图"
          onClick={() => {
            setPlaceReturnFocus(null)
            importOpen()
          }}
        >
          <Icon name="download" />
        </button>
        <button
          type="button"
          className="map-fab"
          title="评论与 @助手"
          aria-label="打开同行人评论"
          onClick={openThreads}
        >
          <Icon name="chat" />
        </button>
        <div className="map-fab-add">
          <button
            type="button"
            className={`map-fab primary${addOpen ? ' open' : ''}`}
            aria-label="在地图加地点"
            aria-expanded={addOpen}
            onClick={() => setAddOpen(value => !value)}
          >
            <Icon name={addOpen ? 'x' : 'plus'} />
          </button>
          {addOpen && (
            <>
              <span className="map-fab-scrim" role="presentation" onClick={() => setAddOpen(false)} />
              <div className="add-ring" role="menu" aria-label="选择附近分类">
                <div className="ar-title">在附近找</div>
                <div className="ar-items">
                  {CATEGORY_RING.map(item => (
                    <button
                      key={item.kind}
                      type="button"
                      role="menuitem"
                      disabled={!!nearbyBusy}
                      onClick={() => void searchNearby(item.kind)}
                    >
                      {nearbyBusy === item.kind ? <span className="spinner spinner-xs" /> : <span>{item.icon}</span>}
                      <em>{item.label}</em>
                    </button>
                  ))}
                </div>
                <div className="ar-tip">以当前地图中心搜索；没有结果会明确提示。</div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}
