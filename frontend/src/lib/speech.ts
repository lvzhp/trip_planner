import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 网页语音识别（Web Speech API）的薄封装。
 *
 * - 只在宿主支持时启用；WeChat web-view / 多数移动 WebView 里 getCtor() 为空，
 *   PlanSheet 会明确提示改用键盘输入，不假装录音可用。
 * - 识别结果按 final chunk 回调，调用方自行拼接（避免重复追加）。
 * - 组件卸载 / 关闭时 abort，避免麦克风一直占用。
 */

type SpeechRecognitionLike = {
  lang: string
  interimResults: boolean
  continuous: boolean
  maxAlternatives: number
  onresult: ((event: any) => void) | null
  onerror: ((event: any) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

function getCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
  }
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

export interface SpeechHookOptions {
  onFinal?: (chunk: string) => void
  lang?: string
}

export function useSpeechRecognition(options: SpeechHookOptions = {}) {
  const [supported, setSupported] = useState(false)
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [error, setError] = useState<string | null>(null)
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const onFinalRef = useRef(options.onFinal)
  onFinalRef.current = options.onFinal

  useEffect(() => {
    setSupported(Boolean(getCtor()))
  }, [])

  const stop = useCallback(() => {
    try {
      recRef.current?.stop()
    } catch {
      /* already stopped */
    }
    setListening(false)
    setInterim('')
  }, [])

  const start = useCallback(() => {
    const Ctor = getCtor()
    if (!Ctor) {
      setError('当前宿主不支持网页语音识别，直接打字也一样快。')
      return false
    }
    if (recRef.current) {
      try {
        recRef.current.abort()
      } catch {
        /* ignore */
      }
      recRef.current = null
    }
    const rec = new Ctor()
    rec.lang = options.lang || 'zh-CN'
    rec.interimResults = true
    rec.continuous = false
    rec.maxAlternatives = 1
    rec.onresult = event => {
      let finalChunk = ''
      let interimChunk = ''
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]
        const text = String(result?.[0]?.transcript || '')
        if (result.isFinal) finalChunk += text
        else interimChunk += text
      }
      if (finalChunk.trim()) onFinalRef.current?.(finalChunk.trim())
      setInterim(interimChunk)
    }
    rec.onerror = event => {
      const code = String(event?.error || '')
      const message =
        code === 'not-allowed' || code === 'service-not-allowed'
          ? '麦克风权限被拒绝，请在浏览器/系统设置里允许后重试。'
          : code === 'no-speech'
            ? '没有听到声音，再按住说一次试试。'
            : code === 'audio-capture'
              ? '没有找到可用的麦克风。'
              : '语音识别暂时不可用，可直接打字。'
      setError(message)
      setListening(false)
      setInterim('')
      recRef.current = null
    }
    rec.onend = () => {
      setListening(false)
      setInterim('')
      recRef.current = null
    }
    try {
      rec.start()
      recRef.current = rec
      setError(null)
      setListening(true)
      return true
    } catch {
      setError('语音识别启动失败，可直接打字。')
      setListening(false)
      return false
    }
  }, [options.lang])

  useEffect(() => {
    return () => {
      try {
        recRef.current?.abort()
      } catch {
        /* ignore */
      }
      recRef.current = null
    }
  }, [])

  return { supported, listening, interim, error, start, stop, setError }
}
