/**
 * Геосводка при ПОСЛЕДОВАТЕЛЬНОЙ загрузке.
 *
 * `npm run smoke` кидает оба файла разом, и этого мало: у пользователя файлы
 * приходят по одному, и между загрузками сцена успевает до-центрироваться
 * (`ensureSceneContentNearOrigin`).
 *
 * Проверяем не разнос центров (он ничего не докажет: сойтись может и на общем
 * сдвиге), а АБСОЛЮТНЫЕ координаты каждой модели — те самые, что печатает
 * строка состояния и по которым сверяются с Civil 3D.
 */
import { chromium } from 'playwright';
import { makeGeoIfc } from './fixtures/make-geo-ifc.mjs';
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

// Площадка и здание с объекта: ПЗУ крупный, АР маленький и внутри него.
// Проверяем не разнос, а АБСОЛЮТНЫЕ координаты — то, что читают в статус-баре.
const SITE = { x: 54821, y: 33302, z: 1556, cols: 30, count: 300, step: 40 };
const BLD = { x: 55273, y: 33814, z: 1600, cols: 4, count: 12, step: 10 };

/** Центр сетки коробок фикстуры в абсолютных координатах. */
function gridCentre(f) {
    const rows = Math.ceil(f.count / f.cols);
    return {
        e: f.x + (f.cols - 1) * f.step / 2,
        n: f.y + (rows - 1) * f.step / 2,
        h: f.z + 1.5
    };
}

const siteFile = path.join(ROOT, 'tools', 'fixtures', 'seq-site.ifc');
const bldFile = path.join(ROOT, 'tools', 'fixtures', 'seq-bld.ifc');

// Площадка широкая (как ПЗУ), здание компактное (как АР): у них сильно разные
// центры, поэтому общий сдвиг сцены сразу вылезет в абсолютных координатах.
await fs.writeFile(siteFile, makeGeoIfc({
    worldX: SITE.x, worldY: SITE.y, worldZ: SITE.z,
    count: SITE.count, cols: SITE.cols, step: SITE.step, seed: 21, name: 'seq-site.ifc'
}));
await fs.writeFile(bldFile, makeGeoIfc({
    worldX: BLD.x, worldY: BLD.y, worldZ: BLD.z,
    count: BLD.count, cols: BLD.cols, step: BLD.step, seed: 909, name: 'seq-bld.ifc'
}));

const { server, port } = await startStaticServer(ROOT);
const browser = await chromium.launch({ executablePath: await resolveChromium() });
const page = await browser.newPage();
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));

const centreOf = (list, re) => {
    const b = list.find((m) => re.test(m.file));
    return b ? { x: b.centerX, y: b.centerY, z: b.centerZ } : null;
};

try {
    await page.goto(`http://127.0.0.1:${port}/bim-lva-composer-ifc.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.BimLvaDebug, null, { timeout: 60_000 });

    // 1) сначала площадка — она задаёт ноль сцены
    await page.setInputFiles('#localFileInput', siteFile);
    await page.waitForFunction(
        () => (window.BimLvaDebug?.modelBounds || []).some((m) => /seq-site\.ifc$/i.test(m.file)),
        null, { timeout: 120_000 }
    );
    // даём сцене до-центрироваться, как это происходит у пользователя
    await page.evaluate(() => document.getElementById('fit')?.click());
    await page.waitForTimeout(600);

    // 2) затем здание — отдельной загрузкой
    await page.setInputFiles('#localFileInput', bldFile);
    const bounds = await page
        .waitForFunction(() => {
            const list = (window.BimLvaDebug?.modelBounds || [])
                .filter((m) => /seq-(site|bld)\.ifc$/i.test(m.file));
            return list.length === 2 ? list : false;
        }, { timeout: 120_000 })
        .then((h) => h.jsonValue())
        .catch(() => null);

    if (!bounds) {
        problems.push('вторая модель не загрузилась');
    } else {
        for (const [label, re, want] of [
            ['площадка', /seq-site\.ifc$/i, gridCentre(SITE)],
            ['здание', /seq-bld\.ifc$/i, gridCentre(BLD)]
        ]) {
            const c = centreOf(bounds, re);
            const abs = await page.evaluate(
                ([x, y, z]) => window.BimLvaDebug.absoluteAt(x, y, z),
                [c.x, c.y, c.z]
            );
            const d = Math.hypot(abs.e - want.e, abs.n - want.n, abs.h - want.h);
            console.log(
                `${label}: центр ${abs.e.toFixed(1)} / ${abs.n.toFixed(1)} / ${abs.h.toFixed(1)} м, ` +
                `ожидалось ${want.e.toFixed(1)} / ${want.n.toFixed(1)} / ${want.h.toFixed(1)} · ` +
                `ошибка ${d.toFixed(2)} м`
            );
            if (d > 1) {
                problems.push(
                    `${label}: абсолютные координаты уехали на ${d.toFixed(1)} м ` +
                    `(ноль сцены разъехался с геометрией)`
                );
            }
        }
    }
} catch (error) {
    problems.push('исключение: ' + (error?.message || error));
} finally {
    await browser.close();
    server.close();
    await fs.rm(siteFile, { force: true });
    await fs.rm(bldFile, { force: true });
}

console.log('');
if (problems.length) {
    console.error(`Проблемы (${problems.length}):`);
    problems.forEach((p) => console.error('  · ' + p));
    process.exit(1);
}
console.log('OK — при загрузке по одному файлы садятся на свои места.');
