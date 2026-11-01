import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTripStore } from '../stores/tripStore'
import { useListStore } from '../stores/listStore'
import { useUiStore } from '../stores/uiStore'
import { useSpeechRecognition } from '../lib/speech'
import { hapticTap } from '../platform/shell'
import { Icon } from '../lib/icons'

interface Props {
  open: boolean
  onClose: () => void
}

const SUGGESTIONS = [
  '五一去新疆 8 天，上海出发，想自驾',
  '周末去安吉，带爸妈慢游，节奏松一点',
  '帮我把 Day 3 排轻松一点，下午再出发',
]

/**
 * 底部「按住说 / 规划」面板。
 *
 * 借鉴高德「按住说话」的入口，但不是语音助手：识别出的文字会先落到文本框，
 * 用户可以改完再开始规划；不支持语音的宿主明确降级为键盘输入。
 */
export function MobilePlanSheet({ open, onClose }: Props) {
  const navigate = useNavigate()
  const onTripPage = useLocation().pathname.startsWith('/t/')
  const trip = useTripStore(s => s.trip)
  const readonly = useTripStore(s => s.readonly)
  const createTrip = useListStore(s => s.createTrip)
  const setPendingPrompt = useUiStore(s => s.setPendingPrompt)
  const [text, setText] = useState('')
  const [target, setTarget] = useState<'current' | 'new'>('new')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const speech = useSpeechRecognition({
    onFinal: chunk => {
      setText(prev => (prev ? `${prev}${/[。！？!?，,]$/.test(prev) ? '' : ' '}` : '') + chunk)
      hapticTap('light')
    },
  })

  const canContinue = Boolean(trip && !readonly)

  useEffect(() => {
    if (!open) {
      speech.stop()
      return
    }
    setText('')
    setTarget(onTripPage && canContinue ? 'current' : 'new')
    setError(null)
    speech.setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const prompt = [text.trim(), speech.listening ? speech.interim.trim() : ''].filter(Boolean).join(' ').trim()

  const submit = async () => {
    if (!prompt) {
      setError('先按住说一句，或者直接输入你想怎么玩。')
      textareaRef.current?.focus()
      return
    }
    setBusy(true)
    setError(null)
    try {
      let id = target === 'current' && canContinue ? trip?.tripId || '' : ''
      if (!id) {
        id = (await createTrip(prompt.replace(/\s+/g, ' ').slice(0, 24))) || ''
        if (!id) throw new Error('新建行程失败，请稍后再试')
      }
      setPendingPrompt(prompt, id)
      onClose()
      navigate(`/t/${id}/chat`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请稍后再试')
    } finally {
      setBusy(false)
    }
  }

  const continueChat = () => {
    if (!trip) return
    speech.stop()
    onClose()
    navigate(`/t/${trip.tripId}/chat`)
  }

  const onMicDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
    const started = speech.start()
    if (!started && !speech.supported) textareaRef.current?.focus()
  }

  const onMicUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    speech.stop()
  }

  return (
    <div className="plan-sheet-scrim" role="dialog" aria-modal="true" aria-label="开始规划" onClick={onClose}>
      <div className="plan-sheet" onClick={event => event.stopPropagation()}>
        <div className="plan-sheet-grip" aria-hidden="true" />
        <div className="plan-sheet-head">
          <div>
            <div className="plan-sheet-title">
              <Icon name="sparkle" /> 说一句，开始规划
            </div>
            <p className="plan-sheet-sub">按住说话，松开转成文字；也可以直接输入。</p>
          </div>
          <button className="icon-btn" type="button" aria-label="关闭" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>

        {canContinue && (
          <div className="plan-target" role="tablist" aria-label="发送到哪个行程">
            <button
              type="button"
              role="tab"
              aria-selected={target === 'current'}
              className={target === 'current' ? 'active' : ''}
              onClick={() => setTarget('current')}
            >
              继续当前行程
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={target === 'new'}
              className={target === 'new' ? 'active' : ''}
              onClick={() => setTarget('new')}
            >
              新建行程
            </button>
          </div>
        )}

        <div className={`plan-voice${speech.listening ? ' listening' : ''}`}>
          <button
            type="button"
            className={`plan-mic${speech.listening ? ' listening' : ''}`}
            aria-label="按住说话"
            onPointerDown={onMicDown}
            onPointerUp={onMicUp}
            onPointerCancel={() => speech.stop()}
            onContextMenu={event => event.preventDefault()}
          >
            <span className="plan-mic-orb">
              <Icon name="mic" />
            </span>
            <span className="plan-mic-label">{speech.listening ? '正在听… 松开结束' : '按住说话'}</span>
            {speech.listening && (
              <span className="plan-wave" aria-hidden="true">
                <i /><i /><i /><i /><i />
              </span>
            )}
          </button>
          <div className="plan-interim" aria-live="polite">
            {speech.interim || (speech.listening ? '说出目的地、天数、同行人、交通方式…' : '')}
          </div>
        </div>

        <div className="plan-input-wrap">
          <textarea
            ref={textareaRef}
            className="plan-input"
            rows={3}
            value={text}
            onChange={event => {
              setText(event.target.value)
              setError(null)
              if (speech.error) speech.setError(null)
            }}
            placeholder="例如：五一去新疆 8 天，上海出发，想自驾，节奏别太赶…"
          />
          <div className="plan-suggestions">
            {SUGGESTIONS.map(item => (
              <button key={item} type="button" className="plan-suggestion" onClick={() => setText(item)}>
                {item}
              </button>
            ))}
          </div>
        </div>

        {!speech.supported && (
          <div className="plan-hint">
            <Icon name="info" /> 当前宿主不支持网页语音识别，直接打字即可；小程序真机语音需要原生录音 + ASR 服务。
          </div>
        )}
        {(error || speech.error) && <div className="plan-error">{error || speech.error}</div>}

        <div className="plan-actions">
          <button className="btn plan-submit" type="button" onClick={() => void submit()} disabled={busy || !prompt}>
            {busy ? <span className="spinner spinner-sm" /> : <Icon name="send" />}
            {target === 'current' && canContinue ? '发送给当前行程' : '新建并开始规划'}
          </button>
          {canContinue && (
            <button className="plan-continue" type="button" onClick={continueChat}>
              <Icon name="chat" /> 继续《{shortTitle(trip?.title)}》的对话
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function shortTitle(title?: string | null): string {
  const value = (title || '当前行程').trim()
  return value.length > 14 ? `${value.slice(0, 14)}…` : value
}
