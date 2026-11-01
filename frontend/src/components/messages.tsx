import { useEffect, useId, useRef, useState } from 'react'
import type { AskUser, AskUserAnswer, AskUserQuestion, ContextTag, Trip } from '../types'
import { actTypeMeta, channelMeta, conflictTypeLabel, Icon } from '../lib/icons'
import { fmtDate, fmtMoney } from '../lib/format'
import { DEPARTURE_CITIES } from '../lib/cities'
import { SUBAGENT_ROLE_LABELS, SUBAGENT_STATUS_LABELS, subagentKey } from '../lib/subagents'
import { RichMessage } from './RichMessage'
import { useTripStore } from '../stores/tripStore'
import { useUiStore } from '../stores/uiStore'
import type { AskAnswerData, ChatUserItem, ChatAssistantItem, ChatToolGroup, ChatToolItem } from './chatModel'
import { toolIcon } from './chatModel'

export function UserMessage({ item }: { item: ChatUserItem }) {
  return (
    <div className="msg-user">
      {item.contextTags.length > 0 && (
        <div className="ctx-chips">
          {item.contextTags.map((c: any, i: number) => (
            <span className="ctx-chip" key={i}>
              <Icon name="pin" /> @{c.label}
            </span>
          ))}
        </div>
      )}
      <div className="bubble">{item.text}</div>
      <span className="msg-time">{item.at || ''}</span>
    </div>
  )
}

export function AssistantMessage({ item }: { item: ChatAssistantItem }) {
  const trip = useTripStore(s => s.trip)
  const derived = useTripStore(s => s.derived)
  const openDrawer = useUiStore(s => s.openDrawer)
  return (
    <div className={`msg-ai${item.error ? ' msg-error' : ''}`}>
      <span className="avatar">
        <Icon name={item.error ? 'xCircle' : 'sparkle'} />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <RichMessage segments={item.segments} fallback={item.text} />
        {item.card === 'ready' && trip && derived && <ReadyCard trip={trip} derived={derived} onBooking={() => openDrawer('booking')} />}
        {item.card === 'ready' && trip && <Assumptions items={trip.constraints.assumptions || []} />}
        {item.at && <div className="msg-time">Trace · {item.at}</div>}
      </div>
    </div>
  )
}

export function ToolGroup({ group }: { group: ChatToolGroup }) {
  const running = group.items.some(i => !i.result)
  const failed = group.items.some(i => i.result && i.result.ok === false)
  const researchTasks = group.items.flatMap(item =>
    item.call.tool === 'dispatch_research' && Array.isArray(item.result?.data?.results)
      ? (item.result!.data.results as any[])
      : [],
  )
  const hasResearch = researchTasks.length > 0
  // 子 Agent 调研是用户要能看见的过程记录：跑完也保持展开，不要自动收起
  const [open, setOpen] = useState(running || hasResearch)
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running && !hasResearch) setOpen(false)
    wasRunning.current = running
  }, [running, hasResearch])
  const researchRoles = Array.from(new Set(researchTasks.map(task => task.role as string)))
  return (
    <div className={`tool-group${open ? ' open' : ''}`} role="group" aria-label="工具调用">
      <button className="tool-group-head" type="button" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        {running ? <span className="spinner spinner-sm" /> : <Icon name={failed ? 'xCircle' : 'checkCircle'} />}
        <span>
          {running
            ? hasResearch
              ? '正在等子 Agent 调研…'
              : '正在调用工具…'
            : failed
              ? '部分工具失败'
              : hasResearch
                ? '子 Agent 调研完成'
                : '工具调用完成'}
        </span>
        {hasResearch && !running ? (
          <span className="tg-research-tag">
            {researchRoles.map(role => SUBAGENT_ROLE_LABELS[role] || role).join(' / ')} · {researchTasks.length} 份摘要
          </span>
        ) : null}
        {!hasResearch && <span className="tg-count">{group.items.length} 项</span>}
        <Icon name="caretRight" className="caret" />
      </button>
      <div className="tool-group-body">
        {group.thinking && (
          <div className="thinking-row">
            <button type="button" className="thinking-toggle" onClick={() => setThinkingOpen(v => !v)}>
              <Icon name={thinkingOpen ? 'caretDown' : 'caretRight'} /> 思考过程
            </button>
            {thinkingOpen && <div className="thinking-text">{group.thinking}</div>}
          </div>
        )}
        {group.items.map(item => (
          <ToolItemView key={item.key} item={item} />
        ))}
      </div>
    </div>
  )
}

