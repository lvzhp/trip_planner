import { useEffect, useRef, useState } from 'react'
import type { PlaceSegment } from '../types'
import { usePlaceActions } from '../lib/placeActions'
import { placeIcon } from '../lib/placeMeta'
import { Icon } from '../lib/icons'
import { useUiStore } from '../stores/uiStore'
import { usePlaceStore } from '../stores/placeStore'
import { useTripStore } from '../stores/tripStore'
import { toast } from '../lib/toast'
import { openAmap } from '../lib/nav'
import { highlightLegOnMap } from '../lib/mapBridge'

/**
 * 行内地点 chip（mindtrip/06 §1）：图标 + 地点名 + 状态徽标。
 *
 * - 默认透明，hover 浅底 `--surface-2`，不做胶囊底色；
 * - `✓` 蓝勾 = 已在行程（点击打开浮卡，不删除）；
 * - `＋` 蓝色加号 = 候选，可加入当前天；
 * - `!` 灰色 = 未定位/无坐标（点击打开「确认位置」）；
 * - hover 300ms 出浮卡；click 地图 flyTo + 选中 marker + 打开浮卡；
 * - 移动端去掉 hover，触摸 550ms 长按出「加入第 N 天 / 收藏 / 导航」。
 */
export function PlaceChip({ segment }: { segment: PlaceSegment }) {
  const { openPlaceAt, addSegment, defaultDay } = usePlaceActions()
  const pending = useUiStore(s => s.pendingAddPoiIds.includes(segment.poiId))
  const openPlace = useUiStore(s => s.openPlace)
  const closePlace = useUiStore(s => s.closePlace)
  const setHoverStopId = useUiStore(s => s.setHoverStopId)
  const trip = useTripStore(s => s.trip)
  const readonly = useTripStore(s => s.readonly)
  const saved = usePlaceStore(s => s.isSaved(segment.poiId))
  const toggleSaved = usePlaceStore(s => s.toggle)
  const [menuOpen, setMenuOpen] = useState(false)
  const hoverTimer = useRef<number>()
  const longPressTimer = useRef<number>()
  const moved = useRef(false)

  const state = segment.missing ? 'missing' : segment.added ? 'added' : segment.hasCoords ? 'candidate' : 'unlocated'
  const label = state === 'missing' ? '该地点已不在行程' : segment.fullName || segment.name
  const title = [label, segment.city].filter(Boolean).join(' · ')

  useEffect(() => () => {
    window.clearTimeout(hoverTimer.current)
    window.clearTimeout(longPressTimer.current)
  }, [])

  const clearHover = () => {
    window.clearTimeout(hoverTimer.current)
    setHoverStopId(null)
  }

  const open = (el: HTMLElement | null) => {
    clearHover()
    if (state === 'missing') {
      toast('该地点已不在行程，可重新搜索加入', 'info')
    }
    openPlaceAt(segment, el)
  }

  const onMainClick = (el: HTMLElement) => {
    if (moved.current) {
      moved.current = false
      return
    }
    setMenuOpen(false)
    open(el)
  }

  const onBadge = async (el: HTMLElement) => {
    if (state === 'candidate') {
      await addSegment(segment)
      return
    }
    open(el)
  }

  const startLongPress = () => {
    window.clearTimeout(longPressTimer.current)
    longPressTimer.current = window.setTimeout(() => {
      moved.current = false
      setMenuOpen(true)
    }, 550)
  }

  const cancelLongPress = () => window.clearTimeout(longPressTimer.current)

  const dayOptions = (trip?.days || []).slice(0, 6)

  const addToDay = async (dayIndex: number) => {
    setMenuOpen(false)
    if (segment.added) {
      toast(`已在行程里了`, 'info')
      return
    }
    await addSegment(segment, dayIndex)
  }

  return (
    <span className={`place-chip state-${state}${segment.missing ? ' is-missing' : ''}`} data-poi-id={segment.poiId}>
      <button
        type="button"
        className="pc-main"
        aria-pressed={segment.added}
        aria-label={`${segment.name}${segment.city ? ` · ${segment.city}` : ''}`}
        title={title}
        onClick={event => onMainClick(event.currentTarget)}
        onMouseEnter={event => {
          if (window.matchMedia('(hover: none)').matches) return
          setHoverStopId(segment.poiId)
          const target = event.currentTarget
          window.clearTimeout(hoverTimer.current)
          hoverTimer.current = window.setTimeout(() => open(target), 300)
        }}
        onMouseLeave={clearHover}
        onFocus={clearHover}
        onTouchStart={() => {
          moved.current = false
          startLongPress()
        }}
        onTouchEnd={cancelLongPress}
        onTouchMove={() => {
          moved.current = true
          cancelLongPress()
        }}
        onContextMenu={event => {
          event.preventDefault()
          setMenuOpen(true)
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            open(event.currentTarget)
          }
        }}
      >
        <span className="pc-ic" aria-hidden="true">{placeIcon(segment.category)}</span>
        <span className="pc-name">{segment.name}</span>
      </button>
      <button
        type="button"
        className="pc-badge"
        aria-label={
          pending ? '正在加入' : state === 'candidate' ? '加入行程' : state === 'unlocated' ? '确认位置' : '已在行程'
        }
        aria-pressed={segment.added}
        disabled={pending || readonly}
        onClick={event => {
          event.stopPropagation()
          void onBadge(event.currentTarget)
        }}
      >
        {pending ? <span className="spinner spinner-xs" /> : null}
        {!pending && state === 'added' && <Icon name="check" />}
        {!pending && state === 'candidate' && <Icon name="plus" />}
        {!pending && state === 'unlocated' && <span className="pc-bang">!</span>}
        {!pending && state === 'missing' && <Icon name="x" />}
      </button>

      {menuOpen && (
        <>
          <span className="place-chip-scrim" role="presentation" onClick={() => setMenuOpen(false)} />
          <span className="place-chip-menu" role="menu">
            <span className="pcm-head">{segment.name}</span>
            <span className="pcm-group">
              {dayOptions.map(day => (
                <button key={day.dayIndex} type="button" role="menuitem" onClick={() => void addToDay(day.dayIndex)}>
                  加入 Day {day.dayIndex}
                </button>
              ))}
            </span>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false)
                void toggleSaved({
                  poiId: segment.poiId,
                  name: segment.fullName || segment.name,
                  category: segment.category,
                  lat: segment.lat ?? null,
                  lng: segment.lng ?? null,
                  city: segment.city ?? null,
                  address: segment.address ?? null,
                })
              }}
            >
              {saved ? '取消收藏' : '收藏 · 想去'}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false)
                if (segment.lat == null || segment.lng == null) {
                  openPlace(segment.poiId, { segment, mode: 'sheet', origin: 'chip' })
                  return
                }
                openAmap({ name: segment.name, lng: segment.lng, lat: segment.lat }, trip?.constraints.transportMode)
              }}
            >
              导航
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false)
                closePlace()
                openPlace(segment.poiId, { segment, mode: 'popover', origin: 'chip' })
              }}
            >
              {segment.added ? '看浮卡' : '确认位置'}
            </button>
          </span>
        </>
      )}
    </span>
  )
}

