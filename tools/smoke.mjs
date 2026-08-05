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
import { makeBlocksDxf } from './fixtures/make-blocks-dxf.mjs';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startStaticServer } from './static-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = process.env.SMOKE_PAGE || 'bim-lva-composer-ifc.html';

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

/**
 * Уведомления заменили alert(): проверяем и механизм, и реальный путь из UI.
 * Кнопка «Ведомость» без выделения обязана показать сообщение об ошибке —
 * раньше это был блокирующий alert.
 */
async function checkNotifications(page) {
    const api = await page.evaluate(() => typeof window.BimLvaNotify?.error === 'function');
    if (!api) {
        problems.push('window.BimLvaNotify недоступен — уведомления не поднялись');
        return null;
    }

    await page.evaluate(() => window.BimLvaNotify.error('Проверка уведомлений'));
    const shown = await page
        .waitForFunction(
            () => [...document.querySelectorAll('.toast.is-error .toast-text')]
                .some((t) => t.textContent.includes('Проверка уведомлений')),
            { timeout: 3000 }
        )
        .then(() => true)
        .catch(() => false);
    if (!shown) problems.push('уведомление через BimLvaNotify не появилось');

    // Реальный путь: экспорт ведомости без выделения. Кнопка живёт в свёрнутой
    // панели, поэтому дёргаем обработчик напрямую, а не мышью.
    await page.evaluate(() => document.querySelectorAll('.toast .toast-close').forEach((b) => b.click()));
    await page.evaluate(() => document.getElementById('btnSchedule').click());
    const fromUi = await page
        .waitForFunction(
            () => [...document.querySelectorAll('.toast .toast-text')]
                .some((t) => /ведомост/i.test(t.textContent)),
            { timeout: 3000 }
        )
        .then(() => true)
        .catch(() => false);
    if (!fromUi) problems.push('кнопка «Ведомость» без выделения не показала уведомление');

    return { api: true, shown, fromUi };
}

/**
 * Прогон проверки коллизий на двух перекрывающихся моделях.
 * Коллизии переведены с полного перебора A×B на пространственную сетку —
 * здесь проверяется, что в реальном UI она находит пары, а не молчит.
 */
async function checkClash(page) {
    // Списки моделей наполняются при открытии панели, а не при загрузке файла.
    await page.evaluate(() => document.getElementById('btnClash').click());
    await page.waitForTimeout(300);

    const ready = await page.evaluate(() => {
        const a = document.getElementById('clashModelA');
        const b = document.getElementById('clashModelB');
        if (!a || !b || a.options.length < 2) return false;
        a.selectedIndex = 0;
        b.selectedIndex = 1;
        a.dispatchEvent(new Event('change', { bubbles: true }));
        b.dispatchEvent(new Event('change', { bubbles: true }));
        // Пресет «все классы»: сетка не должна зависеть от фильтра.
        const preset = document.getElementById('clashClassPreset');
        if (preset) {
            const all = [...preset.options].find((o) => /все/i.test(o.textContent));
            if (all) { preset.value = all.value; preset.dispatchEvent(new Event('change', { bubbles: true })); }
        }
        return true;
    });
    if (!ready) {
        problems.push('в списках коллизий меньше двух моделей — проверку не запустить');
        return null;
    }

    const started = Date.now();
    await page.evaluate(() => document.getElementById('runClash').click());
    const status = await page
        .waitForFunction(
            () => {
                const t = document.getElementById('clashStatus')?.textContent || '';
                return /Найдено пар|не найдено/i.test(t) ? t : false;
            },
            { timeout: 120_000 }
        )
        .then((h) => h.jsonValue())
        .catch(() => null);

    if (!status) {
        problems.push('проверка коллизий не завершилась');
        return null;
    }
    const pairs = Number(/Найдено пар:\s*(\d+)/i.exec(status)?.[1] || 0);
    if (!pairs) {
        problems.push(`коллизии не найдены на заведомо пересекающихся моделях: ${status}`);
    }
    return { pairs, ms: Date.now() - started };
}

