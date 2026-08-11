/**
 * Повёрнутая вставка + тесселированная геометрия — случай с объекта.
 *
 * В Navisworks у файла АР видно преобразование сцены: начало
 * (55300.050, 33820.602, 1600.150) и поворот 12.060° вокруг оси Z, а сама
 * геометрия лежит в `IfcPolygonalFaceSet` с ЛОКАЛЬНЫМИ вершинами. Все прежние
 * фикстуры были без поворота и на выдавленных телах, поэтому этот путь ни
 * одной проверкой не задевался.
 *
 * Сверяем абсолютное положение центра геометрии с посчитанным вручную.
 */
import { chromium } from 'playwright';
import { makeGeoIfc } from './fixtures/make-geo-ifc.mjs';
import { makeTessellatedIfc, tessellatedCentre } from './fixtures/make-tessellated-ifc.mjs';
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

// Числа с объекта: площадка ПЗУ и здание АР с поворотом 12.06°
const SITE = { worldX: 54900, worldY: 33300, worldZ: 1556, count: 200, cols: 20, step: 40, seed: 5 };
const BLD = { worldX: 55300.05, worldY: 33820.602, worldZ: 1600.15, rotationDeg: 12.06, boxes: 6, step: 12, size: 6, seed: 9 };
// Тот же случай, но в МИЛЛИМЕТРАХ: у файла АР единицы миллиметровые, и это
// последняя комбинация, которой не касалась ни одна проверка
const BLD_MM = { ...BLD, seed: 77, lengthToMetres: 0.001 };

const siteFile = path.join(ROOT, 'tools', 'fixtures', 'rot-site.ifc');
const bldFile = path.join(ROOT, 'tools', 'fixtures', 'rot-bld.ifc');
await fs.writeFile(siteFile, makeGeoIfc({ ...SITE, name: 'rot-site.ifc' }));
await fs.writeFile(bldFile, makeTessellatedIfc({ ...BLD, name: 'rot-bld.ifc' }));
const bldMmFile = path.join(ROOT, 'tools', 'fixtures', 'rot-bld-mm.ifc');
await fs.writeFile(bldMmFile, makeTessellatedIfc({ ...BLD_MM, name: 'rot-bld-mm.ifc' }));

const { server, port } = await startStaticServer(ROOT);
const browser = await chromium.launch({ executablePath: await resolveChromium() });
const page = await browser.newPage();
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));

try {
    await page.goto(`http://127.0.0.1:${port}/bim-lva-composer-ifc.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.BimLvaDebug, null, { timeout: 60_000 });

    for (const f of [siteFile, bldFile, bldMmFile]) {
        await page.setInputFiles('#localFileInput', f);
        const base = path.basename(f);
        await page.waitForFunction(
            (nm) => (window.BimLvaDebug?.modelBounds || []).some((m) => m.file === nm),
            base,
            { timeout: 120_000 }
        );
        await page.waitForTimeout(400);
    }
    await page.evaluate(() => document.getElementById('fit')?.click());
    await page.waitForTimeout(500);

    const bounds = await page.evaluate(() => window.BimLvaDebug.modelBounds);
    for (const [label, re, cfg] of [
        ['метры', /rot-bld\.ifc$/i, BLD],
        ['миллиметры', /rot-bld-mm\.ifc$/i, BLD_MM]
    ]) {
    const bld = bounds.find((m) => re.test(m.file));
    if (!bld) {
        problems.push(`здание (${label}) не загрузилось`);
    } else {
        const abs = await page.evaluate(
            ([x, y, z]) => window.BimLvaDebug.absoluteAt(x, y, z),
            [bld.centerX, bld.centerY, bld.centerZ]
        );
        const want = tessellatedCentre(cfg);
        const d = Math.hypot(abs.e - want.e, abs.n - want.n, abs.h - want.h);
        console.log(
            `здание (${label}): ${abs.e.toFixed(2)} / ${abs.n.toFixed(2)} / ${abs.h.toFixed(2)} м · ` +
            `ожидалось ${want.e.toFixed(2)} / ${want.n.toFixed(2)} / ${want.h.toFixed(2)} · ` +
            `ошибка ${d.toFixed(2)} м`
        );
        if (d > 1) {
            problems.push(`повёрнутая вставка (${label}): здание село мимо на ${d.toFixed(1)} м`);
        }

        const a = cfg.rotationDeg * Math.PI / 180;
        const wantX = Math.abs(((cfg.boxes - 1) * cfg.step + cfg.size) * Math.cos(a))
            + Math.abs(cfg.size * Math.sin(a));
        console.log(`  габарит по X: ${bld.sizeX.toFixed(2)} м, ожидалось ${wantX.toFixed(2)}`);
        if (Math.abs(bld.sizeX - wantX) > 1) {
            problems.push(
                `поворот или единицы (${label}) не применились: габарит ${bld.sizeX.toFixed(2)} ` +
                `вместо ${wantX.toFixed(2)}`
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
    await fs.rm(bldMmFile, { force: true });
}

console.log('');
if (problems.length) {
    console.error(`Проблемы (${problems.length}):`);
    problems.forEach((p) => console.error('  · ' + p));
    process.exit(1);
}
console.log('OK — тесселированная геометрия с повёрнутой вставкой садится на место.');
