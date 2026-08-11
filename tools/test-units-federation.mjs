/**
 * Сводка из файлов с РАЗНЫМИ единицами длины.
 *
 * Настоящий случай с объекта: ПЗУ выгружен Civil 3D в метрах, АР — через ODA
 * (Renga/nanoCAD) в миллиметрах, координаты у обоих одни и те же. Если
 * приведение мм→м проехало мимо, второй файл улетает на километры, причём
 * габарит и «Диагностика IFC» этого не показывают: в самом файле всё верно.
 *
 * Проверяем не картинку, а расстояние между центрами: оно должно равняться
 * заданному разносу площадок, независимо от единиц.
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

// Координаты площадки — из реального ПЗУ
const WORLD = { x: 55421, y: 33702, z: 1556 };
const GAP = 200; // м, разнос между «площадкой» и «зданием»

const metres = path.join(ROOT, 'tools', 'fixtures', 'units-m.ifc');
const millis = path.join(ROOT, 'tools', 'fixtures', 'units-mm.ifc');

await fs.writeFile(metres, makeGeoIfc({
    worldX: WORLD.x, worldY: WORLD.y, worldZ: WORLD.z,
    count: 40, cols: 8, seed: 11, name: 'units-m.ifc'
}));
await fs.writeFile(millis, makeGeoIfc({
    worldX: WORLD.x + GAP, worldY: WORLD.y, worldZ: WORLD.z,
    count: 40, cols: 8, seed: 777, name: 'units-mm.ifc',
    lengthToMetres: 0.001
}));

const { server, port } = await startStaticServer(ROOT);
const browser = await chromium.launch({ executablePath: await resolveChromium() });
const page = await browser.newPage();
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));

try {
    await page.goto(`http://127.0.0.1:${port}/bim-lva-composer-ifc.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.BimLvaDebug, null, { timeout: 60_000 });
    await page.setInputFiles('#localFileInput', [metres, millis]);

    const bounds = await page
        .waitForFunction(() => {
            const list = (window.BimLvaDebug?.modelBounds || [])
                .filter((m) => /units-(m|mm)\.ifc$/i.test(m.file));
            return list.length === 2 ? list : false;
        }, { timeout: 120_000 })
        .then((h) => h.jsonValue())
        .catch(() => null);

    if (!bounds) {
        problems.push('файлы не загрузились: в сцене нет обеих моделей');
    } else {
        const m = bounds.find((b) => /units-m\.ifc$/i.test(b.file));
        const mm = bounds.find((b) => /units-mm\.ifc$/i.test(b.file));
        const dist = Math.hypot(mm.centerX - m.centerX, mm.centerY - m.centerY, mm.centerZ - m.centerZ);
        const sizeRatio = mm.sizeX / m.sizeX;

        console.log(`метры:       ${m.sizeX.toFixed(1)} × ${m.sizeY.toFixed(1)} × ${m.sizeZ.toFixed(1)} м`);
        console.log(`миллиметры:  ${mm.sizeX.toFixed(1)} × ${mm.sizeY.toFixed(1)} × ${mm.sizeZ.toFixed(1)} м`);
        console.log(`разнос:      ${dist.toFixed(1)} м, ожидалось ${GAP}`);

        if (Math.abs(sizeRatio - 1) > 0.02) {
            problems.push(
                `мм-файл пришёл в сцену в ${sizeRatio.toFixed(3)}× от метрового — единицы не приведены`
            );
        }
        if (Math.abs(dist - GAP) > 5) {
            problems.push(
                `модели встали в ${dist.toFixed(1)} м друг от друга вместо ${GAP} — ` +
                `мм-файл потерял мировые координаты`
            );
        }
    }
} catch (error) {
    problems.push('исключение: ' + (error?.message || error));
} finally {
    await browser.close();
    server.close();
    await fs.rm(metres, { force: true });
    await fs.rm(millis, { force: true });
}

console.log('');
if (problems.length) {
    console.error(`Проблемы (${problems.length}):`);
    problems.forEach((p) => console.error('  · ' + p));
    process.exit(1);
}
console.log('OK — файлы в метрах и миллиметрах садятся в одну сводку.');
