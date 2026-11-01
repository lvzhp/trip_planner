import { useMemo } from 'react'
import { useTripStore } from '../stores/tripStore'
import { useUiStore } from '../stores/uiStore'
import { Icon } from '../lib/icons'
import { fmtDistance, fmtDuration, fmtFetchedAt, legLine, modeMeta } from '../lib/placeMeta'
import { clearLegHighlightOnMap, highlightLegOnMap } from '../lib/mapBridge'

/**
 * 距离行（mindtrip/06 §5）：卡片之间插入一行。
 * - 有数据：`🚶 1.2 km · 18 分钟`；没数据：「距离待算」（绝不用直线距离假装）
 * - 重排/加地点后先显示「计算中」；失败保留旧值并标「待更新」
 * - 点一行：地图高亮该段 + 弹出小条（LegInfoBar）
 */
export function DistanceRow({
  fromStopId,
  toStopId,
  dayIndex,
}: {
  fromStopId: string
  toStopId: string
  dayIndex?: number
}) {
  const showDistances = useUiStore(s => s.showDistances)
  const setLegInfo = useUiStore(s => s.setLegInfo)
  const legInfo = useUiStore(s => s.legInfo)
  const routeLegs = useTripStore(s => s.routeLegs)
  const legsPending = useTripStore(s => s.legsPending)
  const legsStale = useTripStore(s => s.legsStale)

  const leg = useMemo(
    () => routeLegs.find(item => item.fromStopId === fromStopId && item.toStopId === toStopId),
    [routeLegs, fromStopId, toStopId],
  )
  const pending =
    !!legsPending &&
    ((legsPending.fromStopId === fromStopId && legsPending.toStopId === toStopId) ||
      legsPending.fromStopId === fromStopId ||
      legsPending.toStopId === toStopId)
  const stale = !!leg && legsStale.includes(leg.legId)
  const active = legInfo?.fromStopId === fromStopId && legInfo?.toStopId === toStopId
  const isRoad = !!leg && ['drive', 'walk', 'bike', 'transit'].includes(leg.mode)
  const amapBacked = leg?.source === 'amap'
  // 用户要求：不用行程里的旧估算冒充真实距离；道路段没有高德数据就显示「高德待算」
  const canShow = !!leg && (!isRoad || amapBacked)
  const text = pending
    ? '计算中…'
    : canShow && leg
      ? legLine(leg)
      : isRoad
        ? '高德待算'
        : leg
          ? legLine(leg)
          : '距离待算'

  if (!showDistances) return null

  return (
    <div className={`distance-row${active ? ' active' : ''}`} data-day={dayIndex ?? undefined}>
      <span className="dr-rail" aria-hidden="true" />
      <button
        type="button"
        className="dr-main"
        aria-label={`${leg?.fromName || '上一站'} 到 ${leg?.toName || '下一站'} 的路程`}
        onClick={() => {
          if (active) {
            setLegInfo(null)
            clearLegHighlightOnMap()
            return
          }
          setLegInfo({ fromStopId, toStopId })
          highlightLegOnMap(fromStopId, toStopId)
        }}
      >
        <span className="dr-icon" aria-hidden="true">
          {pending ? <span className="spinner spinner-xs" /> : <Icon name="route" />}
        </span>
        <span className="dr-text">{text}</span>
        {stale && <span className="dr-stale">待更新</span>}
        {!pending && leg && !amapBacked && isRoad && <span className="dr-src">高德待算</span>}
        {!pending && leg && !amapBacked && !isRoad && <span className="dr-src">行程数据</span>}
      </button>
    </div>
  )
}

/** 点距离行后的小条：`步行 · 1.2km · 18 分钟 · 高德路径 · 抓取于… · 仅供参考`。 */
export function LegInfoBar() {
  const legInfo = useUiStore(s => s.legInfo)
  const setLegInfo = useUiStore(s => s.setLegInfo)
  const routeLegs = useTripStore(s => s.routeLegs)
  if (!legInfo) return null
  const leg = routeLegs.find(
    item => item.fromStopId === legInfo.fromStopId && item.toStopId === legInfo.toStopId,
  )
  const sourceLabel = leg?.source === 'amap' ? '高德规划' : '尚未走高德规划'
  const close = () => {
    setLegInfo(null)
    clearLegHighlightOnMap()
  }
  return (
    <div className="leg-info-bar" role="status">
      <span className="lib-icon">{modeMeta(leg?.mode).icon}</span>
      <div className="lib-main">
        <strong>
          {leg?.fromName || '上一站'} → {leg?.toName || '下一站'}
        </strong>
        <span className="lib-meta">
          {[
            modeMeta(leg?.mode).label,
            leg?.source === 'amap' ? fmtDistance(leg?.distanceM) : '高德待算',
            leg?.source === 'amap' ? fmtDuration(leg?.durationMin) : null,
            sourceLabel,
            leg?.source === 'amap' && leg?.fetchedAt ? `抓取于 ${fmtFetchedAt(leg.fetchedAt)}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <span className="lib-note">路线与距离由高德规划，仅供参考；实际以导航为准。</span>
      </div>
      <button className="icon-btn" type="button" aria-label="关闭路段信息" onClick={close}>
        <Icon name="x" />
      </button>
    </div>
  )
}
