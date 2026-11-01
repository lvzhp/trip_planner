import type { MessageSegment, SseEvent, Trip } from '../types'
import { analyzeTurns, buildQaStubs } from './qaModel'

export interface AskAnswerData {
  questionIndex: number
  optionIds: string[]
  note: string
  freeText?: string | null
  /** 选择器（城市/日期）里填的值 */
  value?: string | null
}

export interface ChatUserItem {
  kind: 'user'
  event: SseEvent
  text: string
  at?: string
  contextTags: any[]
}
export interface ChatAssistantItem {
  kind: 'assistant'
  event: SseEvent
  text: string
  at?: string
  card?: string | null
  error?: boolean
  /** 服务端序列化的消息片段（地点 chip / 路程 chip）。旧消息没有 → 渲染纯文本 */
  segments?: MessageSegment[] | null
}
export interface ChatToolItem {
  kind: 'tools'
  key: string
  /** 事件所属回合：子 Agent 详情用它拼 key（同一 task_id 跨回合不冲突） */
  turnId?: string
  call: { callId?: string; tool: string; args: any; summary?: string; verbose?: string }
  result?: any
}
export interface ChatToolGroup {
  kind: 'tool-group'
  key: string
  items: ChatToolItem[]
  thinking?: string
}
export interface ChatAskItem {
  kind: 'ask'
  key: string
  ask: any
  answer?: { answers: AskAnswerData[]; freeText?: string | null }
}
export interface ChatThinkingItem {
  kind: 'thinking'
  key: string
  text: string
}
/** qa turn 在对话栏的折叠存根（docs/07 §8）：完整回答在 stop 详情的问答段。 */
export interface ChatQaStubItem {
  kind: 'qa-stub'
  key: string
  stopId: string
  stopLabel: string
  question: string
  snippet: string
  seq: number
}
export type ChatItem =
  | ChatUserItem
  | ChatAssistantItem
  | ChatToolGroup
  | ChatAskItem
  | ChatThinkingItem
  | ChatQaStubItem

export function collectAnswers(events: SseEvent[]): Record<string, { answers: AskAnswerData[]; freeText?: string | null }> {
  const out: Record<string, { answers: AskAnswerData[]; freeText?: string | null }> = {}
  for (const event of events) {
    if (event.type !== 'message') continue
    const p = event.payload || {}
    if (!p.hidden || !p.answerTo) continue
    const mapped = (p.answers || []).map((a: any) => ({
      questionIndex: a.questionIndex ?? 0,
      optionIds: a.optionIds || [],
      note: a.note || '',
      freeText: a.freeText ?? null,
      value: a.value ?? null,
    }))
    out[p.answerTo] = {
      answers: mapped,
      freeText: p.freeText ?? (!mapped.length ? p.text || null : null),
    }
  }
  return out
}

