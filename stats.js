/**
 * BIM.LVA — лёгкая статистика посещений и использования.
 *
 * CounterAPI: 5 агрегатных счётчиков (лимит free).
 * Детали событий — в Яндекс.Метрике (если задан ID) и в локальном журнале для stats.html.
 * Не передаём имена файлов, содержимое моделей и персональные данные.
 */
(function (global) {
  'use strict';

  // Номер счётчика из https://metrika.yandex.ru/ (0 = выкл.)
  const YANDEX_METRIKA_ID = 0;

  const COUNTER_API = 'https://api.counterapi.dev/v1';
  const NAMESPACE = 'bimlva';
  const EVENT_LOG_KEY = 'bimlva_stats_event_log_v1';
  const EVENT_LOG_MAX = 200;
  const SESSION_STARTED_KEY = 'bimlva_stats_session_started_v1';

  const BUCKETS = {
    site: 'page_site',
    composer: 'page_composer',
    load: 'event_load',
    feature: 'event_feature',
    lead: 'event_lead'
  };

  const SESSION_PREFIX = 'bimlva_stats_once_';
  let metrikaReady = false;

  function safeSessionGet(key) {
    try { return sessionStorage.getItem(key); } catch (_) { return null; }
  }
  function safeSessionSet(key, value) {
    try { sessionStorage.setItem(key, value); } catch (_) {}
  }
  function safeLocalGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function safeLocalSet(key, value) {
    try { localStorage.setItem(key, value); } catch (_) {}
  }

  function bump(counterName) {
    const url = `${COUNTER_API}/${NAMESPACE}/${encodeURIComponent(counterName)}/up`;
    try {
      if (typeof fetch === 'function') {
        fetch(url, { method: 'GET', mode: 'cors', keepalive: true, cache: 'no-store' }).catch(() => {});
        return;
      }
    } catch (_) {}
    try {
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.src = url + (url.includes('?') ? '&' : '?') + '_=' + Date.now();
    } catch (_) {}
  }

  function oncePerSession(key, counterName) {
    const sk = SESSION_PREFIX + key;
    if (safeSessionGet(sk)) return false;
    safeSessionSet(sk, '1');
    bump(counterName);
    return true;
  }

  function ensureMetrika() {
    if (!YANDEX_METRIKA_ID || metrikaReady) return;
    metrikaReady = true;
    global[`yaCounter${YANDEX_METRIKA_ID}`] = null;
    (function (m, e, t, r, i, k, a) {
      m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
      m[i].l = 1 * new Date();
      for (var j = 0; j < document.scripts.length; j++) {
        if (document.scripts[j].src === r) return;
      }
      k = e.createElement(t); a = e.getElementsByTagName(t)[0];
      k.async = 1; k.src = r; a.parentNode.insertBefore(k, a);
    })(global, document, 'script', 'https://mc.yandex.ru/metrika/tag.js', 'ym');

    global.ym(YANDEX_METRIKA_ID, 'init', {
      clickmap: true,
      trackLinks: true,
      accurateTrackBounce: true,
      webvisor: false
    });
  }

  function metrikaGoal(name, params) {
    if (!YANDEX_METRIKA_ID) return;
    ensureMetrika();
    try {
      if (typeof global.ym === 'function') {
        global.ym(YANDEX_METRIKA_ID, 'reachGoal', name, params || {});
      }
    } catch (_) {}
  }

  function metrikaHit(url) {
    if (!YANDEX_METRIKA_ID) return;
    ensureMetrika();
    try {
      if (typeof global.ym === 'function') {
        global.ym(YANDEX_METRIKA_ID, 'hit', url || location.href);
      }
    } catch (_) {}
  }

  function sanitizeProps(props) {
    const safe = {};
    if (!props || typeof props !== 'object') return safe;
    Object.keys(props).forEach((k) => {
      const v = props[k];
      if (v == null) return;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        // не копим длинные имена файлов / пути
        if (typeof v === 'string' && v.length > 80) safe[k] = v.slice(0, 77) + '…';
        else safe[k] = v;
      }
    });
    return safe;
  }

  function pushEventLog(name, props) {
    try {
      const raw = safeLocalGet(EVENT_LOG_KEY);
      const list = raw ? JSON.parse(raw) : [];
      const arr = Array.isArray(list) ? list : [];
      arr.unshift({
        t: Date.now(),
        e: name,
        p: props || {}
      });
      safeLocalSet(EVENT_LOG_KEY, JSON.stringify(arr.slice(0, EVENT_LOG_MAX)));
    } catch (_) {}
  }

  function getRecentEvents(limit) {
    try {
      const raw = safeLocalGet(EVENT_LOG_KEY);
      const list = raw ? JSON.parse(raw) : [];
      const arr = Array.isArray(list) ? list : [];
      return arr.slice(0, Math.max(1, Number(limit) || 40));
    } catch (_) {
      return [];
    }
  }

  function clearRecentEvents() {
    try { localStorage.removeItem(EVENT_LOG_KEY); } catch (_) {}
  }

  function getLocalSummary(limit) {
    const events = getRecentEvents(limit || EVENT_LOG_MAX);
    const byName = {};
    let loadsOk = 0;
    let loadsFail = 0;
    let loadsAttempt = 0;
    let yandexOk = 0;
    let yandexFail = 0;
    let pages = 0;
    let features = 0;
    let lastAt = null;
    events.forEach((r) => {
      const name = String(r?.e || 'unknown');
      byName[name] = (byName[name] || 0) + 1;
      if (r?.t && (lastAt == null || r.t > lastAt)) lastAt = r.t;
      if (name === 'model_load') loadsOk += 1;
      if (name === 'load_failed' || name === 'load_georaster_failed' || name === 'yandex_load_failed') loadsFail += 1;
      if (name === 'load_attempt' || name === 'yandex_load_attempt') loadsAttempt += 1;
      if (name === 'yandex_load_ok' || name === 'yandex_browse_success') yandexOk += 1;
      if (name === 'yandex_load_failed' || name === 'yandex_browse_failed') yandexFail += 1;
      if (name.startsWith('page_')) pages += 1;
      else if (resolveBucket(name) === BUCKETS.feature) features += 1;
    });
    const top = Object.entries(byName)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 20)
      .map(([name, count]) => ({ name, count }));
    const loadDenom = loadsOk + loadsFail;
    return {
      total: events.length,
      byName,
      top,
      loadsOk,
      loadsFail,
      loadsAttempt,
      loadSuccessPct: loadDenom > 0 ? Math.round((loadsOk / loadDenom) * 1000) / 10 : null,
      yandexOk,
      yandexFail,
      pages,
      features,
      lastAt,
      sessionStartedAt: Number(safeSessionGet(SESSION_STARTED_KEY) || 0) || null
    };
  }

  function markSessionStart() {
    if (!safeSessionGet(SESSION_STARTED_KEY)) {
      safeSessionSet(SESSION_STARTED_KEY, String(Date.now()));
      pushEventLog('session_start', {
        path: String(location.pathname || '').slice(-60)
      });
    }
  }

  function flushSessionDuration() {
    const started = Number(safeSessionGet(SESSION_STARTED_KEY) || 0);
    if (!started) return;
    const sec = Math.max(1, Math.round((Date.now() - started) / 1000));
    pushEventLog('session_ping', { sec });
  }

  function resolveBucket(name) {
    if (
      name === 'model_load' ||
      name.startsWith('load_') ||
      name.startsWith('yandex_load') ||
      name === 'yandex_browse_success' ||
      name === 'yandex_browse_failed'
    ) {
      return BUCKETS.load;
    }
    if (
      name === 'lead_request' ||
      name === 'download_click' ||
      name === 'lead_open'
    ) {
      return BUCKETS.lead;
    }
    return BUCKETS.feature;
  }

  /**
   * @param {'site'|'composer'|'case'|'plugin_ksi'|string} page
   */
  function trackPage(page) {
    markSessionStart();
    const p = String(page || 'site');
    if (p === 'composer') {
      oncePerSession('page_composer', BUCKETS.composer);
    } else {
      oncePerSession('page_site', BUCKETS.site);
    }
    metrikaHit(location.pathname + location.search + '#' + p);
    pushEventLog('page_' + p, {});
  }

  /**
   * @param {string} event
   * @param {Record<string, string|number|boolean>=} props
   */
  function track(event, props) {
    markSessionStart();
    const name = String(event || 'unknown');
    const bucket = resolveBucket(name);
    const safe = sanitizeProps(props);

    // Загрузки / ошибки загрузок / лиды — каждый раз; остальное — раз за сессию на имя+ключ
    const always =
      bucket === BUCKETS.load ||
      bucket === BUCKETS.lead ||
      name.endsWith('_failed') ||
      name.endsWith('_attempt');

    if (always) {
      bump(bucket);
    } else {
      const onceKey = 'ev_' + name + (safe.source ? '_' + safe.source : '') + (safe.mode ? '_' + safe.mode : '');
      oncePerSession(onceKey, bucket);
    }

    pushEventLog(name, safe);
    metrikaGoal(name, safe);
  }

  async function getCount(counterName) {
    const url = `${COUNTER_API}/${NAMESPACE}/${encodeURIComponent(counterName)}/`;
    const res = await fetch(url, { method: 'GET', mode: 'cors', cache: 'no-store', redirect: 'follow' });
    if (!res.ok) throw new Error('counter ' + counterName + ' HTTP ' + res.status);
    const data = await res.json();
    return Number(data.count) || 0;
  }

  async function getAllCounts() {
    const entries = await Promise.all(
      Object.entries(BUCKETS).map(async ([key, name]) => {
        try {
          return [key, await getCount(name)];
        } catch (_) {
          return [key, null];
        }
      })
    );
    const out = {};
    entries.forEach(([k, v]) => { out[k] = v; });
    return out;
  }

  function getDerived(counts) {
    const site = Number(counts?.site) || 0;
    const composer = Number(counts?.composer) || 0;
    const load = Number(counts?.load) || 0;
    const feature = Number(counts?.feature) || 0;
    const lead = Number(counts?.lead) || 0;
    const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
    return {
      siteToComposer: pct(composer, site),
      composerToLoad: pct(load, composer),
      siteToLead: pct(lead, site),
      featuresPerComposer: composer > 0 ? Math.round((feature / composer) * 100) / 100 : null
    };
  }

  if (YANDEX_METRIKA_ID) ensureMetrika();

  try {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushSessionDuration();
      });
      if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', flushSessionDuration);
      }
    }
  } catch (_) {}

  global.BimLvaStats = {
    trackPage,
    track,
    getCount,
    getAllCounts,
    getDerived,
    getRecentEvents,
    getLocalSummary,
    clearRecentEvents,
    BUCKETS,
    NAMESPACE,
    YANDEX_METRIKA_ID
  };
})(typeof window !== 'undefined' ? window : globalThis);
