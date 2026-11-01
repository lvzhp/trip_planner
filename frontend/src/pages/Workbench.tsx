import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { AskUserAnswer, CandidatePlace, Conflict, ContextTag, MessageSegment } from '../types'
import { useAppStore } from '../stores/appStore'
import { useTripStore } from '../stores/tripStore'
import { useUiStore } from '../stores/uiStore'
import { useMediaQuery } from '../lib/useMediaQuery'
import { toast } from '../lib/toast'
import { Topbar } from '../components/Topbar'
import { ChatPane } from '../components/ChatPane'
import { TripPanel } from '../components/TripPanel'
import { MapPane } from '../components/MapPane'
import { Drawers } from '../components/Drawers'
import { PlaceCardHost } from '../components/PlaceCardHost'
import { ItineraryDrawer } from '../components/ItineraryDrawer'
import { ImportDialog } from '../components/ImportDialog'
import { ThreadPanel } from '../components/ThreadPanel'
import type { MapController } from '../map/controller'
import type { ComposerHandle } from '../components/Composer'
import { Icon } from '../lib/icons'
import { conflictTypeLabel } from '../lib/icons'
import { shareCurrentTrip } from '../lib/share'
import { notifyMiniProgramTrip, hapticTap } from '../platform/shell'
import { runtime } from '../platform/runtime'