/**
 * Раскрытие блоков DXF: у фикстуры габарит посчитан руками, поэтому проверяем
 * не «что-то появилось», а что вставки встали ровно туда, куда должны —
 * со своим смещением, масштабом, поворотом и вложенностью.
 * Без раскрытия блоков чертёж был бы пуст: собственных сущностей в нём нет.
 */
async function checkDxfBlocks(page) {
    const { text, expected } = makeBlocksDxf();
    const fixture = path.join(ROOT, 'tools', 'fixtures', 'smoke-blocks.dxf');
    await fs.writeFile(fixture, text);
    try {
        const before = await page.evaluate(() => window.BimLvaDebug?.modelCount ?? 0);
        await page.setInputFiles('#localFileInput', fixture);
        const loaded = await page
            .waitForFunction((n) => (window.BimLvaDebug?.modelCount ?? 0) > n, before, { timeout: 60_000 })
            .then(() => true)
            .catch(() => false);
        if (!loaded) {
            problems.push('DXF с блоками не загрузился');
            return null;
        }
        // Именно эта модель: в сцене уже лежат IFC из предыдущих проверок.
        const bounds = await page.evaluate(
            () => (window.BimLvaDebug?.modelBounds || []).find((m) => /smoke-blocks\.dxf$/i.test(m.file)) || null
        );
        if (!bounds) {
            problems.push('DXF с блоками загрузился, но геометрии в сцене нет — вставки не раскрылись');
            return null;
        }
        // Модель могла быть смещена к нулю сцены, поэтому сверяем размеры, а не
        // абсолютные координаты.
        const gotW = bounds.sizeX;
        const gotH = bounds.sizeY;
        const wantW = expected.maxX - expected.minX;
        const wantH = expected.maxY - expected.minY;
        const ok = Math.abs(gotW - wantW) < 0.01 && Math.abs(gotH - wantH) < 0.01;
        if (!ok) {
            problems.push(
                `блоки DXF раскрыты неверно: габарит ${gotW.toFixed(2)}×${gotH.toFixed(2)}, ` +
                `ожидался ${wantW}×${wantH}`
            );
        }
        return { ok, size: `${gotW.toFixed(1)}×${gotH.toFixed(1)}` };
    } finally {
        await fs.rm(fixture, { force: true });
    }
}

async function main() {
    const { server, port } = await startStaticServer(ROOT);
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
    let toast = null;
    let clash = null;
    let dxfBlocks = null;
    // Любая сборка Composer, включая тестовую копию, а не только основной файл.
    if (/^bim-lva-composer-ifc.*\.html$/.test(PAGE)) {
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
            else {
                // Порядок важен: «Ведомость» ругается только когда ничего не
                // выделено, а прогон коллизий выделяет тысячи элементов —
                // поэтому уведомления идут первыми, коллизии последними.
                toast = await checkNotifications(page);
                pick = await checkPicking(page);

                // Вторая модель в тех же координатах — заведомые пересечения.
                const second = path.join(ROOT, 'tools', 'fixtures', 'smoke-grid-b.ifc');
                await fs.writeFile(second, makeGridIfc(300, 20, 3));
                try {
                    await page.setInputFiles('#localFileInput', second);
                    await page.waitForFunction(
                        () => document.querySelectorAll('#tree [data-file-root]').length > 1,
                        { timeout: 90_000 }
                    ).catch(() => problems.push('вторая модель не загрузилась'));
                    clash = await checkClash(page);
                    dxfBlocks = await checkDxfBlocks(page);
                } finally {
                    await fs.rm(second, { force: true });
                }
            }
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
    if (toast) console.log(`тосты:     API ${toast.shown ? 'ок' : 'НЕТ'}, из UI ${toast.fromUi ? 'ок' : 'НЕТ'}`);
    if (clash) console.log(`коллизии:  пар ${clash.pairs}, за ${clash.ms} мс`);
    if (dxfBlocks) console.log(`блоки DXF: ${dxfBlocks.ok ? `раскрыты верно, габарит ${dxfBlocks.size}` : 'ОШИБКА'}`);

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
