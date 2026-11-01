import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { useTripStore } from '../stores/tripStore'
import { useUiStore } from '../stores/uiStore'
import { Icon } from '../lib/icons'
import { toast } from '../lib/toast'
import { relativeTime } from '../lib/format'
import type { Thread } from '../types'

/**
 * 同行人评论 + `@助手`（P2-1）。
 *
 * 边界：不是 IM —— 没有已读/在线/推送；普通评论**不触发 AI**，只有 @助手 才触发；
 * `@助手` 的回复只读行程事实，改行程仍走主对话或行程抽屉。
 */
export function ThreadPanel() {
  const open = useUiStore(s => s.threadsOpen)
  const close = useUiStore(s => s.closeThreads)
  const tripId = useTripStore(s => s.tripId)
  const readonly = useTripStore(s => s.readonly)
  const [threads, setThreads] = useState<Thread[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || !tripId) return
    let alive = true
    setLoading(true)
    api
      .threads(tripId)
      .then(data => {
        if (!alive) return
        setThreads(data.threads || [])
        setActiveId(current => current ?? data.threads?.[0]?.threadId ?? null)
      })
      .catch(err => toast(err instanceof Error ? err.message : '评论加载失败', 'xCircle'))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [open, tripId])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, close])

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [activeId, threads])

  if (!open || !tripId) return null

  const active = threads.find(thread => thread.threadId === activeId) || null

  const createThread = async () => {
    const value = title.trim()
    if (!value) {
      toast('给这个话题起个名字', 'info')
      return
    }
    setCreating(true)
    try {
      const created = await api.createThread(tripId, value)
      setThreads(list => [...list, created])
      setActiveId(created.threadId)
      setTitle('')
    } catch (err) {
      toast(err instanceof Error ? err.message : '创建话题失败', 'xCircle')
    } finally {
      setCreating(false)
    }
  }

  const send = async (mention = false) => {
    const body = draft.trim()
    if (!body || !active || sending) return
    setSending(true)
    try {
      const payload = mention && !body.includes('@助手') ? `@助手 ${body}` : body
      const data = await api.addComment(active.threadId, payload)
      if (data.thread) {
        setThreads(list => list.map(thread => (thread.threadId === data.thread!.threadId ? data.thread! : thread)))
      }
      setDraft('')
      if (data.reply) toast('助手已回复', 'checkCircle')
    } catch (err) {
      toast(err instanceof Error ? err.message : '发送失败', 'xCircle')
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <div className="threads-scrim" role="presentation" onClick={close} />
      <aside className="threads-panel" role="dialog" aria-modal="false" aria-label="同行人评论">
        <header className="tp-head">
          <div>
            <h2>同行人评论</h2>
            <p>按话题讨论；只有 @助手 才会触发回复，普通评论不打扰行程。</p>
          </div>
          <button className="icon-btn" type="button" aria-label="关闭评论" onClick={close}>
            <Icon name="x" />
          </button>
        </header>

        <div className="threads-body">
          <div className="threads-list">
            {loading && (
              <div className="threads-loading">
                <span className="spinner" /> 加载中…
              </div>
            )}
            {!loading && threads.length === 0 && <div className="threads-empty">还没有话题。新建一个，比如「住宿怎么分」。</div>}
            {threads.map(thread => (
              <button
                key={thread.threadId}
                type="button"
                className={`thread-item${thread.threadId === activeId ? ' active' : ''}`}
                onClick={() => setActiveId(thread.threadId)}
              >
                <span className="ti-title">{thread.title}</span>
                <span className="ti-meta">
                  {thread.comments.length} 条 · {relativeTime(thread.createdAt)}
                </span>
              </button>
            ))}
            <div className="thread-create">
              <input
                type="text"
                value={title}
                placeholder="新话题标题"
                aria-label="新话题标题"
                onChange={event => setTitle(event.target.value)}
                onKeyDown={event => event.key === 'Enter' && void createThread()}
              />
              <button className="btn btn-sm" type="button" onClick={() => void createThread()} disabled={creating}>
                {creating ? <span className="spinner spinner-xs" /> : '新建话题'}
              </button>
            </div>
          </div>

          <div className="threads-detail">
            {active ? (
              <>
                <div className="thread-detail-head">
                  <strong>{active.title}</strong>
                  <span>{active.comments.length} 条评论</span>
                </div>
                <div className="thread-comments" ref={scrollRef}>
                  {active.comments.length === 0 && <div className="threads-empty">第一条评论就从这里开始。</div>}
                  {active.comments.map(comment => (
                    <div className={`thread-comment author-${comment.author}`} key={comment.commentId}>
                      <div className="tc-head">
                        <span className="tc-author">
                          {comment.author === 'assistant' ? '助手' : comment.author === 'companion' ? '同行人' : '我'}
                        </span>
                        <span className="tc-time">{relativeTime(comment.createdAt)}</span>
                        {comment.mentionsAssistant && <span className="tc-mention">@助手</span>}
                      </div>
                      <p>{comment.body}</p>
                    </div>
                  ))}
                </div>
                <div className="thread-composer">
                  <textarea
                    rows={2}
                    value={draft}
                    placeholder={readonly ? '只读分享不能评论' : '写点想法；需要助手回答就点「@助手」'}
                    aria-label="评论内容"
                    disabled={readonly}
                    onChange={event => setDraft(event.target.value)}
                    onKeyDown={event => {
                      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void send()
                    }}
                  />
                  <div className="thread-composer-actions">
                    <button type="button" className="btn btn-sm" disabled={readonly || !draft.trim()} onClick={() => void send(true)}>
                      @助手 提问
                    </button>
                    <button type="button" className="btn btn-sm btn-primary" disabled={readonly || !draft.trim() || sending} onClick={() => void send(false)}>
                      {sending ? <span className="spinner spinner-xs" /> : <Icon name="send" />} 评论
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="threads-empty">选一个话题，或新建一个。</div>
            )}
          </div>
        </div>
      </aside>
    </>
  )
}
