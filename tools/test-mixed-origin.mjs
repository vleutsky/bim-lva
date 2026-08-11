/**
 * Сводка «DWG/DXF + IFC»: абсолютные координаты не должны зависеть ни от того,
 * какой файл задал ноль сцены, ни от того, во что попал курсор.
 *
 * Ноль хранится в разных осях в зависимости от источника: IFC отдаёт геометрию
 * Y-up (E, h, −N), внешние форматы — сразу Z-up (E, N, h). Если это не
 * учитывать, координаты «меняются местами» при промахе мимо элемента, а у DWG
 * уезжает север.
 */
import { chromium } from 'playwright';
import { makeGeoIfc } from './fixtures/make-geo-ifc.mjs';
import { makeGeoDxf, geoDxfCentre } from './fixtures/make-geo-dxf.mjs';
import { startStaticServer } from './static-server.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

async function resolveChromium() {
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (!base) return undefined;
    const entries = await fs.readdir(base).catch(() => []);
    for (const dir of entries.filter((d) => d.startsWith('chromium-')).sort().reverse()) {
        const bin = path.join(base, dir, 'chrome-linux', 'chrome');
        if (await fs.access(bin).then(() => true, () => false)) return bin;
    }
    return undefined;
}

const DXF = { worldX: 55300, worldY: 33800, worldZ: 1600, cols: 8, rows: 8, step: 12, size: 8 };
const IFC = { worldX: 55420, worldY: 33700, worldZ: 1556, cols: 10, count: 100, step: 20 };

function ifcCentre(f) {
    const rows = Math.ceil(f.count / f.cols);
    return {
        e: f.worldX + (f.cols - 1) * f.step / 2,
        n: f.worldY + (rows - 1) * f.step / 2,
        h: f.worldZ + 1.5
    };
}

const dxfFile = path.join(ROOT, 'tools', 'fixtures', 'mixed-geo.dxf');
const ifcFile = path.join(ROOT, 'tools', 'fixtures', 'mixed-geo.ifc');
await fs.writeFile(dxfFile, makeGeoDxf(DXF));
await fs.writeFile(ifcFile, makeGeoIfc({ ...IFC, seed: 31, name: 'mixed-geo.ifc' }));

const { server, port } = await startStaticServer(ROOT);
const browser = await chromium.launch({ executablePath: await resolveChromium() });

async function runOrder(order) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => problems.push(`[${order.join(' → ')}] pageerror: ${e.message}`));
    try {
        await page.goto(`http://127.0.0.1:${port}/bim-lva-composer-ifc.html`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !!window.BimLvaDebug, null, { timeout: 60_000 });
        for (const f of order) {
            await page.setInputFiles('#localFileInput', f === 'dxf' ? dxfFile : ifcFile);
            const re = f === 'dxf' ? /mixed-geo\.dxf$/i : /mixed-geo\.ifc$/i;
            await page.waitForFunction(
                (src) => (window.BimLvaDebug?.modelBounds || []).some((m) => new RegExp(src, 'i').test(m.file)),
                f === 'dxf' ? 'mixed-geo\\.dxf$' : 'mixed-geo\\.ifc$',
                { timeout: 120_000 }
            );
            await page.waitForTimeout(400);
        }
        await page.evaluate(() => document.getElementById('fit')?.click());
        await page.waitForTimeout(500);

        const bounds = await page.evaluate(() => window.BimLvaDebug.modelBounds);
        const want = { dxf: geoDxfCentre(DXF), ifc: ifcCentre(IFC) };
        const label = order.join(' → ');
        for (const kind of ['dxf', 'ifc']) {
            const b = bounds.find((m) => new RegExp(`mixed-geo\\.${kind}$`, 'i').test(m.file));
            if (!b) {
                problems.push(`[${label}] ${kind.toUpperCase()} не загрузился`);
                continue;
            }
            const abs = await page.evaluate(
                ([x, y, z]) => window.BimLvaDebug.absoluteAt(x, y, z),
                [b.centerX, b.centerY, b.centerZ]
            );
            const w = want[kind];
            const d = Math.hypot(abs.e - w.e, abs.n - w.n, abs.h - w.h);
            console.log(
                `[${label}] ${kind.toUpperCase()}: ${abs.e.toFixed(1)} / ${abs.n.toFixed(1)} / ${abs.h.toFixed(1)} ` +
                `· ожидалось ${w.e.toFixed(1)} / ${w.n.toFixed(1)} / ${w.h.toFixed(1)} · ошибка ${d.toFixed(2)} м`
            );
            if (d > 1.5) {
                problems.push(`[${label}] ${kind.toUpperCase()}: координаты уехали на ${d.toFixed(1)} м`);
            }
        }
    } finally {
        await page.close();
    }
}

try {
    await runOrder(['dxf', 'ifc']);
    await runOrder(['ifc', 'dxf']);
} catch (error) {
    problems.push('исключение: ' + (error?.message || error));
} finally {
    await browser.close();
    server.close();
    await fs.rm(dxfFile, { force: true });
    await fs.rm(ifcFile, { force: true });
}

console.log('');
if (problems.length) {
    console.error(`Проблемы (${problems.length}):`);
    problems.forEach((p) => console.error('  · ' + p));
    process.exit(1);
}
console.log('OK — координаты не зависят от того, кто задал ноль сцены.');
