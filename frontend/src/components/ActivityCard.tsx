import { useState } from 'react'
import type { Activity, Conflict, Day, DayDerived, SeasonClosure, Stop, Ticket } from '../types'
import { actTypeMeta, channelMeta, conflictTypeLabel, Icon, transitMeta } from '../lib/icons'
import { dayColorVar, fmtDur, fmtMoney, shortName, timeDiff } from '../lib/format'
import { openAmap } from '../lib/nav'
import { useTripStore } from '../stores/tripStore'
import { useUiStore } from '../stores/uiStore'
import { usePlaceStore } from '../stores/placeStore'

interface Props {
  stop: Stop
  day: Day
  activity: Activity
  /** 这一段行程的起点（上一张卡片的地点；当天第一张卡取前一天的最后一个地点） */
  fromStop?: Stop | null
  /** 下一张卡片的地点：长途交通卡的「到达」在没写站名时用它兜底 */
  nextStop?: Stop | null
  /** 整趟行程的出发地（constraints.origin），当天第一张卡没有前一天时显示 */
  originLabel?: string | null
  dayDerived?: DayDerived
  stopped: boolean
  transportMode?: string | null
  onEdit: () => void
  onSelect: (activityId: string) => void
  /** 卡片内「详情」：进入该卡所属地点的详情，并把这张卡作为概览高亮上下文 */
  onOpenDetail: () => void
  /** meal 占位块的「附近吃什么」入口 → stop 详情·美食段（docs/07 动线 A） */
  onOpenFood?: () => void
  onConflictChoice: (conflict: Conflict, optionLabel: string) => void
  onOpenConflicts: () => void
  readonly: boolean
}

/** 一张卡片的路由行：明确写「出发 → 到达」，导航只出现在到达点。 */
function RouteLine({
  fromName,
  toName,
  depTime,
  arrTime,
  middle,
  onNavigate,
}: {
  fromName: string
  toName: string
  depTime?: string | null
  arrTime?: string | null
  middle?: React.ReactNode
  onNavigate?: (() => void) | null
}) {
  return (
    <div className="act-route">
      <div className="ar-end ar-from">
        <span className="ar-role">出发</span>
        <span className="ar-name" title={fromName}>
          {fromName}
        </span>
        {depTime ? <span className="ar-time">{depTime}</span> : null}
      </div>
      <div className="ar-mid" aria-hidden={!middle}>
        {middle || <span className="ar-hop">衔接</span>}
      </div>
      <div className="ar-end ar-to">
        <span className="ar-role">到达</span>
        <span className="ar-name" title={toName}>
          {toName}
        </span>
        {arrTime ? <span className="ar-time">{arrTime}</span> : null}
        {onNavigate ? (
          <button
            className="btn btn-sm ar-nav"
            type="button"
            aria-label={`导航到${toName}`}
            onClick={e => {
              e.stopPropagation()
              onNavigate()
            }}
          >
            <Icon name="arrowUpRight" /> 导航
          </button>
        ) : null}
      </div>
    </div>
  )
}

function hopLabel(stopId: string | null | undefined, currentStopId: string): string {
  if (!stopId) return '衔接'
  return stopId === currentStopId ? '原地' : '前往'
}