export function RouteChip({
  fromPoiId,
  toPoiId,
  fromName,
  toName,
  mode,
  distanceM,
  durationMin,
}: {
  fromPoiId: string
  toPoiId: string
  fromName?: string
  toName?: string
  mode: string
  distanceM?: number | null
  durationMin?: number | null
}) {
  const setLegInfo = useUiStore(s => s.setLegInfo)
  const legText = [fromName, toName].filter(Boolean).join(' → ')
  const meta = mode === 'walk' ? '🚶' : mode === 'transit' ? '🚌' : mode === 'train' ? '🚆' : mode === 'flight' ? '✈' : '🚗'
  const distance = distanceM != null ? (distanceM < 1000 ? `${Math.round(distanceM)} m` : `${(distanceM / 1000).toFixed(1)} km`) : null
  const duration = durationMin != null ? (durationMin < 60 ? `${Math.round(durationMin)} 分钟` : `${Math.floor(durationMin / 60)}h${String(Math.round(durationMin % 60)).padStart(2, '0')}m`) : null
  return (
    <button
      type="button"
      className="route-chip"
      title={legText || '路程'}
      aria-label={`路程 ${legText || ''}`}
      onClick={event => {
        event.stopPropagation()
        setLegInfo({ fromStopId: fromPoiId, toStopId: toPoiId })
        highlightLegOnMap(fromPoiId, toPoiId)
      }}
    >
      {/* 只显示「交通方式 + 距离 + 时长」：两端地点由相邻 chip 已经表达，避免正文变长 */}
      <span className="rc-meta">
        {meta} {[distance, duration].filter(Boolean).join(' · ') || '距离待算'}
      </span>
    </button>
  )
}
