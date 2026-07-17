/**
 * BIM.LVA — лёгкая статистика посещений и использования.
 *
 * По умолчанию пишет в CounterAPI (без регистрации) — смотрите stats.html.
 * Опционально: укажите YANDEX_METRIKA_ID, чтобы видеть графики в Яндекс.Метрике.
 *
 * Не передаём имена файлов, содержимое моделей и персональные данные.
 */
(function (global) {
  'use strict';

  // --- конфиг ---
  // Номер счётчика из https://metrika.yandex.ru/ (0 = выкл.)
  const YANDEX_METRIKA_ID = 0;

  const COUNTER_API = 'https://api.counterapi.dev/v1';
  const NAMESPACE = 'bimlva';

  // Ровно 5 публичных счётчиков (лимит free CounterAPI)
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

  /**
   * @param {'site'|'composer'|'case'|'plugin_ksi'|string} page
   */
  function trackPage(page) {
    const p = String(page || 'site');
    if (p === 'composer') {
      oncePerSession('page_composer', BUCKETS.composer);
    } else {
      oncePerSession('page_site', BUCKETS.site);
    }
    metrikaHit(location.pathname + location.search + '#' + p);
  }

  /**
   * @param {string} event
   * @param {Record<string, string|number|boolean>=} props
   */
  function track(event, props) {
    const name = String(event || 'unknown');
    const bucket =
      name === 'model_load' || name.startsWith('load_') ? BUCKETS.load :
      name === 'lead_request' || name === 'download_click' || name === 'lead_open' ? BUCKETS.lead :
      name === 'composer_cta' ? BUCKETS.feature :
      BUCKETS.feature;

    // Модели и лиды считаем каждый раз; остальное — не чаще раза за сессию на имя события
    if (bucket === BUCKETS.load || bucket === BUCKETS.lead) {
      bump(bucket);
    } else {
      oncePerSession('ev_' + name, bucket);
    }

    const safe = {};
    if (props && typeof props === 'object') {
      Object.keys(props).forEach((k) => {
        const v = props[k];
        if (v == null) return;
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          safe[k] = v;
        }
      });
    }
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

  if (YANDEX_METRIKA_ID) ensureMetrika();

  global.BimLvaStats = {
    trackPage,
    track,
    getCount,
    getAllCounts,
    BUCKETS,
    NAMESPACE,
    YANDEX_METRIKA_ID
  };
})(typeof window !== 'undefined' ? window : globalThis);