export function buildChatItems(events: SseEvent[]): ChatItem[] {
  const items: ChatItem[] = []
  const answers = collectAnswers(events)
  // qa turn 在对话栏折叠为一条存根（docs/07 §8）。先按 turn 汇总，
  // 走到该 turn 的第一个事件时吐存根，其余事件全部跳过。
  const turnInfo = analyzeTurns(events)
  const stubs = buildQaStubs(events)
  const emittedStubs = new Set<string>()
  const isQaTurn = (ev: SseEvent): string | null => {
    const turnId = ev.turnId || `seq-${ev.seq}`
    const info = turnInfo.get(turnId)
    if (info && info.kind === 'qa' && info.stopId) return turnId
    return null
  }
  let i = 0
  while (i < events.length) {
    const ev = events[i]
    const qaTurn = isQaTurn(ev)
    if (qaTurn) {
      // 该 turn 的存根只在首次遇到时渲染一次；其余事件（含工具组）跳过
      if (!emittedStubs.has(qaTurn)) {
        const stub = stubs.get(qaTurn)
        if (stub) {
          items.push({
            kind: 'qa-stub',
            key: `qa-${qaTurn}`,
            stopId: stub.stopId,
            stopLabel: stub.stopLabel,
            question: stub.question,
            snippet: stub.snippet,
            seq: stub.seq,
          })
        }
        emittedStubs.add(qaTurn)
      }
      i++
      continue
    }
    if (ev.type === 'plan_patch') {
      i++
      continue
    }
    if (ev.type === 'message') {
      const p = ev.payload || {}
      if (p.hidden) {
        i++
        continue
      }
      if (p.role === 'user') {
        items.push({
          kind: 'user',
          event: ev,
          text: p.text || '',
          at: p.at,
          contextTags: p.contextTags || [],
        })
      } else {
        items.push({
          kind: 'assistant',
          event: ev,
          text: p.text || '',
          at: p.at,
          card: p.kind || null,
          error: !!p.error,
          segments: Array.isArray(p.segments) ? (p.segments as MessageSegment[]) : null,
        })
      }
      i++
      continue
    }
    if (ev.type === 'ask_user') {
      const p = ev.payload || {}
      const key = p.askId || ev.turnId || String(ev.seq)
      items.push({ kind: 'ask', key, ask: p, answer: answers[key] })
      i++
      continue
    }
    if (ev.type === 'thinking') {
      // collect adjacent tool calls into a group; standalone thinking gets a row
      let j = i + 1
      while (
        j < events.length &&
        (events[j].type === 'thinking' ||
          events[j].type === 'tool_call' ||
          events[j].type === 'tool_result' ||
          // 子 Agent 进度事件夹在 tool_call / tool_result 之间，不能把一次工具调用拆成两组
          events[j].type === 'subagent')
      )
        j++
      const slice = events.slice(i, j)
      const hasTools = slice.some(x => x.type === 'tool_call')
      if (!hasTools) {
        const text = slice.map(x => x.payload?.text || '').filter(Boolean).join('\n')
        if (text) items.push({ kind: 'thinking', key: `think-${ev.seq}`, text })
        i = j
        continue
      }
      const group = buildToolGroup(slice, `group-${ev.seq}`)
      if (group) items.push(group)
      i = j
      continue
    }
    if (ev.type === 'tool_call' || ev.type === 'tool_result') {
      let j = i
      while (
        j < events.length &&
        (events[j].type === 'tool_call' ||
          events[j].type === 'tool_result' ||
          events[j].type === 'thinking' ||
          events[j].type === 'subagent')
      )
        j++
      const group = buildToolGroup(events.slice(i, j), `group-${ev.seq}`)
      if (group) items.push(group)
      i = j
      continue
    }
    i++
  }
  return items
}

function buildToolGroup(events: SseEvent[], key: string): ChatToolGroup | null {
  const calls: Record<string, ChatToolItem> = {}
  const order: string[] = []
  let thinking = ''
  for (const ev of events) {
    if (ev.type === 'thinking') {
      thinking += (thinking ? '\n' : '') + (ev.payload?.text || '')
    } else if (ev.type === 'tool_call') {
      const p = ev.payload || {}
      const callId = p.callId || `call-${ev.seq}`
      calls[callId] = {
        kind: 'tools',
        key: callId,
        turnId: ev.turnId,
        call: { callId, tool: p.tool || 'tool', args: p.args || {}, summary: p.summary, verbose: p.verbose },
      }
      order.push(callId)
    } else if (ev.type === 'tool_result') {
      const p = ev.payload || {}
      const callId = p.callId || `call-${ev.seq}`
      if (!calls[callId]) {
        calls[callId] = {
          kind: 'tools',
          key: callId,
          call: { callId, tool: p.tool, args: {}, summary: p.summary },
        }
        order.push(callId)
      }
      calls[callId].result = p
    }
  }
  if (!order.length) return null
  return {
    kind: 'tool-group',
    key,
    items: order.map(id => calls[id]),
    thinking: thinking || undefined,
  }
}

export function toolIcon(tool: string): string {
  if (tool === 'search_poi' || tool === 'search_around' || tool === 'place_detail') return 'search'
  if (tool === 'plan_route' || tool === 'transport_info_lookup') return 'car'
  if (tool === 'web_search' || tool === 'fetch_page' || tool === 'dispatch_research') return 'search'
  if (tool === 'get_weather' || tool === 'climate_reference' || tool === 'sun_times') return 'weather'
  if (tool === 'draft_itinerary' || tool === 'update_itinerary') return 'route'
  if (
    tool === 'ticket_channel_lookup' ||
    tool === 'opening_hours_lookup' ||
    tool === 'closure_notice_lookup' ||
    tool === 'permit_policy_lookup'
  ) {
    return 'ticket'
  }
  if (tool === 'holiday_calendar') return 'calendar'
  if (tool === 'social_digest') return 'wechat'
  return 'sparkle'
}

export function findStop(trip: Trip | null, stopId: string) {
  if (!trip) return null
  for (const day of trip.days) {
    for (const stop of day.stops) {
      if (stop.stopId === stopId) return { day, stop }
    }
  }
  return null
}

export function findActivity(trip: Trip | null, activityId: string) {
  if (!trip) return null
  for (const day of trip.days) {
    for (const stop of day.stops) {
      for (const activity of stop.activities) {
        if (activity.activityId === activityId) return { day, stop, activity }
      }
    }
  }
  return null
}
