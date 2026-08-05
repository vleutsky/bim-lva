/**
 * Дымовой тест вьювера: поднимает статику, открывает Composer в Chromium и
 * падает, если в консоли есть ошибка, запрос не отдался или сцена не собралась.
 *
 * Нужен потому, что весь вьювер — один файл на 17k строк без сборки и тестов:
 * опечатка в импорте или битый путь к вендору ловятся только глазами.
 *
 * Запуск: npm run smoke
 */
import { chromium } from 'playwright';
import { makeGridIfc } from './fixtures/make-grid-ifc.mjs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = process.env.SMOKE_PAGE || 'bim-lva-composer-ifc.html';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.woff2': 'font/woff2',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

function startServer() {
    const server = createServer(async (req, res) => {
        const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
        const file = path.join(ROOT, rel || 'index.html');
        // Никаких выходов за корень репозитория.
        if (!file.startsWith(ROOT)) {
            res.writeHead(403).end('forbidden');
            return;
        }
        try {
            const body = await fs.readFile(file);
            res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
            res.end(body);
        } catch {
            res.writeHead(404).end('not found');
        }
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

/** Внешние сервисы (Яндекс.Диск, Supabase) в дымовом тесте не участвуют. */
function isLocal(url, port) {
    return url.startsWith(`http://127.0.0.1:${port}/`);
}

const problems = [];

/**
 * Готовый Chromium окружения (PLAYWRIGHT_BROWSERS_PATH) может не совпадать по
 * ревизии с версией playwright из package.json — тогда берём бинарь напрямую.
 */
async function resolveChromium() {
    const explicit = process.env.SMOKE_CHROMIUM;
    if (explicit) return explicit;
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (!base) return undefined;
    const entries = await fs.readdir(base).catch(() => []);
    for (const dir of entries.filter((d) => d.startsWith('chromium-')).sort().reverse()) {
        const bin = path.join(base, dir, 'chrome-linux', 'chrome');
        if (await fs.access(bin).then(() => true, () => false)) return bin;
    }
    return undefined;
}

/**
 * Кликает по геометрии и проверяет, что элемент выбрался. Это главная
 * регрессия при переходе на BVH: выделение батча читает expressId по
 * `hit.face.a`, а дерево переупорядочивает индексный буфер.
 * Точку ищем от центра холста по расходящейся сетке — где именно в кадре
 * окажется геометрия после fitView, тест знать не должен.
 */
async function checkPicking(page) {
    const box = await page.locator('#stage canvas').boundingBox();
    if (!box) {
        problems.push('не найден холст для клика');
        return null;
    }
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const offsets = [0, 0.08, -0.08, 0.16, -0.16];

    for (const dx of offsets) {
        for (const dy of offsets) {
            await page.mouse.click(cx + dx * box.width, cy + dy * box.height);
            // Панель свойств перерисовывается не в обработчике клика — ждём её.
            const hit = await page
                .waitForFunction(
                    () => {
                        const t = document.querySelector('#props')?.textContent || '';
                        return /ExpressID/i.test(t) ? t : false;
                    },
                    { timeout: 2000 }
                )
                .then((h) => h.jsonValue())
                .catch(() => null);
            if (hit) {
                const id = /ExpressID\s*(\d+)/i.exec(hit)?.[1] || '?';
                return { ok: true, label: `ExpressID ${id}` };
            }
        }
    }
    problems.push('клик по геометрии не выделил ни одного элемента');
    return { ok: false };
}

async function main() {
    const { server, port } = await startServer();
    const browser = await chromium.launch({
        executablePath: await resolveChromium(),
        args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader']
    });
    const page = await browser.newPage();

    const external = [];
    // «Failed to load resource» в консоли не несёт URL — адрес берём из события
    // запроса, иначе диагностировать битый путь невозможно.
    const RESOURCE_NOISE = /Failed to load resource/i;

    page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        if (RESOURCE_NOISE.test(msg.text())) return; // учтено в requestfailed/response
        problems.push(`console.error: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    page.on('requestfailed', (req) => {
        const line = `${req.url()} — ${req.failure()?.errorText}`;
        (isLocal(req.url(), port) ? problems : external).push(`запрос не удался: ${line}`);
    });
    page.on('response', (res) => {
        if (res.status() < 400) return;
        const line = `HTTP ${res.status()}: ${res.url()}`;
        (isLocal(res.url(), port) ? problems : external).push(line);
    });

    const url = `http://127.0.0.1:${port}/${PAGE}`;
    await page.goto(url, { waitUntil: 'load', timeout: 60_000 });

    // Модуль инициализируется асинхронно (wasm web-ifc), даём ему время.
    await page.waitForFunction(() => !!document.querySelector('#stage canvas'), { timeout: 60_000 })
        .catch(() => problems.push('canvas не появился в #stage — сцена three.js не собралась'));

    // Загружаем настоящий IFC: это единственный способ проверить, что wasm
    // web-ifc отдаётся с локального пути и геометрия действительно строится.
    // Модель — сетка коробок: на одной коробке (12 треугольников) BVH не
    // строится по порогу, и путь пикинга через дерево остался бы непроверенным.
    let ifcLoaded = null;
    let pick = null;
    if (PAGE === 'bim-lva-composer-ifc.html') {
        const fixture = path.join(ROOT, 'tools', 'fixtures', 'smoke-grid.ifc');
        await fs.writeFile(fixture, makeGridIfc(2100, 50, 3));
        try {
            await page.setInputFiles('#localFileInput', fixture);
            ifcLoaded = await page
                .waitForFunction(
                    () => document.querySelectorAll('#tree [data-file-root]').length > 0 &&
                        document.querySelectorAll('#tree .tlabel').length > 1,
                    { timeout: 90_000 }
                )
                .then(() => true)
                .catch(() => false);
            if (!ifcLoaded) problems.push('IFC не загрузился: дерево модели осталось пустым');
            else pick = await checkPicking(page);
        } finally {
            await fs.rm(fixture, { force: true });
        }
    }

    const state = await page.evaluate(() => ({
        canvas: !!document.querySelector('#stage canvas'),
        fps: document.getElementById('fps')?.textContent || '',
        fontFamily: getComputedStyle(document.body).fontFamily,
        treeItems: document.querySelectorAll('#tree .tlabel').length,
        meshCount: window.BimLvaDebug?.meshCount ?? -1,
        bvhCount: window.BimLvaDebug?.bvhCount ?? -1
    }));

    if (state.bvhCount === 0) {
        problems.push('BVH не построен ни на одном меше — пикинг остался линейным перебором');
    }

    if (process.env.SMOKE_SHOT) {
        await page.screenshot({ path: process.env.SMOKE_SHOT, fullPage: false });
        console.log(`скриншот:  ${process.env.SMOKE_SHOT}`);
    }

    await browser.close();
    server.close();

    console.log(`Страница:  ${PAGE}`);
    console.log(`canvas:    ${state.canvas ? 'есть' : 'НЕТ'}`);
    console.log(`FPS-метка: ${state.fps || '—'}`);
    console.log(`шрифт:     ${state.fontFamily}`);
    if (ifcLoaded !== null) console.log(`IFC:       ${ifcLoaded ? `загружен, узлов дерева ${state.treeItems}` : 'НЕ загрузился'}`);
    if (state.meshCount >= 0) console.log(`мешей:     ${state.meshCount}, с BVH: ${state.bvhCount}`);
    if (pick) console.log(`пикинг:    ${pick.ok ? `элемент выбран (${pick.label})` : 'НЕ РАБОТАЕТ'}`);

    if (external.length) {
        // Не ошибка теста: сеть наружу (Supabase, Яндекс.Диск) тут недоступна.
        console.log(`\nВнешние запросы, недоступные в тесте (${new Set(external).size}):`);
        for (const e of [...new Set(external)]) console.log(`  · ${e}`);
    }

    if (problems.length) {
        console.error(`\nПроблемы (${new Set(problems).size}):`);
        for (const p of [...new Set(problems)]) console.error(`  · ${p}`);
        process.exit(1);
    }
    console.log('\nOK — ошибок в консоли и битых локальных запросов нет.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
