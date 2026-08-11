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
import { makeGeoIfc } from './fixtures/make-geo-ifc.mjs';
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
let train = null;
let coordPin = null;
let ruler = null;
let reload = null;
let bvhPeak = -1;
let viewCube = null;
let draw = null;

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
 * Метка координат. Проверяем не «появилась подпись», а совпадение чисел с тем,
 * что вьювер считает абсолютной координатой той же точки: метка и строка
 * состояния обязаны показывать одно и то же, иначе по ней нельзя сверяться
 * с Civil 3D.
 */
async function checkCoordPin(page) {
    const box = await page.locator('#stage canvas').boundingBox();
    if (!box) {
        problems.push('не найден холст для метки координат');
        return null;
    }
    await page.evaluate(() => document.getElementById('btnCoordPin')?.click());
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const offsets = [0, 0.08, -0.08, 0.16, -0.16];

    let text = null;
    for (const dx of offsets) {
        for (const dy of offsets) {
            if (text) break;
            await page.mouse.click(cx + dx * box.width, cy + dy * box.height);
            text = await page
                .waitForFunction(
                    () => document.querySelector('.coord-pin-label')?.textContent || false,
                    { timeout: 1500 }
                )
                .then((h) => h.jsonValue())
                .catch(() => null);
        }
    }
    await page.evaluate(() => document.getElementById('btnCoordPin')?.click());

    if (!text) {
        problems.push('метка координат не поставилась по клику');
        return null;
    }
    const nums = /X\s*(-?[\d.]+)\s*Y\s*(-?[\d.]+)\s*Z\s*(-?[\d.]+)/.exec(text.replace(/\s+/g, ' '));
    if (!nums) {
        problems.push('в метке нет трёх координат: ' + text.slice(0, 60));
        return null;
    }
    const shown = [Number(nums[1]), Number(nums[2]), Number(nums[3])];

    // Тот же пересчёт, но от позиции самой метки в сцене
    const truth = await page.evaluate(() => {
        const pin = window.BimLvaDebug?.coordPins?.[0];
        if (!pin) return null;
        return window.BimLvaDebug.absoluteAt(pin.x, pin.y, pin.z);
    });
    if (!truth) {
        problems.push('метка не попала в BimLvaDebug.coordPins');
        return null;
    }
    const diff = Math.max(
        Math.abs(shown[0] - truth.e),
        Math.abs(shown[1] - truth.n),
        Math.abs(shown[2] - truth.h)
    );
    if (diff > 0.01) {
        problems.push(`метка показывает не те координаты: расхождение ${diff.toFixed(3)} м`);
    }
    // Метка не должна исчезать при очистке замеров — это разные слои
    await page.evaluate(() => document.getElementById('btnMeasure')?.click());
    await page.evaluate(() => document.getElementById('btnMeasure')?.click());
    const stillThere = await page.evaluate(() => !!document.querySelector('.coord-pin-label'));
    if (!stillThere) problems.push('метку стёрло переключением замеров');

    // Список меток: строка на метку, окно открывается и закрывается
    await page.evaluate(() => document.getElementById('btnCoordPinList')?.click());
    const rows = await page.locator('#pinsList .pin-row').count();
    if (rows !== 1) problems.push(`в списке меток ${rows} строк вместо 1`);
    const counter = await page.textContent('#pinsCount');
    if (counter.trim() !== '1') problems.push(`счётчик меток показывает «${counter}» вместо 1`);
    await page.evaluate(() => document.getElementById('pinsClose')?.click());

    // Перетаскивание точки: координаты обязаны поехать вслед за ней
    const dot = await page.locator('.coord-pin-dot').first().boundingBox();
    const before = await page.evaluate(() => window.BimLvaDebug.coordPins[0]);
    if (dot) {
        await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
        await page.mouse.down();
        await page.mouse.move(dot.x + 40, dot.y + 25, { steps: 6 });
        await page.mouse.up();
    }
    const after = await page.evaluate(() => window.BimLvaDebug.coordPins[0]);
    const movedBy = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
    if (movedBy < 0.01) {
        problems.push('точку метки не удалось перетащить');
    } else {
        const shownAfter = await page.evaluate(
            () => document.querySelector('.coord-pin-label').innerText.replace(/\s+/g, ' ')
        );
        const n = /X\s*(-?[\d.]+)\s*Y\s*(-?[\d.]+)\s*Z\s*(-?[\d.]+)/.exec(shownAfter);
        const truthAfter = await page.evaluate(
            () => window.BimLvaDebug.absoluteAt(...Object.values(window.BimLvaDebug.coordPins[0]))
        );
        const d2 = n ? Math.max(
            Math.abs(Number(n[1]) - truthAfter.e),
            Math.abs(Number(n[2]) - truthAfter.n),
            Math.abs(Number(n[3]) - truthAfter.h)
        ) : Infinity;
        if (d2 > 0.01) problems.push('после переноса подпись метки не обновилась');
    }

    return { shown, diff, movedBy };
}

