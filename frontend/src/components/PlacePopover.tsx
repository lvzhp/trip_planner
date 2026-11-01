import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../lib/icons'
import { useUiStore } from '../stores/uiStore'

/** 桌面地点浮卡（mindtrip/06 §2.2）：锚定 chip，空间不足时翻转，Esc/点外部/滚动关闭。 */
export function PlacePopover({
  anchor,
  children,
  onClose,
}: {
  anchor: { x: number; y: number; w: number; h: number } | null
  children: React.ReactNode
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 16, top: 16 })
  const returnFocus = useUiStore(s => s.placeReturnFocus)

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const place = () => {
      const margin = 12
      const width = node.offsetWidth || 320
      const height = node.offsetHeight || 380
      let left = anchor ? anchor.x + anchor.w + 12 : margin
      // 默认锚在 chip 右侧；放不下就翻到左侧（§2.2 空间不足时翻转）
      if (left + width + margin > window.innerWidth) {
        left = anchor ? anchor.x - width - 12 : window.innerWidth - width - margin
      }
      if (left < margin) left = margin
      let top = anchor ? anchor.y + anchor.h / 2 - height / 2 : margin
      if (top + height + margin > window.innerHeight) top = window.innerHeight - height - margin
      if (top < 56) top = 56
      setPos({ left, top })
    }
    place()
    // 详情异步到达后高度会变：重新定位，避免浮卡被裁在视口外
    const observer = new ResizeObserver(place)
    observer.observe(node)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [anchor])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        const target = returnFocus
        if (target && target.isConnected) window.setTimeout(() => target.focus(), 20)
      }
    }
    const onPointerDown = (event: PointerEvent) => {
      const node = ref.current
      if (node && !node.contains(event.target as Node)) {
        // 触发 chip 的点击不在这里关，PlaceChip 自己会重新打开
        onClose()
      }
    }
    const onScroll = (event: WheelEvent) => {
      const node = ref.current
      if (node && event.target instanceof Node && node.contains(event.target)) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('wheel', onScroll, { passive: true })
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('wheel', onScroll)
    }
  }, [onClose, returnFocus])

  return createPortal(
    <div
      className="place-popover"
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-label="地点浮卡"
      style={{ left: pos.left, top: pos.top }}
    >
      <button className="place-popover-close icon-btn" type="button" aria-label="关闭浮卡" onClick={onClose}>
        <Icon name="x" />
      </button>
      {children}
    </div>,
    document.body,
  )
}