export function ActivityCard({
  stop,
  day,
  activity,
  fromStop,
  nextStop,
  originLabel,
  stopped,
  transportMode,
  onEdit,
  onSelect,
  onOpenDetail,
  onOpenFood,
  onConflictChoice,
  onOpenConflicts,
  readonly,
}: Props) {
  const diffTags = useTripStore(s => s.diffTags)
  const derived = useTripStore(s => s.derived)
  const routeLegs = useTripStore(s => s.routeLegs)
  const selectedActivityId = useUiStore(s => s.selectedActivityId)
  const conflicts = (derived?.conflicts || []).filter(c => c.activityId === activity.activityId)
  const diffTag = diffTags[stop.stopId]
  const meta = actTypeMeta[activity.type] || actTypeMeta.visit
  const tw = `${activity.timeWindow.start} – ${activity.timeWindow.end}`
  const cardClass = `act-card${activity.type === 'stay' ? ' stay-card' : ''}${activity.type === 'long_transit' ? ' transit-card' : ''}${
    activity.type === 'free' ? ' free-card' : ''
  }${selectedActivityId === activity.activityId ? ' selected' : ''}${diffTag ? ' diff-changed' : ''}${
    stopped ? ' pending-update' : ''
  }`

  const select = () => onSelect(activity.activityId)
  // 每张卡自己就是地点：day color 用于地点行的左侧色条（与地图 marker 同色）
  const cardStyle = { ['--day-color' as string]: dayColorVar(day.dayIndex) } as React.CSSProperties
  const placeRow = <PlaceRow stop={stop} onOpenDetail={onOpenDetail} />
  const cardLabel = `${activity.title}，地点 ${shortName(stop.poi.name)}`

  if (activity.type === 'long_transit' && activity.transitDetail) {
    const td = activity.transitDetail as any
    let mid: React.ReactNode = null
    let extras: React.ReactNode = null
    let fromTo: [string, string] | null = null
    if (td.mode === 'flight') {
      mid = (
        <div className="tr-mid">
          <span className="tr-dur">{fmtDur(timeDiff(td.depTime, td.arrTime))}</span>
          <span className="tr-line">
            <Icon name="flight" />
          </span>
          <span className="transit-no">
            {td.flightNo} · {td.airline}
          </span>
        </div>
      )
      fromTo = [
        td.airportFrom || stop.poi.name,
        td.airportTo || nextStop?.poi.name || '到达',
      ]
      extras = (
        <div className="tx-row">
          <Icon name="pin" /> {td.airportFrom} → {td.airportTo}
        </div>
      )
    } else if (td.mode === 'train') {
      mid = (
        <div className="tr-mid">
          <span className="tr-dur">{fmtDur(timeDiff(td.depTime, td.arrTime))}</span>
          <span className="tr-line">
            <Icon name="train" />
          </span>
          <span className="transit-no">
            {td.trainNo} · {td.seatClass || ''}
          </span>
        </div>
      )
      fromTo = [
        td.stationFrom || stop.poi.name,
        td.stationTo || nextStop?.poi.name || '到达',
      ]
      extras = (
        <div className="tx-row">
          <Icon name="pin" /> {td.stationFrom} → {td.stationTo}
        </div>
      )
    } else {
      mid = (
        <div className="tr-mid">
          <span className="tr-dur">{fmtDur(td.driveMinutes)}</span>
          <span className="tr-line" style={{ ['--line-flight' as string]: 'var(--line-drive)' } as React.CSSProperties}>
            <Icon name="car" />
          </span>
          <span className="transit-no" style={{ color: 'var(--line-drive)' }}>
            {td.distanceKm} 公里
          </span>
        </div>
      )
      extras = (
        <>
          <div className="tx-row">
            <Icon name="route" /> {(td.roadRefs || []).join(' / ')}
            {td.roadCondition ? ` · ${td.roadCondition}` : ''}
          </div>
          {td.waypointsPoi?.length > 0 && (
            <div className="tx-row">
              <Icon name="pin" /> 途经：{td.waypointsPoi.map((w: any) => w.name).join('、')}
            </div>
          )}
          {td.fuelStops?.length > 0 && (
            <div className="tx-row">
              <Icon name="fuel" /> 加油：{td.fuelStops.map((w: any) => w.name).join('、')}
            </div>
          )}
          {td.permitRequired && (
            <div className="tx-row">
              <Icon name="lock" /> 需通行证：{td.permitNote || ''}
            </div>
          )}
        </>
      )
    }
    const dep = td.depTime || activity.timeWindow.start
    const arr = td.arrTime || activity.timeWindow.end
    return (
      <div
        className={cardClass}
        style={cardStyle}
        data-stop-id={stop.stopId}
        data-activity-id={activity.activityId}
        tabIndex={0}
        role="button"
        aria-label={cardLabel}
        onClick={select}
        onKeyDown={e => e.key === 'Enter' && select()}
      >
        {diffTag && <span className="diff-corner pulsing">{diffTag}</span>}
        <div className="act-card-top">
          <span className="act-time">{tw}</span>
          <span className="act-type act-type-long_transit">
            <Icon name={td.mode === 'flight' ? 'flight' : td.mode === 'train' ? 'train' : 'car'} /> 长途 ·{' '}
            {td.mode === 'flight' ? '航班' : td.mode === 'train' ? '火车' : '自驾'}
          </span>
          {!readonly && <EditButton onClick={e => { e.stopPropagation(); onEdit() }} />}
        </div>
        <div className="act-title">{activity.title}</div>
        <RouteLine
          fromName={fromTo ? fromTo[0] : stop.poi.name}
          toName={fromTo ? fromTo[1] : nextStop?.poi.name || '到达'}
          depTime={dep}
          arrTime={arr}
          middle={mid}
          onNavigate={
            // 导航只指向「到达点」：只有到达站/机场没写名字、且有下一站坐标时才可导航
            td.stationTo || td.airportTo || !nextStop || nextStop.poi.lng == null
              ? null
              : () => openAmap(nextStop.poi, transportMode)
          }
        />
        <div className="transit-extras">{extras}</div>
        {placeRow}
        {td.seasonClosure && <SeasonClosureAlert sc={td.seasonClosure} onOpenConflicts={onOpenConflicts} />}
        {activity.ticket && activity.ticket.kind !== 'none' && <TicketMini ticket={activity.ticket} />}
        {conflicts.map(c => (
          <CardConflict key={c.id || c.message} conflict={c} onChoice={onConflictChoice} />
        ))}
      </div>
    )
  }

  if (activity.type === 'free') {
    return (
      <div
        className={cardClass}
        style={cardStyle}
        data-stop-id={stop.stopId}
        data-activity-id={activity.activityId}
        tabIndex={0}
        role="button"
        aria-label={cardLabel}
        onClick={select}
        onKeyDown={e => e.key === 'Enter' && select()}
      >
        {diffTag && <span className="diff-corner pulsing">{diffTag}</span>}
        <div className="act-card-top">
          <span className="act-time">{tw}</span>
          <span className="act-type act-type-free">
            <Icon name="free" /> 自由活动
          </span>
          {!readonly && <EditButton onClick={e => { e.stopPropagation(); onEdit() }} />}
        </div>
        <div className="act-title">{activity.title}</div>
        <RouteLine
          fromName={fromStop?.poi.name || originLabel || '行程起点'}
          toName={stop.poi.name}
          middle={<span className="ar-hop">{hopLabel(fromStop?.stopId, stop.stopId)}</span>}
          onNavigate={stop.poi.lng == null && !stop.poi.amapPoiId ? null : () => openAmap(stop.poi, transportMode)}
        />
        <div className="free-hint">
          <Icon name="sparkle" /> 这段时间自己安排 —— 也可以让我补排
        </div>
        {placeRow}
        {conflicts.map(c => (
          <CardConflict key={c.id || c.message} conflict={c} onChoice={onConflictChoice} />
        ))}
      </div>
    )
  }

  // 相邻 stop 的转场优先用高德 route_legs；行程文档里的旧值只标「行程」，不冒充真实距离
  const stopPosition = day.stops.findIndex(item => item.stopId === stop.stopId)
  const previousStop = stopPosition > 0 ? day.stops[stopPosition - 1] : null
  const isFirstActivity = stop.activities[0]?.activityId === activity.activityId
  const routeLeg = previousStop
    ? routeLegs.find(item => item.fromStopId === previousStop.stopId && item.toStopId === stop.stopId)
    : undefined
  const routeLegAmap = routeLeg?.source === 'amap'
  let transit: React.ReactNode = null
  if (isFirstActivity && previousStop) {
    const meta = transitMeta[routeLeg?.mode || 'drive'] || transitMeta.drive
    const distanceKm = routeLeg?.distanceM != null ? routeLeg.distanceM / 1000 : null
    transit = (
      <div className="act-transit">
        <Icon name={meta.icon} />
        {routeLegAmap ? (
          <span>
            从上一站 {meta.label} <span className="num">{routeLeg?.durationMin ?? '—'}</span> 分钟
            {distanceKm != null ? (
              <>
                {' '}· <span className="num">{distanceKm >= 100 ? Math.round(distanceKm) : distanceKm.toFixed(1)}</span> km
              </>
            ) : null}
            <em className="act-src amap">高德</em>
          </span>
        ) : (
          <span>
            从上一站 · <em className="act-src">高德待算</em>
          </span>
        )}
      </div>
    )
  } else if (activity.transitFromPrev) {
    transit = (
      <div className="act-transit">
        <Icon name={transitMeta[activity.transitFromPrev.mode]?.icon || 'car'} />
        <span>
          从上一站 {transitMeta[activity.transitFromPrev.mode]?.label || ''} <span className="num">{activity.transitFromPrev.minutes}</span> 分钟
          {activity.transitFromPrev.distanceKm ? (
            <>
              {' '}· <span className="num">{activity.transitFromPrev.distanceKm}</span> km
            </>
          ) : null}
          <em className="act-src">行程</em>
        </span>
      </div>
    )
  }

  return (
    <div
      className={cardClass}
      style={cardStyle}
      data-stop-id={stop.stopId}
      data-activity-id={activity.activityId}
      tabIndex={0}
      role="button"
      aria-label={cardLabel}
      onClick={select}
      onKeyDown={e => e.key === 'Enter' && select()}
    >
      {diffTag && <span className="diff-corner pulsing">{diffTag}</span>}
      <div className="act-card-top">
        <span className="act-time">{tw}</span>
        <span className={`act-type act-type-${activity.type}`}>
          <Icon name={meta.icon} /> {meta.label}
        </span>
        {!readonly && <EditButton onClick={e => { e.stopPropagation(); onEdit() }} />}
      </div>
      <div className="act-title">{activity.title}</div>
      <RouteLine
        fromName={fromStop?.poi.name || originLabel || '行程起点'}
        toName={stop.poi.name}
        middle={transit || <span className="ar-hop">{hopLabel(fromStop?.stopId, stop.stopId)}</span>}
        onNavigate={stop.poi.lng == null && !stop.poi.amapPoiId ? null : () => openAmap(stop.poi, transportMode)}
      />
      {placeRow}
      {activity.ticket && activity.ticket.kind !== 'none' && <TicketMini ticket={activity.ticket} />}
      {activity.type === 'meal' && onOpenFood && (
        <button className="act-meal-entry" type="button" onClick={e => { e.stopPropagation(); onOpenFood() }}>
          <Icon name="utensils" /> 附近吃什么 · 看当地推荐
        </button>
      )}
      {activity.tips?.[0] && (
        <div className="act-meta-row">
          <Icon name="info" /> <span>{activity.tips[0]}</span>
        </div>
      )}
      {conflicts.map(c => (
        <CardConflict key={c.id || c.message} conflict={c} onChoice={onConflictChoice} />
      ))}
    </div>
  )
}

