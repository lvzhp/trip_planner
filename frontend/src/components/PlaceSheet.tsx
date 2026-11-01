import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** 移动端地点 bottom sheet（mindtrip/06 §2.2）：60% 高，可上拉到 90%，下拉关闭。 */
export function PlaceSheet({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const [dragY, setDragY] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const startY = useRef(0)
  const dragging = useRef(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    document.body.classList.add('sheet-open')
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.classList.remove('sheet-open')
    }
  }, [onClose])

  const onPointerDown = (event: React.PointerEvent) => {
    dragging.current = true
    startY.current = event.clientY
  }
  const onPointerMove = (event: React.PointerEvent) => {
    if (!dragging.current) return
    setDragY(Math.max(-40, event.clientY - startY.current))
  }
  const onPointerUp = () => {
    if (!dragging.current) return
    dragging.current = false
    if (dragY > 90) {
      onClose()
    } else if (dragY < -30) {
      setExpanded(true)
    } else if (dragY > 30) {
      setExpanded(false)
    }
    setDragY(0)
  }

  return createPortal(
    <>
      <div className="place-sheet-scrim" role="presentation" onClick={onClose} />
      <div
        className={`place-sheet${expanded ? ' expanded' : ''}${dragY !== 0 ? ' dragging' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="地点详情"
        style={dragY !== 0 ? { transform: `translateY(${dragY}px)`, transition: 'none' } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="place-sheet-handle" aria-hidden="true">
          <span />
        </div>
        <div className="place-sheet-body">{children}</div>
      </div>
    </>,
    document.body,
  )
}