/**
 * Черчение полилиний и выгрузка в DXF. Проверяем содержимое файла: координаты
 * обязаны быть мировыми (иначе чертёж ляжет у нуля, а не на площадке), 2D —
 * с одной отметкой на всю линию, и структура R12 (POLYLINE/VERTEX/SEQEND).
 */
async function checkDrawDxf(page) {
    const box = await page.locator('#stage canvas').boundingBox();
    if (!box) return null;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    const drawOne = async (kind, pts) => {
        await page.evaluate((k) => {
            const sel = document.getElementById('drawModeSelect');
            sel.value = k;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            const btn = document.getElementById('btnDraw');
            if (!btn.classList.contains('on')) btn.click();
        }, kind);
        for (const [dx, dy] of pts) {
            await page.mouse.click(cx + dx * box.width, cy + dy * box.height);
            await page.waitForTimeout(60);
        }
        await page.keyboard.press('Escape');
        await page.waitForTimeout(120);
    };

    await drawOne('3d', [[-0.12, -0.06], [0.0, 0.02], [0.11, -0.04]]);
    await drawOne('2d', [[-0.10, 0.10], [0.06, 0.12]]);
    await page.evaluate(() => {
        const btn = document.getElementById('btnDraw');
        if (btn.classList.contains('on')) btn.click();
    });

    const drawn = await page.evaluate(() => window.BimLvaDebug.drawn);
    if (drawn.length !== 2) {
        problems.push(`начерчено ${drawn.length} полилиний вместо 2 — клики не попали по геометрии`);
        return null;
    }
    const three = drawn.find((d) => d.kind === '3d');
    const flat = drawn.find((d) => d.kind === '2d');
    if (three.abs.length !== 3) problems.push(`в 3D-полилинии ${three.abs.length} точек вместо 3`);
    if (flat && flat.abs.length === 2) {
        const dz = Math.abs(flat.abs[0].z - flat.abs[1].z);
        if (dz > 1e-6) problems.push(`2D-полилиния получилась с перепадом ${dz.toFixed(3)} м`);
    }

    const dxf = await page.evaluate(() => window.BimLvaDebug.dxfPreview());
    const has = (t) => dxf.includes(t);
    if (!has('AC1009')) problems.push('в DXF нет версии AC1009 (R12)');
    if (!has('$INSUNITS')) problems.push('в DXF не указаны единицы');
    if (!has('LVA_3D') || !has('LVA_2D')) problems.push('в DXF нет слоёв LVA_2D/LVA_3D');
    if (!has('SEQEND')) problems.push('в DXF полилиния не закрыта SEQEND');
    if (!has('EOF')) problems.push('DXF без EOF');

    const vertexCount = (dxf.match(/\r\nVERTEX\r\n/g) || []).length;
    const wantVertex = drawn.reduce((n, d) => n + d.abs.length, 0);
    if (vertexCount !== wantVertex) {
        problems.push(`в DXF ${vertexCount} вершин вместо ${wantVertex}`);
    }

    // Мировые координаты: первая точка обязана попасть в файл как есть
    const first = three.abs[0];
    const wantX = first.x.toFixed(6);
    if (!dxf.includes(wantX)) {
        problems.push(`в DXF нет мировой координаты X ${wantX} — выгрузка ушла в локальных`);
    }
    return { polylines: drawn.length, vertices: vertexCount, x: first.x };
}

/**
 * Видовой куб. Проверяем не «кнопка нажалась», а куда встала камера: вид
 * сверху обязан смотреть строго вниз, вид с юга — строго на север, иначе
 * это не стандартный вид, а «примерно похоже».
 */
