/* ============================================================
   Trace Planner · Workbench 应用逻辑
   三态工作台（完整 / 首次规划中 / 节点重规划中）+ 三向联动
   + 抽屉体系 + 移动端 sheet。hash 路由：
     #/t/{tripId}   完整规划态（默认）
     #/planning     首次规划中（ask_user + 工具时间线 + 地图骨架）
     #/replan       节点重规划中（@阿勒泰 · Day 3，自动演示流程 B）
   ============================================================ */

(function () {
  'use strict';
  const { icon, el, esc, md, store, toast, copyText, fmtDate, fmtMoney, fmtDur, timeDiff,
    transitMeta, actTypeMeta, channelMeta, conflictTypeLabel, bookingKindLabel,
    dayColorVar, toggleTheme, toggleDensity, bindMenu } = window.TP_UI;
  const { MapCanvas, renderThumb } = window.TP_Map;
  const D = window.TP_DATA;

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  /* POI 评分：确定性派生（演示数据） */
  function poiRating(name) {
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 9973;
    return (4.2 + (h % 8) / 10).toFixed(1);
  }

  const state = {
    route: 'complete',          // complete | planning | replan
    readonly: false,
    trip: null,
    activeDay: 1,
    panelOpen: true,
    sending: false,
    ctxChips: [],
    popover: { stopId: null, pinned: false },
    bookingDone: store.get('bookingDone', []),
    sheetLevel: 0               // 移动端：0 收起 1 半屏 2 近全屏
  };

  let map = null;

  /* ============================================================
     顶栏
     ============================================================ */
  function renderTopbar() {
    const t = state.trip;
    const conf = D.derived.conflicts;
    const errs = conf.filter(c => c.severity === 'error').length;
    const warns = conf.filter(c => c.severity === 'warning').length;

    const conflictCls = errs ? 'has-error' : warns ? 'has-warning' : 'ok';
    const conflictLabel = errs ? `${errs} 个错误 · ${warns} 个警告` : warns ? `${warns} 个警告` : '校验通过';

    const host = $('#topbar-main') || $('#topbar');
    host.innerHTML = `
      <a class="topbar-brand" href="index.html" title="返回行程列表">
        <span class="logo">${icon('logo')}</span>
        <span class="desktop-only">Trace Planner</span>
      </a>
      <button class="icon-btn hamburger-only" id="btn-menu" aria-label="菜单">${icon('hamburger')}</button>
      <div class="trip-title-block">
        <button class="trip-title" id="btn-title" ${state.readonly ? 'disabled' : ''} title="点击重命名">
          <span class="trip-title-text" id="trip-title-text">${esc(t.title)}</span>
          ${state.readonly ? '' : icon('edit')}
        </button>
        <span class="trip-subtitle">新疆 · 8天7晚 · 5月1日–5月8日 · 自驾</span>
      </div>
      <button class="version-pill desktop-only" id="btn-version" title="版本历史">
        ${icon('history')} <span id="version-label">v${t.version}</span>
      </button>
      <button class="conflict-badge-btn ${conflictCls} desktop-only" id="btn-conflicts">
        ${icon('warn')} <span>${conflictLabel}</span>
      </button>
      <div class="topbar-actions">
        ${state.readonly ? '' : `
        <div class="desktop-only" style="position:relative">
          <button class="model-switch" id="btn-model" aria-expanded="false" aria-haspopup="true">
            <span class="provider-dot"></span>
            <span id="model-label">${esc(D.currentModel.provider)} · ${esc(D.currentModel.name)}</span>
            ${icon('caretDown', { class: 'caret' })}
          </button>
          <div class="menu model-menu" id="model-menu" role="menu"></div>
        </div>`}
        <button class="icon-btn desktop-only" id="btn-theme" title="切换深色模式" aria-label="切换深色模式">${document.documentElement.dataset.theme === 'dark' ? icon('sun') : icon('moon')}</button>
        ${state.readonly ? '' : `
        <button class="btn btn-sm desktop-only" id="btn-share">${icon('share')} 分享</button>
        <button class="btn btn-sm desktop-only" id="btn-export">${icon('download')} 导出长图</button>`}
      </div>`;

    renderModelMenu();
    bindTopbarEvents();
  }

  function renderModelMenu() {
    const menu = $('#model-menu');
    if (!menu) return;
    menu.innerHTML = D.models.map(p => `
      <div class="menu-label">${esc(p.provider)}</div>
      ${p.options.map(o => `
        <button class="menu-item model-opt ${o.id === D.currentModel.id ? 'selected' : ''}" data-provider="${esc(p.provider)}" data-id="${o.id}" data-name="${esc(o.name)}" role="menuitemradio" aria-checked="${o.id === D.currentModel.id}">
          <span>
            <span class="m-name">${esc(o.name)}</span><br>
            <span class="m-desc">${esc(o.desc)}</span>
          </span>
          ${icon('check', { class: 'check' })}
        </button>`).join('')}
    `).join('');
    menu.querySelectorAll('.model-opt').forEach(b => b.addEventListener('click', () => {
      D.currentModel = { provider: b.dataset.provider, id: b.dataset.id, name: b.dataset.name };
      $('#model-label') && ($('#model-label').textContent = `${D.currentModel.provider} · ${D.currentModel.name}`);
      menu.classList.remove('open');
      renderModelMenu();
      toast(`已切换到 ${D.currentModel.name}`);
    }));
  }

  function bindTopbarEvents() {
    $('#btn-version').addEventListener('click', openVersionDrawer);
    $('#btn-conflicts').addEventListener('click', () => openConflictDrawer(true));
    $('#btn-share')?.addEventListener('click', async () => {
      await copyText(location.href.replace(/#.*$/, '') + '#/s/' + state.trip.tripId, '只读分享链接已复制');
    });
    $('#btn-export')?.addEventListener('click', () => {
      toast('正在生成导出视图，请在打印对话框中选择「另存为 PDF」或截长图', 'info');
      setTimeout(() => window.print(), 600);
    });
    const btnTheme = $('#btn-theme');
    btnTheme.addEventListener('click', () => {
      const next = toggleTheme();
      btnTheme.innerHTML = next === 'dark' ? icon('sun') : icon('moon');
    });
    bindMenu('#btn-model', '#model-menu');
    $('#btn-title').addEventListener('click', () => {
      if (state.readonly) return;
      const block = $('#btn-title');
      const cur = state.trip.title;
      block.innerHTML = `<input id="title-input" value="${esc(cur)}" aria-label="行程标题">`;
      const input = $('#title-input');
      input.focus(); input.select();
      const commit = () => {
        const v = input.value.trim() || cur;
        state.trip.title = v;
        renderTopbar();
        if (v !== cur) toast('标题已更新');
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = cur; input.blur(); }
      });
    });
    $('#btn-menu')?.addEventListener('click', () => {
      /* 移动端汉堡：循环打开三个抽屉入口 */
      openDrawerSheet();
    });
  }

  function openDrawerSheet() {
    /* 移动端菜单：简单弹层列出抽屉入口 */
    const existing = $('#mobile-menu');
    if (existing) { existing.remove(); return; }
    const m = el(`<div class="menu open" id="mobile-menu" style="position:fixed;top:50px;left:10px;z-index:1000;min-width:180px">
      <button class="menu-item" data-act="version">${icon('history')} 版本历史</button>
      <button class="menu-item" data-act="booking">${icon('calendar')} 预订提醒</button>
      <button class="menu-item" data-act="conflicts">${icon('warn')} 校验冲突</button>
      <div class="menu-sep"></div>
      <button class="menu-item" data-act="theme">${icon('moon')} 切换主题</button>
      <button class="menu-item" data-act="home">${icon('map')} 行程列表</button>
    </div>`);
    document.body.appendChild(m);
    m.addEventListener('click', e => {
      const b = e.target.closest('.menu-item'); if (!b) return;
      m.remove();
      const act = b.dataset.act;
      if (act === 'version') openVersionDrawer();
      if (act === 'booking') openBookingDrawer();
      if (act === 'conflicts') openConflictDrawer();
      if (act === 'theme') toggleTheme();
      if (act === 'home') location.href = 'index.html';
    });
    setTimeout(() => document.addEventListener('click', function rm(ev) {
      if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('click', rm); }
    }), 0);
  }

  /* ============================================================
     对话区渲染（五种消息形态）
     ============================================================ */
  function renderConvo(items) {
    const host = $('#chat-scroll');
    host.innerHTML = '';
    for (const it of items) host.appendChild(buildMessage(it));
    scrollChatToBottom();
  }
  function appendMessage(it) {
    const host = $('#chat-scroll');
    host.appendChild(buildMessage(it));
    scrollChatToBottom();
    return host.lastElementChild;
  }
  function scrollChatToBottom() {
    const host = $('#chat-scroll');
    requestAnimationFrame(() => { host.scrollTop = host.scrollHeight; });
  }

  function buildMessage(it) {
    switch (it.type) {
      case 'user': return buildUserMsg(it);
      case 'ai': return buildAiMsg(it);
      case 'tools': return buildToolGroup(it);
      case 'ask_user': return buildAskCard(it);
      case 'ready_card': return buildReadyCard();
      case 'assumption': return buildAssumptionNote(it);
      default: return el('<div></div>');
    }
  }

  /* (a) 用户消息 */
  function buildUserMsg(it) {
    const chips = (it.ctx || []).map(c =>
      `<span class="ctx-chip">${icon('pin')} @${esc(c.label)}</span>`).join('');
    return el(`
      <div class="msg-user">
        ${chips ? `<div class="ctx-chips">${chips}</div>` : ''}
        <div class="bubble">${esc(it.text)}</div>
        <span class="msg-time">${esc(it.time || '')}</span>
      </div>`);
  }

  /* (b) AI 文本消息 */
  function buildAiMsg(it) {
    return el(`
      <div class="msg-ai">
        <span class="avatar">${icon('sparkle')}</span>
        <div>
          <div class="md-body">${md(it.md || it.text || '')}</div>
          ${it.time ? `<div class="msg-time">Trace · ${esc(it.time)}</div>` : ''}
        </div>
      </div>`);
  }

  /* (c) 工具调用时间线（聚合为一组，可折叠） */
  function buildToolGroup(it) {
    const node = el(`
      <div class="tool-group ${it.collapsed ? '' : 'open'}" role="group" aria-label="工具调用">
        <button class="tool-group-head" aria-expanded="${!it.collapsed}">
          ${it.status === 'running' ? '<span class="spinner spinner-sm"></span>' : icon('checkCircle')}
          <span>${it.status === 'running' ? '正在调用工具…' : '工具调用完成'}</span>
          <span class="tg-count">${it.items.length} 项</span>
          ${icon('caretRight', { class: 'caret' })}
        </button>
        <div class="tool-group-body"></div>
      </div>`);
    const body = node.querySelector('.tool-group-body');
    for (const tool of it.items) body.appendChild(buildToolItem(tool));
    node.querySelector('.tool-group-head').addEventListener('click', () => {
      node.classList.toggle('open');
      node.querySelector('.tool-group-head').setAttribute('aria-expanded', node.classList.contains('open'));
    });
    return node;
  }

  function buildToolItem(tool) {
    const st = tool.status || 'done';
    const iconName = st === 'running' ? null : (st === 'failed' ? 'xCircle' : tool.icon);
    const node = el(`
      <div class="tool-item ${st}">
        <span class="ti-icon">${st === 'running' ? '<span class="spinner spinner-sm"></span>' : icon(iconName)}</span>
        <div class="ti-main">
          <div class="ti-title">${esc(tool.title)}</div>
          ${tool.result ? `<div class="ti-result">${esc(tool.result)}</div>` : ''}
          ${tool.json ? `<button class="ti-expand">${icon('caretRight')} 查看结果</button><pre class="ti-json">${esc(tool.json)}</pre>` : ''}
        </div>
      </div>`);
    node.querySelector('.ti-expand')?.addEventListener('click', e => {
      e.stopPropagation();
      node.classList.toggle('expanded');
      const open = node.classList.contains('expanded');
      node.querySelector('.ti-expand').innerHTML = `${icon(open ? 'caretDown' : 'caretRight')} ${open ? '收起' : '查看结果'}`;
    });
    return node;
  }

  /* (d) ask_user 提问卡 */
  function buildAskCard(it) {
    if (it.answered) return buildAskCardAnswered(it);
    const node = el(`
      <div class="ask-card" role="form" aria-label="AI 提问">
        <div class="ask-card-head">
          ${icon('chat')}
          <span class="ask-head-title">${esc(it.intro || '需要确认几件事')}</span>
          <span class="chip chip-primary ask-badge">${it.questions.length} 个问题</span>
        </div>
        <div class="ask-questions"></div>
        <div class="ask-free-input">
          <div class="fi-row">
            <input type="text" placeholder="直接输入你的想法…" aria-label="自由输入">
            <button class="btn btn-primary btn-sm">发送</button>
          </div>
        </div>
        <div class="ask-card-foot">
          <span class="foot-hint">备注可以为空，直接提交</span>
          <button class="btn btn-primary ask-submit">下一步 ${icon('arrowUpRight')}</button>
        </div>
      </div>`);
    const qHost = node.querySelector('.ask-questions');
    const answers = it.questions.map(() => ({ selected: new Set(), note: '' }));

    it.questions.forEach((q, qi) => {
      const qNode = el(`
        <div class="ask-question">
          <div class="ask-q-label">${esc(q.question)} <span class="q-hint">${q.multi ? '可多选' : '单选'}</span></div>
          <div class="ask-options" role="${q.multi ? 'group' : 'radiogroup'}"></div>
          <button class="ask-skip">${icon('chat')} 不选，直接和 AI 沟通</button>
          <div class="ask-note">
            <label>备注（可选）</label>
            <textarea rows="1" placeholder="${esc(q.noteHint || '补充说明…')}"></textarea>
          </div>
        </div>`);
      const optHost = qNode.querySelector('.ask-options');
      q.options.forEach(o => {
        const b = el(`<button class="ask-opt" role="${q.multi ? 'checkbox' : 'radio'}" aria-checked="false">${esc(o.label)}</button>`);
        b.addEventListener('click', () => {
          const a = answers[qi];
          if (q.multi) {
            a.selected.has(o.id) ? a.selected.delete(o.id) : a.selected.add(o.id);
          } else {
            a.selected.clear(); a.selected.add(o.id);
            optHost.querySelectorAll('.ask-opt').forEach(x => { x.classList.remove('selected'); x.setAttribute('aria-checked', 'false'); });
          }
          b.classList.toggle('selected', a.selected.has(o.id));
          b.setAttribute('aria-checked', a.selected.has(o.id));
          if (b.classList.contains('selected')) b.insertAdjacentHTML('afterbegin', icon('check'));
          else b.querySelector('.od-icon')?.remove();
          /* 选中任一选项后出现备注框 */
          qNode.querySelector('.ask-note').classList.toggle('visible', a.selected.size > 0);
        });
        optHost.appendChild(b);
      });
      qNode.querySelector('.ask-skip').addEventListener('click', () => {
        node.querySelector('.ask-free-input').classList.add('visible');
        node.querySelector('.ask-card-foot').style.display = 'none';
        node.querySelector('.ask-free-input input').focus();
      });
      qNode.querySelector('.ask-note textarea').addEventListener('input', e => { answers[qi].note = e.target.value; });
      qHost.appendChild(qNode);
    });

    /* 自由输入出口 */
    const fi = node.querySelector('.ask-free-input');
    const sendFree = () => {
      const v = fi.querySelector('input').value.trim();
      if (!v) return;
      finishAsk(node, it, null, v);
    };
    fi.querySelector('button').addEventListener('click', sendFree);
    fi.querySelector('input').addEventListener('keydown', e => { if (e.key === 'Enter') sendFree(); });

    node.querySelector('.ask-submit').addEventListener('click', () => {
      const anySelected = answers.some(a => a.selected.size > 0);
      if (!anySelected) {
        toast('请至少选择一个选项，或点「不选，直接和 AI 沟通」', 'info');
        return;
      }
      finishAsk(node, it, answers, null);
    });

    function finishAsk(cardNode, data, answersArr, freeText) {
      /* 转只读已答态 */
      const answeredData = {
        ...data, answered: true,
        questions: data.questions.map((q, qi) => ({
          ...q,
          answer: answersArr ? [...answersArr[qi].selected].map(id => q.options.find(o => o.id === id)?.label).filter(Boolean).join('、') : null,
          note: answersArr ? answersArr[qi].note : ''
        })),
        freeText
      };
      cardNode.replaceWith(buildAskCardAnswered(answeredData));
      scrollChatToBottom();
      if (it.onAnswer) it.onAnswer(answeredData);
    }
    return node;
  }

  function buildAskCardAnswered(it) {
    const rows = it.questions.map(q => {
      if (q.answer == null && !q.note) return '';
      /* answer 可能是选项 id（如 'd8'）或已拼接的 label，统一解析为 label */
      let ans = q.answer;
      if (ans && q.options) {
        ans = String(ans).split('、').map(part => {
          const opt = q.options.find(o => o.id === part || o.label === part);
          return opt ? opt.label : part;
        }).join('、');
      }
      return `<div class="ask-answered-row">
        <span class="aq">${esc(q.question)}</span>
        <span class="av">${esc(ans || '—')}</span>
        ${q.note ? `<span class="an">备注：${esc(q.note)}</span>` : ''}
      </div>`;
    }).join('');
    return el(`
      <div class="ask-card answered">
        <div class="ask-card-head">
          ${icon('checkCircle')}
          <span class="ask-head-title">已回答</span>
          <span class="chip ask-badge">${icon('lock')} 只读</span>
        </div>
        ${rows}
        ${it.freeText ? `<div class="ask-answered-row"><span class="aq">自由输入</span><span class="av">${esc(it.freeText)}</span></div>` : ''}
      </div>`);
  }

  /* (e) 行程就绪卡 */
  function buildReadyCard() {
    const t = state.trip;
    const b = D.derived.budgetSummary;
    const dayRows = t.days.map(d => `
      <div class="ready-day-row" style="--day-color:${dayColorVar(d.dayIndex)}">
        <span class="rd-swatch"></span>
        <span class="rd-day">Day ${d.dayIndex}</span>
        <span class="rd-date">${fmtDate(d.date)}</span>
        <span class="rd-theme">${esc(d.theme)}</span>
      </div>`).join('');
    const node = el(`
      <div class="ready-card">
        <div class="ready-head">
          <span class="rh-icon">${icon('route')}</span>
          <div>
            <div class="rh-title">行程就绪 · 北疆大环线</div>
            <div class="rh-sub">8天7晚 · 5月1日–5月8日 · 2人自驾 · 上海往返</div>
          </div>
        </div>
        <div class="ready-stats">
          <div class="od-stat"><span class="st-num">${t.days.length}</span><span class="st-cap">天</span></div>
          <div class="od-stat"><span class="st-num">${countStops()}</span><span class="st-cap">地点</span></div>
          <div class="od-stat"><span class="st-num">¥${(b.grandTotal / 10000).toFixed(1)}w</span><span class="st-cap">总预算(2人)</span></div>
          <div class="od-stat"><span class="st-num">${D.derived.bookingTimeline.length}</span><span class="st-cap">待预订项</span></div>
        </div>
        <div class="ready-days">${dayRows}</div>
        <div class="ready-foot">
          <span class="rf-note">${icon('warn')} 1 项遗留待确认：独库公路 5 月初未开放（见冲突面板）</span>
          <button class="btn btn-sm" id="ready-booking">${icon('calendar')} 预订提醒清单</button>
        </div>
      </div>`);
    node.querySelector('#ready-booking').addEventListener('click', () => openBookingDrawer());
    return node;
  }
  function countStops() {
    return state.trip.days.reduce((n, d) => n + d.stops.length, 0);
  }

  /* 假设提示条 */
  function buildAssumptionNote(it) {
    const node = el(`
      <div class="assumption-note">
        ${icon('info')}
        <span>${it.items.map(esc).join('；')}。<span class="an-edit" role="button" tabindex="0">修改假设</span></span>
      </div>`);
    const edit = () => {
      if (state.readonly) { toast('只读分享页不可修改', 'info'); return; }
      addCtxChip({ label: '行程假设', kind: 'assumption' });
      $('#composer-input')?.focus();
      toast('已把「行程假设」加入上下文，直接输入要改的内容');
    };
    node.querySelector('.an-edit').addEventListener('click', edit);
    node.querySelector('.an-edit').addEventListener('keydown', e => { if (e.key === 'Enter') edit(); });
    return node;
  }

  /* ============================================================
     输入框 + 上下文 chip
     ============================================================ */
  function initComposer() {
    const ta = $('#composer-input');
    if (!ta) return;
    $('#btn-send').innerHTML = icon('send');
    ta.addEventListener('input', autoGrow);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    $('#btn-send').addEventListener('click', () => {
      if (state.sending) stopSending(); else sendMessage();
    });
    $$('.slash-cmd').forEach(b => b.addEventListener('click', () => {
      ta.value = (ta.value ? ta.value + ' ' : '') + b.dataset.cmd + ' ';
      ta.focus(); autoGrow();
    }));
    function autoGrow() {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
    }
  }

  function addCtxChip(chip) {
    state.ctxChips.push(chip);
    renderCtxChips();
  }
  function renderCtxChips() {
    const bar = $('#ctx-chips-bar');
    if (!bar) return;
    bar.innerHTML = '';
    state.ctxChips.forEach((c, i) => {
      const n = el(`<span class="ctx-chip-input">${icon('pin')} @${esc(c.label)}
        <button aria-label="移除上下文标签 ${esc(c.label)}">${icon('x', { class: 'chip-x' })}</button></span>`);
      n.querySelector('button').addEventListener('click', () => {
        state.ctxChips.splice(i, 1); renderCtxChips();
      });
      bar.appendChild(n);
    });
  }

  function sendMessage() {
    if (state.readonly || state.sending) return;
    const ta = $('#composer-input');
    const text = ta.value.trim();
    if (!text) return;

    /* 斜杠命令 */
    if (text.startsWith('/')) {
      const cmd = text.split(/\s+/)[0].toLowerCase();
      if (cmd === '/booking') { ta.value = ''; ta.style.height = 'auto'; openBookingDrawer(); return; }
      if (cmd === '/conflicts') { ta.value = ''; ta.style.height = 'auto'; openConflictDrawer(true); return; }
      if (cmd === '/history' || cmd === '/versions') { ta.value = ''; ta.style.height = 'auto'; openVersionDrawer(); return; }
      if (cmd === '/replan') {
        ta.value = ''; ta.style.height = 'auto';
        if (!state.ctxChips.length) { toast('先点卡片上的「改这里」选择一个节点，再输入想怎么改', 'info'); $('#composer-input').focus(); }
        return;
      }
      toast(`未知命令 ${cmd} · 可用：/replan /booking /conflicts /history`, 'info');
      return;
    }

    const ctx = [...state.ctxChips];
    ta.value = ''; ta.style.height = 'auto';
    appendMessage({ type: 'user', text, ctx, time: nowHM() });
    state.ctxChips = []; renderCtxChips();
    setSending(true);

    /* 判断是否为 Day 3 阿勒泰节点重规划 → 走流程 B 脚本 */
    const isDay3 = ctx.some(c => c.dayIndex === 3) || /阿勒泰|Day\s*3/.test(text);
    if (isDay3 && /重规划|重排|下午|起晚/.test(text)) {
      setTimeout(() => runReplanScript(), 900);
    } else {
      setTimeout(() => {
        appendMessage({ type: 'ai', time: nowHM(), md: genericReply(text, ctx) });
        setSending(false);
      }, 1200);
    }
  }

  function genericReply(text, ctx) {
    if (/重排|重新排|调整/.test(text)) {
      const where = ctx.length ? `**${ctx.map(c => c.label).join('、')}**` : '当天行程';
      return `我会重排 ${where}。先说明思路：\n- 保留当天已确认的住宿与门票\n- 只调整受影响的时间窗，其余天不动\n\n（原型演示：从卡片上的「改这里」发起节点级重规划可以看到完整流程）`;
    }
    if (/酒店|住宿/.test(text)) return '正在为你查找替代住宿…（原型演示：这里会调用 POI 搜索工具并给出 2–3 个候选卡片）';
    if (/预算|多少钱/.test(text)) {
      const b = D.derived.budgetSummary;
      return `当前预算概览（2 人）：\n- 门票 ¥${b.ticketsTotal.toLocaleString()} · 住宿 ¥${b.hotelsTotal.toLocaleString()}\n- 餐饮预估 ¥${b.foodEstTotal.toLocaleString()} · 交通（机票+租车+油费）¥${b.transitEstTotal.toLocaleString()}\n- **合计 ¥${b.grandTotal.toLocaleString()}**，预算 ¥${b.budgetTotal.toLocaleString()} 内，余量 ¥${(b.budgetTotal - b.grandTotal).toLocaleString()}`;
    }
    return `收到。「${text}」我会结合当前行程上下文处理。（原型演示：试试点卡片上的「改这里」，或输入「预算」查看概览）`;
  }

  function setSending(on) {
    state.sending = on;
    const btn = $('#btn-send');
    btn.classList.toggle('stop', on);
    btn.innerHTML = on ? icon('stop') : icon('send');
    btn.title = on ? '停止生成' : '发送';
    $('#composer-input').disabled = on;
    $('#composer').classList.toggle('disabled', on);
  }
  function stopSending() {
    setSending(false);
    appendMessage({ type: 'ai', time: nowHM(), md: '已停止本次生成。' });
  }
  function nowHM() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /* ============================================================
     行程卡片面板
     ============================================================ */
  function renderPanel() {
    const t = state.trip;
    /* day tabs */
    const tabs = $('#day-tabs');
    tabs.innerHTML = t.days.map(d => {
      const dayConf = D.derived.conflicts.filter(c => c.dayIndex === d.dayIndex);
      const hasErr = dayConf.some(c => c.severity === 'error');
      const hasWarn = dayConf.length > 0;
      return `
        <button class="day-tab ${d.dayIndex === state.activeDay ? 'active' : ''}" data-day="${d.dayIndex}"
          style="--day-color:${dayColorVar(d.dayIndex)}" role="tab" aria-selected="${d.dayIndex === state.activeDay}">
          <span class="dt-day">Day ${d.dayIndex}</span>
          <span class="dt-date">${fmtDate(d.date)}</span>
          ${hasErr ? '<span class="conflict-dot" title="有错误"></span>' : hasWarn ? '<span class="conflict-dot warning-only" title="有警告"></span>' : ''}
        </button>`;
    }).join('');
    tabs.querySelectorAll('.day-tab').forEach(b => b.addEventListener('click', () => switchDay(+b.dataset.day)));

    renderDayCards();
  }

  function switchDay(dayIdx, opts = {}) {
    state.activeDay = dayIdx;
    $$('.day-tab').forEach(b => {
      const on = +b.dataset.day === dayIdx;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on);
    });
    renderDayCards();
    if (!opts.noMap) map && map.applyDayFilter(dayIdx);
    updateDayCardOnMap(dayIdx);
    if (opts.scrollTo) {
      const card = $(`.act-card[data-activity-id="${opts.scrollTo}"]`) || $(`.act-card[data-stop-id="${opts.stopId}"]`);
      if (card) highlightCard(card);
    }
  }

  function updateDayCardOnMap(dayIdx) {
    const day = state.trip.days.find(d => d.dayIndex === dayIdx);
    const dc = $('#map-daycard');
    if (!dc || !day) return;
    const names = day.stops.map(s => s.poi.name.split(' · ')[0]);
    const routeStr = names.length > 2 ? `${names[0]} → … → ${names[names.length - 1]}` : names.join(' → ');
    dc.style.setProperty('--day-color', dayColorVar(dayIdx));
    dc.innerHTML = `
      <span class="day-swatch"></span>
      <div>
        <div class="dc-title">Day ${dayIndex2CN(dayIdx)} · ${fmtDate(day.date)}</div>
        <div class="dc-sub">${esc(routeStr)}</div>
      </div>
      <span class="dc-nav">
        <button data-nav="-1" aria-label="前一天">${icon('chevronLeft')}</button>
        <button data-nav="1" aria-label="后一天">${icon('chevronRight')}</button>
      </span>`;
    dc.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => {
      const n = dayIdx + +b.dataset.nav;
      if (n >= 1 && n <= state.trip.days.length) switchDay(n);
    }));
  }
  function dayIndex2CN(i) { return String(i); }

  function renderDayCards() {
    const day = state.trip.days.find(d => d.dayIndex === state.activeDay);
    const host = $('#panel-scroll');
    if (!day) return;
    const dd = D.derived.days[day.dayIndex] || { window: {}, loadHours: 0 };
    const dayConf = D.derived.conflicts.filter(c => c.dayIndex === day.dayIndex);

    /* 收集所有活动，按时间排序 */
    const rows = [];
    for (const stop of [...day.stops].sort((a, b) => a.seq - b.seq)) {
      for (const act of stop.activities) rows.push({ stop, act });
    }
    rows.sort((a, b) => (a.act.timeWindow?.start || '99:99').localeCompare(b.act.timeWindow?.start || '99:99'));

    let cardsHtml = '';
    let stayInserted = false;
    for (const { stop, act } of rows) {
      if (act.type === 'stay' && !stayInserted) {
        cardsHtml += `<div class="stay-divider">${icon('moon')} 今晚住宿</div>`;
        stayInserted = true;
      }
      cardsHtml += renderActCard(stop, act, day, dayConf);
    }
    /* 天级冲突（无 activityId） */
    const dayLevelConf = dayConf.filter(c => !c.activityId);
    const dayConfHtml = dayLevelConf.map(c => renderConflictBanner(c)).join('');

    host.innerHTML = `
      <div class="day-head" style="--day-color:${dayColorVar(day.dayIndex)}">
        <div class="day-head-top">
          <span class="dh-swatch"></span>
          <span class="dh-title">Day ${day.dayIndex} · ${esc(day.theme)}</span>
          <span class="dh-date">${fmtDate(day.date)}</span>
          ${state.readonly ? '' : `<button class="dh-edit-rhythm" data-day="${day.dayIndex}">${icon('clock')} 改作息</button>`}
        </div>
        <div class="day-stats">
          <div class="od-stat"><span class="st-num">${dd.window.firstStart || '—'}–${dd.window.lastEnd || '—'}</span><span class="st-cap">作息 ${day.rhythm.wake} 起 / ${day.rhythm.sleep} 休</span></div>
          <div class="od-stat"><span class="st-num">${dd.loadHours || 0}h</span><span class="st-cap">活动负载</span></div>
          <div class="od-stat"><span class="st-num">${dd.window.transitHours || 0}h</span><span class="st-cap">交通</span></div>
          <div class="od-stat"><span class="st-num">¥${dayBudget(day).toLocaleString()}</span><span class="st-cap">当日预算</span></div>
        </div>
      </div>
      <div class="day-cards" data-day="${day.dayIndex}">
        ${dayConfHtml}
        ${cardsHtml}
      </div>`;

    bindCardEvents(host);
    host.querySelector('.dh-edit-rhythm')?.addEventListener('click', e => {
      const di = +e.currentTarget.dataset.day;
      addCtxChip({ label: `Day ${di} 作息`, kind: 'rhythm', dayIndex: di });
      $('#composer-input').focus();
      toast('已插入作息上下文，输入新的起床/休息时间');
    });
  }

  function dayBudget(day) {
    let sum = 0;
    for (const s of day.stops) for (const a of s.activities) {
      const tk = a.ticket;
      if (tk && tk.priceRange && tk.kind !== 'none') sum += (tk.priceRange[0] + tk.priceRange[1]) / 2;
      if (a.foodDetail) sum += a.foodDetail.perPersonPrice * 2;
    }
    return Math.round(sum);
  }

  function renderConflictBanner(c) {
    return `
      <div class="conflict-item severity-${c.severity}" data-conflict-id="${c.id}" style="cursor:pointer">
        <div class="ci-head">
          <span class="ci-type">${icon(c.severity === 'error' ? 'xCircle' : 'warn')} ${conflictTypeLabel[c.type] || c.type}</span>
          <span class="ci-day">Day ${c.dayIndex}</span>
        </div>
        <div class="ci-msg">${esc(c.message)}</div>
      </div>`;
  }

  function renderActCard(stop, act, day, dayConf) {
    const meta = actTypeMeta[act.type] || actTypeMeta.visit;
    const tw = act.timeWindow ? `${act.timeWindow.start} – ${act.timeWindow.end}` : '全天';
    const conflicts = dayConf.filter(c => c.activityId === act.activityId);
    const diffTag = (state.diffTags || {})[act.activityId];

    /* --- 长途交通卡：整行高权重 --- */
    if (act.type === 'long_transit' && act.transitDetail) {
      const td = act.transitDetail;
      let mid = '', no = '', extras = '';
      if (td.mode === 'flight') {
        mid = `<div class="tr-mid"><span class="tr-dur">${fmtDur(timeDiff(td.depTime, td.arrTime))}</span>
          <span class="tr-line">${icon('flight')}</span>
          <span class="transit-no">${esc(td.flightNo)} · ${esc(td.airline)}</span></div>`;
        no = '';
        extras = `<div class="tx-row">${icon('pin')} ${esc(td.airportFrom)} → ${esc(td.airportTo)}</div>`;
      } else if (td.mode === 'train') {
        mid = `<div class="tr-mid"><span class="tr-dur">${fmtDur(timeDiff(td.depTime, td.arrTime))}</span>
          <span class="tr-line">${icon('train')}</span>
          <span class="transit-no">${esc(td.trainNo)} · ${esc(td.seatClass || '')}</span></div>`;
        extras = `<div class="tx-row">${icon('pin')} ${esc(td.stationFrom)} → ${esc(td.stationTo)}</div>`;
      } else {
        mid = `<div class="tr-mid"><span class="tr-dur">${fmtDur(td.driveMinutes)}</span>
          <span class="tr-line" style="--line-flight:var(--line-drive)">${icon('car')}</span>
          <span class="transit-no" style="color:var(--line-drive)">${td.distanceKm} 公里</span></div>`;
        extras = `
          <div class="tx-row">${icon('route')} ${esc((td.roadRefs || []).join(' / '))}${td.roadCondition ? ' · ' + esc(td.roadCondition) : ''}</div>
          ${td.waypointsPoi?.length ? `<div class="tx-row">${icon('pin')} 途经：${td.waypointsPoi.map(esc).join('、')}</div>` : ''}
          ${td.fuelStops?.length ? `<div class="tx-row">${icon('fuel')} 加油：${td.fuelStops.map(esc).join('、')}</div>` : ''}
          ${td.permitRequired ? `<div class="tx-row">${icon('lock')} 需通行证：${esc(td.permitNote || '')}</div>` : ''}`;
      }
      const fromTo = td.mode === 'flight' ? [td.airportFrom, td.airportTo] : td.mode === 'train' ? [td.stationFrom, td.stationTo] : null;
      return `
        <div class="act-card transit-card ${state.pendingDay3 && day.dayIndex === 3 ? 'pending-update' : ''}" data-stop-id="${stop.stopId}" data-activity-id="${act.activityId}" tabindex="0" role="button">
          ${diffTag ? `<span class="diff-corner pulsing">${esc(diffTag)}</span>` : ''}
          <div class="act-card-top">
            <span class="act-time">${act.timeWindow.start} – ${act.timeWindow.end}</span>
            <span class="act-type act-type-long_transit">${icon(td.mode === 'flight' ? 'flight' : td.mode === 'train' ? 'train' : 'car')} 长途 · ${td.mode === 'flight' ? '航班' : td.mode === 'train' ? '火车' : '自驾'}</span>
            ${editBtn(stop, act)}
          </div>
          <div class="act-title">${esc(act.title)}</div>
          <div class="transit-route">
            <div class="tr-endpoint"><span class="tr-time">${td.depTime}</span><span class="tr-place">${esc(fromTo ? fromTo[0] : '出发')}</span></div>
            ${mid}
            <div class="tr-endpoint" style="text-align:right"><span class="tr-time">${td.arrTime}</span><span class="tr-place">${esc(fromTo ? fromTo[1] : '到达')}</span></div>
          </div>
          <div class="transit-extras">${extras}</div>
          ${td.seasonClosure ? renderSeasonClosure(td.seasonClosure) : ''}
          ${act.ticket && act.ticket.kind !== 'none' ? renderTicketMini(act.ticket) : ''}
        </div>`;
    }

    /* --- free 卡片 --- */
    if (act.type === 'free') {
      return `
        <div class="act-card free-card" data-stop-id="${stop.stopId}" data-activity-id="${act.activityId}" tabindex="0" role="button">
          <div class="act-card-top">
            <span class="act-time">${tw}</span>
            <span class="act-type act-type-free">${icon('free')} 自由活动</span>
            ${editBtn(stop, act)}
          </div>
          <div class="act-title">${esc(act.title)}</div>
          <div class="free-hint">${icon('sparkle')} 这段时间自己安排 —— 也可以让我补排</div>
        </div>`;
    }

    /* --- 普通卡片（游览 / 餐饮 / 住宿） --- */
    const transit = act.transitFromPrev ? `
      <div class="act-transit">${icon(transitMeta[act.transitFromPrev.mode]?.icon || 'car')}
        <span>从上一站 ${transitMeta[act.transitFromPrev.mode]?.label || ''} <span class="num">${act.transitFromPrev.minutes}</span> 分钟${act.transitFromPrev.distanceKm ? ` · <span class="num">${act.transitFromPrev.distanceKm}</span> km` : ''}</span>
      </div>` : '';
    return `
      <div class="act-card ${act.type === 'stay' ? 'stay-card' : ''} ${state.pendingDay3 && day.dayIndex === 3 ? 'pending-update' : ''}"
        data-stop-id="${stop.stopId}" data-activity-id="${act.activityId}" tabindex="0" role="button">
        ${diffTag ? `<span class="diff-corner pulsing">${esc(diffTag)}</span>` : ''}
        <div class="act-card-top">
          <span class="act-time">${tw}</span>
          <span class="act-type act-type-${act.type}">${icon(meta.icon)} ${meta.label}</span>
          ${editBtn(stop, act)}
        </div>
        <div class="act-title">${esc(act.title)}</div>
        ${transit}
        ${act.ticket && act.ticket.kind !== 'none' ? renderTicketMini(act.ticket) : ''}
        ${act.foodDetail ? `<div class="act-meta-row">${icon('utensils')} <span>${esc(act.foodDetail.shopName)} · ${act.foodDetail.dishes.map(esc).join('、')} · 人均 <span class="val">¥${act.foodDetail.perPersonPrice}</span></span></div>` : ''}
        ${act.tips && act.tips[0] ? `<div class="act-meta-row">${icon('info')} <span>${esc(act.tips[0])}</span></div>` : ''}
        ${conflicts.map(c => renderCardConflict(c)).join('')}
      </div>`;
  }

  function editBtn(stop, act) {
    if (state.readonly) return '';
    return `<button class="act-edit-btn" data-edit-stop="${stop.stopId}" data-edit-act="${act.activityId}" aria-label="改这里：${esc(act.title)}">${icon('edit')} 改这里</button>`;
  }

  function renderTicketMini(tk) {
    const price = fmtMoney(tk.priceRange);
    const wechat = tk.channels?.find(c => c.type === 'wechat_mp');
    const lead = tk.leadTimeDays ? `需提前 ${tk.leadTimeDays} 天` : '';
    const real = tk.realNameRequired ? '实名制' : '';
    return `
      <div class="act-meta-row ticket">${icon('ticket')}
        <span><span class="val">${price}</span>${lead || real ? ` · ${[lead, real].filter(Boolean).join(' · ')}` : ''}
        ${wechat ? `<br><span class="channel-hint">首选 ${channelLabel(wechat.type)}<span class="wechat-name">「${esc(wechat.detail || wechat.name)}」</span></span>` : ''}</span>
      </div>`;
  }
  function channelLabel(type) { return channelMeta[type]?.label || type; }

  function renderSeasonClosure(sc) {
    return `
      <div class="season-closure-alert">${icon('warn')}
        <span><strong>季节性封路：</strong>${esc(sc.note || `${sc.road || '该路段'} 开放时间 ${esc(sc.openFrom || '?')} – ${esc(sc.openTo || '?')}，当前日期无法通行`)}
        <br><button class="btn btn-sm" style="margin-top:6px" data-open-conflicts>查看处理方案</button></span>
      </div>`;
  }

  function renderCardConflict(c) {
    return `
      <div class="act-conflict severity-${c.severity}" data-conflict-id="${c.id}" role="button" tabindex="0" aria-expanded="false">
        ${icon('warn')} <span>${esc(c.message.length > 34 ? c.message.slice(0, 34) + '…' : c.message)}（点击查看详情）</span>
        ${icon('caretRight', { class: 'expand-caret' })}
      </div>
      <div class="conflict-detail" data-detail-for="${c.id}">
        <div class="fix-title">${icon('sparkle')} 建议修法</div>
        ${esc(c.suggestedFix || '暂无自动修复建议，可在对话中告诉我怎么处理。')}
        ${c.askUser ? renderInlineAsk(c) : ''}
      </div>`;
  }

  function renderInlineAsk(c) {
    return `
      <div class="ci-ask" style="margin-top:8px;border-top:1px dashed var(--border);padding-top:8px">
        <div style="font-size:12px;font-weight:700;margin-bottom:6px">${esc(c.askUser.question)}</div>
        <div class="ask-options">
          ${c.askUser.options.map(o => `<button class="ask-opt btn-sm" data-conflict-choice="${o.id}" data-conflict-id="${c.id}">${esc(o.label)}</button>`).join('')}
        </div>
      </div>`;
  }

  function bindCardEvents(host) {
    /* 卡片点击 → 地图高亮居中 */
    host.querySelectorAll('.act-card').forEach(card => {
      const go = () => {
        const stopId = card.dataset.stopId;
        $$('.act-card.selected').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        if (map && stopId) { map.centerOn(stopId); map.selectStop(stopId, false); }
      };
      card.addEventListener('click', e => {
        if (e.target.closest('.act-edit-btn, .act-conflict, .conflict-detail, button')) return;
        go();
      });
      card.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    });
    /* 改这里 → chip + 聚焦输入框 */
    host.querySelectorAll('.act-edit-btn').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const stopId = b.dataset.editStop;
      const stop = findStop(stopId);
      if (!stop) return;
      addCtxChip({ label: `${stop.poi.name.split(' · ')[0]} · Day ${stop.dayIndex}`, stopId, dayIndex: stop.dayIndex });
      const ta = $('#composer-input');
      ta.focus();
      ta.placeholder = `说说想怎么改「${stop.poi.name.split(' · ')[0]}」…`;
    }));
    /* 卡片冲突展开 */
    host.querySelectorAll('.act-conflict').forEach(b => {
      const toggle = e => {
        e.stopPropagation();
        const detail = host.querySelector(`[data-detail-for="${b.dataset.conflictId}"]`);
        const open = detail.classList.toggle('open');
        b.classList.toggle('open', open);
        b.setAttribute('aria-expanded', open);
      };
      b.addEventListener('click', toggle);
      b.addEventListener('keydown', e => { if (e.key === 'Enter') toggle(e); });
    });
    /* 冲突内嵌选择题 */
    host.querySelectorAll('[data-conflict-choice]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const c = D.derived.conflicts.find(x => x.id === b.dataset.conflictId);
      const opt = c.askUser.options.find(o => o.id === b.dataset.conflictChoice);
      appendMessage({ type: 'user', text: opt.label, time: nowHM(), ctx: [{ label: `冲突 · ${conflictTypeLabel[c.type]}` }] });
      setSending(true);
      setTimeout(() => {
        appendMessage({ type: 'ai', time: nowHM(), md: `好的，已记录你的决定：**${opt.label}**。\n${b.dataset.conflictChoice === 'keep' ? '保持当前 v6 方案（特克斯+琼库什台），我会把「独库公路」从必去清单移到「下次再来」。' : '这会触发全程重排，涉及机票日期 —— 我先生成新版本再给你 diff 预览。'}\n\n（原型演示：此处会触发 plan_patch 事件流）` });
        setSending(false);
      }, 1000);
    }));
    host.querySelector('[data-open-conflicts]')?.addEventListener('click', e => { e.stopPropagation(); openConflictDrawer(true); });
    /* 天级冲突横幅 → 打开冲突面板并定位 */
    host.querySelectorAll('.day-cards > .conflict-item[data-conflict-id]').forEach(b => b.addEventListener('click', () => openConflictDrawer(true)));
  }

  function findStop(stopId) {
    for (const day of state.trip.days) for (const s of day.stops) if (s.stopId === stopId) return { ...s, dayIndex: day.dayIndex };
    return null;
  }

  function highlightCard(card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('flash-highlight');
    void card.offsetWidth;
    card.classList.add('flash-highlight');
    setTimeout(() => card.classList.remove('flash-highlight'), 1300);
  }

  /* ============================================================
     marker 点击浮层（§3.5）
     ============================================================ */
  function openPopover(stopId) {
    forceClosePopover();
    const stop = findStop(stopId);
    if (!stop) return;
    state.popover.stopId = stopId;

    const acts = stop.activities;
    const anyTicket = acts.map(a => a.ticket).filter(t => t && t.kind !== 'none');
    const mainTicket = anyTicket.find(t => t.kind === 'attraction') || anyTicket[0];
    const tips = acts.flatMap(a => a.tips || []);
    const foods = stop.nearbyFood || [];

    const actsHtml = acts.map(a => {
      const meta = actTypeMeta[a.type] || actTypeMeta.visit;
      return `
        <div class="pop-activity">
          <span class="pa-icon">${icon(meta.icon)}</span>
          <div style="min-width:0">
            <div class="pa-title">${esc(a.title)}</div>
            ${a.timeWindow ? `<div class="pa-time">${a.timeWindow.start}–${a.timeWindow.end}</div>` : ''}
            ${a.note ? `<div class="pa-note">${esc(a.note)}</div>` : ''}
          </div>
        </div>`;
    }).join('');

    const ticketHtml = mainTicket ? `
      <div>
        <div class="pop-section-title">门票与购票渠道</div>
        <div class="ticket-block">
          <div class="ticket-main">
            <span class="ticket-name">${esc(ticketTitle(stop, mainTicket))}</span>
            <span class="ticket-price">${fmtMoney(mainTicket.priceRange)}</span>
          </div>
          <div class="ticket-meta">
            ${mainTicket.leadTimeDays ? `<span class="chip chip-warning">需提前 ${mainTicket.leadTimeDays} 天</span>` : ''}
            ${mainTicket.realNameRequired ? '<span class="chip">实名制</span>' : ''}
            ${mainTicket.note ? `<span>${esc(mainTicket.note)}</span>` : ''}
          </div>
          ${mainTicket.channels?.length ? `
            <div class="ticket-channels">
              <div class="pop-section-title">购票渠道</div>
              ${mainTicket.channels.map((c, i) => `
                <div class="channel-row">
                  <span class="ch-icon ${channelMeta[c.type]?.cls || ''}">${icon(channelMeta[c.type]?.icon || 'web')}</span>
                  <span class="ch-name">${esc(c.name)}</span>
                  ${i === 0 ? '<span class="ch-preferred">首选</span>' : ''}
                  ${(c.type === 'wechat_mp' || c.type === 'mini_program') && c.detail ? `<button class="btn btn-sm ch-copy" data-copy="${esc(c.detail)}">${icon('copy')} 复制名称</button>` : ''}
                  ${c.note ? `<span style="font-size:11px;color:var(--text-faint)">${esc(c.note)}</span>` : ''}
                </div>`).join('')}
            </div>` : ''}
          ${mainTicket.recommendedPurchase ? `
            <div class="ticket-recommend">
              ${icon('calendar')} 建议购买：<strong>${esc(fmtDate(mainTicket.recommendedPurchase.targetDate))} ${esc(mainTicket.recommendedPurchase.session || '')}</strong>
              ${mainTicket.recommendedPurchase.note ? `，${esc(mainTicket.recommendedPurchase.note)}` : ''}
            </div>` : ''}
        </div>
      </div>` : '';

    const tipsHtml = tips.length ? `
      <div>
        <div class="pop-section-title">注意事项</div>
        <ul class="tips-list">${tips.map(t => `<li>${icon('info')} <span>${esc(t)}</span></li>`).join('')}</ul>
      </div>` : '';

    const foodHtml = foods.length ? `
      <div>
        <div class="pop-section-title">顺路美食 · 不占时间轴</div>
        ${foods.map(f => `<div class="food-row"><span class="fd-name">${esc(f.name)}</span><span class="fd-dishes">${f.dishes.map(esc).join('、')}${f.note ? ' · ' + esc(f.note) : ''}</span></div>`).join('')}
      </div>` : '';

    const node = el(`
      <div class="poi-popover" role="dialog" aria-label="${esc(stop.poi.name)} 详情">
        <div class="pop-head">
          <div style="min-width:0">
            <div class="pop-title">${esc(stop.poi.name)}</div>
            <div class="pop-sub">
              <span>${esc(stop.poi.city)}</span> ·
              <span class="pop-rating">★ ${poiRating(stop.poi.name)}</span> ·
              <span style="color:var(--day-color);font-weight:700">${esc(stop.poi.address || '')}</span>
            </div>
          </div>
          <div class="pop-actions">
            <button class="icon-btn" data-pin title="固定浮层" aria-label="固定浮层">${icon('pin')}</button>
            <button class="icon-btn" data-close aria-label="关闭">${icon('x')}</button>
          </div>
        </div>
        <div class="pop-body">
          <div>
            <div class="pop-section-title">该地点的活动 · ${acts.length} 项</div>
            ${actsHtml}
          </div>
          ${ticketHtml}
          ${tipsHtml}
          ${foodHtml}
          <details class="source-fold">
            <summary>${icon('caretRight')} 信息来源</summary>
            <div class="src-body">
              · 高德地图 POI <code>${esc(stop.poi.amapPoiId || 'B0FF****')}</code>（坐标/评分）<br>
              · 04-24 20:06 搜索「${esc(stop.poi.name.split(' · ')[0])} 门票 预约」· 8 条结果<br>
              · 04-24 20:06 搜索「${esc(stop.poi.name.split(' · ')[0])} 攻略」· 网页摘要
            </div>
          </details>
        </div>
        ${state.readonly ? '' : `
        <div class="pop-foot">
          <button class="btn btn-primary" data-edit>${icon('edit')} 改这里</button>
          <button class="btn" data-view-card>${icon('panelRight')} 在卡片面板中查看</button>
        </div>`}
      </div>`);

    node.style.setProperty('--day-color', dayColorVar(stop.dayIndex));
    $('.map-pane').appendChild(node);
    positionPopover(node, stopId);

    /* 事件 */
    node.querySelector('[data-close]').addEventListener('click', () => closePopover());
    node.querySelector('[data-pin]').addEventListener('click', e => {
      state.popover.pinned = !state.popover.pinned;
      node.classList.toggle('pinned', state.popover.pinned);
      e.currentTarget.style.color = state.popover.pinned ? 'var(--accent)' : '';
      toast(state.popover.pinned ? '浮层已固定' : '已取消固定');
    });
    node.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => copyText(b.dataset.copy, `已复制「${b.dataset.copy}」`)));
    node.querySelector('[data-edit]')?.addEventListener('click', () => {
      addCtxChip({ label: `${stop.poi.name.split(' · ')[0]} · Day ${stop.dayIndex}`, stopId, dayIndex: stop.dayIndex });
      $('#composer-input')?.focus();
      closePopover();
    });
    node.querySelector('[data-view-card]')?.addEventListener('click', () => {
      if (!state.panelOpen) togglePanel(true);
      switchDay(stop.dayIndex, { noMap: false });
      const card = $(`.act-card[data-stop-id="${stopId}"]`);
      if (card) highlightCard(card);
    });
  }

  function ticketTitle(stop, tk) {
    const base = stop.poi.name.split(' · ')[0];
    if (tk.kind === 'attraction') return `${base}门票${tk.note && tk.note.includes('区间车') ? ' + 区间车' : ''}`;
    if (tk.kind === 'hotel') return `${base} 住宿`;
    if (tk.kind === 'transport') return '交通票';
    return base;
  }

  function positionPopover(node, stopId) {
    const pos = map.screenPos(stopId);
    const pane = $('.map-pane').getBoundingClientRect();
    if (!pos) return;
    const w = 340;
    let left = pos.x + 20, top = pos.y - 60;
    if (left + w > pane.width - 12) left = Math.max(12, pos.x - w - 20);
    const h = Math.min(node.offsetHeight, pane.height * 0.74);
    if (top + h > pane.height - 12) top = Math.max(12, pane.height - h - 12);
    if (top < 12) top = 12;
    node.style.left = left + 'px';
    node.style.top = top + 'px';
  }

  function closePopover() {
    if (state.popover.pinned) return;
    $$('.poi-popover').forEach(n => n.remove());
    state.popover.stopId = null;
  }
  function forceClosePopover() {
    state.popover.pinned = false;
    $$('.poi-popover').forEach(n => n.remove());
    state.popover.stopId = null;
  }

  /* ============================================================
     抽屉体系：版本历史 / 预订提醒 / 校验冲突
     ============================================================ */
  function ensureDrawer() {
    let scrim = $('#drawer-scrim'), drawer = $('#drawer');
    if (!scrim) {
      scrim = el('<div class="drawer-scrim" id="drawer-scrim"></div>');
      drawer = el('<aside class="drawer" id="drawer" role="dialog" aria-modal="true"></aside>');
      document.body.append(scrim, drawer);
      scrim.addEventListener('click', closeDrawer);
      document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
    }
    return { scrim, drawer };
  }
  function openDrawer(title, sub, bodyHtml, onMount) {
    const { scrim, drawer } = ensureDrawer();
    drawer.innerHTML = `
      <div class="drawer-head">
        <div>
          <div class="dh-title">${esc(title)}</div>
          ${sub ? `<div class="dh-sub">${sub}</div>` : ''}
        </div>
        <button class="icon-btn" data-close-drawer aria-label="关闭">${icon('x')}</button>
      </div>
      <div class="drawer-body">${bodyHtml}</div>`;
    drawer.querySelector('[data-close-drawer]').addEventListener('click', closeDrawer);
    scrim.classList.add('open');
    drawer.classList.add('open');
    onMount && onMount(drawer);
  }
  function closeDrawer() {
    $('#drawer-scrim')?.classList.remove('open');
    $('#drawer')?.classList.remove('open');
  }

  /* ---- 版本历史 ---- */
  function openVersionDrawer() {
    const log = state.trip.revisionLog;
    const items = [...log].reverse().map(v => `
      <div class="version-item ${v.version === state.trip.version ? 'current' : ''}" data-version="${v.version}" tabindex="0" role="button">
        <div class="v-rail"><span class="v-dot"></span><span class="v-line"></span></div>
        <div class="v-main">
          <div class="v-head">
            <span class="v-no">v${v.version}</span>
            <span class="v-time">${esc(v.time)}</span>
            ${v.version === state.trip.version ? '<span class="v-current-tag">当前版本</span>' : ''}
          </div>
          <div class="v-quote">${icon('quote')} <q>${esc(v.userRequest)}</q></div>
          <div class="v-summary">${esc(v.summary)}</div>
          <div class="v-ops">${v.opCount} 处改动${v.changedStopIds[0] === '*' ? ' · 全程' : ` · ${v.changedStopIds.length} 个地点`}</div>
          ${v.version === state.trip.version ? '' : `
            <div class="v-actions">
              <button class="btn btn-sm" data-preview="${v.version}">${icon('eye')} 预览 diff</button>
              <button class="btn btn-sm btn-primary" data-restore="${v.version}">恢复到此版本</button>
            </div>`}
          <div class="diff-preview" id="diff-preview-${v.version}" style="display:none"></div>
        </div>
      </div>`).join('');

    openDrawer('版本历史', `线性时间轴 · 共 ${log.length} 个版本 · 点击版本查看与当前的 diff`,
      `<div class="version-list">${items}</div>`, drawer => {
        drawer.querySelectorAll('[data-preview]').forEach(b => b.addEventListener('click', e => {
          e.stopPropagation();
          const v = +b.dataset.preview;
          const host = drawer.querySelector(`#diff-preview-${v}`);
          const isOpen = host.style.display !== 'none';
          drawer.querySelectorAll('.diff-preview').forEach(x => x.style.display = 'none');
          if (isOpen) return;
          host.innerHTML = renderDiff(v);
          host.style.display = 'block';
        }));
        drawer.querySelectorAll('[data-restore]').forEach(b => b.addEventListener('click', e => {
          e.stopPropagation();
          const v = +b.dataset.restore;
          state.trip.version = v;
          $('#version-label').textContent = 'v' + v;
          closeDrawer();
          toast(`已恢复到 v${v}（演示：地图与卡片将按该版本重排）`);
        }));
      });
  }

  function renderDiff(version) {
    const rows = (D.versionDiffs[version] || []).map(r => {
      const cls = r.op === 'add' ? 'd-add' : r.op === 'del' ? 'd-del' : r.op === 'mod' ? 'd-mod' : '';
      const opLabel = { add: '新增', del: '删除', mod: '修改', keep: '未变' }[r.op] || r.op;
      return `<div class="diff-row ${cls}"><span class="d-op">${opLabel}</span><span class="d-text">${r.text}</span></div>`;
    }).join('');
    return `
      <div class="diff-preview-title">
        v${version} → v${state.trip.version} 变更
        <span class="legend">
          <span class="l-add"><i></i>增</span>
          <span class="l-del"><i></i>删</span>
          <span class="l-mod"><i></i>改</span>
        </span>
      </div>
      ${rows || '<div style="font-size:12px;color:var(--text-faint)">该版本无结构化 diff 记录</div>'}`;
  }

  /* ---- 预订提醒清单 ---- */
  function openBookingDrawer() {
    const today = D.derived.today;
    const items = [...D.derived.bookingTimeline].sort((a, b) => a.orderBy.localeCompare(b.orderBy));
    const groups = [];
    for (const it of items) {
      const g = groups.find(x => x.date === it.orderBy);
      if (g) g.items.push(it); else groups.push({ date: it.orderBy, items: [it] });
    }
    const doneCount = state.bookingDone.length;
    const total = items.length;

    const groupsHtml = groups.map(g => {
      const overdue = g.date < today;
      return `
        <div class="booking-group-label">
          ${icon('calendar')} ${fmtDate(g.date)} 前${overdue ? `<span class="overdue-tag"> · 已逾期</span>` : ''}
        </div>
        ${g.items.map(it => {
          const done = state.bookingDone.includes(it.id);
          return `
            <div class="booking-item ${done ? 'done' : ''} ${overdue && !done ? 'overdue' : ''}" data-bk="${it.id}">
              <button class="booking-check" role="checkbox" aria-checked="${done}" aria-label="标记 ${esc(it.title)} 已订">${icon('check')}</button>
              <div class="bi-main">
                <div class="bi-title"><span class="bi-kind">${bookingKindLabel[it.kind] || it.kind}</span>${esc(it.title)}</div>
                <div class="bi-sub">${esc(it.channelHint)} · <span class="num">${fmtMoney(it.priceRange)}</span>${it.realNameRequired ? ' · 实名' : ''} · 提前 ${it.leadTimeDays} 天 · Day ${it.dayIndex}</div>
                ${overdue && !done ? `<div class="bi-overdue">${icon('warn')} 已过建议下单日期（今天 ${fmtDate(today)}），票量紧张请尽快</div>` : ''}
              </div>
            </div>`;
        }).join('')}`;
    }).join('');

    openDrawer('预订提醒', `按「应该在哪个日期下单」倒排 · 今天 ${fmtDate(today)}`, `
      <div class="booking-list">
        <div class="booking-summary">
          <span>共 <strong class="num">${total}</strong> 项 · 已完成 <strong class="num" id="bk-done">${doneCount}</strong> 项</span>
          <span class="bs-progress"><i id="bk-bar" style="width:${total ? doneCount / total * 100 : 0}%"></i></span>
        </div>
        ${groupsHtml}
      </div>`, drawer => {
        drawer.querySelectorAll('.booking-check').forEach(b => b.addEventListener('click', () => {
          const item = b.closest('.booking-item');
          const id = item.dataset.bk;
          const i = state.bookingDone.indexOf(id);
          if (i >= 0) state.bookingDone.splice(i, 1); else state.bookingDone.push(id);
          store.set('bookingDone', state.bookingDone);
          const done = state.bookingDone.includes(id);
          item.classList.toggle('done', done);
          item.classList.toggle('overdue', !done && item.querySelector('.bi-overdue') != null);
          b.setAttribute('aria-checked', done);
          $('#bk-done').textContent = state.bookingDone.length;
          $('#bk-bar').style.width = (state.bookingDone.length / total * 100) + '%';
        }));
      });
  }

  /* ---- 校验冲突面板 ---- */
  function openConflictDrawer(scrollFirst) {
    const sorted = [...D.derived.conflicts].sort((a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
    const errs = sorted.filter(c => c.severity === 'error').length;
    const warns = sorted.length - errs;

    const itemsHtml = sorted.map(c => `
      <div class="conflict-item severity-${c.severity}" data-conflict-jump="${c.id}" tabindex="0" role="button">
        <div class="ci-head">
          <span class="ci-type">${icon(c.severity === 'error' ? 'xCircle' : 'warn')} ${conflictTypeLabel[c.type] || c.type} · ${c.severity === 'error' ? '错误' : '警告'}</span>
          <span class="ci-day">Day ${c.dayIndex}</span>
        </div>
        <div class="ci-msg">${esc(c.message)}</div>
        <div class="ci-jump">${icon('arrowUpRight')} 点击跳转到对应卡片 / 地图位置</div>
        ${c.askUser ? `
          <div class="ci-ask">
            <div style="font-size:13px;font-weight:700;margin-bottom:8px">${icon('chat')} ${esc(c.askUser.question)}</div>
            <div class="ask-options">
              ${c.askUser.options.map(o => `<button class="ask-opt" data-conflict-choice="${o.id}" data-conflict-id="${c.id}">${esc(o.label)}</button>`).join('')}
            </div>
          </div>` : `
          <div class="ci-ask" style="border-top:1px dashed var(--border)">
            <div class="fix-title" style="font-size:12px;font-weight:700;display:flex;gap:5px;align-items:center;color:var(--text)">${icon('sparkle')} 建议修法</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:4px;line-height:1.5">${esc(c.suggestedFix || '')}</div>
          </div>`}
      </div>`).join('');

    openDrawer('校验冲突', `<span style="color:var(--error)">${errs} 个错误</span> · <span style="color:var(--warning)">${warns} 个警告</span> · 按严重度排序`,
      `<div class="conflict-list">${itemsHtml}</div>`, drawer => {
        drawer.querySelectorAll('[data-conflict-jump]').forEach(item => {
          const jump = e => {
            if (e.target.closest('.ask-opt')) return;
            const c = sorted.find(x => x.id === item.dataset.conflictJump);
            closeDrawer();
            if (!state.panelOpen) togglePanel(true);
            switchDay(c.dayIndex, { scrollTo: c.activityId, stopId: c.stopId });
            setTimeout(() => {
              const card = c.activityId
                ? $(`.act-card[data-activity-id="${c.activityId}"]`)
                : (c.stopId ? $(`.act-card[data-stop-id="${c.stopId}"]`) : null);
              if (card) { highlightCard(card); if (card.dataset.stopId && map) { map.centerOn(card.dataset.stopId); map.selectStop(card.dataset.stopId, false); } }
            }, 120);
          };
          item.addEventListener('click', jump);
          item.addEventListener('keydown', e => { if (e.key === 'Enter') jump(e); });
        });
        drawer.querySelectorAll('[data-conflict-choice]').forEach(b => b.addEventListener('click', e => {
          e.stopPropagation();
          const c = sorted.find(x => x.id === b.dataset.conflictId);
          const opt = c.askUser.options.find(o => o.id === b.dataset.conflictChoice);
          closeDrawer();
          appendMessage({ type: 'user', text: opt.label, time: nowHM(), ctx: [{ label: `冲突 · ${conflictTypeLabel[c.type]}` }] });
          setSending(true);
          setTimeout(() => {
            appendMessage({ type: 'ai', time: nowHM(), md: `已记录决定：**${opt.label}**。${b.dataset.conflictChoice === 'keep' ? '当前 v6/v7 方案保持不变，「独库公路」将标记为「下次再来」。该冲突已解除。' : '这会影响机票日期与整体路线，我会生成新版本并给出 diff 预览。'}\n\n（原型演示：此处触发 plan_patch 事件流）` });
            setSending(false);
          }, 1000);
        }));
        if (scrollFirst) {
          const first = drawer.querySelector('[data-conflict-jump]');
          first && first.scrollIntoView({ block: 'center' });
        }
      });
  }

  /* ============================================================
     分割条 + 预设 + 持久化
     ============================================================ */
  const PRESETS = { chat: 58, balanced: 40, map: 26 };   /* 对话区占比 % */
  function initSplitter() {
    const sp = $('#splitter');
    if (!sp) return;
    const body = $('.wb-body');
    const pane = $('#desktop-chat-slot') || $('.chat-pane');
    let ratio = store.get('splitRatio', PRESETS.balanced);
    applyRatio(ratio);

    function applyRatio(r) {
      ratio = Math.min(72, Math.max(18, r));
      pane.style.flex = `0 0 ${ratio}%`;
      $$('.split-presets button').forEach(b => {
        b.classList.toggle('active', Math.abs(PRESETS[b.dataset.preset] - ratio) < 2);
      });
    }

    sp.addEventListener('pointerdown', e => {
      e.preventDefault();
      sp.classList.add('dragging');
      document.body.classList.add('splitting');
      sp.setPointerCapture(e.pointerId);
      const move = ev => {
        const rect = body.getBoundingClientRect();
        applyRatio((ev.clientX - rect.left) / rect.width * 100);
        if (state.popover.stopId) {
          const pop = $('.poi-popover');
          if (pop) positionPopover(pop, state.popover.stopId);
        }
      };
      const up = () => {
        sp.classList.remove('dragging');
        document.body.classList.remove('splitting');
        store.set('splitRatio', ratio);
        sp.removeEventListener('pointermove', move);
        sp.removeEventListener('pointerup', up);
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
    });

    $$('.split-presets button').forEach(b => b.addEventListener('click', () => {
      const r = PRESETS[b.dataset.preset];
      pane.style.transition = 'flex-basis .25s cubic-bezier(.4,0,.2,1)';
      applyRatio(r);
      store.set('splitRatio', r);
      setTimeout(() => { pane.style.transition = ''; }, 280);
    }));
  }

  /* ============================================================
     卡片面板折叠 + 移动端 sheet
     ============================================================ */
  function togglePanel(open) {
    state.panelOpen = open ?? !state.panelOpen;
    document.body.classList.toggle('panel-collapsed', !state.panelOpen);
    $('#trip-panel')?.classList.toggle('collapsed', !state.panelOpen);
    paintPanelToggle();
    setTimeout(() => map && map.fitView(state.panelOpen ? state.activeDay || 'all' : 'all'), 280);
  }
  function paintPanelToggle() {
    const t = $('#panel-toggle');
    if (t) t.innerHTML = `${icon(state.panelOpen ? 'chevronRight' : 'panelRight')} ${state.panelOpen ? '收起面板' : '行程卡片'}`;
  }

  function initMobileSheet() {
    const handle = $('#sheet-handle');
    const panel = $('#trip-panel');
    if (!handle || !panel) return;
    handle.addEventListener('click', () => {
      state.sheetLevel = (state.sheetLevel + 1) % 3;
      panel.classList.toggle('collapsed', state.sheetLevel === 0);
      panel.classList.toggle('half', state.sheetLevel === 1);
      panel.classList.toggle('full', state.sheetLevel === 2);
      updateSheetSummary();
    });
    /* 手势上滑/下滑 */
    let startY = null;
    handle.addEventListener('touchstart', e => { startY = e.touches[0].clientY; }, { passive: true });
    handle.addEventListener('touchend', e => {
      if (startY == null) return;
      const dy = startY - e.changedTouches[0].clientY;
      if (Math.abs(dy) > 40) {
        state.sheetLevel = dy > 0 ? Math.min(2, state.sheetLevel + 1) : Math.max(0, state.sheetLevel - 1);
        panel.classList.toggle('collapsed', state.sheetLevel === 0);
        panel.classList.toggle('half', state.sheetLevel === 1);
        panel.classList.toggle('full', state.sheetLevel === 2);
        updateSheetSummary();
      }
      startY = null;
    }, { passive: true });
    /* 移动端 tab：行程 / 对话（对话 pane 移入 sheet 内） */
    $$('#mobile-tabs button').forEach(b => b.addEventListener('click', () => {
      const which = b.dataset.tab;
      $$('#mobile-tabs button').forEach(x => x.classList.toggle('active', x === b));
      const slot = $('#mobile-chat-slot');
      const chat = $('#chat-pane');
      if (which === 'chat') {
        slot.classList.add('active');
        slot.appendChild(chat);
        $('#panel-scroll').style.display = 'none';
        $('#day-tabs').style.display = 'none';
        if (state.sheetLevel === 0) { state.sheetLevel = 1; panel.classList.remove('collapsed'); panel.classList.add('half'); }
        scrollChatToBottom();
      } else {
        slot.classList.remove('active');
        $('#desktop-chat-slot').appendChild(chat);
        $('#panel-scroll').style.display = '';
        $('#day-tabs').style.display = '';
      }
      updateSheetSummary();
    }));
    /* mobile.html 锁定半屏 sheet 关键态 */
    if (document.body.dataset.forceSheet === 'half') {
      state.sheetLevel = 1;
      panel.classList.remove('collapsed');
      panel.classList.add('half');
    }
    updateSheetSummary();
  }
  function updateSheetSummary() {
    const s = $('#sheet-summary');
    if (!s) return;
    const day = state.trip?.days.find(d => d.dayIndex === state.activeDay);
    s.innerHTML = `<strong>Day ${state.activeDay}</strong> · ${day ? esc(day.theme) : ''} · ${countStops()} 站 · v${state.trip?.version}`;
  }

  /* ============================================================
     流程 B · 节点级重规划脚本（Day 3 补丁）
     ============================================================ */
  function runReplanScript() {
    /* 1. AI 文本说明将改什么 */
    appendMessage({
      type: 'ai', time: nowHM(),
      md: '我会把 **Day 3** 起床时间改到 `13:00`，并后移当天活动：\n- **删除** 五彩滩（时间不够）\n- **取消** 三湾徒步（顺带解决与禾木日落的时间重叠警告）\n- **保留** 禾木日落观景，住宿不变\n\n只改 Day 3，其余 7 天不动。'
    });

    /* 2. 工具调用（进行中 → 完成） */
    const toolsNode = appendMessage({
      type: 'tools', time: nowHM(), status: 'running', collapsed: false,
      items: [
        { icon: 'car', title: '正在重算 阿勒泰→禾木 驾车路程…', status: 'running' },
        { icon: 'sun', title: '正在查询禾木 5月3日 日落时间…', status: 'running' }
      ]
    });
    markDay3Pending(true);

    setTimeout(() => {
      toolsNode.replaceWith(buildToolGroup({
        status: 'done', collapsed: true,
        items: [
          { icon: 'car', title: '路径规划 · 阿勒泰→禾木（经贾登峪）', result: '248 公里 / 4.2 小时 · 13:00 出发可赶上日落', json: '{\n  "from":"阿勒泰","to":"禾木",\n  "distanceKm":248,"minutes":252,\n  "via":["布尔津","贾登峪"]\n}' },
          { icon: 'sun', title: '查询禾木日落时间', result: '日落 21:23 · 建议 19:40 前到观景台', json: '{\n  "sunset":"21:23","goldenHour":"20:40"\n}' },
          { icon: 'route', title: '生成局部补丁 · Day 3', result: '4 处改动 · 影响 2 个 stop / 3 条连线', json: '{\n  "dayIndex":3,\n  "ops":["rhythm.wake 09:00->13:00","remove 五彩滩","remove 三湾徒步","keep 禾木日落"]\n}' }
        ]
      }));
      scrollChatToBottom();

      /* 3. 补丁落地：数据变更 */
      applyDay3Patch();

      /* 4. 地图增量更新 + diff 高亮 */
      incrementalUpdateDay3();

      /* 5. 卡片面板切到 Day 3 并高亮 */
      markDay3Pending(false);
      switchDay(3);
      setTimeout(() => {
        const card = $('.act-card[data-stop-id="d3s1"]');
        if (card) highlightCard(card);
      }, 300);

      /* 6. AI 总结 */
      setTimeout(() => {
        appendMessage({
          type: 'ai', time: nowHM(),
          md: D.day3Patch.summary.md + '\n\n#### 改动清单\n- Day 3 作息 `09:00` → `13:00`\n- 五彩滩 stop 删除（-1.2h）\n- 三湾徒步删除（-2h），**「时间重叠」警告已消除**\n- 禾木日落保留 `19:40–21:30`\n\n#### 遗留\n- 「独库公路未开放」错误仍在，等你在冲突面板做决定'
        });
        setSending(false);
        toast('Day 3 已重排 · v8 已生成');
      }, 600);
    }, 1800);
  }

  function applyDay3Patch() {
    const day3 = state.trip.days.find(d => d.dayIndex === 3);
    /* 删除整个 stop：五彩滩(d3s2)、喀纳斯(d3s3) */
    day3.stops = day3.stops.filter(s => s.stopId !== 'd3s2' && s.stopId !== 'd3s3');
    /* d3s1 活动重排：只留转场，加简餐 */
    const s1 = day3.stops.find(s => s.stopId === 'd3s1');
    s1.activities = [
      {
        activityId: 'd3s1a1', seq: 1, type: 'long_transit',
        title: '可可托海 → 阿勒泰 → 布尔津 · 自驾转场',
        timeWindow: { start: '13:00', end: '17:30' },
        note: '下午出发，路上简餐', tips: [],
        transitFromPrev: null,
        transitDetail: { mode: 'self_drive', distanceKm: 344, driveMinutes: 270, waypointsPoi: ['北屯市', '布尔津县'], roadRefs: ['G216', 'S319', 'S232'], roadCondition: '路况良好', seasonClosure: null, fuelStops: ['北屯中石油'], parking: '贾登峪停车场', permitRequired: false, permitNote: null }
      }
    ];
    /* 禾木日落时间窗微调 */
    const s4 = day3.stops.find(s => s.stopId === 'd3s4');
    const sunset = s4.activities.find(a => a.activityId === 'd3s4a1');
    if (sunset) sunset.timeWindow = { start: '19:40', end: '21:30' };
    /* 作息 */
    day3.rhythm = { wake: '13:00', sleep: '23:30' };
    /* 版本 + revisionLog */
    state.trip.version = 8;
    state.trip.revisionLog.push({
      version: 8, time: '今天 ' + nowHM(),
      userRequest: '（@阿勒泰 · Day 3）我起晚了，想下午再出发，重规划一下',
      summary: 'Day3 作息 09:00→13:00，删除五彩滩与三湾徒步，禾木日落保留',
      opCount: 4, changedStopIds: ['d3s1', 'd3s2', 'd3s3', 'd3s4'], changedActivityIds: ['d3s1a1', 'd3s4a1']
    });
    D.versionDiffs[8] = [
      { op: 'mod', text: 'D3 作息 wake <span class="num">09:00</span> <span class="d-arrow">→</span> <span class="num">13:00</span>' },
      { op: 'del', text: 'D3 五彩滩 stop（含 1 项活动）' },
      { op: 'del', text: 'D3 喀纳斯 · 三湾徒步（<span class="num">17:30–19:30</span>）' },
      { op: 'mod', text: 'D3 禾木日落 <span class="num">19:00–21:30</span> <span class="d-arrow">→</span> <span class="num">19:40–21:30</span>' },
      { op: 'add', text: '冲突消除：time_overlap_d3（三湾徒步×禾木日落）' }
    ];
    /* 冲突面板同步：消除 time_overlap */
    D.derived.conflicts = D.derived.conflicts.filter(c => c.id !== 'time_overlap_d3');
    $('#version-label') && ($('#version-label').textContent = 'v8');
    renderTopbar();
  }

  function incrementalUpdateDay3() {
    if (!map) return;
    /* 删除受影响 marker 与连线 */
    map.applyPatch({
      removeStopIds: ['d3s2', 'd3s3'],
      updateStops: [],
      diffTags: {},
      flashSegments: []
    });
    /* 重建 Day 3 剩余 stop 的连线：d3s1 → d3s4 */
    const day3 = state.trip.days.find(d => d.dayIndex === 3);
    const stops3 = day3.stops.sort((a, b) => a.seq - b.seq);
    for (let i = 1; i < stops3.length; i++) {
      const from = stops3[i - 1], to = stops3[i];
      map._renderSegment(map.stops.find(s => s.stopId === from.stopId), map.stops.find(s => s.stopId === to.stopId), 3);
    }
    /* flash Day 3 所有连线 */
    map.segments.filter(s => s.dayIdx === 3).forEach(sg => {
      const path = sg.g.querySelector('.route-path');
      path.classList.add('route-flash');
      setTimeout(() => path.classList.remove('route-flash'), 1700);
    });
    /* 脉冲 + diff 角标 */
    map.pulseMarker('d3s1');
    map.pulseMarker('d3s4');
    map.addDiffTag('d3s1', '09:00 → 13:00');
    map.applyDayFilter(3);
    /* 卡片 diff 角标 */
    state.diffTags = { d3s1a1: '09:00 → 13:00' };
  }

  function markDay3Pending(on) {
    state.pendingDay3 = on;
    $$('.day-cards[data-day="3"] .act-card').forEach(c => {
      c.classList.toggle('pending-update', on);
      if (on && !c.querySelector('.pending-veil')) {
        c.insertAdjacentHTML('beforeend', `<div class="pending-veil"><span class="spinner spinner-sm"></span> 待更新 · AI 正在重排…</div>`);
      }
      if (!on) c.querySelector('.pending-veil')?.remove();
    });
  }

  /* ============================================================
     流程 A · 首次规划脚本（#/planning）
     ============================================================ */
  function runPlanningFlow(answeredData) {
    appendMessage({ type: 'ai', time: nowHM(), md: '明白了：**8 天 · 上海出发 · 自驾**。我现在开始检索和排线，地图和卡片会在骨架行程生成后一次性填充。' });

    let cur = appendMessage({
      type: 'tools', time: nowHM(), status: 'running', collapsed: false,
      items: [{ icon: 'search', title: '正在搜索「北疆 五一 自驾 环线」…', status: 'running' }]
    });
    setSending(true);

    /* 工具逐步推进：每次用新的 group 替换当前节点（保留引用） */
    const replaceTools = (status, items) => {
      const next = buildToolGroup({ status, collapsed: status === 'done', items });
      if (cur.parentNode) cur.replaceWith(next);
      cur = next;
      scrollChatToBottom();
    };

    const steps = [
      { at: 900, items: [
        { icon: 'search', title: '搜索「北疆 五一 自驾 环线」', result: '12 条结果 · 已提取 4 条成熟路线', status: 'done' },
        { icon: 'car', title: '正在计算 乌鲁木齐→可可托海 驾车路程…', status: 'running' }] },
      { at: 1900, items: [
        { icon: 'search', title: '搜索「北疆 五一 自驾 环线」', result: '12 条结果', status: 'done' },
        { icon: 'car', title: '路径规划 · 乌鲁木齐→可可托海', result: '486 公里 / 约 6 小时', status: 'done' },
        { icon: 'search', title: '正在查询独库公路开放时间…', status: 'running' }] },
      { at: 2900, items: [
        { icon: 'search', title: '搜索「北疆 五一 自驾 环线」', result: '12 条结果', status: 'done' },
        { icon: 'car', title: '路径规划 · 乌鲁木齐→可可托海', result: '486 公里 / 约 6 小时', status: 'done' },
        { icon: 'search', title: '搜索「独库公路 开放时间 2026」', result: '8 条结果 · 往年 6 月上旬通车 ⚠', status: 'done' },
        { icon: 'pin', title: '正在检索 喀纳斯 / 禾木 / 赛里木湖 POI…', status: 'running' }] },
      { at: 3900, items: [
        { icon: 'search', title: '搜索「北疆 五一 自驾 环线」', result: '12 条结果', status: 'done' },
        { icon: 'car', title: '路径规划 · 乌鲁木齐→可可托海', result: '486 公里 / 约 6 小时', status: 'done' },
        { icon: 'search', title: '搜索「独库公路 开放时间 2026」', result: '8 条结果 · 往年 6 月上旬通车 ⚠', status: 'done' },
        { icon: 'pin', title: 'POI 检索 · 喀纳斯 / 禾木 / 赛里木湖', result: '3 个必去点定位完成', status: 'done' },
        { icon: 'weather', title: '查询天气 · 阿勒泰 5/1–5/8', result: '晴为主，夜间 -2°C～4°C', status: 'done' },
        { icon: 'bed', title: '搜索住宿 · 禾木 5/3 晚', result: '9 家 · 景区内木屋 ¥680 起', status: 'done' }] }
    ];

    for (const s of steps) setTimeout(() => replaceTools('running', s.items), s.at);

    /* 骨架写入：地图一次性绘制 + 卡片填充（工具完成后，无全页遮罩） */
    setTimeout(() => {
      replaceTools('done', steps[3].items);

      $('#map-skeleton')?.remove();
      if (!map) initMap();
      map.setTrip(state.trip);
      $('#map-daycard') && ($('#map-daycard').style.display = '');
      renderPanel();
      renderTopbar();
      map.fitView('all');
      toast('骨架行程已写入 · 地图已绘制 15 个 stop');

      appendMessage({ type: 'ai', time: nowHM(), md: '骨架行程已生成并写入地图：8 天北疆顺时针环线，15 个地点。\n\n有一个遗留问题：**独库公路 5 月初未开放**（error 级冲突）。我先用「特克斯+琼库什台」替代了 Day 7，顶栏冲突徽章里有三个处理方案供你选择。' });
      appendMessage({ type: 'ready_card', time: nowHM() });
      appendMessage({ type: 'assumption', time: nowHM(), items: D.trip.constraints.assumptions.slice(0, 2) });
      setSending(false);
      scrollChatToBottom();
    }, 5200);
  }

  /* ============================================================
     地图初始化 + 浮层控件
     ============================================================ */
  function initMap() {
    const container = $('#map-canvas');
    map = new MapCanvas(container, {
      interactive: true,   /* 只读分享页地图仍可交互（§3.11） */
      onMarkerClick: stopId => {
        openPopover(stopId);
        /* 三向联动：marker → 卡片面板 */
        const stop = findStop(stopId);
        if (stop) {
          if (window.innerWidth >= 768 && !state.panelOpen) togglePanel(true);
          if (state.activeDay !== stop.dayIndex) switchDay(stop.dayIndex, { noMap: true });
          setTimeout(() => {
            const card = $(`.act-card[data-stop-id="${stopId}"]`);
            if (card) highlightCard(card);
          }, 150);
        }
      },
      onRouteClick: info => {
        const label = info.mode === 'flight' ? `航班 ${info.meta.flightNo || ''}` : info.mode === 'self_drive' ? `自驾 ${info.meta.distanceKm}km` : '路段';
        toast(`${label} · Day ${info.dayIdx}（点击两端 marker 查看详情）`, 'route');
      },
      onBlankClick: () => closePopover()
    });

    /* 地图平移/缩放时，已打开的浮层跟随 marker 重定位 */
    const origT = map._applyTransform.bind(map);
    map._applyTransform = function () {
      origT();
      if (state.popover.stopId) {
        const pop = document.querySelector('.poi-popover');
        if (pop) positionPopover(pop, state.popover.stopId);
      }
    };

    /* 浮层控件 */
    $('#map-controls').innerHTML = `
      <div class="map-ctrl-group">
        <button data-map-act="in" title="放大" aria-label="放大">${icon('plus')}</button>
        <button data-map-act="out" title="缩小" aria-label="缩小">${icon('minus')}</button>
      </div>
      <div class="map-ctrl-group">
        <button data-map-act="fit" title="框住当前天" aria-label="适应视野">${icon('crosshair')}</button>
        <button data-map-act="all" title="显示全程" aria-label="显示全程">${icon('layers')}</button>
      </div>`;
    $('#map-controls').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      const act = b.dataset.mapAct;
      if (act === 'in') map.zoomBy(1.25);
      if (act === 'out') map.zoomBy(1 / 1.25);
      if (act === 'fit') map.fitView(state.activeDay);
      if (act === 'all') { state.activeDay = 0; map.applyDayFilter('all'); $$('.day-tab').forEach(x => x.classList.remove('active')); }
    }));

    $('#map-legend').innerHTML = `
      <div class="legend-title">图例</div>
      <div class="legend-row"><svg width="26" height="8"><line x1="1" y1="4" x2="25" y2="4" stroke="var(--line-city)" stroke-width="2"/></svg> 市内短驳</div>
      <div class="legend-row"><svg width="26" height="8"><line x1="1" y1="4" x2="25" y2="4" stroke="var(--line-flight)" stroke-width="2.5" stroke-dasharray="6 4"/></svg> 长途 · 航班（弧线）</div>
      <div class="legend-row"><svg width="26" height="8"><line x1="1" y1="4" x2="25" y2="4" stroke="var(--line-train)" stroke-width="2.5" stroke-dasharray="4 4"/></svg> 长途 · 火车</div>
      <div class="legend-row"><svg width="26" height="8"><line x1="1" y1="4" x2="25" y2="4" stroke="var(--line-drive)" stroke-width="2.5" stroke-dasharray="8 3 2 3"/></svg> 长途 · 自驾</div>
      <div class="legend-row"><svg width="12" height="12"><circle cx="6" cy="6" r="4" fill="#fff" stroke="var(--line-drive)" stroke-width="2"/></svg> 自驾途经点（不算一站）</div>`;
  }

  /* ============================================================
     路由与初始化
     ============================================================ */
  function resolveRoute() {
    if (document.body.dataset.route) return document.body.dataset.route;
    const h = location.hash;
    const q = new URLSearchParams(location.search).get('state');
    if (h.startsWith('#/planning') || q === 'planning') return 'planning';
    if (h.startsWith('#/replan') || q === 'replanning' || q === 'replan') return 'replan';
    if (h.startsWith('#/s/') || q === 'share') return 'share';
    return 'complete';
  }

  function initStateSwitcher() {
    const sw = $('#state-switcher');
    if (!sw) return;
    const cur = state.route === 'planning' ? 'planning' : state.route === 'replan' ? 'replan' : 'complete';
    sw.querySelectorAll('button').forEach(b => {
      b.classList.toggle('active', b.dataset.state === cur);
      b.addEventListener('click', () => {
        const target = b.dataset.state;
        if (target === cur) return;
        location.hash = target === 'complete' ? '#/t/xj-2026-wuyi' : target === 'planning' ? '#/planning' : '#/replan';
        location.reload();   /* 原型：换态即重载（三态各自独立演示） */
      });
    });
  }

  function init() {
    window.TP_UI.initTheme();
    state.route = resolveRoute();
    state.readonly = document.body.dataset.readonly === 'true' || state.route === 'share';
    state.trip = JSON.parse(JSON.stringify(D.trip));

    /* ?sheet=half：mobile.html iframe 锁定半屏 sheet 关键态；?mobile=1 隐藏原型状态切换器 */
    const q = new URLSearchParams(location.search);
    if (q.get('sheet') === 'half') document.body.dataset.forceSheet = 'half';
    if (q.get('mobile') === '1') $('#state-switcher')?.remove();

    renderTopbar();
    initSplitter();
    initComposer();
    initMobileSheet();
    initStateSwitcher();
    paintPanelToggle();

    $('#panel-toggle')?.addEventListener('click', () => togglePanel());

    if (state.readonly) {
      const banner = $('#share-banner');
      if (banner) banner.style.display = '';
      $('#composer-wrap')?.remove();
      $('#ctx-chips-bar')?.remove();
    }

    if (state.route === 'planning') initPlanningState();
    else if (state.route === 'replan') initReplanState();
    else if (state.route === 'share') initShareState();
    else initCompleteState();
  }

  function initCompleteState() {
    renderConvo(D.convoComplete);
    initMap();
    map.setTrip(state.trip);
    renderPanel();
    switchDay(1);
    map.applyDayFilter('all');
    updateDayCardOnMap(1);
    /* 交付物①：一处正在进行的 diff 高亮（D5 环湖 v7 改动：14:00 → 09:00） */
    setTimeout(() => {
      map.pulseMarker('d5s1');
      map.addDiffTag('d5s1', '14:00 → 09:00');
    }, 1200);
  }

  function initShareState() {
    /* §3.11 只读分享页：同工作台布局，无输入框、无编辑入口、面板展开、地图可交互 */
    renderConvo(D.convoComplete);
    initMap();
    map.setTrip(state.trip);
    renderPanel();
    switchDay(1);
    map.applyDayFilter('all');
    updateDayCardOnMap(1);
  }

  function initPlanningState() {
    /* 交付物②：ask_user 卡 + 工具时间线 + 地图骨架 */
    const items = D.convoPlanning.map(it =>
      it.type === 'ask_user' ? { ...it, onAnswer: runPlanningFlow } : it);
    renderConvo(items);
    /* 地图骨架遮罩（地图 pane 内，非全页遮罩） */
    const pane = $('.map-pane');
    if (!$('#map-skeleton')) {
      pane.insertAdjacentHTML('afterbegin', `
        <div class="map-skeleton" id="map-skeleton" style="pointer-events:none">
          <div class="map-skeleton-card">
            <span class="spinner"></span>
            <span class="sk-title">正在生成行程地图…</span>
            <span class="sk-sub">骨架行程写入后，路线与 stop 会一次性绘制</span>
            <div class="sk-line" style="width:180px"></div>
            <div class="sk-line" style="width:140px"></div>
            <div class="sk-line" style="width:160px"></div>
          </div>
        </div>`);
    }
    initMap();
    /* 面板空态：工具调用期间面板保持可见（禁止全页遮罩） */
    $('#day-tabs').innerHTML = '';
    $('#panel-scroll').innerHTML = `
      <div style="padding:48px 24px;text-align:center;color:var(--text-faint)">
        ${icon('route', { size: '36px' })}
        <p style="margin-top:12px;font-size:13px;line-height:1.6">行程卡片会在骨架行程生成后填充<br>工具调用进度见左侧对话区</p>
      </div>`;
    const dc = $('#map-daycard'); if (dc) dc.style.display = 'none';
  }

  function initReplanState() {
    /* 交付物③：@阿勒泰 · Day 3 chip + pending 视觉 + 自动演示补丁落地（流程 B） */
    renderConvo(D.convoReplanning);
    initMap();
    map.setTrip(state.trip);
    renderPanel();
    switchDay(3);
    addCtxChip({ label: '阿勒泰 · Day 3', stopId: 'd3s1', dayIndex: 3 });
    state.pendingDay3 = true;
    markDay3Pending(true);
    setSending(true);
    setTimeout(() => {
      /* 工具组：running → done */
      const tools = $('#chat-scroll .tool-group');
      if (tools) tools.replaceWith(buildToolGroup({
        status: 'done', collapsed: true,
        items: [
          { icon: 'car', title: '路径规划 · 阿勒泰→禾木（经贾登峪）', result: '248 公里 / 4.2 小时 · 13:00 出发可赶上日落', json: '{\n  "from":"阿勒泰","to":"禾木",\n  "distanceKm":248,"minutes":252,\n  "via":["布尔津","贾登峪"]\n}' },
          { icon: 'sun', title: '查询禾木 5/3 日落时间', result: '日落 21:23 · 建议 19:40 前到观景台', json: '{\n  "sunset":"21:23","goldenHour":"20:40"\n}' },
          { icon: 'route', title: '生成局部补丁 · Day 3', result: '4 处改动 · 影响 2 个 stop / 3 条连线', json: '{\n  "dayIndex":3,\n  "ops":["rhythm.wake 09:00->13:00","remove 五彩滩","remove 三湾徒步","keep 禾木日落"]\n}' }
        ]
      }));
      applyDay3Patch();
      incrementalUpdateDay3();
      state.pendingDay3 = false;
      markDay3Pending(false);
      switchDay(3);
      setTimeout(() => {
        const card = $('.act-card[data-stop-id="d3s1"]');
        if (card) highlightCard(card);
      }, 300);
      appendMessage({ type: 'ai', time: nowHM(), md: D.day3Patch.summary.md + '\n\n改动只涉及 Day 3 的 2 个 stop 与 3 条连线，其余 7 天未动。「独库公路未开放」错误仍在，等你在冲突面板做决定。' });
      setSending(false);
      scrollChatToBottom();
      toast('Day 3 已重排 · v8 已生成');
    }, 2600);
  }

  /* 暴露给页面内联脚本 */
  window.TP_Workbench = { state, openBookingDrawer, openConflictDrawer, openVersionDrawer, renderThumb };

  document.addEventListener('DOMContentLoaded', () => {
    if (document.body.dataset.app === 'workbench') init();
  });
})();
