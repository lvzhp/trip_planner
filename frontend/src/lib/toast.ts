import { ICON_PATHS } from './icons'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastOptions {
  /** 缩略图（P1-5：全局 toast 带缩略图） */
  thumb?: string
  /** 撤销等动作按钮；出现时 toast 停留更久，hover 暂停计时 */
  action?: ToastAction
  /** 默认 2400ms；有 action 时 5000ms */
  timeoutMs?: number
}

let host: HTMLDivElement | null = null

function ensureHost(): HTMLDivElement {
  if (!host || !host.isConnected) {
    host = document.createElement('div')
    host.className = 'toast-host'
    host.setAttribute('aria-live', 'polite')
    document.body.appendChild(host)
  }
  return host
}

function iconSvg(name: string): string {
  return `<svg class="od-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] || ICON_PATHS.checkCircle}</svg>`
}

/**
 * 全局 toast。兼容旧签名 `toast(message, iconName)`，
 * 新增 opts：`thumb` 缩略图、`action` 撤销按钮（3s 自动消失，hover 暂停）。
 */
export function toast(message: string, iconNameOrOpts: string | ToastOptions = 'checkCircle', maybeOpts?: ToastOptions) {
  const opts: ToastOptions = typeof iconNameOrOpts === 'string' ? { ...(maybeOpts || {}) } : { ...(iconNameOrOpts || {}) }
  const iconName = typeof iconNameOrOpts === 'string' ? iconNameOrOpts : 'checkCircle'
  const node = document.createElement('div')
  node.className = 'toast' + (opts.action ? ' toast-action' : '')
  const thumb = opts.thumb
    ? `<span class="toast-thumb"><img src="${opts.thumb}" alt="" loading="lazy" /></span>`
    : iconSvg(iconName)
  node.innerHTML = `${thumb}<span class="toast-text"></span>`
  const text = node.querySelector('.toast-text')
  if (text) text.textContent = message
  if (opts.action) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'toast-btn'
    button.textContent = opts.action.label
    button.addEventListener('click', () => {
      opts.action?.onClick()
      dismiss(0)
    })
    node.appendChild(button)
  }
  ensureHost().appendChild(node)

  const timeout = opts.timeoutMs ?? (opts.action ? 5000 : 2400)
  let timer = window.setTimeout(() => dismiss(260), timeout)
  const pause = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => dismiss(260), 1600)
  }
  node.addEventListener('mouseenter', () => window.clearTimeout(timer))
  node.addEventListener('mouseleave', pause)

  function dismiss(delay: number) {
    window.clearTimeout(timer)
    window.setTimeout(() => {
      node.style.opacity = '0'
      node.style.transition = 'opacity .25s'
      window.setTimeout(() => node.remove(), 260)
    }, delay)
  }
}

export async function copyText(text: string, okMsg = '已复制') {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
    } catch {
      /* ignore */
    }
    ta.remove()
  }
  toast(okMsg)
}
