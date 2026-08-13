/**
 * Кэш тесселированной геометрии IFC.
 *
 * Смысл кэша — пропустить тесселяцию (80 % времени открытия) при повторном
 * открытии того же файла. Проверка «стало быстрее» здесь бесполезна: она
 * зелёная и у кэша, который отдаёт мусор. Проверяем то, что может сломаться
 * молча:
 *
 *  1. первое открытие кэш ЗАПОЛНЯЕТ, второе — ЧИТАЕТ (иначе всё это ни о чём);
 *  2. модель из кэша встаёт на то же место с точностью до миллиметра.
 *     Фикстура геодезическая (55 273 / 33 814 / 1600 м) сознательно: свернуть
 *     вершины в абсолютные float32 и не хранить матрицы — самая заманчивая
 *     оптимизация кэша, и она даёт шаг ≈4 мм на таких координатах. Тест на
 *     фикстуре у нуля этого не заметил бы вовсе;
 *  3. состав модели тот же — число элементов и габарит;
 *  4. очистка кэша действительно возвращает к тесселяции;
 *  5. выключатель выключает: с ним открытие идёт мимо кэша.
 *
 * Запуск: npm run test-geom-cache
 */
import { chromium } from 'playwright';
import { makeGeoIfc } from './fixtures/make-geo-ifc.mjs';
import { makeGridIfc } from './fixtures/make-grid-ifc.mjs';
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
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (!base) return undefined;
    const entries = await fs.readdir(base).catch(() => []);
    for (const dir of entries.filter((d) => d.startsWith('chromium-')).sort().reverse()) {
        const bin = path.join(base, dir, 'chrome-linux', 'chrome');
        if (await fs.access(bin).then(() => true, () => false)) return bin;
    }
    return undefined;
}

// Геодезические координаты — здесь и проверяется, что кэш не потерял точность.
const BLD = { x: 55273, y: 33814, z: 1600, cols: 6, count: 60, step: 8 };
const fixture = path.join(ROOT, 'tools', 'fixtures', 'cache-bld.ifc');
await fs.writeFile(fixture, makeGeoIfc({
    worldX: BLD.x, worldY: BLD.y, worldZ: BLD.z,
    count: BLD.count, cols: BLD.cols, step: BLD.step, seed: 404, name: 'cache-bld.ifc'
}));

const { server, port } = await startStaticServer(ROOT);
const browser = await chromium.launch({ executablePath: await resolveChromium() });
// Один контекст на весь тест: IndexedDB живёт в нём, и между «открытиями»
// (перезагрузками страницы) кэш обязан сохраняться — ради этого он и нужен.
const context = await browser.newContext();
const page = await context.newPage();
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));

