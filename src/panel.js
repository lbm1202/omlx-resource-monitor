/* omlx-resource-monitor — panel.js
 *
 * Live resource panel mounted on /admin/monitor. Connects to the logger via
 * Server-Sent Events (/custom/stream), renders three Canvas graphs:
 *   - CPU/GPU usage lines
 *   - Memory breakdown (model / hot cache / runtime / other) as stacked area
 *   - Memory pressure + swap + compressor (vertical-split canvas)
 * Plus an activity strip with PP/TG progress badges.
 *
 * Theme & language follow the oMLX admin settings (CSS variables + ui_language).
 */
(function () {
  'use strict';
  if (window.__omlxMonitorPanel) return;
  window.__omlxMonitorPanel = true;

  // Page guard — only run on the monitor page.
  if (!/^\/admin\/monitor/.test(location.pathname)) return;

  // ─── Constants ────────────────────────────────────────────────────────────
  const MIN_WINDOW_S = 30;             // max zoom-in (30 s window)
  const DEFAULT_WINDOW_S = 60;
  const MAX_WINDOW_S = 3600;           // max zoom-out (1 h window)
  const ZOOM_STEP_S = 6;               // window size is always a multiple of this
  const ZOOM_RATE = 0.12;              // non-linear zoom: one step ≈ 12 % of current window
  const AXIS_H = 18;                   // bottom time-axis strip height
  const STALE_MS = 30_000;             // beyond this, show "data delayed"

  const COLORS = { cpu: '#16a34a', gpu: '#ea580c', swap: '#f59e0b', comp: '#a855f7' };
  const ACT = { idle: '#9ca3af', pp: '#3b82f6', tg: '#16a34a', load: '#d97706' };

  // Memory-pressure level (kernel jetsam) → label key + visual band color.
  const PRESSURE = {
    1: { key: 'pressure_normal',   color: '#22c55e' },
    2: { key: 'pressure_warning',  color: '#eab308' },
    4: { key: 'pressure_critical', color: '#ef4444' },
    0: { key: 'pressure_unknown',  color: '#737373' },
  };

  // Stacked memory breakdown layers (bottom to top).
  // Label keys are resolved via t() so they i18nize automatically.
  const MEM_LAYERS = [
    { key: 'model_gb',     color: '#1e40af', labelKey: 'mem_model' },
    { key: 'hot_cache_gb', color: '#3b82f6', labelKey: 'mem_hot_cache' },
    { key: 'runtime_gb',   color: '#93c5fd', labelKey: 'mem_runtime' },
    { key: 'mac_other_gb', color: '#64748b', labelKey: 'mem_other' },
  ];

  // ─── i18n ─────────────────────────────────────────────────────────────────
  const I18N = {
    ko: {
      // Page chrome
      back_to_dashboard: '대시보드로 돌아가기',
      panel_eyebrow: '시스템 리소스',
      panel_title:   '실시간 사용량',
      chip_connecting: '연결 중…',
      chip_fresh:      '방금 갱신',
      chip_seconds_ago: '{n}초 전',
      chip_stale:      '데이터 지연',
      status_stale:    '· 로거 확인 필요',
      // Toolbar
      window_label:    '최근 {dur}',
      zoom_hint:       '⌃ + 스크롤 — 스크롤 업: 과거까지 / 스크롤 다운: 최근만',
      // Window units
      unit_seconds:    '{n}초',
      unit_minutes:    '{n}분',
      unit_one_hour:   '1시간',
      // Duration formatter
      dur_seconds: '{n}초',
      dur_minutes_seconds: '{m}분 {s}초',
      // Graph labels
      g_cpu_gpu: 'CPU · GPU',
      g_memory:  '메모리',
      g_pressure: '메모리 압력',
      // Memory layer labels
      mem_model: '모델',
      mem_hot_cache: 'Hot 캐시',
      mem_runtime:   '런타임',
      mem_other:     '기타',
      // Pressure level labels
      pressure_normal:   '정상',
      pressure_warning:  '경고',
      pressure_critical: '위험',
      pressure_unknown:  '확인중',
      pressure_legend:   '압력:',
      // Headers
      cpu_gpu_header: 'CPU {cpu}% · GPU {gpu}%',
      mem_breakdown_tip: 'oMLX {omlx} GB + 기타 {other} GB',
      pressure_header:   '압력 {label} · Swap {swap} GB · 압축 {comp} GB',
      // Activity badges
      activity_loading_models: '모델 상태 확인 중…',
      activity_no_models:      '로드된 모델 없음',
      activity_loading:        '로딩 중',
      activity_loading_for:    '로딩 중 · {sec}초',
      activity_idle:           '대기 중',
      activity_queued:         '대기 · 큐 {n}건',
      activity_pp:             'PP {processed}/{total} tok · {elapsed} ({speed} tok/s{eta})',
      activity_pp_eta:         ' · {dur} 남음',
      activity_tg:             'TG {tps} tok/s · {tok} 토큰 · {elapsed}',
      // Tooltip rows
      tt_no_data: '데이터 없음',
      tt_breakdown: '분해',
      tt_total: '합계',
      tt_pressure_label: '압력',
      tt_pressure_sub:   'jetsam {lvl} · 여유 {free}%',
      tt_swap: 'Swap',
      tt_comp: '압축',
    },
    en: {
      back_to_dashboard: 'Back to Dashboard',
      panel_eyebrow: 'System Resources',
      panel_title:   'Live Usage',
      chip_connecting: 'Connecting…',
      chip_fresh:      'just now',
      chip_seconds_ago: '{n} s ago',
      chip_stale:      'data delayed',
      status_stale:    '· check logger',

      window_label: 'Last {dur}',
      zoom_hint:    '⌃ + scroll — up: more history / down: more recent',

      unit_seconds:  '{n} s',
      unit_minutes:  '{n} min',
      unit_one_hour: '1 h',

      dur_seconds: '{n} s',
      dur_minutes_seconds: '{m} min {s} s',

      g_cpu_gpu: 'CPU · GPU',
      g_memory:  'Memory',
      g_pressure: 'Memory Pressure',

      mem_model: 'Model',
      mem_hot_cache: 'Hot Cache',
      mem_runtime:   'Runtime',
      mem_other:     'Other',

      pressure_normal:   'Normal',
      pressure_warning:  'Warning',
      pressure_critical: 'Critical',
      pressure_unknown:  '...',
      pressure_legend:   'Pressure:',

      cpu_gpu_header: 'CPU {cpu}% · GPU {gpu}%',
      mem_breakdown_tip: 'oMLX {omlx} GB + Other {other} GB',
      pressure_header:   'Pressure {label} · Swap {swap} GB · Compressed {comp} GB',

      activity_loading_models: 'checking models…',
      activity_no_models:      'no models loaded',
      activity_loading:        'loading',
      activity_loading_for:    'loading · {sec} s',
      activity_idle:           'idle',
      activity_queued:         'idle · queued: {n}',
      activity_pp:             'PP {processed}/{total} tok · {elapsed} ({speed} tok/s{eta})',
      activity_pp_eta:         ' · {dur} left',
      activity_tg:             'TG {tps} tok/s · {tok} tokens · {elapsed}',

      tt_no_data: 'no data',
      tt_breakdown: 'breakdown',
      tt_total: 'total',
      tt_pressure_label: 'pressure',
      tt_pressure_sub:   'jetsam {lvl} · free {free}%',
      tt_swap: 'Swap',
      tt_comp: 'Compressed',
    },
  };

  let lang = 'en';

  function t(key, vars) {
    let s = (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
    if (vars) for (const k in vars) s = s.replace('{' + k + '}', vars[k]);
    return s;
  }

  async function initLang() {
    // Resolution order (first match wins):
    //   1. document.documentElement.lang — set by oMLX Jinja on injected admin
    //      pages. On monitor.html (our own) this is "en" by default; the fetch
    //      below upgrades it.
    //   2. /admin/api/global-settings → ui.language — authoritative for the
    //      monitor page itself (no Jinja context).
    //   3. navigator.language — last-ditch fallback.
    const htmlLang = document.documentElement.lang || '';
    if (htmlLang && I18N[htmlLang]) lang = htmlLang;

    try {
      const r = await fetch('/admin/api/global-settings', { cache: 'no-store' });
      if (r.ok) {
        const s = await r.json();
        const root = (s && (s.global_settings || s)) || {};
        const ui = (root.ui && root.ui.language) || root.ui_language || '';
        if (ui && I18N[ui]) { lang = ui; return; }
      }
    } catch (_) {}

    if (!(htmlLang && I18N[htmlLang])) {
      const nav = (navigator.language || '').slice(0, 2);
      if (I18N[nav]) lang = nav;
    }
  }

  // ─── State ────────────────────────────────────────────────────────────────
  let windowS = DEFAULT_WINDOW_S;
  let panAnchorT = null;   // null = live (right edge = latest); otherwise absolute ms of right edge
  let history = [];
  let hoverT = null;       // recomputed every redraw from hoverFrac × range
  let hoverFrac = null;    // canvas X fraction (0..1) — keeps cursor under pointer in live scroll
  let hoverGraph = null;   // 'cpu' | 'mem' | 'pressure'
  let hoverScreenXY = null;
  let _eventSource = null;

  // ─── CSS (uses oMLX admin CSS variables for theming) ──────────────────────
  const css = `
    #orm-panel{background:var(--bg-primary);border:1px solid var(--border-faint);border-radius:16px;padding:24px;margin:0 0 32px 0;color:var(--text-primary);font-family:inherit}
    #orm-panel .mm-head{display:flex;align-items:end;justify-content:space-between;margin-bottom:16px;gap:16px;flex-wrap:wrap}
    #orm-panel .mm-title-wrap{display:flex;flex-direction:column;gap:6px}
    #orm-panel .mm-eyebrow{font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.1em}
    #orm-panel .mm-title{font-size:22px;font-weight:700;letter-spacing:-0.02em;color:var(--text-primary);line-height:1.2}
    #orm-panel .mm-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:var(--bg-secondary);border:1px solid var(--border-faint);font-size:12px;color:var(--text-tertiary)}
    #orm-panel .mm-chip-dot{width:8px;height:8px;border-radius:4px;background:#22c55e;animation:ormpulse 2s infinite}
    @keyframes ormpulse{0%,100%{opacity:1}50%{opacity:.35}}
    #orm-panel .mm-graph-wrap{position:relative;background:var(--bg-secondary);border:1px solid var(--border-faint);border-radius:12px;padding:14px;margin-top:14px}
    #orm-panel .mm-graph-wrap:first-of-type{margin-top:0}
    #orm-panel .mm-ghead{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:12px}
    #orm-panel .mm-glabel{font-size:11px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:.06em;font-weight:600;white-space:nowrap}
    #orm-panel .mm-gnow{font-size:11px;color:var(--text-tertiary);font-variant-numeric:tabular-nums;text-align:right}
    #orm-panel .mm-ram-hint{position:relative}
    #orm-panel .mm-ram-hint.mm-show-tip{text-decoration:underline dotted;text-underline-offset:2px;cursor:help}
    #orm-panel .mm-ram-hint.mm-show-tip::after{
      content:attr(data-tip);position:absolute;bottom:calc(100% + 6px);right:0;
      background:rgba(15,23,42,0.97);color:#fff;padding:6px 10px;border-radius:6px;
      font-size:11px;font-weight:500;white-space:nowrap;
      opacity:0;pointer-events:none;transition:opacity .08s;z-index:100;
      box-shadow:0 4px 14px rgba(0,0,0,0.25)}
    #orm-panel .mm-ram-hint.mm-show-tip:hover::after{opacity:1}
    #orm-panel #orm-canvas{display:block;width:100%;height:104px;cursor:crosshair}
    #orm-panel #orm-mcanvas{display:block;width:100%;height:128px;cursor:crosshair}
    #orm-panel #orm-pcanvas{display:block;width:100%;height:128px;cursor:crosshair}
    #orm-panel .mm-legend{display:flex;gap:14px;font-size:11px;color:var(--text-tertiary);margin-top:8px;align-items:center;flex-wrap:wrap}
    #orm-panel .mm-legend .mm-spacer{flex:1}
    #orm-panel .mm-legend span{display:inline-flex;align-items:center;gap:6px}
    #orm-panel .mm-legend i{display:inline-block;width:12px;height:8px;border-radius:2px}
    #orm-panel .mm-legend-badge{display:inline-flex;align-items:center;gap:10px;padding:3px 10px;border-radius:999px;background:var(--bg-tertiary)}
    #orm-panel .mm-legend-badge > span{display:inline-flex;align-items:center;gap:6px}
    #orm-panel .mm-toolbar{display:flex;gap:14px;font-size:11px;color:var(--text-tertiary);align-items:center;flex-wrap:wrap;margin:0 4px 14px}
    #orm-panel .mm-toolbar .mm-spacer{flex:1}
    #orm-panel .mm-window{font-weight:600;color:var(--text-primary);font-variant-numeric:tabular-nums}
    #orm-panel .mm-zoomhint{color:var(--text-muted)}
    #orm-panel .mm-status{color:#d97706}
    #orm-panel .mm-activity{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
    #orm-panel .mm-act{display:inline-flex;align-items:center;gap:7px;padding:6px 11px;border-radius:9px;font-size:12px;background:var(--bg-secondary);border:1px solid var(--border-faint);font-variant-numeric:tabular-nums}
    #orm-panel .mm-act-dot{width:7px;height:7px;border-radius:4px;flex:none}
    #orm-panel .mm-act-live{animation:ormpulse 1.4s infinite}
    #orm-panel .mm-act-name{font-weight:600;color:var(--text-primary)}
    #orm-panel .mm-act-meta{color:var(--text-tertiary)}
    #orm-panel .mm-act-stack{align-items:flex-start;padding:8px 11px}
    #orm-panel .mm-act-stack .mm-act-dot{margin-top:5px}
    #orm-panel .mm-act-body{display:flex;flex-direction:column;gap:2px;line-height:1.4}
    #orm-tooltip{position:fixed;z-index:99999;display:none;pointer-events:none;background:rgba(15,23,42,0.97);color:#e2e8f0;border:1px solid rgba(255,255,255,0.13);border-radius:9px;padding:9px 11px;font-size:11px;font-family:-apple-system,sans-serif;font-variant-numeric:tabular-nums;box-shadow:0 6px 22px rgba(0,0,0,0.34);min-width:188px}
    #orm-tooltip .mm-tt-time{font-weight:700;margin-bottom:6px;color:#fff}
    #orm-tooltip .mm-tt-row{display:flex;align-items:center;gap:7px;line-height:1.85;white-space:nowrap}
    #orm-tooltip .mm-tt-row i{width:8px;height:8px;border-radius:2px;flex:none}
    #orm-tooltip .mm-tt-label{color:#94a3b8;width:48px}
    #orm-tooltip .mm-tt-val{font-weight:700;color:#fff}
    #orm-tooltip .mm-tt-sub{color:#94a3b8;margin-left:auto;padding-left:10px}
  `;

  // ─── Utilities ────────────────────────────────────────────────────────────
  const isDark = () =>
    document.documentElement.classList.contains('dark') ||
    document.body.classList.contains('dark');

  function fmtWindow(s) {
    if (s >= 3600) return t('unit_one_hour');
    if (s >= 120)  return t('unit_minutes', { n: Math.round(s / 60) });
    return t('unit_seconds', { n: Math.round(s) });
  }

  function fmtClock(ms, withSec) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return withSec
      ? `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
      : `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  const num = (v, digits = 1) => (typeof v === 'number' ? v : 0).toFixed(digits);

  function setText(id, v) {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function fmtTok(n) {
    n = typeof n === 'number' ? n : 0;
    if (n >= 10000) return Math.round(n / 1000) + 'k';
    if (n >= 1000)  return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function fmtDur(s) {
    s = Math.round(typeof s === 'number' ? s : 0);
    if (s < 60) return t('dur_seconds', { n: s });
    return t('dur_minutes_seconds', { m: Math.floor(s / 60), s: s % 60 });
  }

  // ─── Pressure helpers ─────────────────────────────────────────────────────
  // free% from `memory_pressure` (Activity Monitor's "System-wide memory free %").
  function freeOf(p) {
    if (typeof p.free_pct === 'number') return p.free_pct;
    const lvl = p.pressure || 1;          // legacy points — approximate from kernel level
    return lvl >= 4 ? 15 : lvl === 2 ? 40 : 90;
  }

  // free% → line height fraction (0=baseline, 1=top). Lower free% → higher line.
  function pressureFrac(freePct) {
    const f = Math.max(0, Math.min(100, freePct));
    if (f >= 50) return 0.05 + (100 - f) / 50 * 0.43;
    if (f >= 30) return 0.48 + (50 - f) / 20 * 0.34;
    return 0.82 + (30 - f) / 30 * 0.18;
  }

  // ─── HTML builders ────────────────────────────────────────────────────────
  function buildPanel() {
    const el = document.createElement('div');
    el.id = 'orm-panel';
    const memLegend = MEM_LAYERS
      .map((L) => `<span><i style="background:${L.color}"></i>${esc(t(L.labelKey))}</span>`)
      .join('');
    el.innerHTML = `
      <div class="mm-head">
        <div class="mm-title-wrap">
          <div class="mm-eyebrow">${esc(t('panel_eyebrow'))}</div>
          <div class="mm-title">${esc(t('panel_title'))}</div>
        </div>
        <span class="mm-chip"><span class="mm-chip-dot" id="orm-chip-dot"></span><span id="orm-chip-text">${esc(t('chip_connecting'))}</span></span>
      </div>

      <div class="mm-activity" id="orm-activity">
        <span class="mm-act"><span class="mm-act-dot" style="background:#9ca3af"></span><span class="mm-act-meta">${esc(t('activity_loading_models'))}</span></span>
      </div>

      <div class="mm-toolbar">
        <span class="mm-window" id="orm-window">${esc(t('window_label', { dur: fmtWindow(DEFAULT_WINDOW_S) }))}</span>
        <span class="mm-zoomhint">${esc(t('zoom_hint'))}</span>
        <span class="mm-spacer"></span>
        <span class="mm-status" id="orm-status"></span>
      </div>

      <div class="mm-graph-wrap">
        <div class="mm-ghead">
          <span class="mm-glabel">${esc(t('g_cpu_gpu'))}</span>
          <span class="mm-gnow" id="orm-cgraph-now">—</span>
        </div>
        <canvas id="orm-canvas"></canvas>
        <div class="mm-legend">
          <span><i style="background:${COLORS.cpu}"></i>CPU</span>
          <span><i style="background:${COLORS.gpu}"></i>GPU</span>
        </div>
      </div>

      <div class="mm-graph-wrap">
        <div class="mm-ghead">
          <span class="mm-glabel">${esc(t('g_memory'))}</span>
          <span class="mm-gnow" id="orm-mgraph-now">—</span>
        </div>
        <canvas id="orm-mcanvas"></canvas>
        <div class="mm-legend">
          ${memLegend}
        </div>
      </div>

      <div class="mm-graph-wrap">
        <div class="mm-ghead">
          <span class="mm-glabel">${esc(t('g_pressure'))}</span>
          <span class="mm-gnow" id="orm-pgraph-now">—</span>
        </div>
        <canvas id="orm-pcanvas"></canvas>
        <div class="mm-legend">
          <span><i style="background:${COLORS.swap}"></i>${esc(t('tt_swap'))}</span>
          <span><i style="background:${COLORS.comp}"></i>${esc(t('tt_comp'))}</span>
          <span class="mm-legend-badge">
            <span>${esc(t('pressure_legend'))}</span>
            <span><i style="background:${PRESSURE[1].color}"></i>${esc(t('pressure_normal'))}</span>
            <span><i style="background:${PRESSURE[2].color}"></i>${esc(t('pressure_warning'))}</span>
            <span><i style="background:${PRESSURE[4].color}"></i>${esc(t('pressure_critical'))}</span>
          </span>
        </div>
      </div>
    `;
    return el;
  }

  // Translate the "Back to dashboard" link in the host page (monitor.html).
  function localizeChrome() {
    const back = document.querySelector('[data-orm-back]');
    if (back) back.textContent = t('back_to_dashboard');
    const title = document.querySelector('title');
    if (title) title.textContent = t('panel_title') + ' · oMLX';
  }

  // ─── Mount ────────────────────────────────────────────────────────────────
  const findAnchor = () => document.getElementById('orm-mount');

  function mountInto(parent) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    parent.appendChild(buildPanel());

    const tip = document.createElement('div');
    tip.id = 'orm-tooltip';
    document.body.appendChild(tip);

    attachZoomAndPan();
    attachHover();
    updateWindowLabel();
    connectStream();
  }

  // ─── Pan + zoom (wheel) ───────────────────────────────────────────────────
  function attachZoomAndPan() {
    let lastZoomT = 0;
    const onWheel = (e) => {
      // Shift+wheel → pan (keep window size, shift time axis).
      // macOS converts shift+wheel deltaY to deltaX, so accept either.
      const panDelta = e.deltaY || e.deltaX;
      if (e.shiftKey && panDelta) {
        e.preventDefault();
        const now = performance.now();
        if (now - lastZoomT < 70) return;
        lastZoomT = now;
        const dir = Math.sign(panDelta);   // >0 = into the past, <0 = toward live
        const last = latest();
        const liveT = last ? last.t : Date.now();
        if (panAnchorT == null) panAnchorT = liveT;
        const step = windowS * 1000 * 0.12;
        panAnchorT += dir * step;
        if (panAnchorT >= liveT) {
          panAnchorT = null;               // overshoot → snap back to live mode
        } else {
          const oldest = history.length ? history[0].t : null;
          if (oldest != null) {
            const minAnchor = oldest + windowS * 1000;
            if (panAnchorT < minAnchor) panAnchorT = minAnchor;
          }
        }
        updateWindowLabel();
        redraw();
        return;
      }
      if (!e.ctrlKey || !e.deltaY) return;
      e.preventDefault();
      // Non-linear zoom. One step ≈ ZOOM_RATE × current window, snapped to ZOOM_STEP_S.
      // Trackpads spam events — throttle to ~70 ms per step.
      const now = performance.now();
      if (now - lastZoomT < 70) return;
      lastZoomT = now;
      // Direction inverted: scroll up = zoom out (longer history), scroll down = zoom in.
      const dir = -Math.sign(e.deltaY);
      const centerT = hoverT;
      // For zoom-in, base step on the smaller window so in/out are symmetric.
      const base = dir < 0 ? windowS / (1 + ZOOM_RATE) : windowS;
      let step = Math.round((base * ZOOM_RATE) / ZOOM_STEP_S) * ZOOM_STEP_S;
      if (step < ZOOM_STEP_S) step = ZOOM_STEP_S;
      windowS += dir * step;
      windowS = Math.min(MAX_WINDOW_S, Math.max(MIN_WINDOW_S, windowS));
      windowS = Math.round(windowS / ZOOM_STEP_S) * ZOOM_STEP_S;
      // Recenter around the hover point if present.
      if (centerT != null) {
        const last = latest();
        const liveT = last ? last.t : Date.now();
        panAnchorT = centerT + windowS * 1000 / 2;
        if (panAnchorT >= liveT) {
          panAnchorT = null;
        } else {
          const oldest = history.length ? history[0].t : null;
          if (oldest != null) {
            const minAnchor = oldest + windowS * 1000;
            if (panAnchorT < minAnchor) panAnchorT = minAnchor;
          }
        }
      }
      updateWindowLabel();
      redraw();
    };
    document.querySelectorAll('#orm-panel .mm-graph-wrap')
      .forEach((el) => el.addEventListener('wheel', onWheel, { passive: false }));
  }

  // ─── Hover (cursor + tooltip) ─────────────────────────────────────────────
  function attachHover() {
    const map = [
      { id: 'orm-canvas',  graph: 'cpu' },
      { id: 'orm-mcanvas', graph: 'mem' },
      { id: 'orm-pcanvas', graph: 'pressure' },
    ];
    for (const { id, graph } of map) {
      const cvs = document.getElementById(id);
      if (!cvs) continue;
      cvs.addEventListener('mousemove', (e) => {
        const rect = cvs.getBoundingClientRect();
        hoverFrac = (e.clientX - rect.left) / rect.width;
        hoverGraph = graph;
        hoverScreenXY = { x: e.clientX, y: e.clientY };
        redraw();                          // hoverT is recomputed from hoverFrac inside redraw()
      });
      cvs.addEventListener('mouseleave', () => {
        hoverT = null;
        hoverFrac = null;
        hoverGraph = null;
        hoverScreenXY = null;
        redraw();
        hideTooltip();
      });
    }
  }

  function updateWindowLabel() {
    setText('orm-window', t('window_label', { dur: fmtWindow(windowS) }));
  }

  // ─── SSE — single source of truth for all data ────────────────────────────
  // The logger pushes seed (on connect) + tick (every 0.5 s). EventSource
  // handles auto-reconnect; the server re-sends seed on every new connection.
  function connectStream() {
    if (_eventSource) try { _eventSource.close(); } catch (_) {}
    _eventSource = new EventSource('/custom/stream');
    _eventSource.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.type === 'seed') {
        history = Array.isArray(m.points) ? m.points : [];
        if (m.activity) renderActivity(m.activity);
        updateHeads();
        redraw();
      } else if (m.type === 'tick') {
        if (m.point) {
          history.push(m.point);
          const cutoff = Date.now() - MAX_WINDOW_S * 1000;
          while (history.length && history[0].t < cutoff) history.shift();
        }
        if (m.activity) renderActivity(m.activity);
        updateHeads();
        redraw();
      }
    };
    _eventSource.onerror = () => {
      console.warn('[orm] SSE disconnected — EventSource will auto-reconnect');
    };
  }

  // ─── Top-of-card headers (chip + per-graph "now" labels) ──────────────────
  const latest = () => (history.length ? history[history.length - 1] : null);

  function nearestPoint(target) {
    if (!history.length) return null;
    let best = history[0], bd = Math.abs(history[0].t - target);
    for (const p of history) {
      const d = Math.abs(p.t - target);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  function updateHeads() {
    const d = latest();
    if (!d) return;
    const lvl = d.pressure || 1;
    const band = PRESSURE[lvl] || PRESSURE[1];
    const bandLabel = t(band.key);

    setText('orm-cgraph-now', t('cpu_gpu_header', { cpu: num(d.cpu), gpu: num(d.gpu) }));

    // Memory header: GB used + hover-tip with oMLX/Other breakdown.
    // In-place DOM update (don't replace innerHTML) so :hover state survives.
    const omlx  = typeof d.omlx_gb === 'number' ? d.omlx_gb : 0;
    const other = typeof d.mac_other_gb === 'number' ? d.mac_other_gb : 0;
    const gbText = num(d.ram_used_gb, 1) + ' / ' + num(d.ram_total_gb, 0) + ' GB';
    const tip = omlx > 0
      ? t('mem_breakdown_tip', { omlx: num(omlx, 1), other: num(other, 1) })
      : '';
    const nowEl = document.getElementById('orm-mgraph-now');
    if (nowEl) {
      let hint = nowEl.firstElementChild;
      if (!hint || !hint.classList.contains('mm-ram-hint')) {
        nowEl.textContent = '';
        hint = document.createElement('span');
        hint.className = 'mm-ram-hint';
        nowEl.appendChild(hint);
      }
      hint.textContent = gbText;
      if (tip) {
        hint.setAttribute('data-tip', tip);
        hint.classList.add('mm-show-tip');
      } else {
        hint.removeAttribute('data-tip');
        hint.classList.remove('mm-show-tip');
      }
    }

    setText('orm-pgraph-now', t('pressure_header', {
      label: bandLabel,
      swap: num(d.swap || 0, 2),
      comp: num(d.comp || 0, 2),
    }));

    const age = Date.now() - d.t;
    const stale = age > STALE_MS;
    const dot = document.getElementById('orm-chip-dot');
    if (dot) dot.style.background = stale ? '#9ca3af' : band.color;
    setText('orm-chip-text',
      stale ? t('chip_stale')
        : age < 6000 ? t('chip_fresh')
        : t('chip_seconds_ago', { n: Math.round(age / 1000) }));
    setText('orm-status', stale ? t('status_stale') : '');
  }

  // ─── Activity strip (PP/TG badges, one per loaded model) ──────────────────
  function actBadge(color, name, meta, pulse) {
    return `<span class="mm-act">` +
      `<span class="mm-act-dot${pulse ? ' mm-act-live' : ''}" style="background:${color}"></span>` +
      `<span class="mm-act-name">${esc(name)}</span>` +
      (meta ? `<span class="mm-act-meta">${esc(meta)}</span>` : '') +
      `</span>`;
  }

  function renderActivity(am) {
    const el = document.getElementById('orm-activity');
    if (!el) return;
    const models = am && Array.isArray(am.models) ? am.models : [];
    if (!models.length) {
      el.innerHTML = actBadge(ACT.idle, t('activity_no_models'), '', false);
      return;
    }
    const out = [];
    for (const m of models) {
      // One badge per model; multiple in-flight requests become multiple lines.
      const lines = [];
      if (m.is_loading) {
        const s = m.loading_elapsed_seconds;
        lines.push({
          color: ACT.load, pulse: true,
          meta: s ? t('activity_loading_for', { sec: Math.round(s) }) : t('activity_loading'),
        });
      } else {
        const pf = Array.isArray(m.prefilling) ? m.prefilling : [];
        const gn = Array.isArray(m.generating) ? m.generating : [];
        if (!pf.length && !gn.length) {
          const w = m.waiting_requests || 0;
          lines.push({
            color: ACT.idle, pulse: false,
            meta: w ? t('activity_queued', { n: w }) : t('activity_idle'),
          });
        } else {
          for (const p of pf) {
            const eta = typeof p.eta === 'number' ? t('activity_pp_eta', { dur: fmtDur(p.eta) }) : '';
            lines.push({
              color: ACT.pp, pulse: true,
              meta: t('activity_pp', {
                processed: fmtTok(p.processed),
                total:     fmtTok(p.total),
                elapsed:   fmtDur(p.elapsed),
                speed:     Math.round(p.speed || 0),
                eta,
              }),
            });
          }
          for (const g of gn) {
            lines.push({
              color: ACT.tg, pulse: true,
              meta: t('activity_tg', {
                tps:     (g.tokens_per_second || 0).toFixed(1),
                tok:     fmtTok(g.generated_tokens),
                elapsed: fmtDur(g.elapsed_seconds),
              }),
            });
          }
        }
      }
      out.push(modelBadge(m.id, lines));
    }
    el.innerHTML = out.join('');
  }

  function modelBadge(name, lines) {
    const primary = lines.find((l) => l.pulse) || lines[0];
    if (lines.length === 1) {
      return actBadge(primary.color, name, lines[0].meta, primary.pulse);
    }
    return `<span class="mm-act mm-act-stack">` +
      `<span class="mm-act-dot${primary.pulse ? ' mm-act-live' : ''}" style="background:${primary.color}"></span>` +
      `<span class="mm-act-body">` +
        `<span class="mm-act-name">${esc(name)}</span>` +
        lines.map((l) => `<span class="mm-act-meta">${esc(l.meta)}</span>`).join('') +
      `</span></span>`;
  }

  // ─── Tooltip ──────────────────────────────────────────────────────────────
  function ttRow(color, label, val, sub) {
    return `<div class="mm-tt-row"><i style="background:${color}"></i>` +
           `<span class="mm-tt-label">${esc(label)}</span>` +
           `<span class="mm-tt-val">${esc(val)}</span>` +
           (sub ? `<span class="mm-tt-sub">${esc(sub)}</span>` : '') + `</div>`;
  }

  function buildTooltipHTML(graph, p) {
    let h = `<div class="mm-tt-time">${fmtClock(p.t, true)}</div>`;
    if (graph === 'cpu') {
      h += ttRow(COLORS.cpu, 'CPU', num(p.cpu) + '%',
                 num(p.cpu_temp, 0) + '℃ · P' + num(p.pcpu, 0) + ' E' + num(p.ecpu, 0));
      h += ttRow(COLORS.gpu, 'GPU', num(p.gpu) + '%',
                 num(p.gpu_temp, 0) + '℃ · ' + num(p.gpu_mhz, 0) + 'MHz');
    } else if (graph === 'mem') {
      if (typeof p.model_gb !== 'number') {
        h += `<div class="mm-tt-row"><span class="mm-tt-label">${esc(t('tt_breakdown'))}</span><span class="mm-tt-val">${esc(t('tt_no_data'))}</span></div>`;
      } else {
        let total = 0;
        for (const L of MEM_LAYERS) {
          const v = typeof p[L.key] === 'number' ? p[L.key] : 0;
          total += v;
          h += ttRow(L.color, t(L.labelKey), num(v, 1) + 'GB', '');
        }
        h += ttRow('transparent', t('tt_total'), num(total, 1) + 'GB', '');
      }
    } else if (graph === 'pressure') {
      const lvl = p.pressure || 1;
      const band = PRESSURE[lvl] || PRESSURE[1];
      const fp = freeOf(p);
      h += ttRow(band.color, t('tt_pressure_label'), t(band.key),
                 t('tt_pressure_sub', { lvl, free: Math.round(fp) }));
      h += ttRow(COLORS.swap, t('tt_swap'), num(p.swap || 0, 2) + ' GB', '');
      h += ttRow(COLORS.comp, t('tt_comp'), num(p.comp || 0, 2) + ' GB', '');
    }
    return h;
  }

  function showTooltip(graph, cx, cy) {
    const tip = document.getElementById('orm-tooltip');
    if (!tip || hoverT == null) return;
    const p = nearestPoint(hoverT);
    if (!p) return;
    tip.innerHTML = buildTooltipHTML(graph, p);
    tip.style.display = 'block';
    let x = cx + 16, y = cy + 16;
    if (x + tip.offsetWidth  > window.innerWidth - 8)  x = cx - tip.offsetWidth - 16;
    if (y + tip.offsetHeight > window.innerHeight - 8) y = cy - tip.offsetHeight - 16;
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top  = Math.max(8, y) + 'px';
  }

  function hideTooltip() {
    const tip = document.getElementById('orm-tooltip');
    if (tip) tip.style.display = 'none';
  }

  // ─── Canvas rendering ─────────────────────────────────────────────────────
  function setupCanvas(cvs) {
    const dpr = window.devicePixelRatio || 1;
    const w = cvs.clientWidth, h = cvs.clientHeight;
    cvs.width = w * dpr;
    cvs.height = h * dpr;
    const ctx = cvs.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function timeBounds() {
    const last = latest();
    const liveT = last ? last.t : Date.now();
    const tEnd = panAnchorT != null ? panAnchorT : liveT;
    return { t0: tEnd - windowS * 1000, tEnd, range: windowS * 1000 };
  }

  function drawTimeAxis(ctx, w, h, plotH, t0, tEnd) {
    const N = 5;
    const withSec = windowS <= 300;
    const labelColor = isDark() ? 'rgba(160,160,160,0.95)' : 'rgba(110,110,110,0.95)';
    const gridColor  = isDark() ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 1;
    for (let i = 0; i < N; i++) {
      const frac = i / (N - 1);
      const x = frac * w;
      const ts = t0 + (tEnd - t0) * frac;
      ctx.strokeStyle = gridColor;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, plotH);
      ctx.stroke();
      ctx.fillStyle = labelColor;
      ctx.textAlign = i === 0 ? 'left' : i === N - 1 ? 'right' : 'center';
      ctx.fillText(fmtClock(ts, withSec), x, h - 5);
    }
  }

  function drawCursor(ctx, w, plotH, t0, range) {
    if (hoverT == null) return;
    const x = ((hoverT - t0) / range) * w;
    if (x < 0 || x > w) return;
    ctx.save();
    ctx.strokeStyle = isDark() ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, plotH);
    ctx.stroke();
    ctx.restore();
  }

  function redraw() {
    // Hover is screen-anchored: recompute hoverT each redraw so the cursor
    // stays under the mouse pointer even as the graph scrolls in live mode.
    if (hoverFrac != null) {
      const { t0, range } = timeBounds();
      hoverT = t0 + hoverFrac * range;
    }
    drawCpuGpu();
    drawMemoryStack();
    drawPressureGraph();
    if (hoverFrac != null && hoverScreenXY && hoverGraph) {
      showTooltip(hoverGraph, hoverScreenXY.x, hoverScreenXY.y);
    }
  }

  // Graph 1 — CPU / GPU lines (0–100 % axis)
  function drawCpuGpu() {
    const cvs = document.getElementById('orm-canvas');
    if (!cvs || history.length < 2) return;
    const { ctx, w, h } = setupCanvas(cvs);
    const plotH = h - AXIS_H;
    const { t0, tEnd, range } = timeBounds();
    drawTimeAxis(ctx, w, h, plotH, t0, tEnd);
    const xOf = (ts) => ((ts - t0) / range) * w;
    for (const key of ['cpu', 'gpu']) {
      ctx.strokeStyle = COLORS[key];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (const p of history) {
        const v = typeof p[key] === 'number' ? p[key] : 0;
        const x = xOf(p.t);
        const y = plotH - (Math.min(Math.max(v, 0), 100) / 100) * plotH;
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    drawCursor(ctx, w, plotH, t0, range);
  }

  // Graph 2 — Memory: 4-layer stacked area (GB axis, normalized to total RAM)
  function drawMemoryStack() {
    const cvs = document.getElementById('orm-mcanvas');
    if (!cvs || history.length < 2) return;
    const { ctx, w, h } = setupCanvas(cvs);
    const axisTop = h - AXIS_H;
    const plotH = axisTop - 4;
    const { t0, tEnd, range } = timeBounds();
    drawTimeAxis(ctx, w, h, axisTop, t0, tEnd);
    const xOf = (ts) => ((ts - t0) / range) * w;

    const mem = history.filter((p) => typeof p.model_gb === 'number');
    if (mem.length >= 2) {
      const totalGb = (latest() && latest().ram_total_gb) || 64;
      const yOf = (gb) => axisTop - Math.min(gb / totalGb, 1) * plotH;
      const lval = (p, key) => (typeof p[key] === 'number' ? p[key] : 0);
      const below = (p, li) => {
        let s = 0;
        for (let j = 0; j < li; j++) s += lval(p, MEM_LAYERS[j].key);
        return s;
      };
      for (let li = 0; li < MEM_LAYERS.length; li++) {
        const { key, color } = MEM_LAYERS[li];
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.95;
        ctx.beginPath();
        for (let i = 0; i < mem.length; i++) {
          const p = mem[i];
          const x = xOf(p.t), y = yOf(below(p, li) + lval(p, key));
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        for (let i = mem.length - 1; i >= 0; i--) {
          ctx.lineTo(xOf(mem[i].t), yOf(below(mem[i], li)));
        }
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    drawCursor(ctx, w, axisTop, t0, range);
  }

  // Graph 3 — Pressure + swap + compressor (vertical split canvas)
  //   Top ~55 % : pressure fill + line (band color)
  //   Bottom ~40 % : swap + comp lines (GB axis, auto-fit)
  //   Both regions share the same time axis with a subtle divider line.
  function drawPressureGraph() {
    const cvs = document.getElementById('orm-pcanvas');
    if (!cvs || history.length < 2) return;
    const { ctx, w, h } = setupCanvas(cvs);
    const axisTop = h - AXIS_H;
    const fullH = axisTop - 4;
    const pBotY = 4 + Math.round(fullH * 0.55);   // pressure region bottom = divider position
    const pH    = pBotY - 4;
    const gap   = 6;
    const gbTopY = pBotY + gap;
    const gbH    = axisTop - gbTopY;
    const { t0, tEnd, range } = timeBounds();
    drawTimeAxis(ctx, w, h, axisTop, t0, tEnd);

    const xOf = (ts) => ((ts - t0) / range) * w;
    const lvlOf = (p) => p.pressure || 1;
    const bandOfLvl = (lvl) => PRESSURE[lvl] || PRESSURE[1];

    // ── Pressure (top region) ────────────────────────────────────────────────
    const pY = (p) => pBotY - pressureFrac(freeOf(p)) * pH;
    // Filled area below line — band-tinted.
    for (let i = 0; i < history.length - 1; i++) {
      const a = history[i], b = history[i + 1];
      ctx.fillStyle = bandOfLvl(lvlOf(a)).color;
      ctx.globalAlpha = 0.28;
      ctx.beginPath();
      ctx.moveTo(xOf(a.t), pBotY);
      ctx.lineTo(xOf(a.t), pY(a));
      ctx.lineTo(xOf(b.t), pY(b));
      ctx.lineTo(xOf(b.t), pBotY);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Band-colored line on top
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = 2;
    for (let i = 0; i < history.length - 1; i++) {
      const a = history[i], b = history[i + 1];
      ctx.strokeStyle = bandOfLvl(lvlOf(a)).color;
      ctx.beginPath();
      ctx.moveTo(xOf(a.t), pY(a));
      ctx.lineTo(xOf(b.t), pY(b));
      ctx.stroke();
    }

    // ── Divider between regions ──────────────────────────────────────────────
    ctx.strokeStyle = isDark() ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(pBotY) + 0.5);
    ctx.lineTo(w, Math.round(pBotY) + 0.5);
    ctx.stroke();

    // ── Swap + Comp (bottom region, auto-fit GB axis) ────────────────────────
    let maxGb = 2;
    for (const p of history) {
      if (typeof p.swap === 'number') maxGb = Math.max(maxGb, p.swap);
      if (typeof p.comp === 'number') maxGb = Math.max(maxGb, p.comp);
    }
    maxGb = Math.ceil(maxGb * 1.1);
    const yOfGb = (gb) => axisTop - Math.min(gb / maxGb, 1) * gbH;

    function drawLine(key, color) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (const p of history) {
        const v = typeof p[key] === 'number' ? p[key] : 0;
        const x = xOf(p.t), y = yOfGb(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    drawLine('swap', COLORS.swap);
    drawLine('comp', COLORS.comp);
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'butt';

    drawCursor(ctx, w, axisTop, t0, range);
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  async function boot() {
    await initLang();
    localizeChrome();
    if (mountIfReady()) return;
    const obs = new MutationObserver(() => {
      if (mountIfReady()) obs.disconnect();
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 15000);
  }

  function mountIfReady() {
    const target = findAnchor();
    if (target) { mountInto(target); return true; }
    return false;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
