import { useState } from 'react'
import type { CandidatePlace, PlaceDetail } from '../types'
import { Icon } from '../lib/icons'
import {
  fmtDistance,
  fmtFetchedAt,
  fmtRating,
  placeCategoryLabel,
  placeIcon,
  sourceAgeDays,
} from '../lib/placeMeta'
import { copyText } from '../lib/toast'
import { openAmap } from '../lib/nav'

/** 无坐标地点的「确认位置」小卡（mindtrip/06 §1.5）：搜索/地图选点，不静默丢弃。 */
export function LocatePanel({
  detail,
  query,
  setQuery,
  results,
  message,
  loading,
  onSearch,
  onPick,
  onClose,
}: {
  detail: PlaceDetail | null
  query: string
  setQuery: (value: string) => void
  results: CandidatePlace[]
  message: string | null
  loading: boolean
  onSearch: () => void
  onPick: (candidate: CandidatePlace) => void
  onClose: () => void
}) {
  return (
    <div className="locate-panel" role="dialog" aria-label="确认位置">
      <div className="locate-head">
        <strong>确认「{detail?.name || '地点'}」的位置</strong>
        <button className="icon-btn" type="button" aria-label="收起" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="locate-row">
        <input
          type="search"
          value={query}
          placeholder="搜索地点名，例如「禾木村」"
          aria-label="搜索地点"
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') onSearch()
          }}
        />
        <button className="btn btn-sm btn-primary" type="button" onClick={onSearch} disabled={loading || !query.trim()}>
          {loading ? <span className="spinner spinner-xs" /> : '搜索'}
        </button>
      </div>
      {message && <div className="locate-msg">{message}</div>}
      <div className="locate-results">
        {results.map(item => (
          <button key={item.poiId} type="button" onClick={() => onPick(item)}>
            <span className="lr-icon">{placeIcon(item.category)}</span>
            <span className="lr-main">
              <span className="lr-name">{item.name}</span>
              <span className="lr-sub">
                {[item.city, item.address].filter(Boolean).join(' · ') || '无地址'}
                {item.lat != null && item.lng != null ? ` · ${item.lat.toFixed(3)}, ${item.lng.toFixed(3)}` : ''}
              </span>
            </span>
            <span className="lr-pick">用这个位置</span>
          </button>
        ))}
      </div>
      <div className="locate-tip">选中后会把坐标写回行程；地图上的 marker 会立刻出现。</div>
    </div>
  )
}

/** 地点详情模板（P2-3）：图集 / 设施 / 位置 / 评价，不做预订。 */
export function PlaceDetailFull({
  detail,
  saved,
  onToggleSave,
  onClose,
  onNavigate,
}: {
  detail: PlaceDetail
  saved: boolean
  onToggleSave: () => void
  onClose: () => void
  onNavigate: () => void
}) {
  const [active, setActive] = useState(0)
  const photos = detail.photos || []
  const age = sourceAgeDays(detail.source?.fetchedAt)
  const rating = fmtRating(detail.rating)
  return (
    <div className="place-full-scrim" role="presentation" onClick={onClose}>
      <div className="place-full" role="dialog" aria-modal="true" aria-label={`${detail.name} 详情`} onClick={event => event.stopPropagation()}>
        <header className="pf-head">
          <div>
            <h2>{detail.name}</h2>
            <div className="pf-sub">
              {placeIcon(detail.category)} {placeCategoryLabel(detail.category)}
              {detail.city ? ` · ${detail.city}` : ''}
              {rating ? ` · ★ ${rating}` : ' · 暂无评分'}
            </div>
          </div>
          <div className="pf-actions">
            <button className={`pc-heart inline${saved ? ' saved' : ''}`} type="button" aria-pressed={saved} onClick={onToggleSave}>
              {saved ? '♥' : '♡'}
            </button>
            <button className="icon-btn" type="button" aria-label="关闭" onClick={onClose}>
              <Icon name="x" />
            </button>
          </div>
        </header>

        <div className="pf-body">
          <section className="pf-gallery">
            {photos.length ? (
              <>
                <img src={photos[Math.min(active, photos.length - 1)]} alt={`${detail.name} 图 ${active + 1}`} loading="lazy" />
                <div className="pf-thumbs">
                  {photos.map((url, index) => (
                    <button
                      key={url + index}
                      type="button"
                      className={index === active ? 'active' : ''}
                      onClick={() => setActive(index)}
                      aria-label={`第 ${index + 1} 张`}
                    >
                      <img src={url} alt="" loading="lazy" />
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="pf-gallery-empty">
                <Icon name="camera" />
                <span>暂无图片 · 来源未确认</span>
              </div>
            )}
          </section>

          <section className="pf-section">
            <h3>位置</h3>
            <p>
              {[detail.city, detail.address].filter(Boolean).join(' · ') || '地址暂无'}
              {detail.lat != null && detail.lng != null ? (
                <>
                  <br />
                  <span className="pf-coord">
                    {detail.lat.toFixed(5)}, {detail.lng.toFixed(5)}
                  </span>
                  <button
                    className="pc-link"
                    type="button"
                    onClick={() =>
                      void copyText(`${detail.lat},${detail.lng}`, '坐标已复制')
                    }
                  >
                    复制坐标
                  </button>
                </>
              ) : (
                <span className="pc-none"> · 暂无坐标</span>
              )}
            </p>
            <div className="pf-row">
              <button className="btn btn-sm" type="button" onClick={onNavigate} disabled={detail.lat == null}>
                <Icon name="arrowUpRight" /> 打开导航
              </button>
              {detail.businessTime && <span className="pf-chip">营业：{detail.businessTime}</span>}
              {detail.reservationRequired && <span className="pf-chip">需预约</span>}
            </div>
          </section>

          <section className="pf-section">
            <h3>简介</h3>
            <p>{detail.summary || '暂无简介（来源未提供）'}</p>
          </section>

          <section className="pf-section">
            <h3>设施</h3>
            {detail.facilities?.length ? (
              <div className="pf-chips">
                {detail.facilities.map(item => (
                  <span key={item} className="pf-chip">
                    {item}
                  </span>
                ))}
              </div>
            ) : (
              <p className="pc-none">暂无设施信息</p>
            )}
          </section>

          <section className="pf-section">
            <h3>评价</h3>
            {detail.reviews?.length ? (
              <div className="pf-reviews">
                {detail.reviews.map((review, index) => (
                  <div className="pf-review" key={`${review.author || 'anon'}-${index}`}>
                    <div className="pfr-head">
                      <strong>{review.author || '匿名'}</strong>
                      {review.score != null && <span>★ {review.score}</span>}
                    </div>
                    <p>{review.text}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="pc-none">暂无评价（不编造点评）</p>
            )}
          </section>

          <section className="pf-section pf-source">
            <h3>来源</h3>
            <p>
              {detail.source
                ? `高德地图 · 抓取于 ${fmtFetchedAt(detail.source.fetchedAt) || '—'}`
                : '来源未确认'}
              {age != null && age > 30 ? ' · 可能过期' : ''}
            </p>
            <p className="pf-note">
              <Icon name="info" /> 本页只做展示与导航，不提供预订、下单或支付。
              {detail.priceLevel ? ` 价格档：${'¥'.repeat(Math.max(1, Math.min(4, detail.priceLevel)))}` : ''}
              {detail.priceText ? ` ${detail.priceText}` : ''}
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