function ToolItemView({ item }: { item: ChatToolItem }) {
  const [expanded, setExpanded] = useState(false)
  const status = !item.result ? 'running' : item.result.ok === false ? 'failed' : 'done'
  const data = item.result?.data
  const json = data ? JSON.stringify(data, null, 2) : null
  const research = item.call.tool === 'dispatch_research' ? data?.results : null
  const pendingResearch =
    item.call.tool === 'dispatch_research' && !item.result
      ? (Array.isArray(item.call.args?.tasks) ? (item.call.args.tasks as any[]) : [])
      : []
  return (
    <div className={`tool-item ${status}`}>
      <span className="ti-icon">
        {status === 'running' ? <span className="spinner spinner-sm" /> : <Icon name={status === 'failed' ? 'xCircle' : toolIcon(item.call.tool)} />}
      </span>
      <div className="ti-main">
        <div className="ti-title">{item.call.summary || item.call.tool}</div>
        {item.result?.summary && !Array.isArray(research) && (
          <div className="ti-result">{item.result.summary}</div>
        )}
        {item.result?.error && <div className="ti-result">{item.result.error.message || item.result.error}</div>}
        {pendingResearch.length > 0 && <PendingResearch tasks={pendingResearch} turnId={item.turnId} />}
        {Array.isArray(research) && research.length > 0 && <ResearchDigest results={research} turnId={item.turnId} />}
        {json && (
          <>
            <button
              type="button"
              className="ti-expand"
              onClick={e => {
                e.stopPropagation()
                setExpanded(v => !v)
              }}
            >
              <Icon name={expanded ? 'caretDown' : 'caretRight'} /> {expanded ? '收起' : '查看结果'}
            </button>
            <pre className="ti-json" style={{ display: expanded ? 'block' : undefined }}>
              {json}
            </pre>
          </>
        )}
      </div>
    </div>
  )
}

function PendingResearch({ tasks, turnId }: { tasks: any[]; turnId?: string }) {
  const openSubagent = useUiStore(s => s.openSubagent)
  return (
    <div className="research-digest pending">
      {tasks.map(task => {
        const taskId = task.taskId || task.task_id
        return (
          <div
            className="rd-item rd-pending"
            key={taskId || task.goal}
            role="button"
            tabIndex={0}
            onClick={() => taskId && openSubagent(subagentKey(turnId, String(taskId)))}
            onKeyDown={event => {
              if ((event.key === 'Enter' || event.key === ' ') && taskId) {
                event.preventDefault()
                openSubagent(subagentKey(turnId, String(taskId)))
              }
            }}
          >
            <span className="spinner spinner-sm" />
            <span className="rd-role">{SUBAGENT_ROLE_LABELS[task.role] || task.role}</span>
            <span className="rd-goal">{task.goal}</span>
            <Icon name="chevronRight" className="rd-open" />
          </div>
        )
      })}
    </div>
  )
}