export function Workbench({ readonly = false, chatOnly = false }: { readonly?: boolean; chatOnly?: boolean }) {
  const { tripId } = useParams<{ tripId: string }>()
  const navigate = useNavigate()
  const mobile = useMediaQuery('(max-width: 767px)')
  const showChatOnly = chatOnly && mobile
  const trip = useTripStore(s => s.trip)
  const derived = useTripStore(s => s.derived)
  const events = useTripStore(s => s.events)
  const loading = useTripStore(s => s.loading)
  const error = useTripStore(s => s.error)
  const sending = useTripStore(s => s.sending)
  const hydrate = useTripStore(s => s.hydrate)
  const sync = useTripStore(s => s.sync)
  const send = useTripStore(s => s.send)
  const config = useAppStore(s => s.config)
  const loadConfig = useAppStore(s => s.loadConfig)
  const model = useUiStore(s => s.model)
  const modelExplicit = useUiStore(s => s.modelExplicit)
  const setModel = useUiStore(s => s.setModel)
  const chatCollapsed = useUiStore(s => s.chatCollapsed)
  const chatWidth = useUiStore(s => s.chatWidth)
  const setChatWidth = useUiStore(s => s.setChatWidth)
  const setChatCollapsed = useUiStore(s => s.setChatCollapsed)
  const toggleChat = useUiStore(s => s.toggleChat)
  const panelCollapsed = useUiStore(s => s.panelCollapsed)
  const setPanelCollapsed = useUiStore(s => s.setPanelCollapsed)
  const activeDay = useUiStore(s => s.activeDay)
  const selectStop = useUiStore(s => s.selectStop)
  const setActiveDay = useUiStore(s => s.setActiveDay)
  const addContextTag = useUiStore(s => s.addContextTag)
  const clearContextTags = useUiStore(s => s.clearContextTags)
  const composerContext = useUiStore(s => s.composerContext)
  const setComposerPlaceholder = useUiStore(s => s.setComposerPlaceholder)
  const focusComposer = useUiStore(s => s.focusComposer)
  const openDrawer = useUiStore(s => s.openDrawer)
  const openSettings = useUiStore(s => s.openSettings)
  const openStopDetail = useUiStore(s => s.openStopDetail)
  const detailStopId = useUiStore(s => s.detailStopId)
  const theme = useUiStore(s => s.theme)
  const toggleTheme = useUiStore(s => s.toggleTheme)
  const pendingPrompt = useUiStore(s => s.pendingPrompt)
  const consumePendingPrompt = useUiStore(s => s.consumePendingPrompt)
  const mapRef = useRef<MapController | null>(null)
  const composerRef = useRef<ComposerHandle | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [mobileMenu, setMobileMenu] = useState(false)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const [pendingDay, setPendingDay] = useState<number | null>(null)
  const [exportPreview, setExportPreview] = useState<string | null>(null)

  useEffect(() => {
    if (!tripId) return
    useUiStore.setState({ activeDay: 1, mapDay: 1, mobileSheet: 0, selectedStopId: null, selectedActivityId: null, panelCollapsed: false, detailStopId: null, drawer: null })
    void hydrate(tripId, readonly)
  }, [tripId, readonly, hydrate])

  useEffect(() => {
    return () => {
      useTripStore.getState().stop()
    }
  }, [])

  useEffect(() => {
    document.body.classList.add('workbench-page')
    document.body.classList.remove('list-page')
    document.body.classList.toggle('panel-collapsed', panelCollapsed && !mobile)
    return () => {
      document.body.classList.remove('workbench-page', 'panel-collapsed', 'splitting')
    }
  }, [panelCollapsed, mobile])

  useEffect(() => {
    if (trip) document.title = `${trip.title || '行程'} · Trace Planner`
    return () => {
      document.title = 'Trace Planner'
    }
  }, [trip?.title])

  // 小程序 web-view：把当前行程同步给宿主，原生分享/返回时有据可依
  useEffect(() => {
    if (!trip) return
    notifyMiniProgramTrip({
      tripId: trip.tripId,
      title: trip.title || '我的行程',
      path: `/s/${trip.tripId}`,
    })
  }, [trip?.tripId, trip?.title])

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  useEffect(() => {
    if (!config) return
    const group = config.providers.find(p => p.id === model.provider)
    const def = config.defaultModel
    const defGroup = config.providers.find(p => p.id === def.provider)
    const shouldUseDefault =
      (!group || !group.available) ||
      (!modelExplicit && def.provider !== 'mock' && model.provider === 'mock')
    if (shouldUseDefault && defGroup?.available) {
      const m = defGroup.models.find(x => x.id === def.model) || defGroup.models[0]
      if (m) {
        setModel(
          { provider: defGroup.id, model: m.id, name: m.name, providerName: defGroup.provider },
          false,
        )
      }
    }
  }, [config, model.provider, modelExplicit, setModel])

  useEffect(() => {
    const onFocus = () => {
      if (!sending && document.visibilityState === 'visible') void sync()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    document.addEventListener('tp:appstate', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      document.removeEventListener('tp:appstate', onFocus)
    }
  }, [sending, sync])

  // body class for panel offset
  useEffect(() => {
    document.body.classList.toggle('panel-collapsed', panelCollapsed && !mobile)
  }, [panelCollapsed, mobile])

  const findAsk = useCallback(
    (askId: string | null) => {
      const asks = events.filter(e => e.type === 'ask_user')
      if (!askId) return asks[asks.length - 1]?.payload
      return asks.find(e => (e.payload.askId || e.turnId) === askId)?.payload
    },
    [events],
  )

  const sendText = useCallback(
    (text: string, extra?: Partial<Parameters<typeof send>[0]>, tagsOverride?: ContextTag[]) => {
      if (!text.trim() || sending) return
      const tags = tagsOverride ?? [...composerContext]
      const taggedDay = tags.find(t => t.dayIndex)?.dayIndex ?? null
      setPendingDay(taggedDay)
      clearContextTags()
      setComposerPlaceholder('对整个行程说话，或用「改这里」定位到某个节点…')
      void send({
        content: text.trim(),
        contextTags: tags,
        model: { provider: model.provider, model: model.model },
        ...extra,
      })
    },
    [sending, composerContext, clearContextTags, setComposerPlaceholder, send, model],
  )

  // 「按住说」/规划面板把首条指令放进 store；行程 hydrate 完成后在这里发送。
  useEffect(() => {
    if (!chatOnly || !pendingPrompt || !trip || loading || sending || readonly) return
    const prompt = consumePendingPrompt(trip.tripId)
    if (prompt) sendText(prompt)
  }, [chatOnly, pendingPrompt, trip, loading, sending, readonly, consumePendingPrompt, sendText])

  // 本轮高亮集合 + 候选点（mindtrip/06 §3、§4.3）：都从最新一条 assistant turn 派生。
  const latestAssistantKey = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event.type !== 'message') continue
      if (event.payload?.role !== 'assistant') continue
      if (!Array.isArray(event.payload?.segments)) continue
      return `${event.turnId || 'turn'}:${event.seq}`
    }
    return ''
  }, [events])

  useEffect(() => {
    if (!latestAssistantKey) return
    const event = [...events].reverse().find(item => `${item.turnId || 'turn'}:${item.seq}` === latestAssistantKey)
    if (!event) return
    const segments = (event.payload?.segments || []) as MessageSegment[]
    const places = segments.filter((segment): segment is Extract<MessageSegment, { type: 'place' }> => segment.type === 'place')
    const turnId = event.turnId || `seq-${event.seq}`
    const ui = useUiStore.getState()
    const highlighted = places.filter(place => !place.missing)
    ui.setHighlight(turnId, highlighted.map(place => place.poiId))
    // 本轮点如果都不在当前 Day，自动切到「全部」，否则高亮集合看不见
    const currentDay = ui.mapDay
    if (currentDay !== 'all' && highlighted.length > 0 && !highlighted.some(place => place.dayIndex === currentDay)) {
      ui.setMapDay('all')
    }
    const candidates: CandidatePlace[] = places
      // 已在行程的点由行程层渲染（编号 marker），候选层只保留「未加入」的
      .filter(place => !place.missing && place.hasCoords && !place.added)
      .map(place => ({
        poiId: place.poiId,
        name: place.fullName || place.name,
        category: place.category,
        lat: place.lat ?? null,
        lng: place.lng ?? null,
        city: place.city ?? null,
        address: place.address ?? null,
        source: 'chat',
        added: place.added,
        stopId: place.stopId ?? null,
        dayIndex: place.dayIndex ?? null,
      }))
    const keepPrevious = ui.keepPreviousCandidates
    const existing = ui.candidates
    const preserved = keepPrevious ? existing : existing.filter(item => item.source !== 'chat')
    ui.setCandidates([...preserved, ...candidates])
  }, [latestAssistantKey, events])

  // 抽屉 / 浮卡 / 导入的键盘约定：I 打开行程，Esc 逐层关闭
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (typing) return
      if (event.key === 'Escape') {
        const ui = useUiStore.getState()
        if (ui.placeCard) ui.closePlace()
        else if (ui.importOpen) ui.closeImport()
        else if (ui.threadsOpen) ui.closeThreads()
        else if (ui.itineraryOpen) ui.closeItinerary()
        return
      }
      if (event.key === 'i' || event.key === 'I') {
        event.preventDefault()
        useUiStore.getState().itineraryOpen
          ? useUiStore.getState().closeItinerary()
          : useUiStore.getState().openItinerary()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!sending && pendingDay != null) {
      const id = window.setTimeout(() => setPendingDay(null), 900)
      return () => window.clearTimeout(id)
    }
  }, [sending, pendingDay])

  const onSend = (text: string) => {
    if (readonly) return
    sendText(text)
  }

  const onAskAnswer = (askId: string | null, answers: AskUserAnswer[], freeText: string | null) => {
    if (readonly) return
    const ask = findAsk(askId)
    const parts: string[] = []
    if (freeText) parts.push(freeText)
    for (const a of answers) {
      const q = ask?.questions?.[a.questionIndex]
      const title = q?.question || '问题'
      const labels = a.optionIds.map((id: string) => q?.options?.find((o: any) => o.id === id)?.label || id)
      if (labels.length) parts.push(`${title}：${labels.join('、')}`)
      // 「其他」选项的自填内容单独标出来，模型能分清选项和自由输入
      if (a.freeText) parts.push(`${title}：其他 ${a.freeText}`)
      // 城市/日期选择器填的值单独标出，模型能区分「选了选项」和「填了具体值」
      if (a.value) parts.push(`${title}：${a.value}`)
      // 未选的题显式写成「跳过」，否则模型会把「用户跳过」误当成「没问过」（02 §4.2）
      if (!labels.length && !a.freeText && !a.value) parts.push(`${title}：（跳过，按默认）`)
      if (a.note) parts.push(`备注：${a.note}`)
    }
    const content = parts.length ? `（回答提问）${parts.join('；')}` : '（已回答提问）'
    sendText(content, { askAnswers: answers, askId })
  }

  const onConflictChoice = (conflict: Conflict, label: string) => {
    if (readonly) return
    const tag: ContextTag = {
      kind: 'conflict',
      id: conflict.id || conflict.type,
      label: `冲突 · ${conflictTypeLabel[conflict.type] || conflict.type}`,
      dayIndex: conflict.dayIndex,
    }
    sendText(label, undefined, [...composerContext, tag])
    if (mobile && tripId) navigate(`/t/${tripId}/chat`)
  }

  const onSlash = (command: string) => {
    if (command === '/booking') {
      openDrawer('booking')
      return true
    }
    if (command === '/conflicts') {
      openDrawer('conflict')
      return true
    }
    if (command === '/history' || command === '/versions') {
      openDrawer('version')
      return true
    }
    if (command === '/replan') {
      if (!composerContext.length) {
        toast('先点卡片上的「改这里」选择一个节点，再输入想怎么改', 'info')
      } else {
        focusComposer()
      }
      return true
    }
    return false
  }

  const onEditStop = (stopId: string, dayIndex: number) => {
    if (readonly) return
    const found = findStopById(trip, stopId)
    if (!found) return
    const label = `${found.poi.name.split(' · ')[0]} · Day ${dayIndex}`
    addContextTag({ kind: 'stop', id: stopId, label, dayIndex })
    setComposerPlaceholder(`说说想怎么改「${found.poi.name.split(' · ')[0]}」…`)
    focusComposer()
    if (mobile && tripId) navigate(`/t/${tripId}/chat`)
  }

  /** 需求 3：点卡片项只定位地图，不弹详情。 */
  const onSelectCard = (stopId: string, activityId: string, dayIndex: number) => {
    selectStop(stopId, activityId, dayIndex)
    mapRef.current?.selectStop(stopId)
    mapRef.current?.centerOn(stopId)
  }

  /**
   * 卡片内的「详情」入口：卡片本身就是地点（docs/07 §3）。
   * 把这张卡作为详情上下文，概览段会高亮它；地图同步定位。
   */
  const onOpenCardDetail = (stopId: string, activityId: string, dayIndex: number) => {
    selectStop(stopId, activityId, dayIndex)
    mapRef.current?.selectStop(stopId)
    mapRef.current?.centerOn(stopId)
    openStopDetail(stopId, { tab: 'overview', dayIndex, activityId })
  }

  /** 「改这里」挂被点的那张卡片，而不是整段 stop。 */
  const onEditActivity = (stopId: string, activityId: string, dayIndex: number) => {
    if (readonly) return
    const found = findActivityById(trip, stopId, activityId)
    if (!found) return
    const label = `${found.activity.title} · Day ${dayIndex}`
    addContextTag({ kind: 'activity', id: activityId, label, dayIndex })
    setComposerPlaceholder(`说说想怎么改「${found.activity.title}」…`)
    focusComposer()
    if (mobile && tripId) navigate(`/t/${tripId}/chat`)
  }

  /** 需求 3：点地图 marker 才打开详情（一跳直达，docs/07 §5）。 */
  const onMarkerClick = (stopId: string, dayIndex: number) => {
    setActiveDay(dayIndex, false)
    mapRef.current?.selectStop(stopId)
    mapRef.current?.centerOn(stopId)
    openStopDetail(stopId, { tab: 'overview', dayIndex, activityId: null })
  }

  const onBlankClick = () => {
    if (detailStopId) return // 详情打开时点空白不动选择，避免误触
    selectStop(null)
    mapRef.current?.clearSelection()
  }

  const onJumpConflict = (conflict: Conflict) => {
    if (conflict.dayIndex) {
      setPanelCollapsed(false)
      setActiveDay(conflict.dayIndex, true)
      if (conflict.stopId) {
        selectStop(conflict.stopId, conflict.activityId || null, conflict.dayIndex)
        window.setTimeout(() => {
          mapRef.current?.centerOn(conflict.stopId!)
          mapRef.current?.selectStop(conflict.stopId!)
        }, 180)
      }
    }
  }

  const onShare = () => {
    if (!trip) return
    hapticTap()
    void shareCurrentTrip(trip)
  }

  /**
   * 导出长图。
   * 桌面直接下载；手机 / App / 微信里改成预览，让用户长按保存或截图 ——
   * WebView 没有下载目录，a[download] 在 iOS 与微信里都不可靠。
   */
  const onExport = async () => {
    const mobileSurface = mobile || runtime.isMobileShell || runtime.isWeChat
    const target = mobileSurface
      ? document.querySelector<HTMLElement>('.trip-panel')
      : document.querySelector<HTMLElement>('.map-pane')
    if (!target) return
    try {
      const { toPng } = await import('html-to-image')
      const dataUrl = await toPng(target, {
        backgroundColor: theme === 'dark' ? '#0E1418' : '#FFFFFF',
        pixelRatio: 2,
        cacheBust: true,
        skipFonts: true,
      })
      if (mobileSurface) {
        setExportPreview(dataUrl)
        hapticTap('medium')
        toast('长按图片可保存到相册', 'info')
        return
      }
      const a = document.createElement('a')
      a.download = `${trip?.title || '行程'}.png`
      a.href = dataUrl
      a.click()
      toast('长图已导出')
    } catch (err) {
      toast(err instanceof Error ? err.message : '导出失败，可尝试截图分享', 'xCircle')
    }
  }

  /**
   * 对话宽度 320–380px（不是比例）：任何宽度下地图都 ≥65%（§0.2 不变量 1）。
   * 拖拽只在这个区间里调，不会把地图挤到 65% 以下。
   */
  const onSplitterDown = (e: React.PointerEvent) => {
    e.preventDefault()
    document.body.classList.add('splitting')
    const startX = e.clientX
    const startWidth = chatWidth
    const move = (ev: PointerEvent) => {
      const width = Math.min(380, Math.max(320, startWidth + (ev.clientX - startX)))
      setDragWidth(width)
      setChatWidth(width)
    }
    const up = () => {
      document.body.classList.remove('splitting')
      setDragWidth(null)
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }

  const closeMobileMenu = () => setMobileMenu(false)
  const onStartChat = () => {
    if (mobile && tripId && !readonly) navigate(`/t/${tripId}/chat`)
  }

  const mobileMenuNode = mobileMenu && (
    <>
      <div className="menu-scrim" onClick={closeMobileMenu} />
      <div className="menu open mobile-menu" role="menu">
        <button className="menu-item" type="button" onClick={() => { closeMobileMenu(); onShare() }}>
          <Icon name="share" /> 分享行程
        </button>
        {!showChatOnly && (
          <button className="menu-item" type="button" onClick={() => { closeMobileMenu(); void onExport() }}>
            <Icon name="download" /> 导出行程长图
          </button>
        )}
        <div className="menu-sep" />
        {!showChatOnly && (
          <button className="menu-item" type="button" onClick={() => { closeMobileMenu(); navigate(`/t/${tripId}`) }}>
            <Icon name="map" /> 回到地图
          </button>
        )}
        <button className="menu-item" type="button" onClick={() => { closeMobileMenu(); useUiStore.getState().openItinerary() }}>
          <Icon name="route" /> 行程文档
        </button>
        <button className="menu-item" type="button" onClick={() => { closeMobileMenu(); useUiStore.getState().openImport() }}>
          <Icon name="download" /> 导入链接 / 截图
        </button>
        <button className="menu-item" type="button" onClick={() => { closeMobileMenu(); useUiStore.getState().openThreads() }}>
          <Icon name="chat" /> 同行人评论
        </button>
        <button className="menu-item" type="button" onClick={() => { closeMobileMenu(); openDrawer('version') }}>
          <Icon name="history" /> 版本历史
        </button>
        <button className="menu-item" type="button" onClick={() => { closeMobileMenu(); openDrawer('booking') }}>
          <Icon name="calendar" /> 预订提醒
        </button>
        <button className="menu-item" type="button" onClick={() => { closeMobileMenu(); openDrawer('conflict') }}>
          <Icon name="warn" /> 校验冲突
        </button>
        <div className="menu-sep" />
        <button className="menu-item" type="button" onClick={() => { closeMobileMenu(); openSettings() }}>
          <Icon name="settings" /> 接入与设置
        </button>
        <button className="menu-item" type="button" onClick={() => { closeMobileMenu(); toggleTheme() }}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} /> 切换主题
        </button>
        <Link className="menu-item" to="/" onClick={closeMobileMenu}>
          <Icon name="route" /> 行程列表
        </Link>
      </div>
    </>
  )

  if (loading && !trip) {
    return (
      <div className="workbench">
        <Topbar readonly={readonly} onExport={onExport} onMobileMenu={() => setMobileMenu(v => !v)} />
        <div className="wb-loading">
          <span className="spinner" />
          <span>正在加载行程…</span>
        </div>
      </div>
    )
  }

  if (error || !trip) {
    return (
      <div className="workbench">
        <div className="wb-error">
          <span className="we-icon"><Icon name="warn" /></span>
          <h2>没找到这份行程</h2>
          <p>{error || '链接可能已失效，或行程已被删除。'}</p>
          <Link className="btn btn-primary" to="/">返回行程列表</Link>
        </div>
      </div>
    )
  }

  const chat = (
    <ChatPane
      composerRef={composerRef}
      onSend={onSend}
      onAskAnswer={onAskAnswer}
      onSlash={onSlash}
    />
  )

  if (showChatOnly) {
    return (
      <div className="workbench mobile-chat-shell">
        <Topbar readonly={readonly} onExport={onExport} onMobileMenu={() => setMobileMenu(v => !v)} />
        <main className="mobile-chat-page">{chat}</main>
        <Drawers onJump={onJumpConflict} onConflictChoice={onConflictChoice} />
        <PlaceCardHost />
        <ItineraryDrawer />
        <ImportDialog />
        <ThreadPanel />
        {mobileMenuNode}
      </div>
    )
  }

  return (
    <div className={`workbench${panelCollapsed && !mobile ? ' panel-collapsed' : ''}${chatCollapsed && !mobile ? ' chat-collapsed' : ''}`}>
      <Topbar readonly={readonly} onExport={onExport} onMobileMenu={() => setMobileMenu(v => !v)} />
      <main
        className="wb-body"
        ref={bodyRef}
        style={{ ['--chat-w' as string]: chatCollapsed || mobile ? '0px' : `${dragWidth ?? chatWidth}px` } as React.CSSProperties}
      >
        {!mobile && (
          <div
            id="desktop-chat-slot"
            className={chatCollapsed ? 'collapsed' : ''}
            style={chatCollapsed ? undefined : { flex: `0 0 ${dragWidth ?? chatWidth}px`, minWidth: 0 }}
          >
            {chatCollapsed ? (
              <div className="chat-rail">
                <button
                  type="button"
                  className="chat-rail-btn"
                  aria-label="展开对话"
                  title="展开对话"
                  onClick={() => setChatCollapsed(false)}
                >
                  <Icon name="chat" />
                  <span>对话</span>
                  <Icon name="chevronRight" />
                </button>
                <span className="chat-rail-hint">地图优先</span>
              </div>
            ) : (
              <>
                {chat}
                <button
                  className="chat-collapse-btn"
                  type="button"
                  aria-label="收起对话面板"
                  title="收起对话（地图优先）"
                  onClick={() => setChatCollapsed(true)}
                >
                  <Icon name="chevronLeft" /> 收起
                </button>
              </>
            )}
          </div>
        )}

        {!mobile && !chatCollapsed && (
          <div
            className="splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整对话宽度"
            tabIndex={0}
            onPointerDown={onSplitterDown}
          >
            <span className="grip" />
          </div>
        )}

        <MapPane
          mapRef={mapRef}
          onMarkerClick={onMarkerClick}
          onBlankClick={onBlankClick}
        >
          <TripPanel
            mobile={mobile}
            onStartChat={onStartChat}
            onEditStop={onEditStop}
            onEditActivity={onEditActivity}
            onSelectCard={onSelectCard}
            onOpenCardDetail={onOpenCardDetail}
            onConflictChoice={onConflictChoice}
            onOpenConflicts={() => openDrawer('conflict')}
            pendingDay={pendingDay}
          />
          <button className="panel-toggle" type="button" aria-label="折叠/展开行程卡片面板" onClick={() => setPanelCollapsed(!panelCollapsed)}>
            <Icon name={panelCollapsed ? 'panelRight' : 'chevronRight'} /> {panelCollapsed ? '行程卡片' : '收起面板'}
          </button>
        </MapPane>
      </main>

      <Drawers onJump={onJumpConflict} onConflictChoice={onConflictChoice} />
      <PlaceCardHost />
      <ItineraryDrawer />
      <ImportDialog />
      <ThreadPanel />

      {mobileMenuNode}

      {exportPreview && (
        <div className="export-preview-scrim" role="dialog" aria-modal="true" aria-label="行程长图" onClick={() => setExportPreview(null)}>
          <div className="export-preview" onClick={event => event.stopPropagation()}>
            <div className="ep-head">
              <strong>行程长图</strong>
              <button className="icon-btn" type="button" aria-label="关闭" onClick={() => setExportPreview(null)}>
                <Icon name="x" />
              </button>
            </div>
            <div className="ep-body">
              <img src={exportPreview} alt="行程长图预览" />
            </div>
            <div className="ep-tip">长按图片保存到相册，或直接截图分享</div>
          </div>
        </div>
      )}
    </div>
  )
}

function findStopById(trip: ReturnType<typeof useTripStore.getState>['trip'], stopId: string) {
  if (!trip) return null
  for (const day of trip.days) {
    for (const stop of day.stops) if (stop.stopId === stopId) return stop
  }
  return null
}

function findActivityById(
  trip: ReturnType<typeof useTripStore.getState>['trip'],
  stopId: string,
  activityId: string,
) {
  const stop = findStopById(trip, stopId)
  const activity = stop?.activities.find(a => a.activityId === activityId)
  return stop && activity ? { stop, activity } : null
}
