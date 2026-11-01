import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { AskUserAnswer } from '../types'
import { useTripStore } from '../stores/tripStore'
import { useUiStore } from '../stores/uiStore'
import { buildChatItems, type ChatQaStubItem } from './chatModel'
import { AskCard, AssistantMessage, Assumptions, ReadyCard, ThinkingNote, ToolGroup, UserMessage } from './messages'
import { Composer, type ComposerHandle } from './Composer'
import { Icon } from '../lib/icons'
import { toast } from '../lib/toast'
import { Markdown } from '../lib/markdown'
import { SubagentView } from './SubagentView'

/** qa 回合在对话栏的存根（docs/07 §8）：一行摘要，点击跳 stop 详情·问答段并高亮该条。 */
function QaStub({ item, onOpen }: { item: ChatQaStubItem; onOpen: () => void }) {
  return (
    <div className="msg-ai qa-stub-row">
      <span className="avatar">
        <Icon name="chat" />
      </span>
      <button className="qa-stub" type="button" onClick={onOpen} title="查看完整回答">
        <span className="qa-stub-title">
          💬 {item.stopLabel} · {item.question.length > 18 ? item.question.slice(0, 18) + '…' : item.question}
        </span>
        {item.snippet && <span className="qa-stub-snippet">{item.snippet}</span>}
        <span className="qa-stub-more">
          查看 <Icon name="chevronRight" />
        </span>
      </button>
    </div>
  )
}

interface Props {
  composerRef: React.MutableRefObject<ComposerHandle | null>
  onSend: (text: string) => void
  onAskAnswer: (askId: string | null, answers: AskUserAnswer[], freeText: string | null) => void
  onSlash: (command: string) => boolean
}

export function ChatPane({ composerRef, onSend, onAskAnswer, onSlash }: Props) {
  const events = useTripStore(s => s.events)
  const trip = useTripStore(s => s.trip)
  const sending = useTripStore(s => s.sending)
  const sendError = useTripStore(s => s.sendError)
  const readonly = useTripStore(s => s.readonly)
  const derived = useTripStore(s => s.derived)
  const openDrawer = useUiStore(s => s.openDrawer)
  const scrollRef = useRef<HTMLDivElement>(null)
  const items = useMemo(() => buildChatItems(events), [events])
  const hasReady = items.some(item => item.kind === 'assistant' && item.card === 'ready')

  useLayoutEffect(() => {
    const host = scrollRef.current
    if (!host) return
    const id = window.setTimeout(() => {
      host.scrollTop = host.scrollHeight
    }, 30)
    return () => window.clearTimeout(id)
  }, [items.length, sending])

  useEffect(() => {
    if (sendError) toast(`发送失败：${sendError}`, 'xCircle')
  }, [sendError])

  const activeSubagentId = useUiStore(s => s.activeSubagentId)
  const closeSubagent = useUiStore(s => s.closeSubagent)

  // 子 Agent 独立视图：整个对话区切换，没有 Composer（子 Agent 只读、不支持对话）
  if (activeSubagentId) {
    return (
      <section className="chat-pane subagent-pane" aria-label="子 Agent 运行详情">
        <SubagentView runKey={activeSubagentId} onBack={closeSubagent} />
      </section>
    )
  }

  return (
    <section className="chat-pane" id="chat-pane" aria-label="对话区">
      <div className="chat-scroll" id="chat-scroll" ref={scrollRef}>
        {items.length === 0 && !sending && !trip?.days.length && (
          <div className="chat-empty">
            <span className="ce-logo">
              <Icon name="logo" />
            </span>
            <h2>把一次旅行，聊成一份行程</h2>
            <p>
              说目的地、时间和偏好，我会用高德检索地点、算清路程，写成一份可在地图上改的行程文档。
            </p>
            <div className="ce-suggestions">
              {[
                '马上五一了，我想去新疆旅游，给个推荐路线',
                '端午想找个周末去安吉自驾，别太赶',
                '带爸妈去大理 5 天，节奏慢一点',
              ].map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    composerRef.current?.setText(s)
                    composerRef.current?.focus()
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
            <button className="btn btn-sm" type="button" onClick={() => openDrawer('booking')}>
              <Icon name="calendar" /> 查看预订提醒
            </button>
          </div>
        )}

        {items.map((item, index) => {
          if (item.kind === 'user') return <UserMessage item={item} key={`u-${item.event.seq}`} />
          if (item.kind === 'assistant') return <AssistantMessage item={item} key={`a-${item.event.seq}`} />
          if (item.kind === 'qa-stub')
            return (
              <QaStub
                key={item.key}
                item={item}
                onOpen={() =>
                  useUiStore.getState().openStopDetail(item.stopId, { tab: 'qa', scrollToSeq: item.seq })
                }
              />
            )
          if (item.kind === 'tool-group') return <ToolGroup group={item} key={item.key} />
          if (item.kind === 'ask')
            return (
              <AskCard
                key={`ask-${item.key}`}
                ask={item.ask}
                answer={item.answer}
                readonly={readonly}
                onAnswer={onAskAnswer}
              />
            )
          if (item.kind === 'thinking') return <ThinkingNote key={item.key} text={item.text} />
          return null
        })}

        {trip && trip.days.length > 0 && derived && !hasReady && (
          <div className="msg-ai saved-trip-intro">
            <span className="avatar"><Icon name="sparkle" /></span>
            <div style={{ minWidth: 0, flex: 1 }}>
              {items.length === 0 && (
                <Markdown>
                  {`这份 **${trip.title || '行程'}** 已保存在服务端。点任意卡片上的「改这里」，或直接告诉我想怎么改。`}
                </Markdown>
              )}
              <ReadyCard trip={trip} derived={derived} onBooking={() => openDrawer('booking')} />
              <Assumptions items={trip.constraints.assumptions || []} />
            </div>
          </div>
        )}

        {sending && (
          <div className="msg-ai typing-row">
            <span className="avatar">
              <Icon name="sparkle" />
            </span>
            <div className="typing">
              <span className="spinner spinner-sm" /> Trace 正在检索与重排…
            </div>
          </div>
        )}
        {trip && !trip.days.length && items.length === 0 && <div style={{ height: 1 }} />}
      </div>
      <Composer ref={composerRef} onSend={onSend} onSlash={onSlash} />
    </section>
  )
}