async function checkViewCube(page) {
    const views = await page.evaluate(async () => {
        const out = {};
        const cam = () => {
            const d = window.BimLvaDebug.cameraDir;
            return { x: +d.x.toFixed(3), y: +d.y.toFixed(3), z: +d.z.toFixed(3) };
        };
        for (const name of ['top', 'bottom', 'front', 'back', 'left', 'right']) {
            document.querySelector(`#viewCube .vc-btn[data-view="${name}"]`).click();
            await new Promise((r) => setTimeout(r, 60));
            out[name] = cam();
        }
        return out;
    });
    // Взгляд из камеры на цель: сверху смотрим вниз (−Z), с юга — на север (+Y)
    const want = {
        top: [0, 0, -1], bottom: [0, 0, 1],
        front: [0, 1, 0], back: [0, -1, 0],
        left: [1, 0, 0], right: [-1, 0, 0]
    };
    for (const [name, w] of Object.entries(want)) {
        const got = views[name];
        const off = Math.max(Math.abs(got.x - w[0]), Math.abs(got.y - w[1]), Math.abs(got.z - w[2]));
        if (off > 0.02) {
            problems.push(
                `вид «${name}»: камера смотрит (${got.x}, ${got.y}, ${got.z}), ожидалось (${w.join(', ')})`
            );
        }
    }
    // С выделением куб обязан кадрировать элемент, а не всю сцену
    const zoom = await page.evaluate(async () => {
        const row = document.querySelector('#tree .trow[data-eid]');
        if (!row) return null;
        row.click();
        await new Promise((r) => setTimeout(r, 150));
        document.querySelector('#viewCube .vc-btn[data-view="top"]').click();
        await new Promise((r) => setTimeout(r, 150));
        const t = window.BimLvaDebug.cameraTarget;
        const sel = window.BimLvaDebug.selectionCentre;
        return sel ? { t, sel } : null;
    });
    if (!zoom) {
        problems.push('не удалось выделить элемент для проверки зума видовым кубом');
    } else {
        const off = Math.hypot(zoom.t.x - zoom.sel.x, zoom.t.y - zoom.sel.y, zoom.t.z - zoom.sel.z);
        if (off > 0.5) {
            problems.push(`видовой куб с выделением смотрит мимо элемента на ${off.toFixed(1)} м`);
        }
    }
    await page.evaluate(() => document.getElementById('btnClearSelection')?.click());

    return views;
}

/**
 * «Обновить модель» из контекстного меню дерева. Перечитать файл «по пути»
 * браузер не даёт, поэтому подменяем showOpenFilePicker — тот же путь, что
 * отработает у пользователя без FileSystemFileHandle.
 */
async function checkReload(page, port) {
    const fresh = path.join(ROOT, 'tools', 'fixtures', 'reload-b.ifc');
    await fs.writeFile(fresh, makeGeoIfc({
        worldX: 0, worldY: 0, worldZ: 0, count: 24, cols: 6, seed: 4242, name: 'reload-b.ifc'
    }));
    try {
        await page.evaluate(async (url) => {
            const text = await (await fetch(url)).text();
            const file = new File([text], 'reload-b.ifc', { type: 'application/octet-stream' });
            window.showOpenFilePicker = async () => [{
                kind: 'file',
                getFile: async () => file,
                queryPermission: async () => 'granted'
            }];
        }, `http://127.0.0.1:${port}/tools/fixtures/reload-b.ifc`);

        const before = await page.evaluate(() => (window.BimLvaDebug?.modelBounds || []).map((m) => m.file));
        const opened = await page.evaluate(() => {
            const row = document.querySelector('#tree .file-root .trow');
            if (!row) return false;
            row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }));
            return !!document.getElementById('ctxReloadFile');
        });
        if (!opened) {
            problems.push('в контекстном меню дерева нет пункта «Обновить модель»');
            return null;
        }
        await page.evaluate(() => document.getElementById('ctxReloadFile').click());

        const after = await page
            .waitForFunction(() => {
                const list = window.BimLvaDebug?.modelBounds || [];
                return list.some((m) => /reload-b\.ifc$/i.test(m.file)) ? list : false;
            }, { timeout: 60_000 })
            .then((h) => h.jsonValue())
            .catch(() => null);

        if (!after) {
            problems.push('модель не обновилась: нового файла нет в сцене');
            return null;
        }
        // Обновление не должно ни плодить дубли, ни трогать соседние модели
        const names = after.map((m) => m.file);
        if (names.length !== before.length) {
            problems.push(`после обновления моделей ${names.length}, было ${before.length}`);
        }
        const replaced = before.find((n) => !names.includes(n));
        const untouched = before.filter((n) => names.includes(n)).length;
        if (!replaced) problems.push('старая версия модели осталась в сцене — получился дубль');
        if (untouched !== before.length - 1) {
            problems.push('обновление задело соседние модели');
        }
        return { was: replaced, now: 'reload-b.ifc', kept: untouched };
    } finally {
        await fs.rm(fresh, { force: true });
    }
}