/**
 * 卡片内的地点行：位置属于 stop，但入口在每一张卡上（docs/07 §3）。
 * 整张卡点击只做地图定位；这里只放「导航 / 详情」两个明确动作。
 */
function PlaceRow({
  stop,
  onOpenDetail,
}: {
  stop: Stop
  onOpenDetail: () => void
}) {
  const name = shortName(stop.poi.name)
  const poiId = stop.poi.amapPoiId || stop.stopId
  const saved = usePlaceStore(state => state.isSaved(poiId))
  const toggleSaved = usePlaceStore(state => state.toggle)
  return (
    <div className="act-place">
      <span className="ap-pin" aria-hidden="true">
        <Icon name="pin" />
      </span>
      <span className="ap-main">
        <span className="ap-name" title={stop.poi.name}>{name}</span>
        {stop.poi.address ? <span className="ap-addr" title={stop.poi.address}>{stop.poi.address}</span> : null}
      </span>
      <span className="ap-actions">
        <button
          className={`ap-heart${saved ? ' saved' : ''}`}
          type="button"
          aria-label={saved ? `取消收藏${name}` : `收藏${name}`}
          aria-pressed={saved}
          title={saved ? '取消收藏' : '收藏 · 想去'}
          onClick={e => {
            e.stopPropagation()
            void toggleSaved({
              poiId,
              name: stop.poi.name,
              category: 'place',
              lat: stop.poi.lat ?? null,
              lng: stop.poi.lng ?? null,
              city: stop.poi.city ?? null,
              address: stop.poi.address ?? null,
            })
          }}
        >
          {saved ? '♥' : '♡'}
        </button>
        <button
          className="ap-detail"
          type="button"
          aria-label={`查看${name}详情`}
          onClick={e => {
            e.stopPropagation()
            onOpenDetail()
          }}
        >
          详情 <Icon name="chevronRight" />
        </button>
      </span>
    </div>
  )
}

