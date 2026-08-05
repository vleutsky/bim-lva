/**
 * Замер отклика на клик по модели — сколько миллисекунд занимает обработчик
 * целиком: raycast, выделение, перерисовка панели свойств и дерева.
 *
 * Внимание при чтении результата: на моделях до сотни тысяч треугольников
 * время здесь определяет не raycast, а отрисовка панели. Ускорение самого
 * поиска пересечений этой цифрой не измеряется.
 *
 * Меряет внутри страницы, а не round-trip до playwright — иначе шум
 * транспорта съедает разницу.
 *
 * Запуск:  node tools/bench-pick.mjs [число_элементов]
 * Сравнение до/после: прогнать на двух коммитах, модель детерминирована.
 */
import { chromium } from 'playwright';
import { makeGridIfc } from './fixtures/make-grid-ifc.mjs';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startStaticServer } from './static-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COUNT = Number(process.argv[2]) || 6000;
const CLICKS = 40;

async function resolveChromium() {
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (!base) return undefined;
    for (const dir of (await fs.readdir(base).catch(() => []))
        .filter((d) => d.startsWith('chromium-')).sort().reverse()) {
        const bin = path.join(base, dir, 'chrome-linux', 'chrome');
        if (await fs.access(bin).then(() => true, () => false)) return bin;
    }
    return undefined;
}

const { server, port } = await startStaticServer(ROOT);
const browser = await chromium.launch({
    executablePath: await resolveChromium(),
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader']
});
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/bim-lva-composer-ifc.html`, { waitUntil: 'load' });
await page.waitForFunction(() => !!document.querySelector('#stage canvas'), { timeout: 60_000 });

const fixture = path.join(ROOT, 'tools', 'fixtures', '_bench.ifc');
await fs.writeFile(fixture, makeGridIfc(COUNT, Math.ceil(Math.sqrt(COUNT)), 3));
await page.setInputFiles('#localFileInput', fixture);
await page.waitForFunction(() => document.querySelectorAll('#tree .tlabel').length > 1, { timeout: 180_000 });
await page.waitForTimeout(2000);

const result = await page.evaluate(async (clicks) => {
    const canvas = document.querySelector('#stage canvas');
    const r = canvas.getBoundingClientRect();
    const fire = (x, y) => canvas.dispatchEvent(
        new MouseEvent('click', { clientX: x, clientY: y, bubbles: true, cancelable: true })
    );
    // Прогрев: первый клик по мешу строит дерево, его в замер включать нечестно.
    fire(r.left + r.width / 2, r.top + r.height / 2);
    await new Promise((res) => setTimeout(res, 800));

    const times = [];
    for (let i = 0; i < clicks; i++) {
        const x = r.left + r.width * (0.35 + 0.3 * ((i % 7) / 6));
        const y = r.top + r.height * (0.35 + 0.3 * ((Math.floor(i / 7) % 7) / 6));
        const t0 = performance.now();
        fire(x, y);
        times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return {
        median: times[times.length >> 1],
        p90: times[Math.floor(times.length * 0.9)],
        max: times[times.length - 1],
        meshes: window.BimLvaDebug?.meshCount ?? -1,
        bvh: window.BimLvaDebug?.bvhCount ?? -1
    };
}, CLICKS);

await fs.rm(fixture, { force: true });
await browser.close();
server.close();

console.log(`элементов: ${COUNT}, мешей: ${result.meshes}, с BVH: ${result.bvh}`);
console.log(`клик: медиана ${result.median.toFixed(2)} мс · p90 ${result.p90.toFixed(2)} мс · максимум ${result.max.toFixed(2)} мс`);