/** 子 Agent 调研摘要：每个任务一张卡，点击把对话区切换成该子 Agent 的运行详情。 */
function ResearchDigest({ results, turnId }: { results: any[]; turnId?: string }) {
  const openSubagent = useUiStore(s => s.openSubagent)
  return (
    <div className="research-digest">
      {results.map(task => {
        const taskId = task.taskId || task.task_id
        const findings = Array.isArray(task.findings) ? task.findings : []
        const gaps = Array.isArray(task.gaps) ? task.gaps : []
        const stepCount = Array.isArray(task.trace?.steps)
          ? task.trace.steps.length
          : Array.isArray(task.steps)
            ? task.steps.length
            : null
        const open = () => taskId && openSubagent(subagentKey(turnId, String(taskId)))
        return (
          <div
            className={`rd-item rd-${task.status || 'ok'}`}
            key={taskId || task.role}
            role="button"
            tabIndex={0}
            aria-label={`打开子 Agent「${SUBAGENT_ROLE_LABELS[task.role] || task.role}」运行详情`}
            onClick={open}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                open()
              }
            }}
          >
            <div className="rd-head">
              <span className="rd-role">{SUBAGENT_ROLE_LABELS[task.role] || task.role}</span>
              <span className={`rd-state rd-state-${task.status || 'ok'}`}>
                {SUBAGENT_STATUS_LABELS[task.status || 'ok'] || task.status}
              </span>
              <span className="rd-count">
                {findings.length} 条结论{stepCount != null ? ` · ${stepCount} 步` : ''}
              </span>
              <Icon name="chevronRight" className="rd-open" />
            </div>
            {task.summary ? <div className="rd-summary">{task.summary}</div> : null}
            {findings.length > 0 && (
              <ul className="rd-findings">
                {findings.slice(0, 4).map((finding: any, index: number) => (
                  <li key={index}>
                    <span className={`rd-kind rd-kind-${finding.kind || 'clue'}`}>
                      {finding.kind === 'fact' ? '事实' : finding.kind === 'experience' ? '经验' : '线索'}
                    </span>
                    <span className="rd-claim">{finding.claim}</span>
                    {finding.evidence?.[0]?.url ? (
                      <a
                        href={finding.evidence[0].url}
                        target="_blank"
                        rel="noreferrer noopener"
                        onClick={e => e.stopPropagation()}
                      >
                        出处
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {gaps.length > 0 && <div className="rd-gaps">没查到：{gaps.slice(0, 3).join('；')}</div>}
          </div>
        )
      })}
    </div>
  )
}

export function ThinkingNote({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="thinking-note">
      <button type="button" className="thinking-toggle" onClick={() => setOpen(v => !v)}>
        <Icon name={open ? 'caretDown' : 'caretRight'} /> Trace 的思考
      </button>
      {open && <div className="thinking-text">{text}</div>}
    </div>
  )
}

const CITY_HINTS = ['城市', '出发地', '出发城市', '从哪里出发', '从哪出发', '哪座城市']
const DATE_HINTS = ['什么时候', '日期', '哪几天', '几号', '时间段', '出发日', '返程日']

/** 历史卡片没有 input 字段：按题面推断该用什么控件，老事件刷新后也能用选择器。 */
function askInputOf(q: AskUserQuestion): 'chips' | 'city' | 'date' {
  if (q.input === 'city' || q.input === 'date') return q.input
  const text = q.question || ''
  if (CITY_HINTS.some(hint => text.includes(hint))) return 'city'
  if (DATE_HINTS.some(hint => text.includes(hint))) return 'date'
  return 'chips'
}

export function AskCard({
  ask,
  answer,
  onAnswer,
  readonly,
}: {
  ask: AskUser
  answer?: { answers: AskAnswerData[]; freeText?: string | null }
  onAnswer: (askId: string | null, answers: AskUserAnswer[], freeText: string | null) => void
  readonly?: boolean
}) {
  const [selected, setSelected] = useState<Record<number, string[]>>({})
  const [notes, setNotes] = useState<Record<number, string>>({})
  /** 「其他」选项的自填内容：日期/目的地这类 chips 列不全时必须能补充 */
  const [custom, setCustom] = useState<Record<number, string>>({})
  /** 城市/日期选择器填的值（按题目索引） */
  const [picked, setPicked] = useState<Record<number, string>>({})
  /** 备注默认收起：选中一项就弹一个 textarea 会把卡片越撑越高 */
  const [noteOpen, setNoteOpen] = useState<Record<number, boolean>>({})
  const cityListId = useId()
  const [freeMode, setFreeMode] = useState(false)
  const [freeText, setFreeText] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const freeInputRef = useRef<HTMLInputElement>(null)

  const answered = !!answer
  if (answered) {
    return <AnsweredAsk ask={ask} answer={answer} />
  }
  // 空问题卡不渲染：服务端解析失败时宁可整块不显示，也不要出现一张「0 个问题」的卡
  if (!ask.questions || ask.questions.length === 0) return null

  const anySelected =
    Object.values(selected).some(v => v.length > 0) ||
    Object.values(picked).some(v => v.trim().length > 0)

  /** 没选项直接点提交时，不静默失败：展开自由输入并给一句提示。 */
  const openFree = (message: string) => {
    setHint(message)
    setFreeMode(true)
    window.setTimeout(() => freeInputRef.current?.focus(), 30)
  }

  const toggle = (qi: number, id: string, multi: boolean) => {
    setSelected(prev => {
      const cur = prev[qi] || []
      if (multi) {
        return { ...prev, [qi]: cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id] }
      }
      return { ...prev, [qi]: [id] }
    })
  }

  const submit = () => {
    if (!anySelected) {
      openFree('先选一个选项，或直接在这里输入你的想法。')
      return
    }
    setHint(null)
    // 未选的题保留空 optionIds：后端会把它们当「跳过，按默认」处理，
    // 模型由此能区分「用户跳过」和「没问过」（02 §4.2）。
    const answers: AskUserAnswer[] = ask.questions.map((_q, qi) => {
      const ids = selected[qi] || []
      const customText = (custom[qi] || '').trim()
      const pickedText = (picked[qi] || '').trim()
      return {
        questionIndex: qi,
        optionIds: ids,
        note: notes[qi] || '',
        freeText: ids.includes('other') && customText ? customText : null,
        value: pickedText || null,
      }
    })
    onAnswer(ask.askId || null, answers, null)
  }

  const submitFree = () => {
    if (!freeText.trim()) {
      setHint('先写一句你的想法，或在上方选择选项。')
      freeInputRef.current?.focus()
      return
    }
    setHint(null)
    onAnswer(ask.askId || null, [], freeText.trim())
  }

  return (
    <div className="ask-card" role="form" aria-label="AI 提问">
      <div className="ask-card-head">
        <Icon name="chat" />
        <span className="ask-head-title">{ask.intro || '需要确认几件事'}</span>
        <span className="chip chip-primary ask-badge">{ask.questions.length} 个问题</span>
      </div>
      <div className="ask-questions">
        {ask.questions.map((q, qi) => {
          const chosen = selected[qi] || []
          return (
            <div className="ask-question" key={qi}>
              <div className="ask-q-label">
                {q.question} <span className="q-hint">{q.multi ? '可多选' : '单选'}</span>
              </div>
              <div className="ask-options" role={q.multi ? 'group' : 'radiogroup'}>
                {q.options.map(o => {
                  const on = chosen.includes(o.id)
                  return (
                    <button
                      type="button"
                      key={o.id}
                      className={`ask-opt${on ? ' selected' : ''}`}
                      role={q.multi ? 'checkbox' : 'radio'}
                      aria-checked={on}
                      onClick={() => toggle(qi, o.id, q.multi)}
                    >
                      {on && <Icon name="check" />} {o.label}
                    </button>
                  )
                })}
              </div>
              {chosen.includes('other') && !readonly && (
                <input
                  className="ask-other-input"
                  type="text"
                  aria-label={`${q.question} · 其他`}
                  placeholder={q.noteHint || '填写具体内容，例如：6.6–6.13'}
                  value={custom[qi] || ''}
                  onChange={e => setCustom(prev => ({ ...prev, [qi]: e.target.value }))}
                />
              )}
              {!readonly && askInputOf(q) === 'city' && (
                <div className="ask-picker">
                  <Icon name="pin" />
                  <input
                    className="ask-picker-input"
                    type="text"
                    list={cityListId}
                    aria-label={`${q.question} · 城市`}
                    placeholder="输入或选择城市，如：成都"
                    value={picked[qi] || ''}
                    onChange={e => setPicked(prev => ({ ...prev, [qi]: e.target.value }))}
                  />
                </div>
              )}
              {!readonly && askInputOf(q) === 'date' && (
                <div className="ask-picker">
                  <Icon name="calendar" />
                  <input
                    className="ask-picker-input"
                    type="date"
                    aria-label={`${q.question} · 日期`}
                    value={picked[qi] || ''}
                    onChange={e => setPicked(prev => ({ ...prev, [qi]: e.target.value }))}
                  />
                  <span className="ask-picker-hint">选具体日期，返程可在备注里写</span>
                </div>
              )}
              {(chosen.length > 0 || (picked[qi] || '').trim().length > 0) && !readonly && (
                <button
                  type="button"
                  className={`ask-note-toggle${notes[qi]?.trim() ? ' filled' : ''}`}
                  aria-expanded={!!noteOpen[qi]}
                  onClick={() => setNoteOpen(prev => ({ ...prev, [qi]: !prev[qi] }))}
                >
                  <Icon name="edit" />
                  {notes[qi]?.trim() ? '备注已填' : '加备注'}
                  <Icon name={noteOpen[qi] ? 'caretDown' : 'caretRight'} />
                </button>
              )}
              {noteOpen[qi] && !readonly && (
                <div className="ask-note visible">
                  <label>备注（可选）</label>
                  <textarea
                    rows={1}
                    placeholder={q.noteHint || q.options[0]?.noteHint || '补充说明…'}
                    value={notes[qi] || ''}
                    onChange={e => setNotes(prev => ({ ...prev, [qi]: e.target.value }))}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
      <datalist id={cityListId}>
        {DEPARTURE_CITIES.map(city => (
          <option value={city} key={city} />
        ))}
      </datalist>
      <div className={`ask-free-input${freeMode ? ' visible' : ''}`}>
        <div className="fi-row">
          <input
            ref={freeInputRef}
            type="text"
            placeholder="直接输入你的想法…"
            aria-label="自由输入"
            value={freeText}
            onChange={e => setFreeText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') submitFree()
            }}
          />
          <button className="btn btn-primary btn-sm" type="button" onClick={submitFree}>
            发送
          </button>
        </div>
      </div>
      {hint && (
        <div className="ask-hint" role="status">
          <Icon name="info" /> {hint}
        </div>
      )}
      {!freeMode && (
        <div className="ask-card-foot">
          {ask.allowSkip !== false && !readonly ? (
            <button type="button" className="ask-skip foot-skip" onClick={() => openFree('')}>
              <Icon name="chat" /> 跳过这些，直接和 AI 沟通
            </button>
          ) : (
            <span className="foot-hint">选择选项后可提交；没选的题按默认处理</span>
          )}
          <button className="btn btn-primary ask-submit" type="button" onClick={submit}>
            下一步 <Icon name="arrowUpRight" />
          </button>
        </div>
      )}
    </div>
  )
}

function AnsweredAsk({ ask, answer }: { ask: AskUser; answer?: { answers: AskAnswerData[]; freeText?: string | null } }) {
  const rows = ask.questions.map((q, qi) => {
    const ans = answer?.answers.find(a => a.questionIndex === qi)
    const labels = (ans?.optionIds || [])
      .map(id => q.options.find(o => o.id === id)?.label || id)
      .join('、')
    if (!labels && !ans?.note && !ans?.value) return null
    return (
      <div className="ask-answered-row" key={qi}>
        <span className="aq">{q.question}</span>
        <span className="av">{labels || ans?.value || '—'}</span>
        {labels && ans?.value ? <span className="an">{ans.value}</span> : null}
        {ans?.note ? <span className="an">备注：{ans.note}</span> : null}
      </div>
    )
  })
  return (
    <div className="ask-card answered">
      <div className="ask-card-head">
        <Icon name="checkCircle" />
        <span className="ask-head-title">已回答</span>
        <span className="chip ask-badge">
          <Icon name="lock" /> 只读
        </span>
      </div>
      {rows}
      {answer?.freeText ? (
        <div className="ask-answered-row">
          <span className="aq">自由输入</span>
          <span className="av">{answer.freeText}</span>
        </div>
      ) : null}
    </div>
  )
}

export function ReadyCard({
  trip,
  derived,
  onBooking,
}: {
  trip: Trip
  derived: NonNullable<ReturnType<typeof useTripStore.getState>['derived']>
  onBooking: () => void
}) {
  const stops = trip.days.reduce((n, d) => n + d.stops.length, 0)
  const conflicts = derived.conflicts
  const errors = conflicts.filter(c => c.severity === 'error').length
  const bookingCount = derived.bookingTimeline.length
  return (
    <div className="ready-card">
      <div className="ready-head">
        <span className="rh-icon">
          <Icon name="route" />
        </span>
        <div>
          <div className="rh-title">行程就绪 · {trip.title || '北疆大环线'}</div>
          <div className="rh-sub">
            {trip.days.length} 天 · {fmtDate(trip.constraints.dateRange?.start)}–{fmtDate(trip.constraints.dateRange?.end)} ·{' '}
            {trip.constraints.travelers} 人 · {trip.constraints.origin || '出发地'}往返
          </div>
        </div>
      </div>
      <div className="ready-stats">
        <div className="od-stat">
          <span className="st-num">{trip.days.length}</span>
          <span className="st-cap">天</span>
        </div>
        <div className="od-stat">
          <span className="st-num">{stops}</span>
          <span className="st-cap">地点</span>
        </div>
        <div className="od-stat">
          <span className="st-num">¥{(derived.budgetSummary.grandTotal / 10000).toFixed(1)}w</span>
          <span className="st-cap">总预算({trip.constraints.travelers}人)</span>
        </div>
        <div className="od-stat">
          <span className="st-num">{bookingCount}</span>
          <span className="st-cap">待预订项</span>
        </div>
      </div>
      <div className="ready-days">
        {trip.days.map(d => (
          <div className="ready-day-row" style={{ ['--day-color' as string]: `var(--day-${((d.dayIndex - 1) % 12) + 1})` } as React.CSSProperties} key={d.dayIndex}>
            <span className="rd-swatch" />
            <span className="rd-day">Day {d.dayIndex}</span>
            <span className="rd-date">{fmtDate(d.date)}</span>
            <span className="rd-theme">{d.theme}</span>
          </div>
        ))}
      </div>
      <div className="ready-foot">
        <span className="rf-note">
          {conflicts.length > 0 ? (
            <>
              <Icon name="warn" /> {errors} 项错误 · {conflicts.length - errors} 项警告待处理（见冲突面板）
            </>
          ) : (
            <>
              <Icon name="checkCircle" /> 校验通过，没有遗留冲突
            </>
          )}
        </span>
        <button className="btn btn-sm" type="button" onClick={onBooking}>
          <Icon name="calendar" /> 预订提醒清单
        </button>
      </div>
    </div>
  )
}

export function Assumptions({ items }: { items: string[] }) {
  const addContextTag = useUiStore(s => s.addContextTag)
  const focusComposer = useUiStore(s => s.focusComposer)
  const readonly = useTripStore(s => s.readonly)
  if (!items.length) return null
  return (
    <div className="assumption-note">
      <Icon name="info" />
      <span>
        {items.join('；')}。
        {!readonly && (
          <span
            className="an-edit"
            role="button"
            tabIndex={0}
            onClick={() => {
              addContextTag({ kind: 'assumption', label: '行程假设' })
              focusComposer()
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                addContextTag({ kind: 'assumption', label: '行程假设' })
                focusComposer()
              }
            }}
          >
            修改假设
          </span>
        )}
      </span>
    </div>
  )
}

export function ConflictChip({ conflict }: { conflict: { type: string; severity: string; message: string } }) {
  return (
    <span className={`chip ${conflict.severity === 'error' ? 'chip-error' : 'chip-warning'}`}>
      <Icon name={conflict.severity === 'error' ? 'xCircle' : 'warn'} /> {conflictTypeLabel[conflict.type] || conflict.type}
    </span>
  )
}