function EditButton({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  return (
    <button className="act-edit-btn" type="button" onClick={onClick} aria-label="改这里">
      <Icon name="edit" /> 改这里
    </button>
  )
}

function TicketMini({ ticket }: { ticket: Ticket }) {
  const price = fmtMoney(ticket.priceRange)
  // 官方核实过的渠道优先展示；只有游记线索的渠道要显式降级标注（01 §5.2）
  const verified = ticket.channels.find(c => c.status === 'verified')
  const channel = verified || ticket.channels[0]
  const lead = ticket.leadTimeDays ? `需提前 ${ticket.leadTimeDays} 天` : ''
  const real = ticket.realNameRequired ? '实名制' : ''
  const empty = !ticket.priceRange && ticket.channels.length === 0
  return (
    <div className="act-meta-row ticket">
      <Icon name="ticket" />
      <span>
        <span className="val">{empty ? '票务信息待核实' : price}</span>
        {lead || real ? ` · ${[lead, real].filter(Boolean).join(' · ')}` : ''}
        {channel && (
          <>
            <br />
            <span className="channel-hint">
              首选 {channelMeta[channel.type]?.label}
              <span className="wechat-name">「{channel.detail || channel.name}」</span>
              {channel.status === 'verified' ? (
                <span className="chip chip-primary channel-status">官方核实</span>
              ) : channel.status === 'clue' ? (
                <span className="chip chip-warning channel-status">来自游记，未经官方核实</span>
              ) : null}
            </span>
          </>
        )}
      </span>
    </div>
  )
}

function SeasonClosureAlert({ sc, onOpenConflicts }: { sc: SeasonClosure; onOpenConflicts: () => void }) {
  if (!sc) return null
  return (
    <div className="season-closure-alert">
      <Icon name="warn" />
      <span>
        <strong>季节性封路：</strong>
        {sc.note || `该路段开放时间 ${sc.openFrom || '?'} – ${sc.openTo || '?'}，当前日期无法通行`}
        <br />
        <button className="btn btn-sm" type="button" style={{ marginTop: 6 }} onClick={e => { e.stopPropagation(); onOpenConflicts() }}>
          查看处理方案
        </button>
      </span>
    </div>
  )
}

function CardConflict({ conflict, onChoice }: { conflict: Conflict; onChoice: (conflict: Conflict, label: string) => void }) {
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState<string | null>(null)
  return (
    <>
      <div
        className={`act-conflict severity-${conflict.severity}${open ? ' open' : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={e => {
          e.stopPropagation()
          setOpen(v => !v)
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.stopPropagation()
            setOpen(v => !v)
          }
        }}
      >
        <Icon name={conflict.severity === 'error' ? 'xCircle' : 'warn'} />{' '}
        <span>{conflict.message.length > 34 ? conflict.message.slice(0, 34) + '…' : conflict.message}（点击查看详情）</span>
        <Icon name="caretRight" className="expand-caret" />
      </div>
      <div className={`conflict-detail${open ? ' open' : ''}`} onClick={e => e.stopPropagation()}>
        <div className="fix-title">
          <Icon name="sparkle" /> 建议修法
        </div>
        {conflict.suggestedFix || '暂无自动修复建议，可在对话中告诉我怎么处理。'}
        {conflict.askUser && (
          <div className="ci-ask" style={{ marginTop: 8, borderTop: '1px dashed var(--border)', paddingTop: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>{conflict.askUser.questions[0]?.question}</div>
            <div className="ask-options">
              {conflict.askUser.questions[0]?.options.map(o => (
                <button
                  key={o.id}
                  className={`ask-opt btn-sm${chosen === o.id ? ' selected' : ''}`}
                  type="button"
                  disabled={!!chosen}
                  onClick={e => {
                    e.stopPropagation()
                    setChosen(o.id)
                    onChoice(conflict, o.label)
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  )
}
