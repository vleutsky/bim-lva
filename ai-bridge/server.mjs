#!/usr/bin/env node
/**
 * BIM.LVA local AI bridge
 * - Serves Composer over http://127.0.0.1 (avoids HTTPS→localhost mixed content)
 * - Proxies chat to Ollama on 127.0.0.1:11434
 *
 * Usage:
 *   node ai-bridge/server.mjs
 *   then open http://127.0.0.1:3847/bim-lva-composer-ifc.html
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HOST = process.env.BIMLVA_AI_HOST || '127.0.0.1';
const PORT = Number(process.env.BIMLVA_AI_PORT || 3847);
const OLLAMA = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const DEFAULT_MODEL = process.env.BIMLVA_AI_MODEL || 'llama3.2';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ifc': 'application/octet-stream',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    ...headers,
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function ollamaFetch(pathname, options = {}) {
  const url = `${OLLAMA}${pathname}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  if (!res.ok) {
    const msg = json?.error || text || res.statusText;
    const err = new Error(`Ollama: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json ?? text;
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent((urlPath || '/').split('?')[0]);
  const rel = decoded.replace(/^\/+/, '');
  const full = path.resolve(root, rel || 'index.html');
  if (!full.startsWith(root)) return null;
  return full;
}

function systemPrompt() {
  return `Ты — локальный ИИ-ассистент BIM.LVA Composer (IFC/сводка моделей).
Отвечай кратко на русском.
Ты НЕ видишь 3D-mesh. Работай только с JSON-контекстом модели и tool-вызовами.
Если нужно действие в сцене — верни JSON-блок действий.
Формат ответа (строго):
1) Короткий текст для пользователя
2) Затем блок:
\`\`\`json
{"actions":[{"tool":"TOOL_NAME","args":{...}}]}
\`\`\`
Если действий нет: {"actions":[]}

Доступные tools:
- select_by_global_ids: { "globalIds": ["..."] }
- isolate_selection: {}
- show_all: {}
- fit_view: {}
- filter_ifc_class: { "className": "IfcWall" }
- draft_bcf: { "title":"...", "comment":"..." }
- summarize_only: {}  (ничего не делать в UI)

Не выдумывай GlobalId. Бери их только из контекста.`;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      return send(res, 204, '');
    }

    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

    if (url.pathname === '/ai/health') {
      let ollama = null;
      try {
        ollama = await ollamaFetch('/api/tags');
      } catch (err) {
        return send(res, 200, {
          ok: false,
          bridge: true,
          ollama: false,
          error: String(err.message || err),
          hint: 'Запустите Ollama и скачайте модель (см. AI-LOCAL.md)',
        });
      }
      const models = (ollama.models || []).map((m) => m.name);
      return send(res, 200, {
        ok: true,
        bridge: true,
        ollama: true,
        models,
        defaultModel: DEFAULT_MODEL,
      });
    }

    if (url.pathname === '/ai/models' && req.method === 'GET') {
      const tags = await ollamaFetch('/api/tags');
      return send(res, 200, {
        models: (tags.models || []).map((m) => m.name),
        defaultModel: DEFAULT_MODEL,
      });
    }

    if (url.pathname === '/ai/chat' && req.method === 'POST') {
      const body = await readJson(req);
      const model = body.model || DEFAULT_MODEL;
      const userText = String(body.message || '').trim();
      if (!userText) return send(res, 400, { error: 'Пустое сообщение' });

      const context = body.context || {};
      const history = Array.isArray(body.history) ? body.history.slice(-8) : [];

      const chatMessages = [
        { role: 'system', content: systemPrompt() },
        {
          role: 'system',
          content: `Контекст модели (JSON, обрезан при необходимости):\n${JSON.stringify(context).slice(0, 120000)}`,
        },
        ...history,
        { role: 'user', content: userText },
      ];

      const result = await ollamaFetch('/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          model,
          stream: false,
          messages: chatMessages,
          options: {
            temperature: body.temperature ?? 0.2,
          },
        }),
      });

      const content = result?.message?.content || result?.response || '';
      const actions = extractActions(content);
      return send(res, 200, {
        ok: true,
        model,
        message: content,
        actions,
        raw: result,
      });
    }

    // static files from repo root
    if (req.method === 'GET' || req.method === 'HEAD') {
      let filePath = safeJoin(ROOT, url.pathname === '/' ? '/index.html' : url.pathname);
      if (!filePath) return send(res, 403, 'Forbidden');
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return send(res, 404, 'Not found');
      }
      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME[ext] || 'application/octet-stream';
      const buf = fs.readFileSync(filePath);
      return send(res, 200, buf, {
        'Content-Type': mime,
        'Cache-Control': ext === '.html' || ext === '.js' ? 'no-cache' : 'public, max-age=3600',
      });
    }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    send(res, err.status || 500, { error: String(err.message || err) });
  }
});

function extractActions(text) {
  const src = String(text || '');
  const blocks = [];
  const re = /```json\s*([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(src))) blocks.push(m[1]);
  // also try bare JSON object with actions
  if (!blocks.length) {
    const bare = src.match(/\{[\s\S]*"actions"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
    if (bare) blocks.push(bare[0]);
  }
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block);
      if (Array.isArray(parsed?.actions)) return parsed.actions;
    } catch (_) {}
  }
  return [];
}

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('BIM.LVA AI bridge');
  console.log(`  UI:     http://${HOST}:${PORT}/bim-lva-composer-ifc.html`);
  console.log(`  Health: http://${HOST}:${PORT}/ai/health`);
  console.log(`  Ollama: ${OLLAMA}`);
  console.log(`  Model:  ${DEFAULT_MODEL}`);
  console.log('');
  console.log('Держите это окно открытым. Инструкция: AI-LOCAL.md');
});
