/**
 * Статика репозитория по HTTP.
 *
 * Открыть вьювер из проводника нельзя: ES-модули, importmap и wasm по file://
 * не работают. Свой сервер, а не первый попавшийся из npm, нужен ради
 * Content-Type для .wasm — без application/wasm web-ifc не инициализируется.
 */
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.ifc': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8'
};

/**
 * Поднимает сервер на `port` (0 — любой свободный).
 * @returns {Promise<{server: import('node:http').Server, port: number}>}
 */
export function startStaticServer(root, port = 0) {
    const server = createServer(async (req, res) => {
        const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
        const file = path.join(root, rel || 'index.html');
        // Никаких выходов за корень репозитория.
        if (!file.startsWith(root)) {
            res.writeHead(403).end('forbidden');
            return;
        }
        try {
            const body = await fs.readFile(file);
            res.writeHead(200, {
                'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
                // Иначе правка не видна до Ctrl+F5.
                'Cache-Control': 'no-store'
            });
            res.end(body);
        } catch {
            res.writeHead(404).end('not found');
        }
    });
    return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}
