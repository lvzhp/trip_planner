/* ============================================================
   Trace Planner · Map Canvas
   高德底图视觉风格的模拟地图渲染器（SVG）。
   实现 §3.4 全部渲染契约：序号 marker、四种线型、途经点、
   按天高亮、增量 diff、浮层控件、marker 弹层定位。
   接口按 adapter 模式组织，未来可替换为真实 AMap JS API 2.0。
   ============================================================ */

window.TP_Map = (function () {
  'use strict';
  const { icon, esc } = window.TP_UI;

  /* ---------- 投影：世界坐标 = 经纬度线性投影（纬度拉伸模拟墨卡托） ---------- */
  const W = { lng0: 78.4, lat0: 50.2, scale: 62, latStretch: 1.42 };
  function project(lng, lat) {
    return { x: (lng - W.lng0) * W.scale, y: (W.lat0 - lat) * W.scale * W.latStretch };
  }

  /* ---------- 示意底图要素（近似新疆地形，仅为底图质感） ---------- */
  function poly(points, cls) {
    const d = points.map(p => project(p[0], p[1])).map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ') + ' Z';
    return `<path class="${cls}" d="${d}"/>`;
  }
  function line(points, cls) {
    const d = points.map(p => project(p[0], p[1])).map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ');
    return `<path class="${cls}" d="${d}"/>`;
  }
  function label(lng, lat, text, anchor = 'middle') {
    const q = project(lng, lat);
    return `<text class="map-basemap-label" x="${q.x.toFixed(1)}" y="${q.y.toFixed(1)}" text-anchor="${anchor}">${text}</text>`;
  }

  function basemap() {
    let g = '';
    /* 网格 */
    for (let lng = 80; lng <= 92; lng += 2) g += line([[lng, 41], [lng, 50]], 'map-basemap-grid');
    for (let lat = 42; lat <= 49; lat += 1.5) g += line([[79, lat], [93, lat]], 'map-basemap-grid');
    /* 塔克拉玛干沙漠（南缘） */
    g += poly([[80, 41.6], [92, 41.4], [92.5, 40.5], [79.5, 40.5]], 'map-basemap-desert');
    /* 天山山脉带 */
    g += poly([[80.2, 43.2], [84, 42.6], [88, 42.6], [91.5, 43.1], [91.5, 42.2], [87, 41.9], [82, 42.1], [80.2, 42.6]], 'map-basemap-mountain');
    /* 阿尔泰山脉带 */
    g += poly([[85.2, 48.6], [88, 49.1], [90.8, 48.8], [90.6, 48.0], [87.5, 48.3], [85.4, 47.9]], 'map-basemap-mountain');
    /* 水体：赛里木湖 / 艾比湖 / 乌伦古湖 / 博斯腾湖 */
    g += poly([[81.05, 44.72], [81.32, 44.70], [81.30, 44.50], [81.05, 44.52]], 'map-basemap-water');
    g += poly([[82.2, 45.1], [82.8, 45.05], [82.7, 44.8], [82.2, 44.85]], 'map-basemap-water');
    g += poly([[86.9, 47.5], [87.9, 47.45], [87.8, 47.05], [86.9, 47.1]], 'map-basemap-water');
    g += poly([[86.2, 42.1], [87.0, 42.05], [86.9, 41.8], [86.2, 41.85]], 'map-basemap-water');
    /* 国道骨架 */
    const g30 = [[87.62, 43.79], [86.2, 44.15], [84.9, 44.43], [83.2, 44.72], [81.6, 44.85], [81.17, 44.61], [80.6, 44.3], [81.33, 43.92]];
    const g216 = [[87.62, 43.79], [88.1, 44.6], [89.1, 45.9], [89.55, 46.99], [88.14, 47.85]];
    const g217 = [[84.9, 44.43], [85.35, 45.3], [85.69, 46.1], [86.6, 46.9], [87.4, 47.4]];
    const g218 = [[81.33, 43.92], [81.84, 43.21], [82.5, 42.9], [84.1, 43.3], [86.2, 44.15]];
    for (const r of [g30, g216, g217, g218]) {
      g += line(r, 'map-basemap-road-casing');
      g += line(r, 'map-basemap-road');
    }
    /* 城市底注 */
    g += label(87.62, 43.62, '乌鲁木齐');
    g += label(85.35, 45.15, '克拉玛依');
    g += label(88.35, 47.85, '阿勒泰', 'start');
    g += label(80.95, 43.78, '伊宁');
    g += label(84.72, 44.28, '奎屯');
    g += label(81.55, 45.02, '博乐');
    g += label(89.9, 46.92, '富蕴', 'start');
    return g;
  }

  /* ============================================================
     MapCanvas
     ============================================================ */
  class MapCanvas {
    constructor(container, opts = {}) {
      this.container = container;
      this.opts = Object.assign({ interactive: true, onMarkerClick: null, onRouteClick: null }, opts);
      this.zoom = 1; this.tx = 0; this.ty = 0;
      this.stops = [];          // [{stopId, dayIndex, seq, lng, lat, poi, activities}]
      this.waypoints = [];      // [{lng, lat, name, dayIndex}]
      this.segments = [];       // 渲染后的连线（含所属天）
      this.selectedDay = 'all';
      this.selectedStop = null;
      this.diffTags = {};       // stopId -> '09:00 → 13:00'
      this.drag = null;
      this._build();
      if (this.opts.interactive) this._bindGestures();
    }

    _build() {
      this.container.classList.add('map-canvas');
      this.container.innerHTML = `
        <svg class="map-svg" aria-label="行程地图">
          <g class="viewport">
            <g class="layer-basemap">${basemap()}</g>
            <g class="layer-routes"></g>
            <g class="layer-markers"></g>
            <g class="layer-overlay"></g>
          </g>
        </svg>`;
      this.svg = this.container.querySelector('svg');
      this.viewport = this.container.querySelector('.viewport');
      this.routesLayer = this.container.querySelector('.layer-routes');
      this.markersLayer = this.container.querySelector('.layer-markers');
      this.overlayLayer = this.container.querySelector('.layer-overlay');
      this._applyTransform();
    }

    _applyTransform() {
      this.viewport.setAttribute('transform', `translate(${this.tx.toFixed(1)},${this.ty.toFixed(1)}) scale(${this.zoom.toFixed(3)})`);
    }

    /* ---------- 数据装载 ---------- */
    setTrip(trip) {
      this.stops = [];
      this.waypoints = [];
      for (const day of trip.days) {
        for (const stop of day.stops) {
          this.stops.push({ ...stop, dayIndex: day.dayIndex });
          for (const act of stop.activities) {
            const td = act.transitDetail;
            if (td && td.mode === 'self_drive' && td.waypointsPoi) {
              for (const wp of WAYPOINT_COORDS) {
                /* 子串匹配：「恰库尔图镇」命中「恰库尔图」 */
                if (td.waypointsPoi.some(n => n.includes(wp.name) || wp.name.includes(n))) {
                  this.waypoints.push({ ...wp, dayIndex: day.dayIndex });
                }
              }
            }
          }
        }
      }
      this.renderAll();
      this.fitView('all');
    }

    /* ---------- 全量渲染 ---------- */
    renderAll() {
      this.routesLayer.innerHTML = '';
      this.markersLayer.innerHTML = '';
      this.segments = [];
      const byDay = {};
      for (const s of this.stops) (byDay[s.dayIndex] = byDay[s.dayIndex] || []).push(s);

      for (const dayIdx of Object.keys(byDay).map(Number)) {
        const dayStops = byDay[dayIdx].sort((a, b) => a.seq - b.seq);
        for (let i = 1; i < dayStops.length; i++) this._renderSegment(dayStops[i - 1], dayStops[i], dayIdx);
      }
      /* 航班弧线：long_transit flight 活动（含飞往/飞离画面外城市的虚拟端点） */
      for (const s of this.stops) {
        for (const a of s.activities) {
          if (a.type === 'long_transit' && a.transitDetail && a.transitDetail.mode === 'flight') {
            this._renderFlightActivity(a.transitDetail, s.dayIndex);
          }
        }
      }
      for (const s of this.stops) this._renderMarker(s);
      for (const w of this.waypoints) this._renderWaypoint(w);
      this.applyDayFilter(this.selectedDay);
    }

    /* 航班弧线：long_transit flight 活动（含飞往/飞离画面外城市的虚拟端点） */
    _renderFlightActivity(td, dayIdx) {
      const aKnown = { '乌鲁木齐地窝堡 T3': [87.47, 43.91], '乌鲁木齐地窝堡 T2': [87.47, 43.91], '伊宁机场': [81.33, 43.96], '上海虹桥 T2': [121.34, 31.19] };
      const fromC = aKnown[td.airportFrom], toC = aKnown[td.airportTo];
      if (!fromC || !toC) return;
      /* 画面外端点 → 虚拟边界点 */
      const clamp = (c, otherC) => {
        if (c[0] <= 93.2 && c[0] >= 78.6) return c;
        const k = (93.6 - otherC[0]) / (c[0] - otherC[0]);
        return [93.6, otherC[1] + (c[1] - otherC[1]) * k];
      };
      const A = project(...clamp(fromC, toC));
      const B = project(...clamp(toC, fromC));
      this._renderFlightArc(A, B, td, dayIdx);
    }

    _renderFlightArc(a, b, meta, dayIdx) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'segment');
      g.dataset.day = dayIdx;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      const lift = Math.min(90, len * 0.24);
      const cx = mx - dy / len * lift, cy = my + dx / len * lift;
      const d = `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
      g.insertAdjacentHTML('afterbegin', `<path class="route-hit" d="${d}"/><path class="route-flight route-path" d="${d}"/>`);
      /* 弧线中点飞机图标 */
      const qx = 0.25 * a.x + 0.5 * cx + 0.25 * b.x, qy = 0.25 * a.y + 0.5 * cy + 0.25 * b.y;
      const ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI - 90;
      g.insertAdjacentHTML('beforeend',
        `<g transform="translate(${qx.toFixed(1)},${qy.toFixed(1)}) rotate(${ang.toFixed(0)})">
           <circle r="9" fill="var(--bg)" stroke="var(--line-flight)" stroke-width="1.5"/>
           <g transform="translate(-5,-5) scale(0.42)" fill="var(--line-flight)" stroke="none">
             <path d="M10.2 13.8 3 11.4l1.6-1.6 7.3.6 4.4-4.4a2 2 0 1 1 2.8 2.8l-4.4 4.4.6 7.3-1.6 1.6-2.4-7.2-3.2 3.2.3 2.7-1.3.6-2-3.1-3-2 .5-1.3 2.7.3 3.2-3.2Z"/>
           </g>
         </g>`);
      if (meta.flightNo) {
        const durMin = window.TP_UI.timeDiff(meta.depTime, meta.arrTime);
        this._routeLabel(g, qx, qy - 16, `✈ ${meta.flightNo} · ${Math.floor(durMin / 60)}h${String(durMin % 60).padStart(2, '0')}m`);
      }
      g.dataset.from = 'flight-' + (meta.flightNo || dayIdx);
      g.dataset.to = meta.airportTo || '';
      this.routesLayer.appendChild(g);
      this.segments.push({ g, dayIdx, from: g.dataset.from, to: g.dataset.to, mode: 'flight' });
    }

    _renderSegment(fromStop, toStop, dayIdx) {
      /* 判定连线类型：目标 stop 首个活动的 transitFromPrev / long_transit */
      const firstAct = toStop.activities[0];
      let mode = 'city', meta = null;
      if (firstAct && firstAct.type === 'long_transit' && firstAct.transitDetail) {
        mode = firstAct.transitDetail.mode; meta = firstAct.transitDetail;
      } else if (firstAct && firstAct.transitFromPrev) {
        const m = firstAct.transitFromPrev.mode;
        mode = (m === 'drive' && firstAct.transitFromPrev.distanceKm > 60) ? 'self_drive' : 'city';
        meta = firstAct.transitFromPrev;
      }
      const a = project(fromStop.poi.lng, fromStop.poi.lat);
      const b = project(toStop.poi.lng, toStop.poi.lat);
      const cls = { city: 'route-city', flight: 'route-flight', train: 'route-train', self_drive: 'route-drive' }[mode] || 'route-city';
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'segment');
      g.dataset.day = dayIdx;

      let d;
      if (mode === 'flight') {
        /* 虚线弧线（抬起） */
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
        const lift = Math.min(90, len * 0.28);
        const cx = mx - dy / len * lift, cy = my + dx / len * lift;
        d = `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`;
        /* 中点小飞机 */
        const px = (a.x + 2 * cx + b.x) / 4 + (b.x - a.x) / 4 * 0; // 近似曲线中点
        const qx = 0.25 * a.x + 0.5 * cx + 0.25 * b.x, qy = 0.25 * a.y + 0.5 * cy + 0.25 * b.y;
        const ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI - 90;
        g.insertAdjacentHTML('beforeend',
          `<g transform="translate(${qx.toFixed(1)},${qy.toFixed(1)}) rotate(${ang.toFixed(0)})">
             <circle r="9" fill="var(--bg)" stroke="var(--line-flight)" stroke-width="1.5"/>
             <g transform="translate(-5,-5) scale(0.42)" fill="var(--line-flight)" stroke="none">
               <path d="M10.2 13.8 3 11.4l1.6-1.6 7.3.6 4.4-4.4a2 2 0 1 1 2.8 2.8l-4.4 4.4.6 7.3-1.6 1.6-2.4-7.2-3.2 3.2.3 2.7-1.3.6-2-3.1-3-2 .5-1.3 2.7.3 3.2-3.2Z"/>
             </g>
           </g>`);
        if (meta && meta.flightNo) {
          const durMin = window.TP_UI.timeDiff(meta.depTime, meta.arrTime);
          this._routeLabel(g, qx, qy - 16, `✈ ${meta.flightNo} · ${Math.floor(durMin / 60)}h${String(durMin % 60).padStart(2, '0')}m`);
        }
      } else if (mode === 'train') {
        d = `M${a.x},${a.y} L${b.x},${b.y}`;
      } else {
        /* 轻微弯曲，避免完全直线 */
        const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.06, my = (a.y + b.y) / 2 - (b.x - a.x) * 0.06;
        d = `M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`;
      }

      g.insertAdjacentHTML('afterbegin',
        `<path class="route-hit" d="${d}"/><path class="${cls} route-path" d="${d}"/>`);

      /* 市内/自驾短标注 */
      if (mode === 'city' && meta && meta.minutes) {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const ic = meta.mode === 'walk' ? '🚶' : meta.mode === 'transit' ? '🚌' : '🚗';
        this._routeLabel(g, mx, my, `${ic}${meta.minutes}分钟`);
      } else if (mode === 'self_drive' && meta && meta.distanceKm) {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        this._routeLabel(g, mx, my, `🚗${Math.round(meta.driveMinutes / 60 * 10) / 10}h · ${meta.distanceKm}km`);
      }

      g.dataset.from = fromStop.stopId;
      g.dataset.to = toStop.stopId;
      this.routesLayer.appendChild(g);
      this.segments.push({ g, dayIdx, from: fromStop.stopId, to: toStop.stopId, mode });
      if (this.opts.onRouteClick) {
        g.querySelector('.route-hit').addEventListener('click', e => {
          e.stopPropagation();
          this.opts.onRouteClick({ from: fromStop, to: toStop, dayIdx, mode, meta });
        });
      }
    }

    _routeLabel(g, x, y, text) {
      const w = text.length * 6.6 + 12;
      g.insertAdjacentHTML('beforeend',
        `<g class="route-label" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
           <rect class="route-label-bg" x="${(-w / 2).toFixed(1)}" y="-8" width="${w.toFixed(1)}" height="16" rx="4"/>
           <text class="route-label-text" x="0" y="0" text-anchor="middle" dominant-baseline="central">${esc(text)}</text>
         </g>`);
    }

    _renderMarker(stop) {
      const p = project(stop.poi.lng, stop.poi.lat);
      const dayColor = window.TP_UI.dayColorVar(stop.dayIndex);
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'marker');
      g.dataset.stopId = stop.stopId;
      g.dataset.day = stop.dayIndex;
      g.style.setProperty('--day-color', dayColor);
      g.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
      g.innerHTML = `
        <g class="marker-pin">
          <circle class="pin-bg" r="13"/>
          <text class="pin-num" y="0.5">${stop.seq}</text>
        </g>`;
      /* 名称标签 */
      g.insertAdjacentHTML('beforeend',
        `<text x="0" y="26" text-anchor="middle" font-size="11" font-weight="600" fill="var(--text)" paint-order="stroke" stroke="var(--bg)" stroke-width="3" stroke-linejoin="round">${esc(shortName(stop.poi.name))}</text>`);
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', `Day ${stop.dayIndex} 第${stop.seq}站 ${stop.poi.name}`);
      const click = e => { e.stopPropagation(); this.selectStop(stop.stopId, true); };
      g.addEventListener('click', click);
      g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); click(e); } });
      this.markersLayer.appendChild(g);
      stop._markerEl = g;
      stop._pos = p;
    }

    _renderWaypoint(w) {
      const p = project(w.lng, w.lat);
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'waypoint');
      g.dataset.day = w.dayIndex;
      g.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
      g.innerHTML = `
        <g class="waypoint-dot"><circle r="5"/></g>
        <text class="waypoint-label" y="16">${esc(w.name)}</text>`;
      this.markersLayer.appendChild(g);
      w._el = g;
    }

    /* ---------- 按天过滤（高亮当天，其余降饱和保留空间感） ---------- */
    applyDayFilter(day) {
      this.selectedDay = day;
      const all = day === 'all';
      this.markersLayer.querySelectorAll('.marker').forEach(m => {
        const on = all || +m.dataset.day === day;
        m.querySelector('.marker-pin').classList.toggle('dimmed', !on);
        m.style.opacity = on ? '1' : '.45';
      });
      this.markersLayer.querySelectorAll('.waypoint').forEach(m => {
        const on = all || +m.dataset.day === day;
        m.classList.toggle('dimmed', !on);
        m.style.opacity = on ? '1' : '.3';
      });
      this.routesLayer.querySelectorAll('.segment').forEach(s => {
        const on = all || +s.dataset.day === day;
        s.classList.toggle('route-dimmed', !on);
      });
      if (!all) this.fitView(day);
    }

    /* ---------- fitView ---------- */
    fitView(day) {
      let pts;
      if (day === 'all' || day == null) pts = this.stops.map(s => [s.poi.lng, s.poi.lat]);
      else pts = this.stops.filter(s => s.dayIndex === day).map(s => [s.poi.lng, s.poi.lat]);
      if (!pts.length) return;
      const proj = pts.map(p => project(p[0], p[1]));
      const minX = Math.min(...proj.map(p => p.x)), maxX = Math.max(...proj.map(p => p.x));
      const minY = Math.min(...proj.map(p => p.y)), maxY = Math.max(...proj.map(p => p.y));
      const rect = this.container.getBoundingClientRect();
      const pad = 90;
      const zx = (rect.width - pad * 2) / Math.max(maxX - minX, 1);
      const zy = (rect.height - pad * 2) / Math.max(maxY - minY, 1);
      this.zoom = Math.min(Math.max(Math.min(zx, zy), 0.4), 3.2);
      this.tx = rect.width / 2 - (minX + maxX) / 2 * this.zoom;
      this.ty = rect.height / 2 - (minY + maxY) / 2 * this.zoom;
      this._applyTransform();
    }

    zoomBy(f) {
      const rect = this.container.getBoundingClientRect();
      const cx = rect.width / 2, cy = rect.height / 2;
      const nz = Math.min(Math.max(this.zoom * f, 0.3), 5);
      this.tx = cx - (cx - this.tx) * (nz / this.zoom);
      this.ty = cy - (cy - this.ty) * (nz / this.zoom);
      this.zoom = nz;
      this._applyTransform();
    }

    screenPos(stopId) {
      const s = this.stops.find(x => x.stopId === stopId);
      if (!s || !s._pos) return null;
      return { x: s._pos.x * this.zoom + this.tx, y: s._pos.y * this.zoom + this.ty };
    }

    centerOn(stopId) {
      const s = this.stops.find(x => x.stopId === stopId);
      if (!s || !s._pos) return;
      const rect = this.container.getBoundingClientRect();
      this.zoom = Math.max(this.zoom, 1.1);
      this.tx = rect.width / 2 - s._pos.x * this.zoom;
      this.ty = rect.height / 2 - s._pos.y * this.zoom;
      this._applyTransform();
    }

    selectStop(stopId, fromMap) {
      this.markersLayer.querySelectorAll('.marker.selected').forEach(m => m.classList.remove('selected'));
      this.selectedStop = stopId;
      const m = this.markersLayer.querySelector(`.marker[data-stop-id="${stopId}"]`);
      if (m) m.classList.add('selected');
      if (fromMap && this.opts.onMarkerClick) this.opts.onMarkerClick(stopId);
    }
    clearSelection() {
      this.markersLayer.querySelectorAll('.marker.selected').forEach(m => m.classList.remove('selected'));
      this.selectedStop = null;
    }

    /* ---------- 增量更新（关键契约：只重绘受影响部分） ---------- */
    applyPatch(patch) {
      /* patch: { removeStopIds:[], updateStops:[stopObj...], diffTags:{stopId:text}, flashSegments:[[from,to]] } */
      for (const id of patch.removeStopIds || []) {
        const m = this.markersLayer.querySelector(`.marker[data-stop-id="${id}"]`);
        if (m) m.remove();
        this.stops = this.stops.filter(s => s.stopId !== id);
        /* 移除关联连线 */
        this.segments = this.segments.filter(sg => {
          if (sg.from === id || sg.to === id) { sg.g.remove(); return false; }
          return true;
        });
        this.waypoints.forEach(w => { if (w.dayIndex === patch.dayIndex && w._el) { /* 途经点随天保留 */ } });
      }
      for (const stop of patch.updateStops || []) {
        /* 已存在则只更新脉冲；不存在则新建 */
        if (!this.stops.find(s => s.stopId === stop.stopId)) {
          this.stops.push(stop);
          this._renderMarker(stop);
        }
        this.pulseMarker(stop.stopId);
      }
      for (const [from, to] of patch.flashSegments || []) {
        const sg = this.segments.find(s => s.from === from && s.to === to);
        if (sg) {
          const path = sg.g.querySelector('.route-path');
          path.classList.remove('route-flash');
          void path.getBoundingClientRect();
          path.classList.add('route-flash');
          setTimeout(() => path.classList.remove('route-flash'), 1700);
        }
      }
      for (const [stopId, text] of Object.entries(patch.diffTags || {})) {
        this.addDiffTag(stopId, text);
      }
    }

    pulseMarker(stopId) {
      const m = this.markersLayer.querySelector(`.marker[data-stop-id="${stopId}"]`);
      if (!m) return;
      m.querySelectorAll('.marker-pulse').forEach(x => x.remove());
      const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      ring.setAttribute('class', 'marker-pulse');
      ring.setAttribute('r', '13');
      ring.setAttribute('fill', 'none');
      ring.setAttribute('stroke', 'var(--accent)');
      ring.setAttribute('stroke-width', '3');
      m.insertBefore(ring, m.firstChild);
      setTimeout(() => ring.remove(), 1300);   /* 600ms × 2 次后回落 */
    }

    addDiffTag(stopId, text) {
      const m = this.markersLayer.querySelector(`.marker[data-stop-id="${stopId}"]`);
      if (!m) return;
      m.querySelectorAll('.marker-diff-tag').forEach(x => x.remove());
      const w = text.length * 6.2 + 14;
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'marker-diff-tag');
      g.innerHTML = `<rect x="${(-w / 2).toFixed(1)}" y="-40" width="${w.toFixed(1)}" height="17" rx="4"/>
        <text x="0" y="-31.5">${esc(text)}</text>
        <path d="M-4,-23 L4,-23 L0,-18 Z" fill="var(--accent)"/>`;
      m.appendChild(g);
      this.diffTags[stopId] = text;
    }

    /* ---------- 手势：拖拽平移 + 滚轮缩放 ---------- */
    _bindGestures() {
      const c = this.container;
      c.addEventListener('pointerdown', e => {
        if (e.target.closest('.marker, .route-hit, .poi-popover, .map-overlay')) return;
        this.drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
        c.setPointerCapture(e.pointerId);
      });
      c.addEventListener('pointermove', e => {
        if (!this.drag) return;
        this.tx = this.drag.tx + (e.clientX - this.drag.x);
        this.ty = this.drag.ty + (e.clientY - this.drag.y);
        this._applyTransform();
      });
      c.addEventListener('pointerup', () => { this.drag = null; });
      c.addEventListener('wheel', e => {
        e.preventDefault();
        this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12);
      }, { passive: false });
      /* 点击空白关闭弹层 */
      c.addEventListener('click', e => {
        if (!e.target.closest('.marker, .poi-popover, .map-overlay, .route-hit') && this.opts.onBlankClick) this.opts.onBlankClick();
      });
    }
  }

  /* 自驾途经点坐标（空心小圆点） */
  const WAYPOINT_COORDS = [
    { name: '果子沟大桥', lng: 81.62, lat: 44.47 },
    { name: '独库公路天瀑', lng: 84.62, lat: 43.72 },
    { name: '恰库尔图', lng: 89.13, lat: 45.92 },
    { name: '五彩湾', lng: 88.42, lat: 44.98 }
  ];

  function shortName(name) {
    /* 「喀纳斯湖 · 三湾徒步」→「喀纳斯湖」 */
    return name.split(' · ')[0].replace(/^乌鲁木齐 · |^伊宁 · |^特克斯八卦城 · /, m => m.slice(0, -2));
  }

  /* ---------- 缩略图（行程列表页用）：静态 SVG，无交互 ---------- */
  function renderThumb(svgEl, points, dayColors) {
    if (!points || points.length < 2) return;
    const lngs = points.map(p => p[0]), lats = points.map(p => p[1]);
    const minLng = Math.min(...lngs) - 0.6, maxLng = Math.max(...lngs) + 0.6;
    const minLat = Math.min(...lats) - 0.4, maxLat = Math.max(...lats) + 0.4;
    const W2 = 320, H2 = 150;
    const px = lng => ((lng - minLng) / (maxLng - minLng)) * W2;
    const py = lat => H2 - ((lat - minLat) / (maxLat - minLat)) * H2;
    svgEl.setAttribute('viewBox', `0 0 ${W2} ${H2}`);
    let html = `<rect width="${W2}" height="${H2}" fill="#EDF1F4"/>`;
    /* 装饰性底纹 */
    html += `<path d="M0,${H2 * 0.62} Q${W2 * 0.3},${H2 * 0.5} ${W2 * 0.55},${H2 * 0.66} T${W2},${H2 * 0.58} V${H2} H0 Z" fill="#E4EAE3"/>`;
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`).join(' ');
    html += `<path d="${d}" fill="none" stroke="#1D6F5C" stroke-width="2" stroke-dasharray="7 4" stroke-linecap="round" opacity=".8"/>`;
    points.forEach((p, i) => {
      const color = dayColors ? dayColors[Math.min(i, dayColors.length - 1)] : '#1D6F5C';
      html += `<circle cx="${px(p[0]).toFixed(1)}" cy="${py(p[1]).toFixed(1)}" r="4.5" fill="${color}" stroke="#fff" stroke-width="1.6"/>`;
    });
    svgEl.innerHTML = html;
  }

  return { MapCanvas, renderThumb, project, shortName };
})();
