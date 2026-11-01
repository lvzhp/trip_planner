import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { useAppStore } from '../stores/appStore'
import { useTripStore } from '../stores/tripStore'
import { useUiStore } from '../stores/uiStore'
import { Icon } from '../lib/icons'
import { toast } from '../lib/toast'
import { shareCurrentTrip } from '../lib/share'
import { fmtDate } from '../lib/format'
import { hapticTap } from '../platform/shell'
import type { Trip } from '../types'

interface Props {
  readonly: boolean
  onExport: () => void
  onMobileMenu: () => void
}

export function Topbar({ readonly, onExport, onMobileMenu }: Props) {
  const navigate = useNavigate()
  const onChatPage = useLocation().pathname.endsWith('/chat')
  const trip = useTripStore(s => s.trip)
  const derived = useTripStore(s => s.derived)
  const config = useAppStore(s => s.config)
  const model = useUiStore(s => s.model)
  const setModel = useUiStore(s => s.setModel)
  const theme = useUiStore(s => s.theme)
  const toggleTheme = useUiStore(s => s.toggleTheme)
  const openDrawer = useUiStore(s => s.openDrawer)
  const openSettings = useUiStore(s => s.openSettings)
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [modelOpen, setModelOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setModelOpen(false)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [])

  if (!trip) {
    return (
      <header className="topbar">
        <div className="topbar-brand">
          <span className="logo"><Icon name="logo" /></span>
          <span className="desktop-only">Trace Planner</span>
        </div>
      </header>
    )
  }

  const selectedGroup = config?.providers.find(p => p.id === model.provider)
  const realMode = model.provider !== 'mock' && !!selectedGroup?.available
  const errors = derived?.conflicts.filter(c => c.severity === 'error').length || 0
  const warnings = derived?.conflicts.filter(c => c.severity === 'warning').length || 0
  const conflictCls = errors ? 'has-error' : warnings ? 'has-warning' : 'ok'
  const conflictLabel = errors ? `${errors} 个错误 · ${warnings} 个警告` : warnings ? `${warnings} 个警告` : '校验通过'

  const saveTitle = async () => {
    const next = titleDraft.trim() || trip.title || '未命名行程'
    setRenaming(false)
    if (next === trip.title) return
    try {
      const detail = await api.renameTrip(trip.tripId, next)
      useTripStore.setState({ trip: detail.trip, derived: detail.derived })
      toast('标题已更新')
    } catch (err) {
      toast(err instanceof Error ? err.message : '重命名失败', 'xCircle')
    }
  }

  return (
    <header className="topbar" id="topbar">
      <Link className="topbar-brand" to="/" title="返回行程列表">
        <span className="logo"><Icon name="logo" /></span>
        <span className="desktop-only">Trace Planner</span>
      </Link>
      <button className="icon-btn hamburger-only" type="button" aria-label="菜单" onClick={onMobileMenu}>
        <Icon name="hamburger" />
      </button>

      <div className="trip-title-block">
        {renaming ? (
          <input
            className="trip-title-input"
            autoFocus
            value={titleDraft}
            onChange={e => setTitleDraft(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={e => {
              if (e.key === 'Enter') saveTitle()
              if (e.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <button
            className="trip-title"
            type="button"
            title={readonly ? '只读分享' : '点击重命名'}
            disabled={readonly}
            onClick={() => {
              setTitleDraft(trip.title || '')
              setRenaming(true)
            }}
          >
            <span className="trip-title-text">{trip.title || '未命名行程'}</span>
            {!readonly && <Icon name="edit" />}
          </button>
        )}
        <span className="trip-subtitle">{subtitle(trip)}</span>
      </div>

      <button className="version-pill desktop-only" type="button" title="版本历史" onClick={() => openDrawer('version')}>
        <Icon name="history" /> <span>v{trip.version}</span>
      </button>
      <button className={`conflict-badge-btn ${conflictCls} desktop-only`} type="button" onClick={() => openDrawer('conflict')}>
        <Icon name="warn" /> <span>{conflictLabel}</span>
      </button>
      {!readonly && !onChatPage && (
        <button
          className="icon-btn mobile-only"
          type="button"
          aria-label="继续对话"
          title="继续对话"
          onClick={() => navigate(`/t/${trip.tripId}/chat`)}
        >
          <Icon name="chat" />
        </button>
      )}
      <button
        className={`conflict-badge-btn mobile-only ${conflictCls}`}
        type="button"
        aria-label={conflictLabel}
        title={conflictLabel}
        onClick={() => openDrawer('conflict')}
      >
        <Icon name="warn" /> <span>{errors || warnings || '✓'}</span>
      </button>

      <div className="topbar-actions">
        {!readonly && (
          <button
            className={`mode-pill desktop-only ${realMode ? 'real' : 'demo'}`}
            type="button"
            title={realMode ? '当前模型与外部服务已接入' : '当前为演示模式，点击接入真实模型/高德/Tavily'}
            onClick={openSettings}
          >
            <span className="mode-dot" /> {realMode ? '真实模式' : '演示模式'}
          </button>
        )}
        {readonly ? (
          <span className="chip"><Icon name="eye" /> 由 Trace Planner 分享 · 只读</span>
        ) : (
          <>
            <div className="desktop-only" style={{ position: 'relative' }} ref={menuRef}>
              <button
                className="model-switch"
                type="button"
                aria-expanded={modelOpen}
                aria-haspopup="true"
                onClick={e => {
                  e.stopPropagation()
                  setModelOpen(v => !v)
                }}
              >
                <span className="provider-dot" />
                <span>{model.providerName || providerName(model.provider)} · {model.name || model.model}</span>
                <Icon name="caretDown" className="caret" />
              </button>
              <div className={`menu model-menu${modelOpen ? ' open' : ''}`} role="menu">
                {(config?.providers || []).map(group => (
                  <div key={group.id}>
                    <div className="menu-label">{group.provider}</div>
                    {group.models.map(m => {
                      const selected = model.provider === group.id && model.model === m.id
                      return (
                        <button
                          key={m.id}
                          className={`menu-item model-opt${selected ? ' selected' : ''}${!group.available ? ' unavailable' : ''}`}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          title={group.available ? m.desc : '未配置 API Key，请先在 .env 中启用'}
                          onClick={() => {
                            if (!group.available) {
                              toast(`${group.provider} 未配置 API Key，当前仍使用 ${model.name || model.model}`, 'info')
                              return
                            }
                            setModel({ provider: group.id, model: m.id, name: m.name, providerName: group.provider })
                            setModelOpen(false)
                            toast(`已切换到 ${m.name}`)
                          }}
                        >
                          <span>
                            <span className="m-name">{m.name}</span>
                            <br />
                            <span className="m-desc">{m.desc}{!group.available ? ' · 未配置' : ''}</span>
                          </span>
                          <Icon name="check" className="check" />
                        </button>
                      )
                    })}
                  </div>
                ))}
                {config?.demoMode && (
                  <div className="menu-note">
                    <Icon name="info" /> 演示模式使用脚本化 Mock Agent；配置真实 Key 后可切换到真实模型。
                  </div>
                )}
              </div>
            </div>
            <button className="icon-btn desktop-only" type="button" title="接入与设置" aria-label="接入与设置" onClick={openSettings}>
              <Icon name="settings" />
            </button>
            <button className="icon-btn desktop-only" type="button" title="切换深色模式" aria-label="切换深色模式" onClick={toggleTheme}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            </button>
            <button
              className="btn btn-sm desktop-only"
              type="button"
              onClick={() => {
                hapticTap()
                void shareCurrentTrip(trip)
              }}
            >
              <Icon name="share" /> 分享
            </button>
            <button className="btn btn-sm desktop-only" type="button" onClick={onExport}>
              <Icon name="download" /> 导出长图
            </button>
          </>
        )}
      </div>
    </header>
  )
}

function subtitle(trip: Trip): string {
  const c = trip.constraints
  const transport = ({ flight: '飞机', train: '火车', self_drive: '自驾' } as Record<string, string>)[c.transportMode || ''] || ''
  const dates = c.dateRange?.start ? `${fmtDate(c.dateRange.start)}–${fmtDate(c.dateRange.end)}` : '日期待定'
  const days = trip.days.length ? `${trip.days.length}天${Math.max(0, trip.days.length - 1)}晚` : ''
  return [c.origin, days, dates, transport].filter(Boolean).join(' · ')
}

function providerName(id: string): string {
  return (
    { mock: 'Mock', deepseek: 'DeepSeek', qwen: 'Qwen', openai: 'OpenAI', anthropic: 'Claude', custom: '自定义' }[id] ||
    id
  )
}