/**
 * Линейка 2D/3D/уклон. Проверяем не наличие подписи, а согласованность чисел:
 * горизонтальное проложение не может быть длиннее наклонного, а уклон обязан
 * сойтись с ΔZ/L2D — иначе по нему нельзя считать сети.
 */
async function checkRuler(page) {
    const box = await page.locator('#stage canvas').boundingBox();
    if (!box) return null;
    await page.evaluate(() => {
        document.getElementById('btnMeasure').click();
        const sel = document.getElementById('measureModeSelect');
        sel.value = 'ruler';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    // Вторая точка — ниже и в стороне, чтобы попасть на другую высоту:
    // на плоской крыше ΔZ вышел бы нулевым и проверка уклона стала бы холостой.
    await page.mouse.click(cx - box.width * 0.10, cy - box.height * 0.12);
    await page.mouse.click(cx + box.width * 0.12, cy + box.height * 0.18);
    const text = await page
        .waitForFunction(() => {
            const l = [...document.querySelectorAll('.measure-label')]
                .map((d) => d.innerText).find((t) => /L3D/.test(t));
            return l || false;
        }, { timeout: 3000 })
        .then((h) => h.jsonValue())
        .catch(() => null);
    await page.evaluate(() => document.getElementById('btnMeasure').click());

    if (!text) {
        problems.push('линейка не выдала замер (нужны две точки по геометрии)');
        return null;
    }
    const num = (re) => { const m = re.exec(text); return m ? Number(m[1]) : NaN; };
    const l3d = num(/L3D\s+([\d.]+)/);
    const l2d = num(/L2D\s+([\d.]+)/);
    const dz = num(/ΔZ\s+([+-]?[\d.]+)/);
    const perMille = num(/i\s+([+-]?[\d.]+)\s*‰/);

    if (!(l2d <= l3d + 1e-6)) {
        problems.push(`линейка: L2D ${l2d} больше L3D ${l3d}`);
    }
    if (Math.abs(Math.hypot(l2d, dz) - l3d) > 0.01) {
        problems.push(`линейка: L3D не сходится с L2D и ΔZ (${l3d} vs ${Math.hypot(l2d, dz).toFixed(3)})`);
    }
    if (Number.isFinite(perMille) && l2d > 1e-6) {
        const want = dz / l2d * 1000;
        if (Math.abs(want - perMille) > 0.2) {
            problems.push(`линейка: уклон ${perMille}‰ не равен ΔZ/L2D (${want.toFixed(1)}‰)`);
        }
    }
    // Формулу уклона проверяем числами: на плоской фикстуре ΔZ выходит нулевым,
    // и клики её не задевают.
    const slopes = await page.evaluate(() => ({
        down: window.BimLvaDebug.slopeText(-1, 100),
        up: window.BimLvaDebug.slopeText(2.5, 50),
        flat: window.BimLvaDebug.slopeText(0, 30),
        vert: window.BimLvaDebug.slopeText(3, 0),
        steep: window.BimLvaDebug.slopeText(1, 2)
    }));
    const wantSlopes = {
        down: '-10.0 ‰ (-1.00 %) · 1:100',
        up: '50.0 ‰ (5.00 %) · 1:20',
        flat: '0.0 ‰ (0.00 %) · горизонтально',
        vert: 'вертикально',
        steep: '500.0 ‰ (50.00 %) · 1:2.00'
    };
    for (const [k, want] of Object.entries(wantSlopes)) {
        if (slopes[k] !== want) {
            problems.push(`уклон (${k}): «${slopes[k]}», ожидалось «${want}»`);
        }
    }

    return { l3d, l2d, dz, perMille };
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
        await page.setInputFiles('#localFileInput', fixture);
        // Ждём именно габарит, а не счётчик моделей: модель попадает в список
        // раньше, чем её группа наполняется геометрией, и проверка успевала
        // спросить размеры у пустой группы.
        const bounds = await page
            .waitForFunction(
                () => (window.BimLvaDebug?.modelBounds || [])
                    .find((m) => /smoke-blocks\.dxf$/i.test(m.file)) || false,
                { timeout: 60_000 }
            )
            .then((h) => h.jsonValue())
            .catch(() => null);
        if (!bounds) {
            problems.push('DXF с блоками не загрузился или вставки не раскрылись — геометрии в сцене нет');
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

/**
 * Взаимное положение геопривязанных файлов в сводке.
 *
 * Регрессия, которую поймал не тест, а пользователь: COORDINATE_TO_ORIGIN
 * включался для любой геодезической модели, web-ifc сдвигал КАЖДЫЙ файл к его
 * собственному центру (и не сообщал, на сколько — GetCoordinationMatrix отдаёт
 * нули), поэтому шесть файлов одной дороги схлопывались в кучу у нуля.
 * Габариты при этом оставались правильными, и по ним поломка не видна —
 * проверяем именно расстояние между центрами.
 */
/**
 * Локомотив тура. Проверяем не «нарисовалось ли что-то», а размеры: модель
 * заявлена в натуральную величину и по ней прикидывают проезд под путепроводом.
 * Отдельно — что низ колёс лежит на нуле (УГР), иначе поезд утонет в рельефе,
 * и что сложенный токоприёмник не выходит за габарит 1-Т (5300 мм, ГОСТ 9238).
 */
async function checkTourTrain(page) {
    await page.evaluate(() => document.getElementById('btnTour')?.click());
    const ok = await page.evaluate(() => {
        const sel = document.getElementById('tourGroundVehicle');
        if (!sel) return false;
        sel.value = 'train';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    });
    if (!ok) {
        problems.push('в туре нет выбора транспорта (#tourGroundVehicle)');
        return null;
    }
    const box = await page
        .waitForFunction(() => {
            const b = window.BimLvaDebug?.tourVehicleBox;
            return b && b.kind === 'train' ? b : false;
        }, { timeout: 30_000 })
        .then((h) => h.jsonValue())
        .catch(() => null);
    await page.evaluate(() => document.getElementById('tourCloseBtn')?.click());
    if (!box) {
        problems.push('локомотив тура не построился');
        return null;
    }
    const near = (got, want, tol) => Math.abs(got - want) <= tol;
    const checks = [
        [near(box.length, 22.0, 0.15), `длина ${box.length.toFixed(2)} м, ожидалось 22.0`],
        [near(box.width, 3.10, 0.05), `ширина ${box.width.toFixed(2)} м, ожидалось 3.10`],
        [near(box.bottom, 0, 0.02), `низ колёс на ${box.bottom.toFixed(2)} м вместо УГР 0`],
        [box.height <= 5.3, `высота ${box.height.toFixed(2)} м вышла за габарит 1-Т (5.30)`],
        [box.height >= 4.6, `высота ${box.height.toFixed(2)} м — крыша ниже 4.60, модель схлопнулась`]
    ];
    checks.filter(([good]) => !good).forEach(([, msg]) => problems.push('локомотив: ' + msg));
    return box;
}

async function checkGeoFederation(page) {
    const a = path.join(ROOT, 'tools', 'fixtures', 'smoke-geo-a.ifc');
    const b = path.join(ROOT, 'tools', 'fixtures', 'smoke-geo-b.ifc');
    const GAP = 800; // м между площадками
    const base = { worldX: 456_000, worldY: 6_188_000, worldZ: 60, count: 60, cols: 10 };
    await fs.writeFile(a, makeGeoIfc({ ...base, seed: 0, name: 'smoke-geo-a.ifc' }));
    await fs.writeFile(b, makeGeoIfc({ ...base, worldX: base.worldX + GAP, seed: 5000, name: 'smoke-geo-b.ifc' }));
    try {
        await page.setInputFiles('#localFileInput', [a, b]);
        const bounds = await page
            .waitForFunction(
                () => {
                    const list = (window.BimLvaDebug?.modelBounds || [])
                        .filter((m) => /smoke-geo-[ab]\.ifc$/i.test(m.file));
                    return list.length === 2 ? list : false;
                },
                { timeout: 90_000 }
            )
            .then((h) => h.jsonValue())
            .catch(() => null);
        if (!bounds) {
            problems.push('геопривязанные IFC не загрузились — взаимное положение не проверить');
            return null;
        }
        const [m1, m2] = bounds;
        const dist = Math.hypot(m1.centerX - m2.centerX, m1.centerY - m2.centerY, m1.centerZ - m2.centerZ);
        const ok = Math.abs(dist - GAP) < GAP * 0.05;
        if (!ok) {
            problems.push(
                `геопривязанные файлы встали в ${dist.toFixed(0)} м друг от друга вместо ${GAP} — ` +
                (dist < 50
                    ? 'модели схлопнулись в кучу (COORDINATE_TO_ORIGIN сбросил координаты каждого файла)'
                    : 'взаимное положение искажено')
            );
        }
        return { ok, dist };
    } finally {
        await fs.rm(a, { force: true });
        await fs.rm(b, { force: true });
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
    let geoFed = null;
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
                    coordPin = await checkCoordPin(page);
                    ruler = await checkRuler(page);
                    // BVH снимаем до обновления: новая модель маленькая и своего
                    // дерева не строит, а финальная проверка смотрит на итог сцены
                    bvhPeak = await page.evaluate(() => window.BimLvaDebug?.bvhCount ?? -1);
                    draw = await checkDrawDxf(page);
                    viewCube = await checkViewCube(page);
                    reload = await checkReload(page, port);
                    geoFed = await checkGeoFederation(page);
                    train = await checkTourTrain(page);
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

    if (state.bvhCount === 0 && bvhPeak <= 0) {
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
    if (coordPin) {
        console.log(
            `метка XYZ:  ${coordPin.shown.map((v) => v.toFixed(2)).join(' · ')} ` +
            `(расхождение со статус-баром ${coordPin.diff.toFixed(3)} м, ` +
            `перенос точки ${coordPin.movedBy.toFixed(2)} м)`
        );
    }
    if (ruler) {
        console.log(
            `линейка:   L3D ${ruler.l3d.toFixed(2)} · L2D ${ruler.l2d.toFixed(2)} · ` +
            `ΔZ ${ruler.dz.toFixed(2)} · i ${ruler.perMille.toFixed(1)} ‰`
        );
    }
    if (draw) {
        console.log(
            `черчение:  полилиний ${draw.polylines}, вершин в DXF ${draw.vertices}, ` +
            `мировая X ${draw.x.toFixed(2)}`
        );
    }
    if (viewCube) console.log('видовой куб: 6 стандартных видов встали по осям');
    if (reload) {
        console.log(
            `обновление: «${reload.was}» → «${reload.now}», ` +
            `соседних моделей не тронуто ${reload.kept}`
        );
    }
    if (train) {
        console.log(
            `локомотив: ${train.length.toFixed(2)} × ${train.width.toFixed(2)} × ${train.height.toFixed(2)} м ` +
            `(${train.model})`
        );
    }
    if (pick) console.log(`пикинг:    ${pick.ok ? `элемент выбран (${pick.label})` : 'НЕ РАБОТАЕТ'}`);
    if (toast) console.log(`тосты:     API ${toast.shown ? 'ок' : 'НЕТ'}, из UI ${toast.fromUi ? 'ок' : 'НЕТ'}`);
    if (clash) console.log(`коллизии:  пар ${clash.pairs}, за ${clash.ms} мс`);
    if (dxfBlocks) console.log(`блоки DXF: ${dxfBlocks.ok ? `раскрыты верно, габарит ${dxfBlocks.size}` : 'ОШИБКА'}`);
    if (geoFed) console.log(`геосводка: ${geoFed.ok ? `взаимное положение сохранено (${geoFed.dist.toFixed(0)} м)` : `СЛОМАНО (${geoFed.dist.toFixed(0)} м вместо 800)`}`);

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
