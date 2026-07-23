/**
 * BIM.LVA local AI client (browser).
 * Talks to ai-bridge on http://127.0.0.1:3847
 */
(function (global) {
  'use strict';

  const DEFAULT_BASE = 'http://127.0.0.1:3847';
  const LS_BASE = 'bimlva_ai_bridge_url';
  const LS_MODEL = 'bimlva_ai_model';

  function getBase() {
    try {
      return (localStorage.getItem(LS_BASE) || DEFAULT_BASE).replace(/\/$/, '');
    } catch (_) {
      return DEFAULT_BASE;
    }
  }

  function setBase(url) {
    try { localStorage.setItem(LS_BASE, String(url || DEFAULT_BASE).replace(/\/$/, '')); } catch (_) {}
  }

  function getModel() {
    try { return localStorage.getItem(LS_MODEL) || ''; } catch (_) { return ''; }
  }

  function setModel(name) {
    try {
      if (name) localStorage.setItem(LS_MODEL, name);
      else localStorage.removeItem(LS_MODEL);
    } catch (_) {}
  }

  async function health() {
    const base = getBase();
    const res = await fetch(`${base}/ai/health`, { method: 'GET' });
    if (!res.ok) throw new Error(`Bridge HTTP ${res.status}`);
    return res.json();
  }

  async function listModels() {
    const base = getBase();
    const res = await fetch(`${base}/ai/models`);
    if (!res.ok) throw new Error(`Bridge HTTP ${res.status}`);
    return res.json();
  }

  async function chat({ message, context, history, model, temperature }) {
    const base = getBase();
    const res = await fetch(`${base}/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        context: context || {},
        history: history || [],
        model: model || getModel() || undefined,
        temperature: temperature ?? 0.2,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Bridge HTTP ${res.status}`);
    return data;
  }

  function isLocalComposerHost() {
    const h = location.hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
  }

  global.BimLvaAI = {
    DEFAULT_BASE,
    getBase,
    setBase,
    getModel,
    setModel,
    health,
    listModels,
    chat,
    isLocalComposerHost,
  };
})(typeof window !== 'undefined' ? window : globalThis);
