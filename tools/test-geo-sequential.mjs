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
    let bounds = await page
        .waitForFunction(() => {
            const list = (window.BimLvaDebug?.modelBounds || [])
                .filter((m) => /seq-(site|bld)\.ifc$/i.test(m.file));
            return list.length === 2 ? list : false;
        }, { timeout: 120_000 })
        .then((h) => h.jsonValue())
        .catch(() => null);

    // Пользователь после загрузки жмёт «Вписать» — именно там сцена
    // до-центрируется. Габариты надо перечитать ПОСЛЕ этого: метку он ставит
    // на сдвинутую геометрию, и пересчёт в абсолютные обязан это учитывать.
    await page.evaluate(() => document.getElementById('fit')?.click());
    await page.waitForTimeout(500);
    const snap = await page.evaluate(() => window.BimLvaDebug.sceneSnap);
    console.log(`до-центрирований: ${snap.count}, суммарный сдвиг ${snap.length.toFixed(3)} м`);
    // Без этого тест однажды «прошёл» вхолостую: до-центрирование не срабатывало,
    // и проверять было нечего. Нет сдвига — фикстуры перестали воспроизводить случай.
    if (!snap.count || snap.length < 1) {
        problems.push(
            `сцена не до-центрировалась (${snap.count} раз, ${snap.length.toFixed(2)} м) — ` +
            `проверка вхолостую, поправьте фикстуры`
        );
    }
    // Каждый файл обязан вычесть ОБЩИЙ ноль. Если какой-то посажен в свой
    // центр, он встанет «в кучу» у нуля сцены — именно так модель и уезжает.
    const rebases = await page.evaluate(() =>
        window.BimLvaDebug.modelAbsExtents.map((m) => ({ file: m.file, rebase: m.rebase })));
    rebases.forEach((r) => {
        console.log(`${r.file}: ${r.rebase}`);
        if (r.rebase !== 'shared') {
            problems.push(`${r.file}: посажен в свой центр (${r.rebase}) вместо общего нуля`);
        }
    });
    bounds = await page.evaluate(() => window.BimLvaDebug.modelBounds);

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
    // «Поставить по мировым координатам»: нарочно сдвигаем модель и проверяем,
    // что кнопка возвращает её на место — это ручной выход, если файл всё-таки
    // сел не туда.
    const fixed = await page.evaluate(() => {
        const dbg = window.BimLvaDebug;
        const before = dbg.modelBounds.find((m) => /seq-bld\.ifc$/i.test(m.file));
        const absBefore = dbg.absoluteAt(before.centerX, before.centerY, before.centerZ);
        dbg.nudgeModel(/seq-bld\.ifc$/i.source, 37, -14, 9);
        const moved = dbg.modelBounds.find((m) => /seq-bld\.ifc$/i.test(m.file));
        const absMoved = dbg.absoluteAt(moved.centerX, moved.centerY, moved.centerZ);
        dbg.snapToWorld(/seq-bld\.ifc$/i.source);
        const after = dbg.modelBounds.find((m) => /seq-bld\.ifc$/i.test(m.file));
        const absAfter = dbg.absoluteAt(after.centerX, after.centerY, after.centerZ);
        return { absBefore, absMoved, absAfter };
    });
    const drift = Math.hypot(
        fixed.absMoved.e - fixed.absBefore.e,
        fixed.absMoved.n - fixed.absBefore.n,
        fixed.absMoved.h - fixed.absBefore.h
    );
    const back = Math.hypot(
        fixed.absAfter.e - fixed.absBefore.e,
        fixed.absAfter.n - fixed.absBefore.n,
        fixed.absAfter.h - fixed.absBefore.h
    );
    console.log(`сдвинули на ${drift.toFixed(2)} м, после «по мировым координатам» осталось ${back.toFixed(3)} м`);
    if (drift < 1) problems.push('модель не удалось сдвинуть — проверка вхолостую');
    if (back > 0.05) problems.push(`возврат по мировым координатам промахнулся на ${back.toFixed(2)} м`);
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
