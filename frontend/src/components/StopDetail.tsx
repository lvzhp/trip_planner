import { useEffect, useMemo, useRef, useState } from 'react'
import type { Day, GuideSection, Stop } from '../types'
import { useTripStore } from '../stores/tripStore'
import { useUiStore, type DetailTab } from '../stores/uiStore'
import { useGuideStore, guideEntryKey } from '../stores/guideStore'
import { api } from '../api/client'
import { channelMeta, Icon } from '../lib/icons'
import { fmtMoney, shortName } from '../lib/format'
import { copyText, toast } from '../lib/toast'
import { openAmap } from '../lib/nav'
import { Markdown } from '../lib/markdown'
import { collectStopQa, pendingStopQa, type QaItem } from './qaModel'

/**
 * stop 详情视图（docs/07 §5、§6）。
 *
 * 四段：概览（Trip JSON 投影）| 美食 | 打卡（攻略管线，lazy 生成）| 问答（turn 双渲染分流）。
 * 底部常驻 chips + 输入框：问美食/问打卡 = 纯前端切段（零 LLM）；
 * 其余 chips 与自由输入 = 带 stop 标签发送（docs/07 §7）。
 */

interface Props {
  stop: Stop
  day: Day
  /** 从某张卡片进入时，详情头与概览以这张卡为主体；从地图/对话进入时为 null */
  activityId?: string | null
  mobile: boolean
  readonly: boolean
  onClose: () => void
  onEditStop: (stopId: string, dayIndex: number) => void
  onEditActivity?: (activityId: string) => void
}

const TABS: { id: DetailTab; label: string }[] = [
  { id: 'overview', label: '概览' },
  { id: 'food', label: '美食' },
  { id: 'spot', label: '打卡' },
  { id: 'qa', label: '问答' },
]

/** 底部 chips：label 是显示文字，tab 非空则纯前端切段，question 非空则直接发送。 */
const CHIPS: { label: string; tab?: DetailTab; question?: string }[] = [
  { label: '问美食', tab: 'food' },
  { label: '问打卡', tab: 'spot' },
  { label: '问停车', question: '这里停车方便吗？停哪里？' },
  { label: '问门票', question: '这里需要门票吗？在哪买、多少钱？' },
  { label: '问玩法', question: '这里怎么玩比较顺路？有什么避坑提示？' },
]

