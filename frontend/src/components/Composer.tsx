import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useUiStore } from '../stores/uiStore'
import { useTripStore } from '../stores/tripStore'
import { Icon } from '../lib/icons'

export interface ComposerHandle {
  focus: () => void
  setText: (text: string) => void
}

interface Props {
  onSend: (text: string) => void
  onSlash: (command: string) => boolean
}

export const Composer = forwardRef<ComposerHandle | null, Props>(function Composer({ onSend, onSlash }, ref) {
  const [text, setText] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const chips = useUiStore(s => s.composerContext)
  const removeChip = useUiStore(s => s.removeContextTag)
  const placeholder = useUiStore(s => s.composerPlaceholder)
  const focusNonce = useUiStore(s => s.composerFocusNonce)
  const sending = useTripStore(s => s.sending)
  const stop = useTripStore(s => s.stop)
  const readonly = useTripStore(s => s.readonly)

  const grow = () => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'
  }

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
    setText: (v: string) => {
      setText(v)
      window.setTimeout(grow, 0)
    },
  }))

  useEffect(() => {
    if (focusNonce > 0) {
      window.setTimeout(() => taRef.current?.focus(), 20)
    }
  }, [focusNonce])

  useEffect(() => {
    grow()
  }, [text])

  if (readonly) {
    return (
      <div className="composer-wrap readonly-note">
        <Icon name="eye" /> 只读分享视图 · 对话与编辑入口已隐藏
      </div>
    )
  }

  const submit = () => {
    const value = text.trim()
    if (!value || sending) return
    if (value.startsWith('/')) {
      const handled = onSlash(value.split(/\s+/)[0].toLowerCase())
      if (handled) {
        setText('')
        window.setTimeout(grow, 0)
        return
      }
    }
    setText('')
    window.setTimeout(grow, 0)
    onSend(value)
  }

  return (
    <div className="composer-wrap">
      <div className="ctx-chips-bar" aria-label="上下文标签">
        {chips.map((c, i) => (
          <span className="ctx-chip-input" key={`${c.kind}-${c.id || c.label}-${i}`}>
            <Icon name="pin" /> @{c.label}
            <button type="button" aria-label={`移除上下文标签 ${c.label}`} onClick={() => removeChip(i)}>
              <Icon name="x" className="chip-x" />
            </button>
          </span>
        ))}
      </div>
      <div className={`composer${sending ? ' disabled' : ''}`}>
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          placeholder={placeholder}
          disabled={sending}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button
          className={`send-btn${sending ? ' stop' : ''}`}
          type="button"
          aria-label={sending ? '停止生成' : '发送'}
          title={sending ? '停止生成' : '发送'}
          onClick={() => (sending ? stop() : submit())}
        >
          <Icon name={sending ? 'stop' : 'send'} />
        </button>
      </div>
      <div className="composer-hint">
        <span>
          <kbd>Enter</kbd> 发送 · <kbd>Shift+Enter</kbd> 换行
        </span>
        <span className="slash-cmd" data-cmd="/replan" onClick={() => onSlash('/replan')}>
          /replan
        </span>
        <span className="slash-cmd" data-cmd="/booking" onClick={() => onSlash('/booking')}>
          /booking
        </span>
        <span className="slash-cmd" data-cmd="/conflicts" onClick={() => onSlash('/conflicts')}>
          /conflicts
        </span>
        <span className="slash-cmd" data-cmd="/history" onClick={() => onSlash('/history')}>
          /history
        </span>
      </div>
    </div>
  )
})
