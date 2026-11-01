import { Link } from 'react-router-dom'
import { useUiStore } from '../stores/uiStore'
import { Icon } from '../lib/icons'

const COLORS = [
  ['primary', '#1D6F5C', '深松绿'],
  ['primary-600', '#155346', '主色深'],
  ['primary-100', '#E4F0ED', '主色浅'],
  ['accent', '#E8833A', '琥珀橙 · CTA / diff'],
  ['error', '#DC2626', '错误'],
  ['warning', '#F59E0B', '警告'],
  ['success', '#16A34A', '成功'],
  ['info', '#2563EB', '信息'],
  ['bg', '#FFFFFF', '背景'],
  ['surface', '#F8FAFB', '面板 / 卡片底'],
  ['surface-2', '#F1F5F7', '二级底'],
  ['border', '#E3E8EB', '描边'],
  ['text', '#0F1720', '正文'],
  ['text-muted', '#5A6B78', '次要文字'],
  ['text-faint', '#8D9BA6', '弱文字'],
]

export function Spec() {
  const theme = useUiStore(s => s.theme)
  const toggleTheme = useUiStore(s => s.toggleTheme)
  const density = useUiStore(s => s.density)
  const toggleDensity = useUiStore(s => s.toggleDensity)
  return (
    <div className="spec-page">
      <header className="list-topbar">
        <Link className="topbar-brand" to="/">
          <span className="logo"><Icon name="logo" /></span>
          Trace Planner
        </Link>
        <span className="list-tagline">设计规范 · Design System</span>
        <span className="spacer" />
        <button className="btn btn-sm" type="button" onClick={toggleDensity}>密度：{density === 'cozy' ? '舒适' : '紧凑'}</button>
        <button className="icon-btn" type="button" aria-label="切换深色模式" onClick={toggleTheme}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
        <Link className="btn btn-sm" to="/">返回行程</Link>
      </header>
      <main className="spec-main">
        <div className="spec-hero">
          <div>
            <h1>Trace Planner · 设计规范</h1>
            <p>现代工具感 + 旅行的温度。克制、精确、信息密度优先；不做营销落地页。</p>
          </div>
          <span className="chip"><Icon name="layers" /> tokens v1</span>
        </div>

        <section className="spec-section">
          <h2>色彩 <span className="en">Color</span></h2>
          <div className="swatch-grid">
            {COLORS.map(([name, hex, desc]) => (
              <div className="swatch" key={name}>
                <div className="sw-color" style={{ background: `var(--${name})` }} />
                <div className="sw-info">
                  <div className="sw-name">{name}</div>
                  <div className="sw-hex">{hex}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="spec-sub">地图交通线（与语义色区分）</div>
          <div className="spec-card">
            {[
              ['line-city', '#64748B', '市内短驳 · 实线'],
              ['line-flight', '#6366F1', '航班 · 虚线弧'],
              ['line-train', '#C2410C', '火车 · 虚线'],
              ['line-drive', '#1D6F5C', '自驾 · 点划线'],
            ].map(([name, hex, label]) => (
              <div className="spacing-row" key={name}>
                <span className="s-label" style={{ width: 110 }}>{name}</span>
                <span style={{ width: 60, height: 3, background: `var(--${name})`, display: 'inline-block' }} />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label} · {hex}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="spec-section">
          <h2>字体阶梯 <span className="en">Typography</span></h2>
          {[
            ['24 / 600', '我的行程', 24, 600],
            ['20 / 600', '行程就绪 · 新疆环线', 20, 600],
            ['16 / 700', 'Day 3 · 喀纳斯 → 禾木', 16, 700],
            ['14 / 600', '喀纳斯湖 · 三湾徒步', 14, 600],
            ['13 / 400', '从上一站驾车 35 分钟 · 21 km', 13, 400],
            ['12 / 500', '需提前 3 天 · 实名制', 12, 500],
            ['11 / 500', '09:00–12:00 · v7', 11, 500],
          ].map(([label, text, size, weight]) => (
            <div className="type-row" key={label as string}>
              <span className="t-label">{label}</span>
              <span style={{ fontSize: `${size}px`, fontWeight: weight as number }}>{text}</span>
            </div>
          ))}
          <p style={{ fontSize: 12, color: 'var(--text-faint)' }}>
            所有时间、价格、里程必须使用 <code>font-variant-numeric: tabular-nums</code>，卡片流里时间才能列对齐。
          </p>
        </section>

        <section className="spec-section">
          <h2>形状 / 间距 / 阴影 <span className="en">Shape</span></h2>
          <div className="component-row">
            {[['--r-sm', '6px'], ['--r-md', '10px'], ['--r-lg', '14px']].map(([v, label]) => (
              <div className="component-cell" key={v}>
                <div style={{ width: 96, height: 52, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: `var(${v})` }} />
                <span className="c-label">{v} · {label}</span>
              </div>
            ))}
            {['--shadow-sm', '--shadow-md', '--shadow-lg'].map(v => (
              <div className="component-cell" key={v}>
                <div style={{ width: 96, height: 52, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: `var(${v})` }} />
                <span className="c-label">{v}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="spec-section">
          <h2>组件状态 <span className="en">Components</span></h2>
          <div className="spec-card component-row">
            <button className="btn btn-primary">主按钮</button>
            <button className="btn">次按钮</button>
            <button className="btn btn-ghost">幽灵按钮</button>
            <span className="chip">chip</span>
            <span className="chip chip-primary">主色 chip</span>
            <span className="chip chip-warning">需提前 3 天</span>
            <span className="chip chip-error">坐标缺失</span>
            <span className="badge badge-error">1</span>
            <span className="badge badge-warning">3</span>
          </div>
          <div className="spec-sub">冲突 / 交通 / 活动类型</div>
          <div className="spec-card component-row">
            <span className="act-type act-type-visit"><Icon name="camera" /> 游览</span>
            <span className="act-type act-type-meal"><Icon name="utensils" /> 餐饮</span>
            <span className="act-type act-type-stay"><Icon name="bed" /> 住宿</span>
            <span className="act-type act-type-long_transit"><Icon name="flight" /> 长途</span>
            <span className="act-type act-type-free"><Icon name="free" /> 自由</span>
            <span className="conflict-item severity-error" style={{ padding: '8px 10px' }}>
              <span className="ci-type"><Icon name="xCircle" /> 季节封路 · 错误</span>
            </span>
            <span className="conflict-item severity-warning" style={{ padding: '8px 10px' }}>
              <span className="ci-type"><Icon name="warn" /> 时间重叠 · 警告</span>
            </span>
          </div>
        </section>

        <section className="spec-section">
          <h2>动效 <span className="en">Motion</span></h2>
          <ul style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.9 }}>
            <li>全部 150–250ms，<code>cubic-bezier(0.4, 0, 0.2, 1)</code>。</li>
            <li>地图 diff 脉冲 600ms 一次、共 2 次；卡片高亮 1.2s 后回落。</li>
            <li>分割条拖拽跟手无延迟；卡片滚动定位 smooth + 短暂高亮。</li>
            <li>尊重 <code>prefers-reduced-motion</code>，该媒体查询已内置在 tokens.css。</li>
          </ul>
        </section>
      </main>
    </div>
  )
}