/** Одно «открытие файла»: свежая страница, загрузка фикстуры, снимок состояния. */
async function openOnce(label, { disableCache = false } = {}) {
    await page.goto(`http://127.0.0.1:${port}/bim-lva-composer-ifc.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.BimLvaDebug, null, { timeout: 60_000 });
    if (disableCache) await page.evaluate(() => window.BimLvaDebug.geomCache.setEnabled(false));

    const t0 = Date.now();
    await page.setInputFiles('#localFileInput', fixture);
    await page.waitForFunction(
        () => (window.BimLvaDebug?.modelBounds || []).some((m) => /cache-bld\.ifc$/i.test(m.file)),
        null, { timeout: 120_000 }
    );
    // `modelBounds` наполняется РАНЬШЕ, чем загрузка доходит до записи кэша, и
    // проверять кэш по нему — гонка (уже поймана: первое открытие «не заполнило»
    // кэш, а на самом деле не дождались). Конец загрузки — включение `#clear`
    // в самом хвосте loadFilesSequentially.
    await page.waitForFunction(
        () => { const b = document.getElementById('clear'); return b && !b.disabled; },
        null, { timeout: 120_000 }
    );
    const ms = Date.now() - t0;
    // Фоновая запись кэша не должна попасть в следующий шаг недописанной.
    await page.evaluate(() => window.BimLvaDebug.geomCache.idle());

    const snap = await page.evaluate(() => {
        const dbg = window.BimLvaDebug;
        const b = dbg.modelBounds.find((m) => /cache-bld\.ifc$/i.test(m.file));
        const abs = dbg.absoluteAt(b.centerX, b.centerY, b.centerZ);
        return {
            fromCache: dbg.geomCache.usedFor('cache-bld'),
            abs,
            size: { x: b.sizeX, y: b.sizeY, z: b.sizeZ },
            meshes: dbg.meshCount ?? 0,
            treeRows: document.querySelectorAll('#tree .trow').length,
            mem: (document.getElementById('memReadout')?.textContent || '').trim()
        };
    });
    const stats = await page.evaluate(() => window.BimLvaDebug.geomCache.stats());
    console.log(
        `${label}: ${ms} мс · из кэша ${snap.fromCache ? 'да' : 'нет'} · ` +
        `центр ${snap.abs.e.toFixed(3)} / ${snap.abs.n.toFixed(3)} / ${snap.abs.h.toFixed(3)} м · ` +
        `кэш ${stats.models} моделей, ${(stats.bytes / 1048576).toFixed(1)} МБ`
    );
    return { ...snap, ms, stats };
}

// Заведомо выше порога батчинга (2000 фрагментов) — путь крупных моделей.
const bigFixture = path.join(ROOT, 'tools', 'fixtures', 'cache-big.ifc');
await fs.writeFile(bigFixture, makeGridIfc(2600, 52, 5));

/** То же самое для крупной модели: интересен путь через склейку батчей. */
async function openBig(label) {
    await page.goto(`http://127.0.0.1:${port}/bim-lva-composer-ifc.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.BimLvaDebug, null, { timeout: 60_000 });
    const t0 = Date.now();
    await page.setInputFiles('#localFileInput', bigFixture);
    await page.waitForFunction(
        () => { const b = document.getElementById('clear'); return b && !b.disabled; },
        null, { timeout: 180_000 }
    );
    const ms = Date.now() - t0;
    await page.evaluate(() => window.BimLvaDebug.geomCache.idle());
    const snap = await page.evaluate(() => {
        const dbg = window.BimLvaDebug;
        const b = dbg.modelBounds.find((m) => /cache-big\.ifc$/i.test(m.file));
        return {
            fromCache: dbg.geomCache.usedFor('cache-big'),
            size: { x: b.sizeX, y: b.sizeY, z: b.sizeZ },
            meshes: dbg.meshCount ?? 0,
            // Батчей всегда сильно меньше, чем элементов — по этому и опознаём склейку
            batched: (dbg.meshCount ?? 0) < 2600
        };
    });
    console.log(`${label}: ${ms} мс · из кэша ${snap.fromCache ? 'да' : 'нет'} · объектов в сцене ${snap.meshes}`);
    return { ...snap, ms };
}

try {
    // Чистый лист: кэш мог остаться от прошлого прогона в том же профиле.
    await page.goto(`http://127.0.0.1:${port}/bim-lva-composer-ifc.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.BimLvaDebug, null, { timeout: 60_000 });
    await page.evaluate(() => window.BimLvaDebug.geomCache.clear());

    const first = await openOnce('1-е открытие (тесселяция)');
    check(first.fromCache === false, 'первое открытие тесселирует, а не читает кэш');
    check(first.stats.models === 1, `после первого открытия в кэше 1 модель (получили ${first.stats.models})`);
    check(first.stats.bytes > 0, `в кэше есть данные (${(first.stats.bytes / 1024).toFixed(0)} КБ)`);

    const second = await openOnce('2-е открытие (кэш)');
    check(second.fromCache === true, 'второе открытие взяло геометрию из кэша');
    check(second.stats.models === 1, 'повторное открытие не завело вторую запись на тот же файл');

    // Главное: то же место с точностью до миллиметра. Без этого кэш —
    // тихий способ сдвинуть модель.
    const dist = Math.hypot(
        second.abs.e - first.abs.e,
        second.abs.n - first.abs.n,
        second.abs.h - first.abs.h
    );
    check(dist < 0.001,
        `модель из кэша встала на то же место (расхождение ${(dist * 1000).toFixed(3)} мм)`);

    // И сверка с самой фикстурой — чтобы «одинаково неправильно» не прошло.
    const rows = Math.ceil(BLD.count / BLD.cols);
    const want = {
        e: BLD.x + (BLD.cols - 1) * BLD.step / 2,
        n: BLD.y + (rows - 1) * BLD.step / 2,
        h: BLD.z + 1.5
    };
    const errAbs = Math.hypot(second.abs.e - want.e, second.abs.n - want.n, second.abs.h - want.h);
    check(errAbs < 0.01,
        `координаты из кэша совпали с фикстурой (${want.e} / ${want.n} / ${want.h}, ошибка ${errAbs.toFixed(3)} м)`);

    const sizeDelta = Math.max(
        Math.abs(second.size.x - first.size.x),
        Math.abs(second.size.y - first.size.y),
        Math.abs(second.size.z - first.size.z)
    );
    check(sizeDelta < 0.001, `габарит совпал (расхождение ${(sizeDelta * 1000).toFixed(3)} мм)`);
    // Сверять «0 = 0» бессмысленно: пустая сцена совпадает с пустой сценой.
    check(first.meshes > 0 && second.meshes === first.meshes,
        `мешей столько же (${second.meshes} = ${first.meshes})`);
    check(first.treeRows > 0 && second.treeRows === first.treeRows,
        `дерево того же состава (${second.treeRows} = ${first.treeRows} строк)`);
    // Счётчик в статус-баре обязан приписать вес моделей, а не только вкладки:
    // ветка «модели N МБ» считается по geometryBytes, и её легко потерять.
    const memModels = /модели\s+([\d.]+)\s*МБ/.exec(second.mem);
    check(memModels && Number(memModels[1]) > 0,
        `счётчик памяти показывает НЕнулевой вес моделей («${second.mem}»)`);

    // Очистка обязана вернуть к тесселяции — иначе кнопка врёт.
    await page.evaluate(() => window.BimLvaDebug.geomCache.clear());
    const third = await openOnce('3-е открытие (после очистки)');
    check(third.fromCache === false, 'после очистки кэша модель снова тесселируется');

    // Выключатель: кэш заполнен, но открытие обязано пройти мимо него.
    const fourth = await openOnce('4-е открытие (кэш выключен)', { disableCache: true });
    check(fourth.fromCache === false, 'с выключенным кэшем геометрия считается заново');
    const dist4 = Math.hypot(
        fourth.abs.e - first.abs.e, fourth.abs.n - first.abs.n, fourth.abs.h - first.abs.h
    );
    check(dist4 < 0.001, 'выключенный кэш даёт ту же посадку');

    // Крупная модель идёт другим путём: от 2000 фрагментов вьювер СКЛЕИВАЕТ их
    // в батчи. Из кэша атрибуты приезжают подмассивами одного большого буфера —
    // именно здесь склейка могла бы прочитать чужие вершины, а на 60 коробках
    // (путь отдельных мешей) этого не видно вовсе.
    await page.evaluate(() => window.BimLvaDebug.geomCache.clear());
    const bigFirst = await openBig('крупная, 1-е открытие');
    check(bigFirst.batched,
        `крупная модель пошла через батчи (2600 элементов склеены в ${bigFirst.meshes} объект(ов) сцены)`);
    const bigSecond = await openBig('крупная, 2-е открытие');
    check(bigSecond.fromCache === true, 'крупная модель во второй раз взята из кэша');
    const bigDelta = Math.max(
        Math.abs(bigSecond.size.x - bigFirst.size.x),
        Math.abs(bigSecond.size.y - bigFirst.size.y),
        Math.abs(bigSecond.size.z - bigFirst.size.z)
    );
    check(bigDelta < 0.001,
        `склеенные из кэша батчи дали тот же габарит (расхождение ${(bigDelta * 1000).toFixed(3)} мм)`);
    // Цифру печатаем, но выводов из неё не делаем: в эти сотни миллисекунд
    // входит запуск страницы и инициализация WASM, а фикстура маленькая.
    // Насколько кэш ускоряет саму тесселяцию — меряет `npm run bench-load`.
    console.log(
        `  всё открытие: ${bigFirst.ms} мс → ${bigSecond.ms} мс ` +
        `(в обоих — старт страницы и WASM, фикстура мелкая; долю тесселяции см. bench-load)`
    );
} catch (error) {
    problems.push('исключение: ' + (error?.message || error));
} finally {
    await browser.close();
    server.close();
    await fs.rm(fixture, { force: true });
    await fs.rm(bigFixture, { force: true });
}

console.log('');
if (problems.length) {
    console.error(`Проблемы (${problems.length}):`);
    problems.forEach((p) => console.error('  · ' + p));
    process.exit(1);
}
console.log('OK — кэш геометрии ускоряет повторное открытие и не двигает модель.');
