/**
 * Сводка на ЗАВОДСКОЙ сетке (координаты ~1200 м), а не на геодезии.
 *
 * Случай с объекта: два файла из Tekla (АС и КМ) — координаты общие и
 * согласованные, в Navisworks садятся как надо, а во вьювере разлетались.
 * Причина: порог «крупных координат» = 5000 м, заводская сетка под него не
 * проходила, файл не привязывался к общему нулю и садился в СВОЙ центр.
 * Взаимное положение при этом уничтожается — причём центр считается по
 * ВЫБОРКЕ фрагментов, поэтому промах у двух файлов разный и модели не
 * накладывались, а расходились.
 *
 * Точность тут ни при чём: на 1200 м шаг float32 ≈ 0.14 мм.
 *
 * Проверяем то, что и сломалось: РАЗНОС между моделями. Проверять абсолютные
 * координаты здесь недостаточно — сцена законно до-центрируется, и оба файла
 * уезжают вместе; ломается именно взаимное положение.
 *
 * Запуск: npm run test-plant-grid
 */
import { chromium } from 'playwright';
import { makeGeoIfc } from './fixtures/make-geo-ifc.mjs';
import { startStaticServer } from './static-server.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const check = (ok, what) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) problems.push(what);
};

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

// Числа сняты с реальных файлов. Центры моделей по Navisworks:
// АС 1231.43 / 1171.43 / 61.80, КМ 1203.60 / 1061.50 / 63.29 — от них и
// пляшем, подбирая начало сетки так, чтобы центр фикстуры совпал.
// Оба ниже порога 5000 м — в этом и была суть.
//
// Файлы ВОСПРОИЗВОДЯТ выгрузку Tekla: IFC2X3, миллиметры, много вырезов.
// Без этого правило «Tekla + IFC2X3 + вырезы + > 50 м → сбросить координаты
// в ноль» не сработает, и тест пройдёт мимо настоящей причины.
const TEKLA = { schema: 'IFC2X3', application: 'Tekla Structures 2021', lengthToMetres: 0.001 };
const AS = { x: 1219.0, y: 1146.4, z: 60.3, cols: 6, count: 60, step: 5 };
const KM = { x: 1193.6, y: 1046.5, z: 61.8, cols: 5, count: 25, step: 5 };

/** Центр сетки коробок фикстуры в абсолютных координатах. */
function gridCentre(f) {
    const rows = Math.ceil(f.count / f.cols);
    return {
        e: f.x + (f.cols - 1) * f.step / 2,
        n: f.y + (rows - 1) * f.step / 2,
        h: f.z + 1.5
    };
}

const asFile = path.join(ROOT, 'tools', 'fixtures', 'plant-as.ifc');
const kmFile = path.join(ROOT, 'tools', 'fixtures', 'plant-km.ifc');
await fs.writeFile(asFile, makeGeoIfc({
    ...TEKLA, worldX: AS.x, worldY: AS.y, worldZ: AS.z,
    count: AS.count, cols: AS.cols, step: AS.step, seed: 71, name: 'plant-as.ifc',
    booleanOps: 1997          // столько же, сколько в настоящем АС
}));
await fs.writeFile(kmFile, makeGeoIfc({
    ...TEKLA, worldX: KM.x, worldY: KM.y, worldZ: KM.z,
    count: KM.count, cols: KM.cols, step: KM.step, seed: 72, name: 'plant-km.ifc',
    booleanOps: 294           // столько же, сколько в настоящем КМ
}));

// Ожидаемый разнос центров — считаем из чисел фикстур, а не «на глаз»:
// на этом уже обжигались, ожидание по точкам привязки врало.
const cAS = gridCentre(AS);
const cKM = gridCentre(KM);
const WANT = Math.hypot(cAS.e - cKM.e, cAS.n - cKM.n, cAS.h - cKM.h);

const { server, port } = await startStaticServer(ROOT);
const browser = await chromium.launch({ executablePath: await resolveChromium() });
const page = await browser.newPage();
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));

