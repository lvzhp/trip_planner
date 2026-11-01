import { useEffect, useRef, useState } from 'react'
import { PlaceDetailBody } from './PlaceDetailBody'
import { LocatePanel, PlaceDetailFull } from './PlaceCardParts'
import { PlacePopover } from './PlacePopover'
import { PlaceSheet } from './PlaceSheet'
import { usePlaceCard } from '../lib/usePlaceCard'
import { useUiStore } from '../stores/uiStore'
import { highlightLegOnMap } from '../lib/mapBridge'

/**
 * 地点浮卡（桌面锚定 chip）/ bottom sheet（移动端），共用 PlaceDetailBody。
 * - 打开时**不改变地图视野**：地图 flyTo 只在点 chip / 候选点时发生一次；
 * - Esc / 点外部 / 滚轮滚动对话 → 关闭，焦点回到触发 chip；
 * - 移动端 60% 高，可上拉到 90%，下拉关闭。
 */
export function PlaceCardHost() {
  const state = usePlaceCard()
  const { card, closePlace } = state
  const [fullOpen, setFullOpen] = useState(false)
  const [locateOpen, setLocateOpen] = useState(false)
  const previousCard = useRef(card)

  // 关闭浮卡/Sheet 时把焦点还给触发 chip（§2.5 第 4 条）。
  // 放在 host 级而不是 Esc handler 里：Esc、点外部、滚轮关闭都走同一条路径。
  // 优先用打开时保存的元素；它若被重渲染替换，就按 data-poi-id 找回同一个 chip。
  useEffect(() => {
    if (previousCard.current && !card) {
      const poiId = previousCard.current.poiId
      const stored = useUiStore.getState().placeReturnFocus
      window.setTimeout(() => {
        const target =
          stored && stored.isConnected
            ? stored
            : (document.querySelector(`.place-chip[data-poi-id="${CSS.escape(poiId)}"] .pc-main`) as HTMLElement | null)
        target?.focus()
      }, 30)
    }
    previousCard.current = card
  }, [card])

  useEffect(() => {
    if (!card) {
      setFullOpen(false)
      setLocateOpen(false)
    }
  }, [card])

  if (!card) return null

  const body = (
    <>
      {locateOpen && (
        <LocatePanel
          detail={state.detail}
          query={state.locateQuery}
          setQuery={state.setLocateQuery}
          results={state.locateResults}
          message={state.locateMessage}
          loading={state.locating}
          onSearch={() => void state.runLocateSearch()}
          onPick={candidate => void state.applyLocated(candidate)}
          onClose={() => setLocateOpen(false)}
        />
      )}
      <PlaceDetailBody
        detail={state.detail}
        loading={state.loading}
        error={state.error}
        segment={state.segment}
        readonly={state.readonly}
        activeDay={state.activeDay}
        dayOptions={state.dayOptions}
        saved={state.saved}
        feedback={state.feedback}
        onAdd={dayIndex => void state.onAdd(dayIndex)}
        onRemove={() => void state.onRemove()}
        onNavigate={state.onNavigate}
        onOpenFull={() => setFullOpen(true)}
        onRetry={state.retry}
        onToggleSave={state.onToggleSave}
        onFeedback={state.onFeedback}
        onLocate={() => setLocateOpen(true)}
        locating={state.locating}
        onLegClick={(fromStopId, toStopId) => {
          useUiStore.getState().setLegInfo({ fromStopId, toStopId })
          highlightLegOnMap(fromStopId, toStopId)
        }}
      />
      {fullOpen && state.detail && (
        <PlaceDetailFull
          detail={state.detail}
          saved={state.saved}
          onToggleSave={state.onToggleSave}
          onNavigate={state.onNavigate}
          onClose={() => setFullOpen(false)}
        />
      )}
    </>
  )

  const useSheet = card.mode === 'sheet' || (typeof window !== 'undefined' && window.innerWidth <= 767)
  return useSheet ? (
    <PlaceSheet onClose={closePlace}>{body}</PlaceSheet>
  ) : (
    <PlacePopover anchor={card.anchor} onClose={closePlace}>
      {body}
    </PlacePopover>
  )
}