export function StopDetail({ stop, day, activityId, mobile, readonly, onClose, onEditStop, onEditActivity }: Props) {
  const tripId = useTripStore(s => s.tripId)
  const trip = useTripStore(s => s.trip)
  const events = useTripStore(s => s.events)
  const sending = useTripStore(s => s.sending)
  const send = useTripStore(s => s.send)
  const tab = useUiStore(s => s.detailTab)
  const setTab = useUiStore(s => s.setDetailTab)
  const scrollSeq = useUiStore(s => s.detailScrollSeq)
  const model = useUiStore(s => s.model)
  const [text, setText] = useState('')
  const [filters, setFilters] = useState<string[]>([])
  // 跳过问卷的用户在美食段给补填入口（docs/07 §7 的 C 方案：采集时机挪到"正好需要它的那一刻"）
  const [profileMissing, setProfileMissing] = useState(false)
  const openSettings = useUiStore(s => s.openSettings)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const settingsOpen = useUiStore(s => s.settingsOpen)
  useEffect(() => {
    if (readonly) return
    // 也在设置弹窗关闭时重查：用户可能刚在「我的偏好」里补填了档案
    let cancelled = false
    void api
      .profile()
      .then(p => {
        if (!cancelled) setProfileMissing(!p.exists)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [readonly, settingsOpen])
  // 内存缓存 key 必须带上 filters，否则点了口味 chips 会读到上一份结果
  const key = guideEntryKey(stop.stopId, filters)
  const entry = useGuideStore(s => s.entries[key])
  const loadGuide = useGuideStore(s => s.load)

  // 美食/打卡段首次打开时 lazy 生成（docs/07 §9）
  useEffect(() => {
    if ((tab === 'food' || tab === 'spot') && !entry && tripId) {
      void loadGuide(tripId, stop.stopId, { filters, readonly, model: { provider: model.provider, model: model.model } })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, tripId, stop.stopId, key])

  // 问答段定位（从对话栏存根跳转过来，docs/07 §8）
  useEffect(() => {
    if (scrollSeq == null) return
    const host = scrollRef.current
    if (!host) return
    const id = window.setTimeout(() => {
      const node = host.querySelector<HTMLElement>(`[data-seq="${scrollSeq}"]`)
      if (!node) return
      node.scrollIntoView({ behavior: 'smooth', block: 'center' })
      node.classList.remove('flash-highlight')
      void node.offsetWidth
      node.classList.add('flash-highlight')
      window.setTimeout(() => node.classList.remove('flash-highlight'), 1300)
    }, 80)
    return () => window.clearTimeout(id)
  }, [scrollSeq, tab])

  const qaItems = useMemo(() => collectStopQa(events, stop.stopId), [events, stop.stopId])
  // 只认该 stop 的未回答 qa 回合：不能用全局 sending，否则用户在主对话栏改行程时
  // 这里也会误显示"正在回答"
  const qaPending = useMemo(() => pendingStopQa(events, stop.stopId), [events, stop.stopId])
  const acts = useMemo(
    () => [...stop.activities].sort((a, b) => (a.timeWindow?.start || '').localeCompare(b.timeWindow?.start || '')),
    [stop.activities],
  )
  const selectedActivity = useMemo(
    () => (activityId ? stop.activities.find(a => a.activityId === activityId) || null : null),
    [activityId, stop.activities],
  )

  // ESC 返回列表（docs/07 §5）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const sendQuestion = (question: string) => {
    if (!question.trim() || sending || readonly) return
    setText('')
    void send({
      content: question.trim(),
      contextTags: [{ kind: 'stop', id: stop.stopId, label: `${shortName(stop.poi.name)} · Day ${day.dayIndex}`, dayIndex: day.dayIndex }],
      model: { provider: model.provider, model: model.model },
    })
  }

  const onChip = (chip: (typeof CHIPS)[number]) => {
    if (chip.tab) {
      setTab(chip.tab)
      return
    }
    if (chip.question) sendQuestion(chip.question)
  }

  const onNavigate = (target: { name: string; amapPoiId?: string | null; lng?: number | null; lat?: number | null }) => {
    openAmap(target, trip?.constraints.transportMode)
  }

  return (
    <div
      className="stop-detail"
      style={{ ['--day-color' as string]: `var(--day-${((day.dayIndex - 1) % 12) + 1})` } as React.CSSProperties}
    >
      <div className="sd-head">
        <button className="icon-btn" type="button" aria-label="返回行程列表" onClick={onClose}>
          <Icon name="chevronLeft" />
        </button>
        <div className="sd-title">
          <span className="sd-name" title={selectedActivity?.title || stop.poi.name}>
            {selectedActivity ? selectedActivity.title : shortName(stop.poi.name)}
          </span>
          <span className="sd-sub">
            {selectedActivity ? `📍 ${shortName(stop.poi.name)} · ` : ''}
            Day {day.dayIndex}
            {stop.poi.city ? ` · ${stop.poi.city}` : ''}
            {stop.poi.address ? ` · ${stop.poi.address}` : ''}
          </span>
        </div>
        <div className="sd-actions">
          <button className="btn btn-sm btn-primary" type="button" onClick={() => onNavigate(stop.poi)}>
            <Icon name="arrowUpRight" /> 导航
          </button>
          {!readonly && (
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => {
                if (selectedActivity && onEditActivity) onEditActivity(selectedActivity.activityId)
                else onEditStop(stop.stopId, day.dayIndex)
              }}
            >
              <Icon name="edit" /> 改这里
            </button>
          )}
        </div>
      </div>

      <div className="sd-tabs" role="tablist" aria-label="地点详情分段">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === 'qa' && qaItems.length > 0 && <span className="sd-tab-count">{qaItems.length}</span>}
          </button>
        ))}
      </div>

      <div className="sd-body" ref={scrollRef}>
        {tab === 'overview' && (
          <OverviewTab
            stop={stop}
            acts={acts}
            selectedActivityId={selectedActivity?.activityId || null}
            onNavigate={onNavigate}
          />
        )}
        {tab === 'food' && (
          <GuideTab
            kind="food"
            section={entry?.guide?.food}
            entry={entry}
            filters={filters}
            readonly={readonly}
            stopName={shortName(stop.poi.name)}
            profileMissing={profileMissing}
            onSetupProfile={() => openSettings()}
            onFilter={f => setFilters(prev => (prev.includes(f) ? prev.filter(x => x !== f) : [...prev, f]))}
            onReload={() => tripId && loadGuide(tripId, stop.stopId, { filters, refresh: true, readonly, model: { provider: model.provider, model: model.model } })}
            onNavigate={onNavigate}
            onAsk={sendQuestion}
          />
        )}
        {tab === 'spot' && (
          <GuideTab
            kind="spot"
            section={entry?.guide?.spot}
            entry={entry}
            filters={[]}
            readonly={readonly}
            stopName={shortName(stop.poi.name)}
            onReload={() => tripId && loadGuide(tripId, stop.stopId, { filters, refresh: true, readonly, model: { provider: model.provider, model: model.model } })}
            onNavigate={onNavigate}
            onAsk={sendQuestion}
          />
        )}
        {tab === 'qa' && <QaTab items={qaItems} pending={qaPending} emptyHint={readonly ? '只读分享不含问答记录。' : undefined} />}
      </div>

      {!readonly && (
        <div className="sd-composer">
          <div className="sd-chips" aria-label="快捷追问">
            {CHIPS.map(c => (
              <button key={c.label} type="button" className="sd-chip" disabled={sending} onClick={() => onChip(c)}>
                {c.label}
              </button>
            ))}
          </div>
          <div className={`sd-input-row${sending ? ' disabled' : ''}`}>
            <input
              ref={inputRef}
              type="text"
              value={text}
              placeholder={`问${shortName(stop.poi.name)}的事…`}
              disabled={sending}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  sendQuestion(text)
                }
              }}
            />
            <button className="send-btn" type="button" aria-label="发送" disabled={sending || !text.trim()} onClick={() => sendQuestion(text)}>
              <Icon name="send" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 概览段：全部来自 Trip JSON（吸收原 PoiPopover 的内容，删掉假评分）
