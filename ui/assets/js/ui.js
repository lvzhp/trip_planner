/* ============================================================
   Trace Planner · UI 基础库
   图标系统（统一 .od-icon 契约）+ DOM 工具 + toast + 存储
   ============================================================ */

window.TP_UI = (function () {
  'use strict';

  /* ---------- 图标：一个家族，1.7 stroke，24 viewBox ---------- */
  const P = {
    logo: '<path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z"/><path d="m8.5 14.5 2.5-4 2 2.5 1.5-2 1 3.5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/>',
    car: '<path d="M5 11.5 6.8 7h10.4L19 11.5"/><rect x="4" y="11.5" width="16" height="5.5" rx="1.5"/><circle cx="7.5" cy="17" r="1.6"/><circle cx="16.5" cy="17" r="1.6"/>',
    walk: '<circle cx="13" cy="4.5" r="1.8"/><path d="m9 21 3-5.5-2-3 .8-4.2L14 10l2.4 1.6"/><path d="M10.8 8.3 7 10"/>',
    transit: '<rect x="6" y="3.5" width="12" height="12.5" rx="2.5"/><path d="M6 11h12M9.5 20l-1.5 1.5M14.5 20l1.5 1.5M8 17.5h8"/><circle cx="9" cy="13.5" r=".6"/><circle cx="15" cy="13.5" r=".6"/>',
    flight: '<path d="M10.2 13.8 3 11.4l1.6-1.6 7.3.6 4.4-4.4a2 2 0 1 1 2.8 2.8l-4.4 4.4.6 7.3-1.6 1.6-2.4-7.2-3.2 3.2.3 2.7-1.3.6-2-3.1-3-2 .5-1.3 2.7.3 3.2-3.2Z"/>',
    train: '<rect x="5.5" y="3.5" width="13" height="12" rx="3"/><path d="M5.5 10.5h13M8 20l-1.5 1.5M16 20l1.5 1.5M7.5 17.5h9"/><circle cx="9" cy="13" r=".7"/><circle cx="15" cy="13" r=".7"/>',
    bed: '<path d="M3 18v-8m0 4h18v4M3 14h18"/><path d="M21 14v-2a2 2 0 0 0-2-2H10v4"/><circle cx="6.5" cy="11.5" r="1.5"/>',
    utensils: '<path d="M6 3v7a2.5 2.5 0 0 0 5 0V3M8.5 10v11"/><path d="M17 3c-1.5 1-2.5 3-2.5 5.5 0 1.5.8 2.5 2.5 2.5v10"/>',
    camera: '<path d="M4 8.5h3l1.5-2.5h7L17 8.5h3v11H4v-11Z"/><circle cx="12" cy="13.5" r="3.2"/>',
    free: '<circle cx="12" cy="12" r="8.5" stroke-dasharray="3 3"/><path d="M12 8v8M8 12h8"/>',
    ticket: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h13A1.5 1.5 0 0 1 20 8.5v1.8a2 2 0 0 0 0 3.4v1.8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 15.5v-1.8a2 2 0 0 0 0-3.4V8.5Z"/><path d="M12 8v1.5M12 11.2v1.6M12 14.5V16" stroke-dasharray="1.6 1.6"/>',
    warn: '<path d="M12 4.5 2.8 20h18.4L12 4.5Z"/><path d="M12 10v4.2"/><circle cx="12" cy="17" r=".8" fill="currentColor" stroke="none"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><circle cx="12" cy="8" r=".9" fill="currentColor" stroke="none"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.3 2.6 2.6 5-5.4"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    xCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m9 9 6 6m0-6-6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    caretRight: '<path d="m9.5 5.5 7 6.5-7 6.5"/>',
    caretDown: '<path d="m5.5 9.5 6.5 7 6.5-7"/>',
    chevronLeft: '<path d="m14.5 5-7 7 7 7"/>',
    chevronRight: '<path d="m9.5 5 7 7-7 7"/>',
    send: '<path d="M4.5 12 20 4.5 14 20l-3-6.5-6.5-1.5Z"/><path d="m11 13.5 9-9"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
    edit: '<path d="M4.5 19.5h4L20 8a2.1 2.1 0 0 0-3-3L5.5 16.5l-1 3Z"/><path d="m15.5 6.5 2 2"/>',
    pin: '<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    calendar: '<rect x="4" y="5.5" width="16" height="15" rx="2"/><path d="M4 10h16M8.5 3.5V7M15.5 3.5V7"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/>',
    moon: '<path d="M20 14.2A8.2 8.2 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2Z"/>',
    layers: '<path d="m12 3.5 8.5 4.7-8.5 4.7-8.5-4.7L12 3.5Z"/><path d="m4.5 12.5 7.5 4.2 7.5-4.2M4.5 16.5l7.5 4.2 7.5-4.2"/>',
    crosshair: '<circle cx="12" cy="12" r="7.5"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
    history: '<path d="M3.8 12a8.2 8.2 0 1 0 2.6-6M3.5 4.5V9h4.5"/><path d="M12 7.8V12l3 1.8"/>',
    share: '<circle cx="6" cy="12" r="2.4"/><circle cx="17.5" cy="6" r="2.4"/><circle cx="17.5" cy="18" r="2.4"/><path d="m8.2 10.9 7.1-3.7M8.2 13.1l7.1 3.7"/>',
    download: '<path d="M12 4v10.5M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 18.5h15"/>',
    copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path d="M15.5 5.5A1.5 1.5 0 0 0 14 4H6a2 2 0 0 0-2 2v8a1.5 1.5 0 0 0 1.5 1.5"/>',
    panelRight: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M14.5 4.5v15"/>',
    chat: '<path d="M20 12.5a7.2 7.2 0 0 1-7.7 7.2L7 21.5l1-4A7.2 7.2 0 0 1 11.7 4.3 7.2 7.2 0 0 1 20 12.5Z"/>',
    map: '<path d="m9 4.5 6 2.5 5-2.5v13l-5 2.5-6-2.5-5 2.5v-13l5-2.5Z"/><path d="M9 4.5v13M15 7v13"/>',
    hamburger: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    grip: '<circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none"/>',
    sparkle: '<path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.5l-1.8-5.9L4.5 10.8 10.2 9 12 3.5Z"/><path d="M18.5 16.5 19.3 19l2.2.8-2.2.8-.8 2.4"/>',
    wechat: '<path d="M9 4C5.4 4 2.5 6.4 2.5 9.4c0 1.7 1 3.3 2.5 4.3l-.6 2.2 2.4-1.2c.7.2 1.4.3 2.2.3"/><path d="M15.2 8.4c3.2 0 5.8 2.1 5.8 4.8 0 1.5-.9 2.9-2.2 3.7l.5 2-2.1-1c-.6.2-1.3.3-2 .3-3.2 0-5.8-2.1-5.8-4.8s2.6-5 5.8-5Z"/><circle cx="7.3" cy="8" r=".8" fill="currentColor" stroke="none"/><circle cx="10.8" cy="8" r=".8" fill="currentColor" stroke="none"/><circle cx="13.5" cy="12" r=".7" fill="currentColor" stroke="none"/><circle cx="16.8" cy="12" r=".7" fill="currentColor" stroke="none"/>',
    miniProgram: '<path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5"/><path d="M12 7.5a4.5 4.5 0 1 0 4.5 4.5"/><path d="M20.5 3.5 12 12"/>',
    app: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 5.5h3M12 18.2v.1"/>',
    web: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5s-1.1 6.1-3.3 8.5c-2.2-2.4-3.3-5.3-3.3-8.5S9.8 5.9 12 3.5Z"/>',
    ota: '<path d="M4 7.5h16v12H4v-12ZM8 7.5V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2.5"/><path d="M4 12.5h16"/>',
    onsite: '<path d="M4 9.5 12 4l8 5.5"/><path d="M6 9v10.5h12V9M10 19.5v-5h4v5"/>',
    route: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18h4.2a3.3 3.3 0 0 0 0-6.6h-1.4a3.3 3.3 0 0 1 0-6.6h4.2" stroke-dasharray="1 2.6"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.6 0v2.7"/>',
    fuel: '<path d="M4.5 20.5V6a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v14.5M3.5 20.5h11M4.5 10.5h9"/><path d="M13.5 8.5h2.2a1.8 1.8 0 0 1 1.8 1.8v5.4a1.6 1.6 0 0 0 3.2 0V9l-2.4-2.4"/>',
    eye: '<path d="M2.8 12S6 5.8 12 5.8 21.2 12 21.2 12 18 18.2 12 18.2 2.8 12 2.8 12Z"/><circle cx="12" cy="12" r="3"/>',
    arrowUpRight: '<path d="M7 17 17 7M8.5 7H17v8.5"/>',
    quote: '<path d="M9 6.5C6.5 7.8 5 10 5 12.8 5 15.4 6.4 17 8.3 17c1.6 0 2.9-1.2 2.9-2.8 0-1.6-1.1-2.7-2.6-2.7-.3 0-.7 0-.9.2.2-1.3 1.1-2.6 2.4-3.4L9 6.5Zm9 0c-2.5 1.3-4 3.5-4 6.3 0 2.6 1.4 4.2 3.3 4.2 1.6 0 2.9-1.2 2.9-2.8 0-1.6-1.1-2.7-2.6-2.7-.3 0-.7 0-.9.2.2-1.3 1.1-2.6 2.4-3.4L18 6.5Z"/>',
    weather: '<circle cx="8.2" cy="8.2" r="3"/><path d="M8.2 3.2v1.2M8.2 12v1.2M3.2 8.2h1.2M12 8.2h1.2M4.7 4.7l.9.9M10.9 10.9l.9.9M11.8 4.7l-.9.9M5.6 10.9l-.9.9"/><path d="M10.5 18.8a3 3 0 0 1 3-3.8 4.2 4.2 0 0 1 8 1.2 2.7 2.7 0 0 1-.5 5.1h-8a2.6 2.6 0 0 1-2.5-2.5Z"/>'
  };

  function icon(name, opts = {}) {
    const size = opts.size ? ` style="--od-icon-size:${opts.size}"` : '';
    const cls = opts.class ? ' ' + opts.class : '';
    return `<svg class="od-icon${cls}"${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
  }

  /* ---------- DOM 工具 ---------- */
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  /* 极简 Markdown：#### 标题 / **粗体** / `代码` / - 列表 / 换行 */
  function md(src) {
    const lines = String(src).split('\n');
    let out = '', inList = false;
    for (const raw of lines) {
      let line = esc(raw);
      if (line.startsWith('#### ')) {
        if (inList) { out += '</ul>'; inList = false; }
        out += `<h4>${inline(line.slice(5))}</h4>`; continue;
      }
      if (/^\s*[-·]\s+/.test(line)) {
        if (!inList) { out += '<ul>'; inList = true; }
        out += `<li>${inline(line.replace(/^\s*[-·]\s+/, ''))}</li>`; continue;
      }
      if (inList) { out += '</ul>'; inList = false; }
      if (line.trim() === '') continue;
      out += `<p>${inline(line)}</p>`;
    }
    if (inList) out += '</ul>';
    return out;
    function inline(s) {
      return s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`(.+?)`/g, '<code>$1</code>');
    }
  }

  /* ---------- 存储 ---------- */
  const store = {
    get(k, dflt) {
      try { const v = localStorage.getItem('tp:' + k); return v == null ? dflt : JSON.parse(v); }
      catch { return dflt; }
    },
    set(k, v) { try { localStorage.setItem('tp:' + k, JSON.stringify(v)); } catch {} }
  };

  /* ---------- Toast ---------- */
  function toast(msg, iconName = 'checkCircle') {
    let host = document.querySelector('.toast-host');
    if (!host) { host = el('<div class="toast-host" aria-live="polite"></div>'); document.body.appendChild(host); }
    const t = el(`<div class="toast">${icon(iconName)}<span>${esc(msg)}</span></div>`);
    host.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .25s'; setTimeout(() => t.remove(), 260); }, 2400);
  }

  /* ---------- 复制 ---------- */
  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    toast(okMsg || '已复制');
  }

  /* ---------- 日期 / 数字格式化 ---------- */
  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  function fmtDate(iso) {           // 2026-05-03 -> 5月3日
    const [, m, d] = iso.split('-');
    return `${+m}月${+d}日`;
  }
  function fmtDateWeek(iso) {
    const dt = new Date(iso + 'T00:00:00');
    return `${fmtDate(iso)} ${WEEK[dt.getDay()]}`;
  }
  function fmtMoney(range, currency = 'CNY') {
    const [a, b] = range;
    if (!a && !b) return '免费';
    const f = n => '¥' + n.toLocaleString('zh-CN');
    return a === b ? f(a) : `${f(a)}–${f(b)}`;
  }
  function fmtDur(min) {
    const h = Math.floor(min / 60), m = min % 60;
    return h ? (m ? `${h}小时${m}分` : `${h}小时`) : `${m}分钟`;
  }
  function timeDiff(a, b) {          // '09:00' -> '13:00' 分钟差
    const [ah, am] = a.split(':').map(Number), [bh, bm] = b.split(':').map(Number);
    return (bh * 60 + bm) - (ah * 60 + am);
  }

  /* ---------- 交通模式元信息 ---------- */
  const transitMeta = {
    walk:    { icon: 'walk',    label: '步行',   line: 'city' },
    drive:   { icon: 'car',     label: '驾车',   line: 'drive' },
    transit: { icon: 'transit', label: '区间车', line: 'city' },
    flight:  { icon: 'flight',  label: '航班',   line: 'flight' },
    train:   { icon: 'train',   label: '火车',   line: 'train' },
    self_drive: { icon: 'car',  label: '自驾',   line: 'drive' }
  };
  const actTypeMeta = {
    visit:        { icon: 'camera',     label: '游览' },
    meal:         { icon: 'utensils',   label: '餐饮' },
    stay:         { icon: 'bed',        label: '住宿' },
    long_transit: { icon: 'flight',     label: '长途' },
    free:         { icon: 'free',       label: '自由' }
  };
  const channelMeta = {
    wechat_mp:    { icon: 'wechat',      cls: 'ch-wechat', label: '微信公众号' },
    mini_program: { icon: 'miniProgram', cls: 'ch-mini',   label: '小程序' },
    app:          { icon: 'app',         cls: 'ch-app',    label: 'App' },
    web:          { icon: 'web',         cls: 'ch-web',    label: '网页' },
    ota:          { icon: 'ota',         cls: 'ch-ota',    label: 'OTA' },
    onsite:       { icon: 'onsite',      cls: 'ch-onsite', label: '现场' }
  };
  const conflictTypeLabel = {
    day_overload: '当日过载', rhythm_violation: '作息冲突', budget_exceeded: '预算超支',
    season_closed: '季节封路', time_overlap: '时间重叠', insufficient_transit: '交通时间不足',
    must_go_missing: '必去点缺失', missing_coord_source: '坐标缺失', insufficient_transit_info: '交通信息不足'
  };
  const bookingKindLabel = { flight: '机票', train: '火车', hotel: '酒店', ticket: '门票', car: '租车' };

  /* ---------- 按天色 ---------- */
  function dayColorVar(dayIndex) {
    return `var(--day-${((dayIndex - 1) % 12) + 1})`;
  }

  /* ---------- 主题 / 密度 ---------- */
  function initTheme() {
    const saved = store.get('theme', 'light');
    document.documentElement.setAttribute('data-theme', saved);
    const density = store.get('density', 'compact');
    document.documentElement.setAttribute('data-density', density);
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    store.set('theme', next);
    return next;
  }
  function toggleDensity() {
    const cur = document.documentElement.getAttribute('data-density');
    const next = cur === 'cozy' ? 'compact' : 'cozy';
    document.documentElement.setAttribute('data-density', next);
    store.set('density', next);
    return next;
  }

  /* ---------- 简易下拉菜单管理 ---------- */
  function bindMenu(triggerSel, menuSel) {
    const trig = document.querySelector(triggerSel), menu = document.querySelector(menuSel);
    if (!trig || !menu) return;
    trig.addEventListener('click', e => {
      e.stopPropagation();
      const open = menu.classList.toggle('open');
      trig.setAttribute('aria-expanded', open);
    });
    document.addEventListener('click', e => {
      if (!menu.contains(e.target)) { menu.classList.remove('open'); trig.setAttribute('aria-expanded', 'false'); }
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') menu.classList.remove('open'); });
  }

  return {
    icon, el, esc, md, store, toast, copyText,
    fmtDate, fmtDateWeek, fmtMoney, fmtDur, timeDiff,
    transitMeta, actTypeMeta, channelMeta, conflictTypeLabel, bookingKindLabel,
    dayColorVar, initTheme, toggleTheme, toggleDensity, bindMenu
  };
})();
