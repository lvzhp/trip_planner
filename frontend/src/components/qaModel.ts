import type { SseEvent } from '../types'

/**
 * 单会话双渲染的分流模型（docs/07 §8）。
 *
 * turn_kind 不需要后端字段：`plan_patch` 事件当且仅当写工具成功时发出，
 * `ask_user` 本身是独立事件类型 —— 前端按 turnId 分组即可权威派生：
 *   含 plan_patch 或 ask_user → plan 侧（对话栏全文）
 *   否则 → qa（问答段全文 + 对话栏存根）
 *
 * qa 的归属 stop：发起提问的 user message 带 contextTags（kind=stop），
 * 同 turn 的 assistant 回答继承该 stopId。
 */

export type TurnKind = 'plan' | 'qa'

export interface TurnInfo {
  turnId: string
  kind: TurnKind
  /** qa turn 归属的 stop（来自提问时挂的上下文标签） */
  stopId: string | null
  stopLabel: string | null
  dayIndex: number | null
}

export interface QaItem {
  seq: number
  turnId: string
  question: string
  answer: string
  stopId: string
}

/** 对话栏存根：`💬 禾木村 · 问停车` + 回答首句截断。 */
export interface QaStub {
  seq: number
  turnId: string
  stopId: string
  stopLabel: string
  question: string
  answer: string
  snippet: string
}

/** 按 turn 汇总事件，派生 kind 与归属 stop。 */
export function analyzeTurns(events: SseEvent[]): Map<string, TurnInfo> {
  const turns = new Map<string, TurnInfo>()
  const ensure = (turnId: string): TurnInfo => {
    let t = turns.get(turnId)
    if (!t) {
      t = { turnId, kind: 'qa', stopId: null, stopLabel: null, dayIndex: null }
      turns.set(turnId, t)
    }
    return t
  }
  for (const ev of events) {
    const turnId = ev.turnId || `seq-${ev.seq}`
    const t = ensure(turnId)
    if (ev.type === 'plan_patch' || ev.type === 'ask_user') {
      t.kind = 'plan'
    }
    if (ev.type === 'message') {
      const p = ev.payload || {}
      if (p.role === 'user' && Array.isArray(p.contextTags)) {
        const tag = p.contextTags.find((x: any) => x && x.kind === 'stop' && x.id)
        if (tag) {
          t.stopId = String(tag.id)
          t.stopLabel = String(tag.label || '').split(' · ')[0]
          t.dayIndex = tag.dayIndex ?? null
        }
      }
    }
  }
  return turns
}

/** 某 stop 的问答历史（详情视图·问答段）。

 * 只收 qa turn：question = 该 turn 的首条 user 消息；answer = 该 turn 全部
 * assistant 消息按序拼接（一个回合可能分多条文本输出，中间还夹着检索工具）。
 */
export function collectStopQa(events: SseEvent[], stopId: string): QaItem[] {
  const turns = analyzeTurns(events)
  const order: string[] = []
  const byTurn = new Map<string, { question: string; answers: string[]; lastSeq: number }>()
  for (const ev of events) {
    if (ev.type !== 'message') continue
    const turnId = ev.turnId || `seq-${ev.seq}`
    const info = turns.get(turnId)
    if (!info || info.kind !== 'qa' || info.stopId !== stopId) continue
    const p = ev.payload || {}
    if (p.hidden) continue
    let bucket = byTurn.get(turnId)
    if (!bucket) {
      bucket = { question: '', answers: [], lastSeq: ev.seq }
      byTurn.set(turnId, bucket)
      order.push(turnId)
    }
    if (p.role === 'user' && !bucket.question) {
      bucket.question = String(p.text || '')
    } else if (p.role === 'assistant') {
      const text = String(p.text || '').trim()
      if (text) {
        bucket.answers.push(text)
        bucket.lastSeq = ev.seq
      }
    }
  }
  const out: QaItem[] = []
  for (const turnId of order) {
    const bucket = byTurn.get(turnId)!
    if (!bucket.question || !bucket.answers.length) continue
    out.push({
      seq: bucket.lastSeq,
      turnId,
      question: bucket.question,
      answer: bucket.answers.join('\n\n'),
      stopId,
    })
  }
  return out
}

/** 对话栏渲染用：qa turn 折叠为存根，plan turn 保持全文。 */
export function buildQaStubs(events: SseEvent[]): Map<string, QaStub> {
  const turns = analyzeTurns(events)
  const stubs = new Map<string, QaStub>()
  const firstUser = new Map<string, { text: string; seq: number }>()
  const lastAnswer = new Map<string, { text: string; seq: number }>()
  for (const ev of events) {
    if (ev.type !== 'message') continue
    const turnId = ev.turnId || `seq-${ev.seq}`
    const info = turns.get(turnId)
    if (!info || info.kind !== 'qa' || !info.stopId) continue
    const p = ev.payload || {}
    if (p.hidden) continue
    if (p.role === 'user' && !firstUser.has(turnId)) {
      firstUser.set(turnId, { text: String(p.text || ''), seq: ev.seq })
    } else if (p.role === 'assistant' && String(p.text || '').trim()) {
      lastAnswer.set(turnId, { text: String(p.text), seq: ev.seq })
    }
  }
  for (const [turnId, q] of firstUser) {
    const info = turns.get(turnId)!
    const a = lastAnswer.get(turnId)
    if (!a) continue
    stubs.set(turnId, {
      seq: a.seq,
      turnId,
      stopId: info.stopId!,
      stopLabel: info.stopLabel || '该地点',
      question: q.text,
      answer: a.text,
      snippet: snippetOf(a.text),
    })
  }
  return stubs
}

function snippetOf(text: string): string {
  const plain = text
    .replace(/[#*>`_\-\[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > 24 ? plain.slice(0, 24) + '…' : plain
}

/** 该 stop 是否有一轮 qa 正在进行（用户已提问、assistant 还没回）。
 * 用于问答段的"正在回答"指示——流式期间回答还没落成消息事件。 */
export function pendingStopQa(events: SseEvent[], stopId: string): boolean {
  const turns = analyzeTurns(events)
  const answered = new Set<string>()
  for (const ev of events) {
    if (ev.type !== 'message') continue
    const p = ev.payload || {}
    if (p.role === 'assistant' && String(p.text || '').trim()) answered.add(ev.turnId || `seq-${ev.seq}`)
  }
  for (const [turnId, info] of turns) {
    if (info.kind === 'qa' && info.stopId === stopId && !answered.has(turnId)) return true
  }
  return false
}