try {
    await page.goto(`http://127.0.0.1:${port}/bim-lva-composer-ifc.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.BimLvaDebug, null, { timeout: 60_000 });

    // По одному файлу — как у пользователя, а не пачкой
    await page.setInputFiles('#localFileInput', asFile);
    await page.waitForFunction(
        () => (window.BimLvaDebug?.modelBounds || []).some((m) => /plant-as\.ifc$/i.test(m.file)),
        null, { timeout: 120_000 }
    );
    await page.evaluate(() => document.getElementById('fit')?.click());
    await page.waitForTimeout(400);

    await page.setInputFiles('#localFileInput', kmFile);
    await page.waitForFunction(
        () => (window.BimLvaDebug?.modelBounds || []).filter((m) => /plant-(as|km)\.ifc$/i.test(m.file)).length === 2,
        null, { timeout: 120_000 }
    );
    await page.evaluate(() => document.getElementById('fit')?.click());
    await page.waitForTimeout(400);

    const bounds = await page.evaluate(() => window.BimLvaDebug.modelBounds);
    const pick = (re) => bounds.find((m) => re.test(m.file));
    const a = pick(/plant-as\.ifc$/i);
    const b = pick(/plant-km\.ifc$/i);
    check(!!a && !!b, 'оба файла загрузились');

    if (a && b) {
        const got = Math.hypot(a.centerX - b.centerX, a.centerY - b.centerY, a.centerZ - b.centerZ);
        console.log(`  разнос центров: ${got.toFixed(2)} м, ожидалось ${WANT.toFixed(2)} м`);
        check(Math.abs(got - WANT) < 0.5,
            `взаимное положение сохранено (ошибка ${Math.abs(got - WANT).toFixed(2)} м)`);
    }

    // Ни один файл не должен садиться в свой центр: координаты общие.
    // Именно 'self' и уничтожал сводку.
    const rebases = await page.evaluate(() =>
        window.BimLvaDebug.modelAbsExtents.map((m) => ({
            file: m.file, rebase: m.rebase, cto: m.cto, ctoRestored: m.ctoRestored
        })));
    rebases.forEach((r) => {
        console.log(`  ${r.file}: rebase=${r.rebase}, COORDINATE_TO_ORIGIN=${r.cto}`);
        check(r.rebase !== 'self',
            `${r.file} не посажен в свой центр (${r.rebase})`);
        // CTO необратимо теряет абсолютные координаты и не сообщает, на сколько
        // сдвинул. На заводской сетке он не нужен: float32 тут даёт 0.14 мм.
        check(!r.cto,
            `${r.file} открыт БЕЗ сброса координат в ноль`);
    });

    const policy = await page.evaluate(() => window.BimLvaDebug.coordToOriginPolicy({
        maxAbs: 1_195_000, looksLikeMillimetres: true, lengthToMeters: 0.001,
        isTekla: true, isIfc2x3: true, booleanOpsCount: 397
    }));
    check(!policy, 'КМ 1195 м / 397 вырезов — без упреждающего сброса координат');

    const kmText = await fs.readFile(kmFile, 'utf8');
    const sampled = await page.evaluate(
        (text) => window.BimLvaDebug.sampleIfcWorldCenter(text, 0.001),
        kmText
    );
    console.log(`  выборка КМ: maxAbs=${sampled.maxAbs}, shift=${JSON.stringify(sampled.shift)}`);
    check(!!sampled.shift, 'по точкам файла считается сдвиг для восстановления после CTO');
    if (sampled.shift) {
        check(Math.abs(sampled.shift.x - KM.x) < 0.6,
            `восстановление E ${sampled.shift.x.toFixed(2)} ≈ ${KM.x}`);
        check(Math.abs(sampled.shift.y - KM.z) < 0.6,
            `восстановление h ${sampled.shift.y.toFixed(2)} ≈ ${KM.z}`);
        check(Math.abs(sampled.shift.z + KM.y) < 0.6,
            `восстановление −N ${sampled.shift.z.toFixed(2)} ≈ ${-KM.y}`);
    }

    const toasts = await page.evaluate(() =>
        [...document.querySelectorAll('.toast-text, .toast .toast-text')]
            .map((t) => t.textContent || '').join('\n'));
    check(!/СБРОСОМ КООРДИНАТ/.test(toasts),
        'нет предупреждения о сбросе координат на заводской сетке');

    // И абсолютные координаты должны остаться настоящими — заводская сетка
    // это такие же честные координаты, как геодезические.
    for (const [label, m, want] of [['АС', a, cAS], ['КМ', b, cKM]]) {
        if (!m) continue;
        const abs = await page.evaluate(
            ([x, y, z]) => window.BimLvaDebug.absoluteAt(x, y, z),
            [m.centerX, m.centerY, m.centerZ]
        );
        const d = Math.hypot(abs.e - want.e, abs.n - want.n, abs.h - want.h);
        console.log(
            `  ${label}: ${abs.e.toFixed(1)} / ${abs.n.toFixed(1)} / ${abs.h.toFixed(1)} м, ` +
            `ожидалось ${want.e.toFixed(1)} / ${want.n.toFixed(1)} / ${want.h.toFixed(1)} · ошибка ${d.toFixed(2)} м`
        );
        check(d < 0.5, `${label}: абсолютные координаты заводской сетки сохранены`);
    }
} catch (error) {
    problems.push('исключение: ' + (error?.message || error));
} finally {
    await browser.close();
    server.close();
    await fs.rm(asFile, { force: true });
    await fs.rm(kmFile, { force: true });
}

console.log('');
if (problems.length) {
    console.error(`Проблемы (${problems.length}):`);
    problems.forEach((p) => console.error('  · ' + p));
    process.exit(1);
}
console.log('OK — сводка на заводской сетке (~1200 м) не разъезжается.');