// ---------------------------------------------------------------------------

function OverviewTab({
  stop,
  acts,
  selectedActivityId,
  onNavigate,
}: {
  stop: Stop
  acts: Stop['activities']
  selectedActivityId?: string | null
  onNavigate: (t: { name: string; amapPoiId?: string | null; lng?: number | null; lat?: number | null }) => void
}) {
  const tickets = acts.map(a => a.ticket).filter((t): t is NonNullable<typeof t> => !!t && t.kind !== 'none')
  const mainTicket = tickets.find(t => t.kind === 'attraction') || tickets[0]
  const tips = acts.flatMap(a => a.tips || [])
  return (
    <>
      <div className="sd-section-title">该地点的活动 · {acts.length} 项</div>
      {acts.map(a => {
        const current = selectedActivityId === a.activityId
        return (
          <div
            className={`sd-activity${current ? ' is-current' : ''}`}
            data-activity-id={a.activityId}
            key={a.activityId}
          >
            <span className="sd-act-time">{a.timeWindow?.start}–{a.timeWindow?.end}</span>
            <span className="sd-act-title">{a.title}</span>
            {current && <span className="sd-act-current">当前卡片</span>}
          </div>
        )
      })}

      {stop.poi.amapPoiId || (stop.poi.lng != null && stop.poi.lat != null) ? (
        <>
          <div className="sd-section-title">位置</div>
          <div className="sd-location">
            <div className="sd-loc-text">
              {stop.poi.address || stop.poi.city || stop.poi.name}
              {stop.poi.lng != null && stop.poi.lat != null && (
                <span className="sd-loc-coord"> · {stop.poi.lng.toFixed(5)}, {stop.poi.lat.toFixed(5)}</span>
              )}
            </div>
            <button className="btn btn-sm" type="button" onClick={() => onNavigate(stop.poi)}>
              <Icon name="arrowUpRight" /> 在高德地图中打开
            </button>
          </div>
        </>
      ) : null}

      {stop.openingHours && (
        <>
          <div className="sd-section-title">营业时间</div>
          <OpeningHoursBlock hours={stop.openingHours} />
        </>
      )}

      {mainTicket && (
        <>
          <div className="sd-section-title">门票与购票渠道</div>
          <div className="ticket-block">
            <div className="ticket-main">
              <span className="ticket-name">{ticketTitle(stop, mainTicket)}</span>
              <span className="ticket-price">{fmtMoney(mainTicket.priceRange)}</span>
            </div>
            <div className="ticket-meta">
              {mainTicket.leadTimeDays ? <span className="chip chip-warning">需提前 {mainTicket.leadTimeDays} 天</span> : null}
              {mainTicket.realNameRequired ? <span className="chip">实名制</span> : null}
              {mainTicket.note ? <span>{mainTicket.note}</span> : null}
            </div>
            {mainTicket.channels.length > 0 && (
              <div className="ticket-channels">
                {mainTicket.channels.map((c, i) => (
                  <div className="channel-row" key={`${c.name}-${i}`}>
                    <span className={`ch-icon ${channelMeta[c.type]?.cls || ''}`}>
                      <Icon name={channelMeta[c.type]?.icon || 'web'} />
                    </span>
                    <div className="ch-main">
                      <div className="ch-line">
                        <span className="ch-name">{c.name}</span>
                        {i === 0 && <span className="ch-preferred">首选</span>}
                        {c.status === 'verified' ? (
                          <span className="chip chip-primary">官方核实</span>
                        ) : c.status === 'clue' ? (
                          <span className="chip chip-warning">来自游记，未经官方核实</span>
                        ) : null}
                      </div>
                      {c.howToFind ? <div className="ch-note">{c.howToFind}</div> : null}
                      {c.note ? <div className="ch-note">{c.note}</div> : null}
                      {c.evidenceUrl ? (
                        <div className="ch-note">
                          <a href={c.evidenceUrl} target="_blank" rel="noreferrer">
                            核对出处
                          </a>
                        </div>
                      ) : null}
                    </div>
                    {(c.type === 'wechat_mp' || c.type === 'mini_program') && c.detail ? (
                      <button
                        className="icon-btn ch-copy"
                        type="button"
                        aria-label={`复制「${c.detail}」`}
                        onClick={() => copyText(c.detail!, `已复制「${c.detail}」`)}
                      >
                        <Icon name="copy" />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {tips.length > 0 && (
        <>
          <div className="sd-section-title">注意事项</div>
          <ul className="tips-list">
            {tips.map((t, i) => (
              <li key={i}>
                <Icon name="info" /> <span>{t}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// 美食 / 打卡段：B 叙事在上 + A 列表在下（docs/07 §6）
// ---------------------------------------------------------------------------

const FOOD_FILTERS = ['清真', '不吃辣', '素食', '步行可达', '本地人常去']

function GuideTab({
  kind,
  section,
  entry,
  filters,
  readonly,
  stopName,
  profileMissing,
  onSetupProfile,
  onFilter,
  onReload,
  onNavigate,
  onAsk,
}: {
  kind: 'food' | 'spot'
  section?: GuideSection
  entry?: { status: string; stage: string | null; label: string; error: string | null; guide: { source: string; notConfigured?: string | null } | null }
  filters: string[]
  readonly: boolean
  stopName: string
  profileMissing?: boolean
  onSetupProfile?: () => void
  onFilter?: (f: string) => void
  onReload: () => void
  onNavigate: (t: { name: string; amapPoiId?: string | null; lng?: number | null; lat?: number | null }) => void
  onAsk: (q: string) => void
}) {
  const status = entry?.status || 'idle'
  const isDemo = entry?.guide?.source === 'mock'

  if (status === 'loading') {
    return (
      <div className="sd-guide-loading">
        <span className="spinner" />
        <strong>{entry?.label || (kind === 'food' ? '正在检索周边美食…' : '正在检索打卡点…')}</strong>
        <span>用高德找周边真实店铺，再结合网络检索整理特色。首次生成需要十几秒，之后会缓存 3 天。</span>
        <div className="panel-skeleton-lines"><i /><i /><i /><i /></div>
      </div>
    )
  }

  if (status === 'error') {
    const notConfigured = entry?.guide?.notConfigured
    const unavailable = entry?.error === 'unavailable'
    return (
      <div className="sd-guide-error">
        <Icon name={notConfigured ? 'settings' : unavailable ? 'eye' : 'warn'} />
        <strong>
          {unavailable
            ? '行程主人未生成此地攻略'
            : notConfigured
              ? `需要配置 ${notConfigured}`
              : '攻略生成失败'}
        </strong>
        <span>
          {unavailable
            ? '只读分享只能查看已生成的攻略，不能触发新的检索。'
            : notConfigured
              ? '在「接入配置」里填好 Key 后即可生成真实周边推荐。'
              : entry?.error || '请稍后重试。'}
        </span>
        {!unavailable && (
          <button className="btn btn-sm" type="button" onClick={onReload}>
            <Icon name="history" /> 重试
          </button>
        )}
      </div>
    )
  }

  const narrative = section?.narrative || []
  const items = section?.items || []

  return (
    <>
      {isDemo && (
        <div className="sd-demo-banner" role="note">
          <Icon name="info" /> 演示数据 · 非真实检索
        </div>
      )}
      {kind === 'food' && profileMissing && onSetupProfile && !readonly && (
        <div className="sd-profile-hint">
          <span>没设置口味偏好，推荐未按忌口过滤。</span>
          <button type="button" className="btn btn-sm" onClick={onSetupProfile}>
            <Icon name="settings" /> 点此设置
          </button>
        </div>
      )}
      {kind === 'food' && onFilter && !readonly && (
        <div className="sd-filters" aria-label="按口味收窄">
          {FOOD_FILTERS.map(f => (
            <button
              key={f}
              type="button"
              className={`sd-chip${filters.includes(f) ? ' active' : ''}`}
              onClick={() => onFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
      )}

      {narrative.length > 0 && (
        <div className="sd-narrative">
          {narrative.map((p, i) => (
            <p key={i}><Markdown>{p}</Markdown></p>
          ))}
        </div>
      )}

      {items.length > 0 ? (
        <div className="sd-items">
          {items.map((it, i) => (
            <div className="sd-item" key={`${it.name}-${i}`}>
              <div className="sd-item-main">
                <span className="sd-item-name">{it.name}</span>
                {it.distanceM != null && <span className="sd-item-dist">{fmtDistance(it.distanceM)}</span>}
                {it.bestTime && <span className="sd-item-time"><Icon name="clock" /> {it.bestTime}</span>}
                {it.highlight && <span className="sd-item-hl">{it.highlight}</span>}
              </div>
              {(it.amapPoiId || (it.lng != null && it.lat != null)) && (
                <button
                  className="btn btn-sm sd-item-nav"
                  type="button"
                  aria-label={`导航到${it.name}`}
                  onClick={() => onNavigate(it)}
                >
                  <Icon name="arrowUpRight" /> 导航
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        !narrative.length && <div className="sd-guide-empty">这一带暂时没有检索到合适的{kind === 'food' ? '餐饮' : '打卡点'}。</div>
      )}

      {!readonly && (
        <div className="sd-guide-foot">
          <button className="btn btn-sm" type="button" onClick={onReload}>
            <Icon name="history" /> 刷新
          </button>
          <button className="btn btn-sm" type="button" onClick={() => onAsk(kind === 'food' ? `${stopName}还有什么值得吃的？` : `${stopName}适合拍照的地方还有哪些？`)}>
            <Icon name="chat" /> 继续问
          </button>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// 问答段：该 stop 的 Q&A 历史（docs/07 §8 双渲染的落点）
// ---------------------------------------------------------------------------

function QaTab({ items, pending, emptyHint }: { items: QaItem[]; pending: boolean; emptyHint?: string }) {
  if (!items.length && !pending) {
    return (
      <div className="sd-guide-empty">
        {emptyHint || '还没有针对这个地点的提问。用下面的输入框问，或点「问停车 / 问门票」快捷追问。'}
      </div>
    )
  }
  return (
    <div className="sd-qa">
      {items.map(item => (
        <div className="sd-qa-pair" key={item.seq} data-seq={item.seq}>
          <div className="sd-qa-q">
            <Icon name="chat" /> {item.question}
          </div>
          <div className="sd-qa-a">
            <Markdown>{item.answer}</Markdown>
          </div>
        </div>
      ))}
      {pending && (
        <div className="sd-qa-pair">
          <div className="sd-qa-a" style={{ paddingLeft: 0 }}>
            <span className="spinner spinner-sm" /> 正在检索并回答…
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

const WEEKDAY_LABELS: Record<string, string> = {
  mon: '周一',
  tue: '周二',
  wed: '周三',
  thu: '周四',
  fri: '周五',
  sat: '周六',
  sun: '周日',
}

/** 营业时间块（new-plan 02 §3）：未核实的数据明确标「待核实」，不假装是事实。 */
function OpeningHoursBlock({ hours }: { hours: NonNullable<Stop['openingHours']> }) {
  const verified = hours.status === 'verified'
  const days = (list: string[]) =>
    list.length === 7 ? '每天' : list.map(d => WEEKDAY_LABELS[d] || d).join('、')
  return (
    <div className="opening-hours">
      {verified ? (
        <span className="chip chip-primary">已核实</span>
      ) : (
        <span className="chip chip-warning">营业时间待核实</span>
      )}
      {hours.regular.length > 0 && (
        <ul className="open-periods">
          {hours.regular.map((p, i) => (
            <li key={i}>
              {days(p.days)} {p.open}–{p.close}
              {p.lastEntry ? `（最后入园 ${p.lastEntry}）` : ''}
            </li>
          ))}
        </ul>
      )}
      {hours.seasonal.length > 0 && (
        <div className="ch-note">
          季节差异：
          {hours.seasonal
            .map(s => `${s.from}–${s.to} ${s.regular.map(p => `${p.open}–${p.close}`).join('、')}`)
            .join('；')}
        </div>
      )}
      {hours.closedDays.length > 0 && <div className="ch-note">闭馆日：{days(hours.closedDays)}</div>}
      {hours.closedDates.length > 0 && (
        <div className="ch-note">临时闭馆：{hours.closedDates.join('、')}</div>
      )}
      {hours.reservationRequired != null && (
        <div className="ch-note">{hours.reservationRequired ? '需要提前预约' : '无需预约'}</div>
      )}
      {hours.note ? <div className="ch-note">{hours.note}</div> : null}
    </div>
  )
}

function ticketTitle(stop: Stop, tk: NonNullable<Stop['activities'][number]['ticket']>) {
  const base = shortName(stop.poi.name)
  if (tk.kind === 'attraction') return `${base}门票${tk.note && tk.note.includes('区间车') ? ' + 区间车' : ''}`
  if (tk.kind === 'hotel') return `${base} 住宿`
  if (tk.kind === 'transport') return '交通票'
  return base
}

function fmtDistance(m: number): string {
  if (m < 1000) return `${m}m`
  return `${(m / 1000).toFixed(1)}km`
}
