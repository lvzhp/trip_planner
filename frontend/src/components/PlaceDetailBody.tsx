import { useMemo, useState } from 'react'
import type { PlaceDetail, PlaceSegment } from '../types'
import { Icon } from '../lib/icons'
import {
  fmtDistance,
  fmtDuration,
  fmtFetchedAt,
  fmtRating,
  modeMeta,
  placeCategoryLabel,
  placeIcon,
  sourceAgeDays,
} from '../lib/placeMeta'

function formatDurationMin(minutes?: number | null): string {
  if (minutes == null || Number.isNaN(minutes) || minutes <= 0) return '暂无'
  const mins = Math.round(minutes)
  if (mins < 60) return `${mins} 分钟`
  const hours = Math.floor(mins / 60)
  const rest = mins % 60
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`
}

export interface DayOption {
  dayIndex: number
  label: string
}

export interface PlaceDetailBodyProps {
  detail: PlaceDetail | null
  loading: boolean
  error: string | null
  segment?: PlaceSegment | null
  readonly: boolean
  activeDay: number
  dayOptions: DayOption[]
  saved: boolean
  feedback: 'up' | 'down' | null
  onAdd: (dayIndex: number) => void
  onRemove: () => void
  onNavigate: () => void
  onOpenFull: () => void
  onRetry: () => void
  onToggleSave: () => void
  onFeedback: (vote: 'up' | 'down') => void
  onLocate: () => void
  locating?: boolean
  /** 点「相邻地点怎么走」：在地图上高亮该段 */
  onLegClick?: (fromStopId: string, toStopId: string) => void
}

/**
 * 浮卡 / Sheet / 详情模板共用的主体（mindtrip/06 §2.1）。
 * 没有数据就显示「暂无」，不编造评分与价格。
 */
export function PlaceDetailBody({
  detail,
  loading,
  error,
  segment,
  readonly,
  activeDay,
  dayOptions,
  saved,
  feedback,
  onAdd,
  onRemove,
  onNavigate,
  onOpenFull,
  onRetry,
  onToggleSave,
  onFeedback,
  onLocate,
  locating,
  onLegClick,
}: PlaceDetailBodyProps) {
  const [imageIndex, setImageIndex] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const photos = detail?.photos || []
  const inTrip = !!detail?.inTrip
  const noCoords = detail?.lat == null || detail?.lng == null
  const rating = fmtRating(detail?.rating)
  const age = sourceAgeDays(detail?.source?.fetchedAt)
  const missingLabels = useMemo(() => {
    const map: Record<string, string> = {
      rating: '评分',
      review_count: '评价数',
      photos: '图片',
      summary: '简介',
      address: '地址',
      lat: '坐标',
      lng: '坐标',
      open_now: '营业状态',
    }
    return (detail?.missing || []).map(key => map[key] || key).filter((value, index, list) => list.indexOf(value) === index)
  }, [detail?.missing])

  if (loading && !detail) {
    return (
      <div className="place-card-skeleton" aria-label="正在加载地点">
        <div className="pcs-media" />
        <div className="pcs-line w70" />
        <div className="pcs-line w46" />
        <div className="pcs-line w88" />
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="place-card-empty">
        <Icon name="info" />
        <div>
          <strong>地点信息暂时取不到</strong>
          <p>{error || '换个网络再试，或者直接在地图上确认位置。'}</p>
        </div>
        <button className="btn btn-sm" type="button" onClick={onRetry}>
          重试
        </button>
      </div>
    )
  }

  return (
    <div className="place-card">
      <div className="pc-media">
        {photos.length > 0 ? (
          <>
            <img
              src={photos[Math.min(imageIndex, photos.length - 1)]}
              alt={`${detail.name} 图片 ${imageIndex + 1}`}
              loading="lazy"
              onError={event => {
                ;(event.currentTarget as HTMLImageElement).style.display = 'none'
              }}
            />
            {photos.length > 1 && (
              <>
                <button
                  className="pc-media-nav prev"
                  type="button"
                  aria-label="上一张"
                  onClick={() => setImageIndex(index => (index - 1 + photos.length) % photos.length)}
                >
                  <Icon name="chevronLeft" />
                </button>
                <button
                  className="pc-media-nav next"
                  type="button"
                  aria-label="下一张"
                  onClick={() => setImageIndex(index => (index + 1) % photos.length)}
                >
                  <Icon name="chevronRight" />
                </button>
                <span className="pc-dots" role="tablist" aria-label="图片切换">
                  {photos.map((_, index) => (
                    <button
                      key={index}
                      type="button"
                      role="tab"
                      aria-selected={index === imageIndex}
                      className={index === imageIndex ? 'active' : ''}
                      aria-label={`第 ${index + 1} 张`}
                      onClick={() => setImageIndex(index)}
                    />
                  ))}
                </span>
              </>
            )}
          </>
        ) : (
          <div className="pc-media-empty">
            <Icon name="camera" />
            <span>暂无图片</span>
            <em>来源未确认</em>
          </div>
        )}
        <button
          className={`pc-heart${saved ? ' saved' : ''}`}
          type="button"
          aria-label={saved ? '取消收藏' : '收藏'}
          aria-pressed={saved}
          onClick={onToggleSave}
        >
          {saved ? '♥' : '♡'}
        </button>
        <span className={`pc-state ${inTrip ? 'added' : noCoords ? 'unlocated' : 'candidate'}`}>
          {inTrip ? '✓ 已在行程' : noCoords ? '! 未定位' : '＋ 候选'}
        </span>
      </div>

      <div className="pc-title-row">
        <h3 className="pc-title">{detail.name}</h3>
        {rating && (
          <span className="pc-rating" title={detail.reviewCount ? `${detail.reviewCount} 条评价` : '评分'}>
            ★ {rating}
            {detail.reviewCount ? ` (${detail.reviewCount >= 1000 ? `${(detail.reviewCount / 1000).toFixed(1)}k` : detail.reviewCount})` : ''}
          </span>
        )}
      </div>

      <div className="pc-meta">
        <span>{placeIcon(detail.category)} {placeCategoryLabel(detail.category)}</span>
        {detail.city && <span>· {detail.city}</span>}
        {detail.address && detail.address !== detail.city && (
          <span className="pc-addr" title={detail.address}>· {detail.address}</span>
        )}
      </div>

      {inTrip && (
        <div className="pc-stats">
          <span>
            <em>{detail.category === 'stay' ? '住宿' : '停留'}</em>
            {formatDurationMin(detail.visitDurationMin)}
          </span>
          <span>
            <em>门票</em>
            {detail.ticketUnitText || '暂无'}
          </span>
          <span>
            <em>预约</em>
            {detail.reservationRequired === true ? '需要' : detail.reservationRequired === false ? '不需要' : '未确认'}
          </span>
          <span className={detail.coordinateVerified ? 'ok' : 'warn'}>
            <em>坐标</em>
            {detail.coordinateVerified ? '高德' : '未确认'}
          </span>
        </div>
      )}

      {inTrip && detail.ticketTotalText && <div className="pc-ticket-total">门票合计 {detail.ticketTotalText}</div>}

      {detail.summary ? (
        <div className={`pc-summary${expanded ? ' expanded' : ''}`}>
          <p>{detail.summary}</p>
          {detail.summary.length > 72 && (
            <button type="button" className="pc-link" onClick={() => setExpanded(value => !value)}>
              {expanded ? '收起' : '展开'}
            </button>
          )}
        </div>
      ) : (
        <div className="pc-summary pc-none">暂无简介</div>
      )}

      <div className="pc-price-row">
        {detail.priceText ? <span className="pc-price">{detail.priceText}</span> : <span className="pc-none">暂无价格信息</span>}
        {detail.openNow != null && (
          <span className={`pc-open${detail.openNow ? ' open' : ''}`}>{detail.openNow ? '营业中' : '已打烊'}</span>
        )}
        {detail.businessTime && <span className="pc-hours">营业：{detail.businessTime}</span>}
        {detail.reservationRequired && <span className="pc-req">需预约</span>}
      </div>

      {noCoords && (
        <div className="pc-unlocated">
          <Icon name="warn" />
          <span>这个地点还没有坐标，无法在地图上定位。</span>
          <button className="btn btn-sm" type="button" onClick={onLocate} disabled={locating}>
            {locating ? '搜索中…' : '确认位置'}
          </button>
        </div>
      )}

      {missingLabels.length > 0 && (
        <div className="pc-missing">暂无：{missingLabels.join('、')}（来源未提供，不做估算）</div>
      )}

      {inTrip && (detail.activities?.length || 0) > 0 && (
        <div className="pc-block">
          <div className="pc-block-title">玩法</div>
          <div className="pc-play-list">
            {(detail.activities || []).slice(0, 5).map((activity, index) => (
              <div className="pc-play-row" key={`${activity.title}-${index}`}>
                <span className="pc-play-time">
                  {activity.start || '—'}
                  {activity.end ? `–${activity.end}` : ''}
                </span>
                <span className="pc-play-main">
                  <strong>{activity.title}</strong>
                  {(activity.note || activity.tips?.[0]) && <em>{activity.note || activity.tips?.[0]}</em>}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(detail.transferFrom || detail.transferTo) && (
        <div className="pc-block pc-transfer">
          <div className="pc-block-title">
            怎么走 <small>高德规划 · 仅供参考</small>
          </div>
          {[detail.transferFrom, detail.transferTo].filter(Boolean).map((transfer, index) => {
            if (!transfer) return null
            const meta = modeMeta(transfer.mode)
            const amapBacked = transfer.source === 'amap'
            const distance = amapBacked ? fmtDistance(transfer.distanceM) : null
            const duration = amapBacked ? fmtDuration(transfer.durationMin) : null
            const isFrom = transfer.toStopId === detail.stopId
            const other = isFrom ? transfer.fromName : transfer.toName
            return (
              <button
                key={`${transfer.fromStopId}-${transfer.toStopId}-${index}`}
                type="button"
                className="pc-transfer-row"
                onClick={() => onLegClick?.(transfer.fromStopId, transfer.toStopId)}
              >
                <span className="pc-transfer-icon">{meta.icon}</span>
                <span className="pc-transfer-main">
                  <strong>{isFrom ? `从 ${other || '上一站'}` : `去 ${other || '下一站'}`}</strong>
                  <em>
                    {amapBacked
                      ? [meta.label, distance, duration].filter(Boolean).join(' · ')
                      : `${meta.label} · 高德待算`}
                    <span className={`pc-source-tag${amapBacked ? ' amap' : ''}`}>
                      {amapBacked ? '高德' : '待算'}
                    </span>
                  </em>
                </span>
              </button>
            )
          })}
          <div className="pc-transfer-note">路线与时间为高德规划结果，仅供参考；实际以导航为准。</div>
        </div>
      )}

      <div className="pc-actions">
        {inTrip ? (
          <>
            <button className="btn btn-primary btn-sm" type="button" onClick={() => onAdd(activeDay)} disabled>
              <Icon name="checkCircle" /> 已在 Day {detail.dayIndex ?? activeDay}
            </button>
            {!readonly && (
              <button className="btn btn-sm" type="button" onClick={onRemove}>
                移出行程
              </button>
            )}
          </>
        ) : readonly ? (
          <span className="pc-readonly">只读分享：不能修改行程</span>
        ) : (
          <>
            <button className="btn btn-primary btn-sm" type="button" onClick={() => onAdd(activeDay)}>
              <Icon name="plus" /> 加入 Day {activeDay}
            </button>
            {dayOptions.length > 1 && (
              <select
                className="pc-day-select"
                aria-label="选择加入哪一天"
                value={activeDay}
                onChange={event => onAdd(Number(event.target.value))}
              >
                {dayOptions.map(day => (
                  <option key={day.dayIndex} value={day.dayIndex}>
                    {day.label}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
        <button className="btn btn-sm" type="button" onClick={onNavigate}>
          <Icon name="arrowUpRight" /> 导航
        </button>
        <button className="btn btn-sm" type="button" onClick={onOpenFull}>
          详情 <Icon name="chevronRight" />
        </button>
      </div>

      <div className="pc-source">
        <span>
          {detail.source
            ? `高德 · 抓取于 ${fmtFetchedAt(detail.source.fetchedAt) || '—'}`
            : detail.coordinateVerified
              ? '坐标来自高德 POI'
              : '来源未确认'}
        </span>
        {detail.sourceName && detail.sourceName !== detail.name && (
          <span className="pc-amap-name">高德：{detail.sourceName}</span>
        )}
        {age != null && age > 30 && <span className="pc-stale">可能过期</span>}
        {detail.source?.url && (
          <a href={detail.source.url} target="_blank" rel="noreferrer noopener">
            原始页面
          </a>
        )}
        <span className="pc-feedback">
          <button type="button" aria-label="有用" aria-pressed={feedback === 'up'} onClick={() => onFeedback('up')}>
            👍
          </button>
          <button type="button" aria-label="没用" aria-pressed={feedback === 'down'} onClick={() => onFeedback('down')}>
            👎
          </button>
        </span>
      </div>

      {error && (
        <div className="pc-error" role="status">
          <Icon name="warn" /> {error}
        </div>
      )}
    </div>
  )
}
