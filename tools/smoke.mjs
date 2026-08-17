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
let dxfEntities = null;
let sweep = null;
let slope = null;
let roadXs = null;

/** Обратное к шифру ACIS в DXF (как ezdxf.tools.crypt.decode). */
function dxfSatDecrypt(s) {
    let out = '';
    let skipSpace = false;
    for (const ch of s) {
        if (skipSpace && ch === ' ') { skipSpace = false; continue; }
        skipSpace = false;
        const c = ch.charCodeAt(0);
        if (c === 0x20) out += ' ';
        else if (c === 0x40) out += '_';
        else if (c === 0x5F) out += '@';
        else if (c >= 0x41 && c <= 0x5E) {
            const dec = String.fromCharCode(0x41 + (0x5E - c));
            out += dec;
            if (dec === 'A') skipSpace = true;
        } else out += String.fromCharCode(c ^ 0x5F);
    }
    return out;
}

/** Склеить группы 1/3 внутри 3DSOLID и расшифровать SAT. */
function dxfSatPayload(dxf) {
    const lines = String(dxf).split(/\r?\n/);
    const chunks = [];
    let buf = '';
    let inSolid = false;
    for (let i = 0; i + 1 < lines.length; i += 2) {
        const code = lines[i].trim();
        const val = lines[i + 1];
        if (code === '0' && val.trim() === '3DSOLID') {
            if (buf) { chunks.push(dxfSatDecrypt(buf)); buf = ''; }
            inSolid = true;
            continue;
        }
        if (inSolid && code === '0') {
            if (buf) { chunks.push(dxfSatDecrypt(buf)); buf = ''; }
            inSolid = false;
            continue;
        }
        if (inSolid && code === '1') {
            if (buf) chunks.push(dxfSatDecrypt(buf));
            buf = val;
            continue;
        }
        if (inSolid && code === '3') {
            buf += val;
        }
    }
    if (buf) chunks.push(dxfSatDecrypt(buf));
    return chunks.join('\n');
}

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
 * ПКМ по элементу → «Выбрать подобные»: должна выделить остальные элементы
 * того же IFC-класса. Фикстура smoke-grid.ifc — все IFCWALL одного класса,
 * поэтому ожидаем ровно столько элементов, сколько их в модели.
 */
async function checkSelectSimilar(page) {
    const box = await page.locator('#stage canvas').boundingBox();
    if (!box) {
        problems.push('не найден холст для проверки «Выбрать подобные»');
        return null;
    }
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const offsets = [0, 0.08, -0.08, 0.16, -0.16];

    for (const dx of offsets) {
        for (const dy of offsets) {
            const x = cx + dx * box.width;
            const y = cy + dy * box.height;
            await page.mouse.click(x, y);
            const before = await page.evaluate(() => document.getElementById('sSelected')?.textContent || '0');
            if (before === '0' || before === '') continue;

            await page.mouse.click(x, y, { button: 'right' });
            const menuShown = await page.locator('#stageCtx.show').count().catch(() => 0);
            if (!menuShown) continue;
            const disabled = await page.evaluate(
                () => document.getElementById('ctxSelectSimilar')?.classList.contains('disabled')
            );
            if (disabled) {
                await page.mouse.click(10, 10); // закрыть меню, не задев сцену
                continue;
            }
            await page.click('#ctxSelectSimilar');
            const after = await page
                .waitForFunction(
                    (prev) => {
                        const t = document.getElementById('sSelected')?.textContent || '0';
                        return t !== prev ? t : false;
                    },
                    before,
                    { timeout: 2000 }
                )
                .then((h) => h.jsonValue())
                .catch(() => null);
            if (after) return { ok: true, before: Number(before), after: Number(after) };
        }
    }
    problems.push('«Выбрать подобные» не сработала ни в одной точке клика');
    return { ok: false };
}

/**
 * Сущности DXF. Слой склеивается в один объект ради скорости отрисовки, но
 * каждая линия должна опознаваться по диапазону вершин: иначе в дереве видно
 * только слой, а отдельную ось не выбрать. Проверяем и дерево, и клик в сцене.
 */
async function checkDxfEntities(page) {
    const rows = await page.evaluate(() => {
        const root = [...document.querySelectorAll('#tree .file-root')]
            .find((r) => /smoke-blocks\.dxf/i.test(r.textContent || ''));
        if (!root) return null;
        const labels = [...root.querySelectorAll('.tlabel')].map((n) => n.textContent.trim());
        return labels.filter((t) => /^(Отрезок|Полилиния|Дуга|Точка|3D-грань|Сетка) #\d+$/.test(t));
    });
    if (!rows) {
        problems.push('в дереве нет ветки DXF-файла');
        return null;
    }
    if (!rows.length) {
        problems.push('сущности DXF не попали в дерево — виден только слой');
        return null;
    }

    // Клик по строке сущности обязан выделить именно её, а не весь слой
    const picked = await page.evaluate(() => {
        const row = [...document.querySelectorAll('#tree .trow')]
            .find((r) => /^(Отрезок|Полилиния|Дуга|3D-грань) #\d+$/.test(
                r.querySelector('.tlabel')?.textContent.trim() || ''));
        if (!row) return null;
        row.click();
        return document.getElementById('sSelected')?.textContent || null;
    });
    await page.waitForTimeout(200);
    const props = await page.textContent('#props');
    if (picked !== '1') problems.push(`клик по сущности DXF выделил ${picked} элементов вместо 1`);
    if (!/Слой/.test(props)) problems.push('в свойствах сущности DXF нет слоя');
    if (!/Сущность/.test(props)) problems.push('в свойствах сущности DXF нет её типа');

    // Опознание по вершине — то же, что при клике в сцене. Проверяем обе
    // границы каждого диапазона: бинарный поиск ломается именно на них.
    const probe = await page.evaluate(() => window.BimLvaDebug.dxfProbe);
    if (!probe) {
        problems.push('не нашлось объекта DXF с диапазонами сущностей');
    } else {
        const bad = probe.at.filter((p, i) => p.id !== probe.spans[Math.floor(i / 2)].id);
        if (bad.length) {
            problems.push(`опознание сущности по вершине врёт в ${bad.length} случаях из ${probe.at.length}`);
        }
        if (probe.outside !== null) {
            problems.push('вершина за пределами диапазонов опозналась как сущность');
        }
    }

    await page.evaluate(() => document.getElementById('btnClearSelection')?.click());

    // «Выбрать подобные» для DXF: те же слой+тип сущности. Все 4 сущности
    // фикстуры — раскрытые вставки одного и того же полилинии-блока на одном
    // слое, поэтому ожидаем, что найдутся все.
    const similarOk = await page.evaluate(() => window.BimLvaDebug.selectSimilarByFile('smoke-blocks', 'polyline'));
    await page.waitForTimeout(150);
    const similarCount = await page.evaluate(() => document.getElementById('sSelected')?.textContent || '0');
    if (!similarOk) {
        problems.push('«Выбрать подобные» (DXF) не нашла сущность для старта');
    } else if (Number(similarCount) !== rows.length) {
        problems.push(`«Выбрать подобные» (DXF): выделила ${similarCount} вместо ${rows.length}`);
    }
    await page.evaluate(() => document.getElementById('btnClearSelection')?.click());

    return { entities: rows.length, spans: probe ? probe.spans.length : 0, similar: Number(similarCount) };
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
 * Вертикальный переход на полилинии — «разрезать и поднять середину», как
 * LVA_RaisePipeVertical в плагине Civil. Проверяем геометрию, а не меткость
 * мыши: на вход идут доли вдоль отрезков, наружу — инварианты.
 *
 * Главный из них — стояки СТРОГО вертикальны в плане. Если перелом уедет по
 * X/Y хоть на сантиметр, Civil перестанет сам подбирать отводы на стыках, а
 * заметить это на глаз в изометрии нельзя.
 */
async function checkVerticalTransition(page, cx, cy, box) {
    // Чертим СВОЮ линию, а не берём чужую: к этому моменту список переживает
    // пару очисток, а переход добавляет вершины — на общей линии он ломал бы
    // проверки, которые считают их по снимку, снятому раньше.
    // Числами, а не мышью: нужна предсказуемая геометрия, а не меткость клика.
    await page.evaluate(() => {
        const b = document.getElementById('btnDraw');
        if (!b.classList.contains('on')) b.click();
    });
    await page.evaluate(() => {
        const sel = document.getElementById('drawModeSelect');
        if (sel) { sel.value = '3d'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    let ok0 = null;
    for (const [dx, dy] of [[0, 0], [0.08, 0.05], [-0.08, -0.05], [0.12, -0.04]]) {
        await page.mouse.click(cx + dx * box.width, cy + dy * box.height);
        await page.waitForTimeout(90);
        ok0 = await page.evaluate(() => window.BimLvaDebug.drawDraftPoints);
        if (ok0) break;
    }
    if (!ok0) {
        problems.push('вертикальный переход: не удалось поставить первую точку линии');
        return null;
    }
    const id = await page.evaluate(() => {
        const D = window.BimLvaDebug;
        D.drawPointByNumbers(20, 90, 2);
        D.drawPointByNumbers(20, 0, 2);
        D.drawPointByNumbers(20, 90, 2);
        return D.finishDrawnPolyline();
    });
    await page.evaluate(() => {
        const b = document.getElementById('btnDraw');
        if (b.classList.contains('on')) b.click();
    });
    const before = await page.evaluate((i) => window.BimLvaDebug.drawn.find((d) => d.id === i) || null, id);
    if (!before || before.points < 3) {
        problems.push(`вертикальный переход: линия не начертилась (${before ? before.points + ' вершин' : 'нет записи'})`);
        return null;
    }

    const A = { i: 0, t: 0.5 };
    const B = { i: 1, t: 0.5 };
    const TARGET = 40;                    // абсолютная отметка участка, м
    const ok = await page.evaluate(([pid, a, b, z]) => window.BimLvaDebug.verticalTransition(
        pid, a, b, { mode: 'z', value: z }
    ), [id, A, B, TARGET]);
    if (!ok) {
        problems.push('вертикальный переход не выполнился');
        return null;
    }

    const after = await page.evaluate((i) => window.BimLvaDebug.drawn.find((d) => d.id === i), id);
    if (after.points !== before.points + 4) {
        problems.push(`вертикальный переход: вершин ${after.points}, ожидалось ${before.points + 4} (по два на стояк)`);
        return null;
    }

    // Раскладка после вставки: [… A.i, aRise, aTop, …середина…, bTop, bFall, …]
    // Вставка у B идёт первой, поэтому её пара сдвинута ещё на две позиции.
    const v = after.vertsAbs;
    const riserA = [A.i + 1, A.i + 2];
    const riserB = [B.i + 3, B.i + 4];
    for (const [a, b] of [riserA, riserB]) {
        const plan = Math.hypot(v[b].x - v[a].x, v[b].y - v[a].y);
        if (plan > 0.001) {
            problems.push(`стояк вертикального перехода уехал в плане на ${plan.toFixed(3)} м — отводы не сядут`);
        }
        if (Math.abs(v[b].z - v[a].z) < 0.001) {
            problems.push('стояк вертикального перехода получился нулевой высоты');
        }
    }

    // Всё между верхами стояков лежит на заданной отметке.
    const mid = v.slice(riserA[1], riserB[0] + 1);
    const off = Math.max(...mid.map((p) => Math.abs(p.z - TARGET)));
    if (off > 0.001) {
        problems.push(`середина перехода отклонилась на ${off.toFixed(3)} м от отметки ${TARGET}`);
    }

    // За пределами участка ничего не поехало.
    const tailBefore = before.vertsAbs[before.points - 1];
    const tailAfter = v[after.points - 1];
    if (Math.abs(v[0].z - before.vertsAbs[0].z) > 1e-6 || Math.abs(tailAfter.z - tailBefore.z) > 1e-6) {
        problems.push('вертикальный переход сдвинул отметки за пределами участка');
    }
    return { added: after.points - before.points, target: TARGET };
}

/**
 * Черчение полилиний и выгрузка в DXF. Проверяем содержимое файла: координаты
 * обязаны быть мировыми (иначе чертёж ляжет у нуля, а не на площадке), 2D —
 * с одной отметкой на всю линию, и POLYLINE/VERTEX/SEQEND (не LWPOLYLINE).
 * Файл — R2010 (AC1024): самая новая версия с 3DSOLID в SAT.
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

    // Резиновая нить: после ПЕРВОГО клика линия уже обязана тянуться за
    // курсором. Раньше черновик рисовался только с двух поставленных точек —
    // до второго клика не было видно, куда ведёшь.
    await page.evaluate(() => {
        const sel = document.getElementById('drawModeSelect');
        sel.value = '3d';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const btn = document.getElementById('btnDraw');
        if (!btn.classList.contains('on')) btn.click();
    });
    await page.mouse.click(cx - 0.12 * box.width, cy - 0.06 * box.height);
    await page.waitForTimeout(100);
    // Нить появляется в обработчике pointermove, а он на тяжёлой сцене успевает
    // не сразу — ждём условие, а не фиксированную паузу.
    const rubberBand = await (async () => {
        for (let i = 0; i < 12; i++) {
            await page.mouse.move(
                cx + (0.05 + i * 0.004) * box.width,
                cy + (0.03 + i * 0.004) * box.height
            );
            const n = await page.waitForFunction(
                () => (window.BimLvaDebug.drawDraftPoints >= 2 ? window.BimLvaDebug.drawDraftPoints : false),
                { timeout: 500 }
            ).then((h) => h.jsonValue()).catch(() => 0);
            if (n >= 2) return n;
        }
        return 0;
    })();
    if (!rubberBand) {
        problems.push('резиновая нить не появилась после первой точки');
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    await page.evaluate(() => {
        const btn = document.getElementById('btnDraw');
        if (btn.classList.contains('on')) btn.click();
    });

    // Четыре точки — два внутренних угла: только так проверяется, что радиус
    // ложится в УКАЗАННЫЙ угол, а не сразу во все.
    await drawOne('3d', [[-0.12, -0.06], [0.0, 0.02], [0.11, -0.04], [0.20, 0.03]]);
    // Три точки — есть внутренний угол, значит будет что выгрузить дугой
    await drawOne('2d', [[-0.10, 0.10], [0.06, 0.12], [0.18, 0.04]]);
    await page.evaluate(() => {
        const btn = document.getElementById('btnDraw');
        if (btn.classList.contains('on')) btn.click();
    });

    // Привязка: водим курсором по геометрии и ждём, что хотя бы раз поймается
    // вершина или середина, и что точка привязки не убегает от места клика.
    await page.evaluate(() => {
        const b = document.getElementById('btnDraw');
        if (!b.classList.contains('on')) b.click();
    });
    const snaps = [];
    for (let i = -6; i <= 6; i++) {
        const x = cx + (i * 0.014) * box.width;
        const y = cy + (i % 2 ? 0.02 : -0.02) * box.height;
        await page.mouse.move(x, y);
        await page.waitForTimeout(45);
        const snap = await page.evaluate(() => window.BimLvaDebug.snap);
        if (snap) snaps.push(snap);
    }
    await page.evaluate(() => {
        const b = document.getElementById('btnDraw');
        if (b.classList.contains('on')) b.click();
    });
    if (!snaps.length) {
        problems.push('объектная привязка ни разу не сработала на геометрии');
    } else {
        const kinds = new Set(snaps.map((s) => s.type));
        if (!kinds.has('vertex') && !kinds.has('mid')) {
            problems.push(`привязка поймала только ${[...kinds].join(', ')} — вершины и середины не находятся`);
        }
    }

    // Фильтр привязки: оставляем только «вершина» — середин и рёбер быть не
    // должно вовсе. Порог у типов разный, поэтому проверяем именно ТИП, а не
    // факт срабатывания.
    await page.evaluate(() => {
        const D = window.BimLvaDebug;
        D.setSnapType('mid', false);
        D.setSnapType('edge', false);
    });
    await page.evaluate(() => {
        const b = document.getElementById('btnDraw');
        if (!b.classList.contains('on')) b.click();
    });
    const filtered = [];
    for (let i = -6; i <= 6; i++) {
        await page.mouse.move(cx + (i * 0.014) * box.width, cy + (i % 2 ? 0.02 : -0.02) * box.height);
        await page.waitForTimeout(45);
        const s = await page.evaluate(() => window.BimLvaDebug.snap);
        if (s) filtered.push(s.type);
    }
    await page.evaluate(() => {
        const b = document.getElementById('btnDraw');
        if (b.classList.contains('on')) b.click();
    });
    const leaked = filtered.filter((t) => t !== 'vertex');
    if (leaked.length) {
        problems.push(`при фильтре «только вершина» поймались: ${[...new Set(leaked)].join(', ')}`);
    }
    // Страховка от «зелёного вхолостую»: если не сработало НИЧЕГО, проверка
    // ничего и не доказала — тех же граблей уже наступали в гео-тестах.
    if (!filtered.length) {
        problems.push('фильтр привязки: за весь проход не поймалось ни одной вершины — проверка вхолостую');
    }
    await page.evaluate(() => {
        const D = window.BimLvaDebug;
        D.setSnapType('mid', true);
        D.setSnapType('edge', true);
    });

    const drawn = await page.evaluate(() => window.BimLvaDebug.drawn);
    if (drawn.length !== 2) {
        problems.push(`начерчено ${drawn.length} полилиний вместо 2 — клики не попали по геометрии`);
        return null;
    }
    const three = drawn.find((d) => d.kind === '3d');
    const flat = drawn.find((d) => d.kind === '2d');
    if (three.abs.length !== 4) problems.push(`в 3D-полилинии ${three.abs.length} точек вместо 4`);
    if (flat && flat.abs.length >= 2) {
        const dz = Math.max(...flat.abs.map((p) => p.z)) - Math.min(...flat.abs.map((p) => p.z));
        if (dz > 1e-6) problems.push(`2D-полилиния получилась с перепадом ${dz.toFixed(3)} м`);
    }

    // Дуга сопряжения в DXF: для 2D она должна уйти bulge'ом (код 42), а не
    // ломаной. Ожидаемое значение считаем сами: bulge = tan(Δ/4), где Δ —
    // центральный угол дуги, он же π минус угол при вершине.
    if (flat && flat.points >= 3) {
        const bulgeProbe = await page.evaluate((id) => {
            const D = window.BimLvaDebug;
            D.setPolylineRadius(id, 1, 1.5);
            const rec = D.drawn.find((d) => d.id === id);
            const v = rec.vertsAbs;
            const ax = v[0].x - v[1].x, ay = v[0].y - v[1].y;
            const bx = v[2].x - v[1].x, by = v[2].y - v[1].y;
            const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
            const alpha = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb))));
            const ccw = ((-ax) * by - (-ay) * bx) > 0;
            return {
                out: D.dxfVertices(id),
                want: Math.tan((Math.PI - alpha) / 4) * (ccw ? 1 : -1)
            };
        }, flat.id);
        if (!bulgeProbe.out?.arcs) {
            problems.push('дуга 2D-полилинии не ушла в DXF как дуга');
        } else {
            const got = bulgeProbe.out.verts.map((v) => v.bulge).find((b) => Math.abs(b) > 1e-9);
            if (got == null || Math.abs(got - bulgeProbe.want) > 1e-4) {
                problems.push(`bulge дуги ${got} вместо ${bulgeProbe.want.toFixed(6)}`);
            }
        }
        const dxfBulge = await page.evaluate(() => window.BimLvaDebug.dxfPreview());
        if (!/\r\n42\r\n/.test(dxfBulge)) problems.push('в DXF нет кода 42 (bulge) — дуга выгрузилась ломаной');
        await page.evaluate((id) => window.BimLvaDebug.setPolylineRadius(id, 1, 0), flat.id);
    }

    const dxf = await page.evaluate(() => window.BimLvaDebug.dxfPreview());
    const has = (t) => dxf.includes(t);
    if (!has('AC1024')) problems.push('в DXF нет версии AC1024 (R2010, 3DSOLID)');
    if (!has('$INSUNITS')) problems.push('в DXF не указаны единицы');
    if (!has('2Д') || !has('3Д')) problems.push('в DXF нет слоёв 2Д/3Д');
    if (!has('SEQEND')) problems.push('в DXF полилиния не закрыта SEQEND');
    if (!has('EOF')) problems.push('DXF без EOF');
    // Civil: «Ошибка в таблице APPID» на строке 242 — это слой 2Д в LAYER,
    // не APPID. R2010 без owner 330 и файл в 1251 вместо UTF-8 ломают импорт.
    if (!/\r\n0\r\nTABLE\r\n2\r\nAPPID\r\n5\r\n[0-9A-F]+\r\n330\r\n0\r\n/.test(dxf)) {
        problems.push('таблица APPID без owner 330 — Civil 3D не откроет R2010');
    }
    if (!/\r\n0\r\nAPPID\r\n5\r\n[0-9A-F]+\r\n330\r\n[0-9A-F]+\r\n/.test(dxf)) {
        problems.push('запись APPID без owner 330');
    }
    if (!has('ACAD_PLOTSTYLENAME')) problems.push('в DXF нет ACAD_PLOTSTYLENAME');
    if (!/\r\n370\r\n-3\r\n390\r\n/.test(dxf)) {
        problems.push('у LAYER нет lineweight/plotstyle (370/390)');
    }
    const dxfBytes = await page.evaluate(() => window.BimLvaDebug.dxfDownloadBytes());
    const utf8De = [0x32, 0xD0, 0x94]; // «2Д» в UTF-8
    const cp1251De = [0x32, 0xC4];     // «2Д» в Windows-1251
    const hasSeq = (hay, needle) => {
        outer: for (let i = 0; i <= hay.length - needle.length; i++) {
            for (let j = 0; j < needle.length; j++) {
                if (hay[i + j] !== needle[j]) continue outer;
            }
            return true;
        }
        return false;
    };
    if (!hasSeq(dxfBytes, utf8De)) {
        problems.push('скачиваемый DXF не содержит UTF-8 «2Д» — Civil 2010+ не откроет кириллические слои');
    }
    if (hasSeq(dxfBytes, cp1251De) && !hasSeq(dxfBytes, utf8De)) {
        problems.push('скачиваемый DXF в Windows-1251 — Civil читает AC1024 как UTF-8 и падает в APPID');
    }

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

    // Радиус сопряжения в средней вершине 3D-полилинии: точек должно стать
    // больше (вершина заменена дугой), а длина — короче ломаной, но не меньше
    // прямой между концами (дуга режет угол, но не спрямляет целиком).
    const last = three.abs[three.abs.length - 1];
    const straight = Math.hypot(
        last.x - three.abs[0].x, last.y - three.abs[0].y, last.z - three.abs[0].z
    );
    const filletOk = await page.evaluate(
        (id) => window.BimLvaDebug.setPolylineRadius(id, 1, 0.5),
        three.id
    );
    const filleted = await page.evaluate(
        (id) => window.BimLvaDebug.drawn.find((d) => d.id === id),
        three.id
    );
    if (!filletOk || !filleted) {
        problems.push('радиус сопряжения полилинии не применился');
    } else {
        if (filleted.abs.length <= three.abs.length) {
            problems.push(`сопряжение не добавило точек: было ${three.abs.length}, стало ${filleted.abs.length}`);
        }
        if (!(filleted.length3d < three.length3d && filleted.length3d > straight - 1e-6)) {
            problems.push(
                `длина после сопряжения ${filleted.length3d.toFixed(3)} вне диапазона ` +
                `(${straight.toFixed(3)} .. ${three.length3d.toFixed(3)})`
            );
        }
        // Ровно один угол, а не все: у второго внутреннего угла радиус остался 0
        const touched = filleted.radii.filter((r) => r > 0).length;
        if (touched !== 1) {
            problems.push(`радиус лёг в ${touched} углов вместо одного: [${filleted.radii.join(', ')}]`);
        }
        const guides = await page.evaluate(
            (id) => window.BimLvaDebug.filletGuides(id),
            three.id
        );
        if (!guides?.length) {
            problems.push('после сопряжения нет пунктирных тангенсов до вершины');
        } else {
            if (guides.length !== 1) {
                problems.push(`тангенсов сопряжения ${guides.length} вместо 1`);
            }
            const g = guides[0];
            const v = three.vertsAbs[1];
            const dv = Math.hypot(g.vertex.x - v.x, g.vertex.y - v.y, g.vertex.z - v.z);
            if (dv > 1e-4) {
                problems.push(`тангенс сопряжения не к той вершине (сдвиг ${dv.toFixed(4)} м)`);
            }
            const dIn = Math.hypot(g.tangentIn.x - v.x, g.tangentIn.y - v.y, g.tangentIn.z - v.z);
            const dOut = Math.hypot(g.tangentOut.x - v.x, g.tangentOut.y - v.y, g.tangentOut.z - v.z);
            if (dIn < 1e-4 || dOut < 1e-4) {
                problems.push('тангенс сопряжения выродился в точку');
            }
            if (!g.dashed) problems.push('тангенсы сопряжения не пунктирные');
            if (!(g.width > 0 && g.width < (filleted.width || 2) - 1e-6)) {
                problems.push(`тангенсы сопряжения толщиной ${g.width} — ждали тоньше линии (${filleted.width})`);
            }
        }
    }

    // Клик/ПКМ по линии в сцене. Целимся по СПРОЕЦИРОВАННЫМ вершинам, а не по
    // точкам клика: объектная привязка уводит поставленную точку на ближайшую
    // вершину геометрии, и линия проходит не там, где был курсор.
    const linePick = await page.evaluate((id) => {
        const D = window.BimLvaDebug;
        const sp = D.polylineScreenPts(id);
        return sp.map((s) => (D.pickPolylineAt(s.clientX, s.clientY)?.id === id ? 1 : 0));
    }, three.id);
    if (linePick.some((ok) => !ok)) {
        problems.push(`клик по линии в сцене не попадает в ${linePick.filter((v) => !v).length} вершинах из ${linePick.length}`);
    }

    // Ручки вершин и перетаскивание. Сначала выбираем линию так же, как это
    // делает пользователь — кликом по ней в сцене (ручки показываются только у
    // раскрытой полилинии).
    const spSelect = await page.evaluate((id) => window.BimLvaDebug.polylineScreenPts(id), three.id);
    await page.mouse.click(spSelect[1].clientX, spSelect[1].clientY);
    await page.waitForTimeout(250);
    const handles = await page.evaluate(() => window.BimLvaDebug.polylineHandleCount);
    if (handles !== three.abs.length) {
        problems.push(`ручек вершин ${handles} вместо ${three.abs.length}`);
    } else {
        const before = await page.evaluate((id) => window.BimLvaDebug.drawn.find((d) => d.id === id).vertsAbs[0], three.id);
        const sp = await page.evaluate((id) => window.BimLvaDebug.polylineScreenPts(id), three.id);
        // Тянем первую вершину заметно в сторону и ждём, что план изменился
        await page.mouse.move(sp[0].clientX, sp[0].clientY);
        await page.mouse.down();
        await page.mouse.move(sp[0].clientX + 60, sp[0].clientY + 30, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(200);
        const after = await page.evaluate((id) => window.BimLvaDebug.drawn.find((d) => d.id === id).vertsAbs[0], three.id);
        const moved = Math.hypot(after.x - before.x, after.y - before.y);
        if (moved < 0.5) {
            problems.push(`перетаскивание вершины не сдвинуло её (${moved.toFixed(3)} м)`);
        }

        // Ctrl + тянуть — только высота: план обязан остаться на месте.
        const sp2 = await page.evaluate((id) => window.BimLvaDebug.polylineScreenPts(id), three.id);
        const beforeZ = await page.evaluate((id) => window.BimLvaDebug.drawn.find((d) => d.id === id).vertsAbs[0], three.id);
        await page.keyboard.down('Control');
        await page.mouse.move(sp2[0].clientX, sp2[0].clientY);
        await page.mouse.down();
        await page.mouse.move(sp2[0].clientX + 40, sp2[0].clientY - 70, { steps: 6 });
        await page.mouse.up();
        await page.keyboard.up('Control');
        await page.waitForTimeout(200);
        const afterZ = await page.evaluate((id) => window.BimLvaDebug.drawn.find((d) => d.id === id).vertsAbs[0], three.id);
        const planShift = Math.hypot(afterZ.x - beforeZ.x, afterZ.y - beforeZ.y);
        if (planShift > 1e-6) {
            problems.push(`Ctrl-перетаскивание сдвинуло план на ${planShift.toFixed(3)} м — должно менять только высоту`);
        }
        if (afterZ.z - beforeZ.z < 0.5) {
            problems.push(`Ctrl-перетаскивание вверх не подняло вершину (Δ ${(afterZ.z - beforeZ.z).toFixed(3)} м)`);
        }
    }

    // Выбор угла «под курсором»: просим угол рядом с вершиной #3 (индекс 2) и
    // ждём именно его, а не первый попавшийся внутренний.
    const cornerPick = await page.evaluate((id) => {
        const D = window.BimLvaDebug;
        const rec = D.drawn.find((d) => d.id === id);
        // Именно vertsAbs, а не abs: в abs уже лежат точки дуги от сопряжения
        // выше, и abs[2] — не вершина #3, а точка на дуге у вершины #2.
        const target = rec.vertsAbs[2];
        const near = D.absoluteToScene(target.x + 0.3, target.y + 0.3, target.z);
        return {
            picked: D.nearestPolylineCorner(id, near.x, near.y, near.z),
            interior: rec.points - 2
        };
    }, three.id);
    if (cornerPick.picked !== 2) {
        problems.push(`«вписать в этот угол» выбрал вершину #${cornerPick.picked + 1} вместо #3`);
    }

    // Цвет и толщина: у Line2 их держит LineMaterial, а не геометрия. Сверяем
    // именно материал — иначе проверка прошла бы и при неработающей толщине
    // (у обычной THREE.Line linewidth в WebGL молча игнорируется).
    await page.evaluate(() => document.getElementById('btnPolylineList')?.click());
    await page.evaluate(() => {
        const color = document.querySelector('#polylinesList .polyline-color');
        color.value = '#ff0000';
        color.dispatchEvent(new Event('input', { bubbles: true }));
        const width = document.querySelector('#polylinesList input[type="number"]');
        width.value = '6';
        width.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const style = await page.evaluate(
        (id) => window.BimLvaDebug.polylineStyle(id),
        drawn[0].id
    );
    if (style?.materialColor !== '#ff0000') {
        problems.push(`цвет полилинии не дошёл до материала: ${style?.materialColor}`);
    }
    if (style?.materialWidth !== 6) {
        problems.push(`толщина полилинии не дошла до материала: ${style?.materialWidth}`);
    }

    // Правка числами: отметка, длина, уклон.
    const editProbe = await page.evaluate((id) => {
        const D = window.BimLvaDebug;
        const before = D.drawn.find((d) => d.id === id);
        const startAbs = before.abs[0];
        D.editPolyline(id, 'elev', 0, startAbs.z + 5);
        const afterElev = D.drawn.find((d) => d.id === id).abs[0].z;

        D.editPolyline(id, 'length', 0, 25);
        const segLen = D.polylineSegment(id, 0).length3d;

        D.editPolyline(id, 'slope', 0, 40);
        const segSlope = D.polylineSegment(id, 0).slopePermille;

        return { wantElev: startAbs.z + 5, gotElev: afterElev, segLen, segSlope };
    }, three.id);
    if (Math.abs(editProbe.gotElev - editProbe.wantElev) > 1e-3) {
        problems.push(`отметка вершины не применилась: ${editProbe.gotElev} вместо ${editProbe.wantElev}`);
    }
    if (Math.abs(editProbe.segLen - 25) > 1e-3) {
        problems.push(`длина отрезка не применилась: ${editProbe.segLen.toFixed(3)} вместо 25`);
    }
    if (Math.abs(editProbe.segSlope - 40) > 0.05) {
        problems.push(`уклон отрезка не применился: ${editProbe.segSlope?.toFixed(2)} вместо 40`);
    }

    // Вставка вершины в середину отрезка: точек становится на одну больше, а
    // новая лежит ровно посередине между соседями.
    const insertProbe = await page.evaluate((id) => {
        const D = window.BimLvaDebug;
        const before = D.drawn.find((d) => d.id === id);
        const a = before.vertsAbs[0];
        const b = before.vertsAbs[1];
        const at = D.insertPolylineVertex(id, 0);
        const after = D.drawn.find((d) => d.id === id);
        return {
            at, wasPoints: before.points, nowPoints: after.points,
            got: after.vertsAbs[1],
            want: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }
        };
    }, three.id);
    if (insertProbe.nowPoints !== insertProbe.wasPoints + 1) {
        problems.push(`вставка вершины: точек ${insertProbe.nowPoints} вместо ${insertProbe.wasPoints + 1}`);
    } else {
        const off = Math.hypot(
            insertProbe.got.x - insertProbe.want.x,
            insertProbe.got.y - insertProbe.want.y,
            insertProbe.got.z - insertProbe.want.z
        );
        if (off > 1e-6) problems.push(`вставленная вершина не в середине отрезка (${off.toFixed(4)} м)`);
    }

    // Замыкание контура: площадь считаем сами по вершинам (формула шнурков) и
    // сверяем с тем, что показывает вьювер. Радиусы предварительно снимаем —
    // иначе дуги срежут углы и площадь честно станет меньше.
    // Радиусы снимаем ОТДЕЛЬНЫМ шагом и только потом делаем снимок «до»: иначе
    // сравнение поймало бы ещё и исчезновение точек дуг, а не одно замыкание.
    await page.evaluate((id) => {
        const D = window.BimLvaDebug;
        const rec = D.drawn.find((d) => d.id === id);
        for (let i = 0; i < rec.points; i++) D.setPolylineRadius(id, i, 0);
    }, three.id);
    const dxfBeforeClose = await page.evaluate(() => window.BimLvaDebug.dxfPreview());
    const openVerts = (dxfBeforeClose.match(/\r\nVERTEX\r\n/g) || []).length;
    const closeProbe = await page.evaluate((id) => {
        const D = window.BimLvaDebug;
        D.setPolylineClosed(id, true);
        const after = D.drawn.find((d) => d.id === id);
        const p = after.vertsAbs;
        let s = 0;
        for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
            s += (p[j].x + p[i].x) * (p[j].y - p[i].y);
        }
        return { closed: after.closed, area: after.area, want: Math.abs(s) / 2 };
    }, three.id);
    if (!closeProbe.closed) {
        problems.push('контур не замкнулся');
    } else if (Math.abs(closeProbe.area - closeProbe.want) > 0.01) {
        problems.push(`площадь контура ${closeProbe.area?.toFixed(2)} вместо ${closeProbe.want.toFixed(2)} м²`);
    }
    // В DXF замкнутый контур — флагом, а не повторной вершиной
    const dxfClosed = await page.evaluate(() => window.BimLvaDebug.dxfPreview());
    const closedVerts = (dxfClosed.match(/\r\nVERTEX\r\n/g) || []).length;
    if (closedVerts !== openVerts) {
        problems.push(`замыкание изменило число вершин в DXF: ${openVerts} → ${closedVerts}`);
    }
    await page.evaluate((id) => window.BimLvaDebug.setPolylineClosed(id, false), three.id);

    // Профиль по оси. Фикстура — сетка коробок без сплошного основания, поэтому
    // часть лучей честно промахивается: проверяем и это (разрыв, а не подстановка
    // числа), и арифметику рабочей отметки.
    const profile = await page.evaluate((id) => {
        const p = window.BimLvaDebug.polylineProfile(id, 2);
        if (!p) return null;
        return {
            n: p.samples.length, total: p.total, step: p.step, missed: p.missed,
            monotone: p.samples.every((s, i, a) => i === 0 || s.sta >= a[i - 1].sta),
            withGround: p.samples.filter((s) => s.ground != null).length,
            workOk: p.samples.every((s) => s.ground == null
                ? s.work == null
                : Math.abs(s.work - (s.axis - s.ground)) < 1e-9)
        };
    }, three.id);
    if (!profile) {
        problems.push('профиль по оси не построился');
    } else {
        const wantN = Math.floor(profile.total / profile.step) + 1;
        if (profile.n !== wantN) problems.push(`пикетов ${profile.n} вместо ${wantN}`);
        if (!profile.monotone) problems.push('пикетаж профиля не возрастает');
        if (!profile.workOk) problems.push('рабочая отметка не равна «ось минус земля»');
        if (!profile.withGround) problems.push('профиль не нашёл землю ни в одном пикете');
    }

    // «Посадить ось на землю»: там, где земля есть, ось обязана лечь ровно на неё
    if (profile?.withGround) {
        await page.evaluate((id) => window.BimLvaDebug.drapePolyline(id), three.id);
        const after = await page.evaluate(
            (id) => window.BimLvaDebug.polylineProfile(id, 2).samples.filter((s) => s.ground != null),
            three.id
        );
        if (!after.length) problems.push('после посадки на землю профиль потерял отметки');
        // Пикет 0 — это ровно первая вершина, её посадили: рабочая отметка там
        // обязана стать нулём. Между вершинами ось идёт прямой, а земля —
        // ступеньками по коробкам, и совпадать они не обязаны.
        const atStart = await page.evaluate(
            (id) => window.BimLvaDebug.polylineProfile(id, 2).samples[0],
            three.id
        );
        if (atStart?.ground != null && Math.abs(atStart.work) > 1e-6) {
            problems.push(`после посадки рабочая отметка в начале ${atStart.work.toFixed(4)} вместо 0`);
        }
    }

    // Кадрирование полилинии: «→» обязано СОХРАНИТЬ текущее направление взгляда
    // (раньше сбрасывало в изометрию), «⬓» — поставить строго сверху.
    const framing = await page.evaluate((id) => {
        const D = window.BimLvaDebug;
        const norm = (d) => {
            const l = Math.hypot(d.x, d.y, d.z) || 1;
            return { x: d.x / l, y: d.y / l, z: d.z / l };
        };
        const before = norm(D.cameraDir);
        D.focusPolyline(id, 'keep');
        const keep = norm(D.cameraDir);
        D.focusPolyline(id, 'plan');
        const plan = norm(D.cameraDir);
        return { before, keep, plan };
    }, three.id);
    const dirOff = Math.max(
        Math.abs(framing.keep.x - framing.before.x),
        Math.abs(framing.keep.y - framing.before.y),
        Math.abs(framing.keep.z - framing.before.z)
    );
    if (dirOff > 0.02) {
        problems.push(`«приблизить» сменило направление взгляда на ${dirOff.toFixed(3)} — должно сохранять вид`);
    }
    if (Math.abs(framing.plan.z + 1) > 0.02) {
        problems.push(`«в плане» смотрит (${framing.plan.x.toFixed(2)}, ${framing.plan.y.toFixed(2)}, ${framing.plan.z.toFixed(2)}), а не строго вниз`);
    }

    // Профиль в ОТКРЫТОЙ панели обязан пересчитываться при правке геометрии,
    // а не залипать на снятом однажды: именно это и было сломано.
    const profileLive = await page.evaluate((id) => {
        const D = window.BimLvaDebug;
        D.openPolylineProfile(id);
        const rowsBefore = document.getElementById('polyProfileTable').textContent;
        const p0 = D.drawn.find((d) => d.id === id).vertsAbs[0];
        D.editPolyline(id, 'elev', 0, p0.z + 25);   // правка идёт мимо панели
        const rowsAfter = document.getElementById('polyProfileTable').textContent;
        document.getElementById('polyProfileClose').click();
        return { changed: rowsBefore !== rowsAfter, had: rowsBefore.length > 0 };
    }, three.id);
    if (!profileLive.had) {
        problems.push('таблица профиля пуста — проверка обновления вхолостую');
    } else if (!profileLive.changed) {
        problems.push('профиль не обновился после правки отметки вершины');
    }

    // «Тело по оси»: строим по конкретной полилинии и проверяем, что при
    // изменении этой оси тело перестраивается САМО (связь включена).
    const sweepLive = await page.evaluate((id) => {
        const D = window.BimLvaDebug;
        D.buildSweepOnPolyline(id, 'rect', { width: 1, height: 1 });
        const before = D.sweeps[D.sweeps.length - 1];
        // Удлиняем первый отрезок оси — объём обязан вырасти
        const seg = D.polylineSegment(id, 0);
        D.editPolyline(id, 'length', 0, seg.length3d + 20);
        const after = D.sweeps[D.sweeps.length - 1];
        return { before, after };
    }, three.id);
    if (!sweepLive.before || sweepLive.before.polylineId !== three.id) {
        problems.push('тело не привязалось к выбранной оси');
    } else if (!(sweepLive.after.length > sweepLive.before.length + 1)) {
        problems.push(
            `тело не перестроилось за осью: длина ${sweepLive.before.length?.toFixed(2)} → ` +
            `${sweepLive.after.length?.toFixed(2)}`
        );
    }
    await page.evaluate(() => document.getElementById('sweepClear')?.click());

    // Картограмма. Точного ответа для сетки коробок нет, зато есть точный
    // ИНВАРИАНТ: поднимаем проектную отметку на Δ — баланс обязан вырасти
    // ровно на «измеренная площадь × Δ», потому что у каждой ячейки рабочая
    // отметка выросла на Δ. Это проверяет и объём, и площадь разом.
    const earth = await page.evaluate((id) => {
        const D = window.BimLvaDebug;
        D.setPolylineClosed(id, true);
        const a = D.earthwork(id, 1, 'level', 0);
        const b = D.earthwork(id, 1, 'level', 10);
        D.setPolylineClosed(id, false);
        return { a, b };
    }, three.id);
    if (!earth.a || earth.a.tooFine) {
        problems.push('картограмма не посчиталась');
    } else if (!earth.a.measured) {
        problems.push('картограмма: внутри контура не нашлось ни одной ячейки с землёй');
    } else {
        const got = earth.b.balance - earth.a.balance;
        const want = earth.a.area * 10;
        if (Math.abs(got - want) > 1e-6) {
            problems.push(`картограмма: подъём отметки на 10 м дал ${got.toFixed(3)} м³ вместо ${want.toFixed(3)}`);
        }
        if (Math.abs(earth.a.balance - (earth.a.fill - earth.a.cut)) > 1e-9) {
            problems.push('картограмма: баланс не равен «насыпь минус выемка»');
        }
        if (earth.a.measured + earth.a.noGround !== earth.a.cells) {
            problems.push('картограмма: ячейки с землёй и без неё не дают общее число');
        }
    }

    // Список полилиний: модалка открывается, переименование и общее удаление работают.
    await page.evaluate(() => document.getElementById('btnPolylineList')?.click());
    const listShown = await page.locator('#polylinesModal.show').count().catch(() => 0);
    const countBadge = await page.evaluate(() => document.getElementById('polylinesCount')?.textContent);
    if (!listShown) problems.push('список полилиний не открылся');
    else if (countBadge !== '2') problems.push(`счётчик полилиний показывает ${countBadge} вместо 2`);
    await page.evaluate(() => {
        const input = document.querySelector('#polylinesList input.editInput');
        if (!input) return;
        input.value = 'Ось-тест';
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const renamed = await page.evaluate(() => window.BimLvaDebug.drawn.some((d) => d.name === 'Ось-тест'));
    if (!renamed) problems.push('переименование полилинии в списке не сработало');
    await page.evaluate(() => document.getElementById('polylinesClear')?.click());
    const afterClear = await page.evaluate(() => ({
        n: window.BimLvaDebug.drawn.length,
        orphans: window.BimLvaDebug.drawOrphans
    }));
    if (afterClear.n !== 0) problems.push(`«Удалить все» оставило ${afterClear.n} полилиний`);
    if (afterClear.orphans?.length) {
        problems.push(`«Удалить все» оставило в сцене сирот: ${afterClear.orphans.join(', ')}`);
    }
    await page.evaluate(() => document.getElementById('polylinesClose')?.click());

    // Ввод точки числами. Оси сцены: X — восток, Y — север, азимут в геодезии
    // отсчитывается ПО часовой от севера. Значит 90° — чистый восток, 0° —
    // чистый север; на этом и ловится перепутанный синус с косинусом.
    await page.evaluate(() => {
        const b = document.getElementById('btnDraw');
        if (!b.classList.contains('on')) b.click();
    });
    let numericStart = null;
    for (const [dx, dy] of [[0, 0], [0.08, 0.05], [-0.08, -0.05]]) {
        await page.mouse.click(cx + dx * box.width, cy + dy * box.height);
        await page.waitForTimeout(90);
        numericStart = await page.evaluate(() => window.BimLvaDebug.drawDraftPoints);
        if (numericStart) break;
    }
    const numeric = await page.evaluate(() => {
        const D = window.BimLvaDebug;
        // Три шага подряд: по разностям видно направление, координаты первой
        // (кликнутой) точки для этого знать не нужно.
        const a = D.drawPointByNumbers(10, 90, 0);
        const b = D.drawPointByNumbers(10, 90, 0);
        const c = D.drawPointByNumbers(10, 0, 0);
        return { a, b, c };
    });
    if (!numeric.a || !numeric.b || !numeric.c) {
        problems.push('ввод точки числами не сработал');
    } else {
        const east = { x: numeric.b.x - numeric.a.x, y: numeric.b.y - numeric.a.y };
        const north = { x: numeric.c.x - numeric.b.x, y: numeric.c.y - numeric.b.y };
        if (Math.abs(east.x - 10) > 1e-6 || Math.abs(east.y) > 1e-6) {
            problems.push(`азимут 90° дал сдвиг (${east.x.toFixed(3)}, ${east.y.toFixed(3)}) вместо (10, 0)`);
        }
        if (Math.abs(north.x) > 1e-6 || Math.abs(north.y - 10) > 1e-6) {
            problems.push(`азимут 0° дал сдвиг (${north.x.toFixed(3)}, ${north.y.toFixed(3)}) вместо (0, 10)`);
        }
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);

    // Вертикальный переход — В САМОМ КОНЦЕ: он добавляет вершины, и проверки
    // выше (число вершин в DXF, длина после сопряжения, счёт ручек) считают
    // их по снимку, сделанному до. Запуск в середине ронял три проверки сразу.
    const vert = await checkVerticalTransition(page, cx, cy, box);

    await page.evaluate(() => {
        const b = document.getElementById('btnDraw');
        if (b.classList.contains('on')) b.click();
        document.getElementById('btnPolylineList')?.click();
        document.getElementById('polylinesClear')?.click();
        document.getElementById('polylinesClose')?.click();
    });

    return { polylines: drawn.length, vertices: vertexCount, x: first.x, snaps: snaps.length, vert };
}

/**
 * Тело по оси. Проверяем числами: на прямой оси объём обязан быть точно
 * «площадь сечения × длина», габарит — совпасть с размерами сечения, а труба —
 * дать кольцевую площадь. Клики по сцене таких гарантий не дают.
 */
async function checkSweep(page) {
    const cases = await page.evaluate(() => ({
        rect: window.BimLvaDebug.sweepProbe(
            [[0, 0, 0], [10, 0, 0]], 'rect', { width: 0.5, height: 0.3 }, 0),
        pipe: window.BimLvaDebug.sweepProbe(
            [[0, 0, 0], [20, 0, 0]], 'pipe', { diameter: 0.6, wall: 0.05 }, 0),
        trap: window.BimLvaDebug.sweepProbe(
            [[0, 0, 0], [0, 8, 0]], 'trapezoid', { width: 1, topWidth: 3, height: 1 }, 0),
        turn: window.BimLvaDebug.sweepProbe(
            [[0, 0, 0], [10, 0, 0], [10, 10, 0]], 'rect', { width: 1, height: 1 }, 0)
    }));
    if (!cases.rect) {
        problems.push('выдавливание по оси не построилось');
        return null;
    }
    const near = (got, want, tol, what) => {
        if (Math.abs(got - want) > tol) problems.push(`тело по оси: ${what} — ${got.toFixed(4)}, ожидалось ${want}`);
    };
    near(cases.rect.length, 10, 1e-6, 'длина прямой оси');
    near(cases.rect.area, 0.15, 1e-6, 'площадь прямоугольника 0.5×0.3');
    near(cases.rect.volume, 1.5, 1e-6, 'объём при длине 10');
    near(cases.rect.size.x, 10, 1e-3, 'габарит вдоль оси');
    near(cases.rect.size.y, 0.5, 1e-3, 'ширина тела');
    near(cases.rect.size.z, 0.3, 1e-3, 'высота тела');

    // Труба: площадь кольца π(R² − r²), R = 0.3, стенка 0.05
    near(cases.pipe.area, Math.PI * (0.3 * 0.3 - 0.25 * 0.25) , 2e-3, 'площадь кольца трубы');
    // Трапеция: полусумма оснований на высоту
    near(cases.trap.area, (1 + 3) / 2 * 1, 1e-6, 'площадь трапеции');
    near(cases.trap.length, 8, 1e-6, 'длина оси по Y');
    // Поворот: длина складывается из двух участков, тело не должно вырождаться
    near(cases.turn.length, 20, 1e-6, 'длина ломаной оси');
    if (!(cases.turn.triangles > cases.rect.triangles)) {
        problems.push('на ломаной оси тело не набрало дополнительных граней');
    }
    return { volume: cases.rect.volume, pipeArea: cases.pipe.area, triangles: cases.turn.triangles };
}

/**
 * Откосы до рельефа. Линия — числами (createPolylineFromPoints), а не
 * кликами: нужна точная бровка над известным рельефом, чтобы сверить с
 * аналитикой, а не «примерно похоже на откос».
 *
 * Фикстура — сетка коробок 3×3 с шагом 3 (см. main): бокс с боксом смыкаются
 * без зазора, и внутри грид получается СПЛОШНАЯ ровная площадка. Её отметку
 * не подставляем числом — читаем из modelBounds (сцена центрирует модель по
 * её же габариту, и абсолютная высота площадки зависит от этого центрирования,
 * а не от отметки в самом IFC-файле). Дальше для прямой бровки над такой
 * площадкой всё считается аналитически: при уклоне 1:m и превышении бровки
 * над землёй H экзит-дистанция (по нормали в плане) равна H·m, площадь
 * сечения между откосом и землёй — прямоугольный треугольник 0.5·H²·m, а
 * объём при постоянных H и m по всей длине — «площадь сечения × длина».
 */
async function checkSlopeToTerrain(page) {
    const groundZ = await page.evaluate(() => {
        const b = window.BimLvaDebug.modelBounds;
        return b.length ? Math.max(...b.map((m) => m.centerZ + m.sizeZ / 2)) : null;
    });
    if (groundZ == null) {
        problems.push('откосы: не удалось снять отметку площадки из modelBounds — проверка пропущена');
        return null;
    }

    // Насыпь, одна сторона: превышение H=2.4 м, уклон 1:1.5 → экзит 3.6 м.
    const H1 = 2.4, M1 = 1.5;
    const fill = await page.evaluate(([h, m, g]) => {
        const D = window.BimLvaDebug;
        const id = D.createPolylineFromPoints(
            [{ x: 20, y: 15, z: g + h }, { x: 24.4, y: 15, z: g + h }],
            { name: 'Откос-тест-насыпь' }
        );
        const res = D.buildSlopeOnPolyline(id, { side: 'right', mFill: m, mCut: 1, step: 0.5, maxReach: 30 });
        const exitId = res?.sides?.[0]?.exitPolylineIds?.[0];
        const exit = exitId != null ? D.drawn.find((d) => d.id === exitId) : null;
        return { id, res, exit };
    }, [H1, M1, groundZ]);
    if (!fill.res || fill.res.sides.length !== 1) {
        problems.push('откосы: насыпь по одной стороне не построилась');
    } else {
        const s = fill.res.sides[0];
        const wantArea = 0.5 * H1 * H1 * M1;
        const wantLen = 4.4;
        const wantVol = wantArea * wantLen;
        if (s.side !== 'right') problems.push(`откосы: сторона «${s.side}» вместо «right»`);
        if (Math.abs(s.fill - wantVol) > 0.02) {
            problems.push(`откосы: насыпь ${s.fill.toFixed(3)} м³ вместо ${wantVol.toFixed(3)} (площадь×длина)`);
        }
        if (Math.abs(s.cut) > 1e-6) problems.push(`откосы: на насыпи набралась выемка ${s.cut.toFixed(3)} м³`);
        if (s.skippedNoGround || s.skippedNotReached) {
            problems.push(`откосы: насыпь на сплошной площадке пропустила сечения (${s.skippedNoGround}+${s.skippedNotReached})`);
        }
        if (!s.triangles) problems.push('откосы: поверхность насыпи не построилась (нет треугольников)');
        if (!fill.exit || fill.exit.points < 2) {
            problems.push('откосы: линия выхода насыпи не создалась');
        } else {
            const wantY = 15 - H1 * M1;
            const got = fill.exit.vertsAbs || [];
            const dOk = got.length >= 2 && got.every((p) =>
                Math.abs(p.y - wantY) < 0.02 && Math.abs(p.z - groundZ) < 0.02
            );
            if (!dOk) {
                problems.push(
                    `откосы: линия выхода насыпи ${JSON.stringify(got)} — ожидалась Y≈${wantY.toFixed(2)}, Z≈${groundZ.toFixed(2)}`
                );
            }
        }
    }

    // Выемка, обе стороны: заглубление H=1.2 м, уклон 1:1 → экзит 1.2 м, слева и справа.
    const H2 = 1.2, M2 = 1;
    const cut = await page.evaluate(([h, m, g]) => {
        const D = window.BimLvaDebug;
        const id = D.createPolylineFromPoints(
            [{ x: 20, y: -15, z: g - h }, { x: 24.4, y: -15, z: g - h }],
            { name: 'Откос-тест-выемка' }
        );
        const res = D.buildSlopeOnPolyline(id, { side: 'both', mFill: 1.5, mCut: m, step: 0.5, maxReach: 30 });
        return { id, res };
    }, [H2, M2, groundZ]);
    if (!cut.res || cut.res.sides.length !== 2) {
        problems.push('откосы: выемка «в обе стороны» не дала двух поверхностей');
    } else {
        const wantArea = 0.5 * H2 * H2 * M2;
        const wantVolEach = wantArea * 4.4;
        cut.res.sides.forEach((s) => {
            if (Math.abs(s.cut - wantVolEach) > 0.02) {
                problems.push(`откосы: выемка (${s.side}) ${s.cut.toFixed(3)} м³ вместо ${wantVolEach.toFixed(3)}`);
            }
            if (Math.abs(s.fill) > 1e-6) problems.push(`откосы: на выемке набралась насыпь ${s.fill.toFixed(3)} м³ (${s.side})`);
            if (!(s.cutTriangles > 0)) {
                problems.push(`откосы: выемка (${s.side}) без поверхности (${s.cutTriangles} треугольников)`);
            }
            if (s.cut > 0 && s.cutOverlay !== true) {
                problems.push(`откосы: выемка (${s.side}) спрятана под рельефом (нужен overlay без depth-test)`);
            }
        });
        const sides = cut.res.sides.map((s) => s.side).sort().join(',');
        if (sides !== 'left,right') problems.push(`откосы: «в обе стороны» дала стороны ${sides} вместо left,right`);
        if (!(cut.res.tin?.capFaces > 0)) {
            problems.push('откосы: торцы разомкнутой линии не закрылись — в TIN дыра с конца');
        }
        const contour = await page.evaluate((pid) => {
            const D = window.BimLvaDebug;
            const rec = D.drawn.find((d) => d.id === pid);
            return rec ? { closed: rec.closed, points: rec.points } : null;
        }, cut.res.contourPolylineId);
        if (!contour?.closed || contour.points < 4) {
            problems.push(`откосы: контур выхода «в обе стороны» не замкнут (${JSON.stringify(contour)})`);
        }
    }

    // Удаление линии выхода не должно вычёркивать из списка СОСЕДНЮЮ полилинию,
    // оставляя её объект в сцене: в таблице пусто, а контур на площадке виден.
    const ghost = await page.evaluate((g) => {
        const D = window.BimLvaDebug;
        const keepId = D.createPolylineFromPoints(
            [{ x: -30, y: 12, z: g + 1 }, { x: -26, y: 12, z: g + 1 }],
            { name: 'Не-трогать' }
        );
        const srcId = D.createPolylineFromPoints(
            [{ x: 10, y: 12, z: g + 2 }, { x: 14.4, y: 12, z: g + 2 }],
            { name: 'Бровка-выход' }
        );
        const res = D.buildSlopeOnPolyline(srcId, { side: 'right', mFill: 1.5, mCut: 1, step: 0.5, maxReach: 30 });
        const exitId = res?.sides?.[0]?.exitPolylineIds?.[0];
        const deleted = D.deletePolyline(exitId);
        const after = D.drawn;
        return {
            deleted, exitId, keepId, srcId,
            keepAlive: after.some((d) => d.id === keepId),
            srcAlive: after.some((d) => d.id === srcId),
            exitGone: !after.some((d) => d.id === exitId),
            orphans: D.drawOrphans.slice()
        };
    }, groundZ);
    if (!ghost.deleted || ghost.exitId == null) {
        problems.push(`откосы: не удалось удалить линию выхода (${JSON.stringify(ghost)})`);
    } else {
        if (!ghost.keepAlive) {
            problems.push('откосы: удаление линии выхода вычеркнуло соседнюю полилинию из списка, оставив её на сцене');
        }
        if (!ghost.srcAlive) {
            problems.push('откосы: удаление линии выхода сняло и бровку');
        }
        if (!ghost.exitGone) problems.push('откосы: линия выхода осталась в списке после удаления');
        if (ghost.orphans.length) {
            problems.push(`откосы: после удаления выхода в сцене сироты ${JSON.stringify(ghost.orphans)}`);
        }
    }

    // Максимальный вылет меньше экзит-дистанции — сечения обязаны выпасть из
    // расчёта (пропущены), а не подставить какой-то объём.
    // Насыпь с прошлого шага лежит на той же бровке: без очистки новый откос
    // вышел бы на её поверхность, а не в «недолёт».
    await page.evaluate(() => window.BimLvaDebug.clearSlopes());
    const short = await page.evaluate(([h, m, g]) => {
        const D = window.BimLvaDebug;
        const id = D.createPolylineFromPoints(
            [{ x: 20, y: 15, z: g + h }, { x: 24.4, y: 15, z: g + h }],
            { name: 'Откос-тест-недолёт' }
        );
        const res = D.buildSlopeOnPolyline(id, { side: 'right', mFill: m, mCut: 1, step: 0.5, maxReach: 1 });
        return res;
    }, [H1, M1, groundZ]);
    if (!short || short.sides.length !== 1) {
        problems.push('откосы: проверка недолёта не построилась');
    } else {
        const s = short.sides[0];
        if (s.skippedNotReached !== s.sections) {
            problems.push(`откосы: при малом вылете пропущено ${s.skippedNotReached} сечений из ${s.sections} — ожидались все`);
        }
        if (Math.abs(s.fill) > 1e-9 || Math.abs(s.cut) > 1e-9) {
            problems.push(`откосы: при недолёте объём не нулевой (насыпь ${s.fill}, выемка ${s.cut})`);
        }
        if (s.exitPolylineIds.length) problems.push('откосы: при недолёте всё равно создалась линия выхода');
    }

    // Площадка: замкнутый квадрат 4×4 м. Середина обязана заполниться
    // (2 треугольника), иначе в TIN дыра до исходного рельефа. LandXML —
    // northing easting elev; DXF площадки — один 3DSOLID (SAT 700) на
    // слое «Откос», без POLYFACE и без 3D-полилиний по рёбрам. Оба в абсолютных метрах.
    await page.evaluate(() => window.BimLvaDebug.clearSlopes());
    const pad = await page.evaluate((g) => {
        const D = window.BimLvaDebug;
        const z = g + 2;
        const id = D.createPolylineFromPoints(
            [
                { x: 20, y: 15, z }, { x: 24, y: 15, z },
                { x: 24, y: 19, z }, { x: 20, y: 19, z }
            ],
            { name: 'Откос-тест-площадка', closed: true }
        );
        const res = D.buildSlopeOnPolyline(id, {
            side: 'right', mFill: 1.5, mCut: 1, step: 0.5, maxReach: 30,
            padColor: '#ff00aa'
        });
        const tin = D.slopeTin(res?.id);
        const xml = D.slopeLandXml(res?.id) || '';
        const dxf = D.slopeDxfPreview(res?.id) || '';
        const p1 = xml.match(/<P id="1">([^<]+)<\/P>/);
        const xyz = p1 ? p1[1].trim().split(/\s+/).map(Number) : null;
        const exitId = res?.sides?.[0]?.exitPolylineIds?.[0];
        const exit = exitId != null ? D.drawn.find((d) => d.id === exitId) : null;
        return {
            res, tin,
            xmlFaces: (xml.match(/<F>/g) || []).length,
            xmlPnts: (xml.match(/<P id="/g) || []).length,
            xmlHasSurface: /<Surface /i.test(xml) && /surfType="TIN"/i.test(xml),
            dxfFaces: (dxf.match(/\r\n3DFACE\r\n/g) || []).length,
            dxfSolids: (dxf.match(/\r\n3DSOLID\r\n/g) || []).length,
            dxfAcadver: /AC1024/.test(dxf),
            dxfPolyface: (dxf.match(/\r\n70\r\n64\r\n/g) || []).length,
            dxfMeshVerts: (dxf.match(/\r\n70\r\n192\r\n/g) || []).length,
            dxfMeshFaces: (dxf.match(/\r\n70\r\n128\r\n/g) || []).length,
            dxfLineVerts: (dxf.match(/\r\n70\r\n32\r\n/g) || []).length,
            dxfPolylines: (dxf.match(/\r\nPOLYLINE\r\n/g) || []).length,
            dxfSlopeLayer: /Откос/.test(dxf),
            dxfRawHasBody: /body\s+\$-1/.test(dxf),
            dxf,
            p1: xyz,
            tin0: tin?.points?.[0] || null,
            exitClosed: !!exit?.closed,
            exitPoints: exit?.points || 0,
            exitDxfVerts: exitId != null ? (D.dxfVertices(exitId)?.verts.length || 0) : 0
        };
    }, groundZ);
    if (!pad.res?.tin) {
        problems.push('откосы: площадка не собрала TIN');
    } else {
        if (pad.res.tin.padFaces !== 2) {
            problems.push(`откосы: середина площадки ${pad.res.tin.padFaces} треугольников вместо 2 — дыра в TIN`);
        }
        const overlay = pad.res.padOverlay;
        if (!overlay || overlay.depthTest !== false) {
            problems.push(`откосы: заливка площадки не поверх рельефа (${JSON.stringify(overlay)})`);
        }
        if (overlay && overlay.color !== '#ff00aa') {
            problems.push(`откосы: цвет площадки ${overlay.color} вместо #ff00aa`);
        }
        if (pad.res.tin.capFaces) {
            problems.push(`откосы: у замкнутой площадки не должно быть торцов (${pad.res.tin.capFaces})`);
        }
        if (pad.res.tin.faces < 10) {
            problems.push(`откосы: TIN площадки ${pad.res.tin.faces} граней — мало (середина 2 + 4 борта по 2)`);
        }
        if (!pad.xmlHasSurface || pad.xmlFaces !== pad.res.tin.faces || pad.xmlPnts !== pad.res.tin.points) {
            problems.push(
                `откосы: LandXML не сходится с TIN (граней xml ${pad.xmlFaces}/${pad.res.tin.faces}, ` +
                `точек ${pad.xmlPnts}/${pad.res.tin.points})`
            );
        }
        if (pad.p1 && pad.tin0) {
            // LandXML: northing easting elev = Y X Z абсолютные
            const dn = Math.abs(pad.p1[0] - pad.tin0.y);
            const de = Math.abs(pad.p1[1] - pad.tin0.x);
            const dz = Math.abs(pad.p1[2] - pad.tin0.z);
            if (dn > 1e-5 || de > 1e-5 || dz > 1e-5) {
                problems.push(
                    `откосы: LandXML точка 1 (${pad.p1.join(', ')}) не совпала с TIN ` +
                    `(N=${pad.tin0.y}, E=${pad.tin0.x}, Z=${pad.tin0.z})`
                );
            }
        } else {
            problems.push('откосы: в LandXML нет точки id=1');
        }
        if (!pad.dxfSlopeLayer || !pad.dxfAcadver || pad.dxfSolids !== 1 || pad.dxfPolyface
            || pad.dxfPolylines || pad.dxfLineVerts || pad.dxfFaces || pad.dxfRawHasBody) {
            problems.push(
                `откосы: DXF площадки — 3DSOLID ${pad.dxfSolids}, AC1024 ${pad.dxfAcadver}, ` +
                `POLYFACE ${pad.dxfPolyface}, POLYLINE ${pad.dxfPolylines}, ` +
                `рёбер-линий ${pad.dxfLineVerts}, 3DFACE ${pad.dxfFaces}, ` +
                `слой Откос ${pad.dxfSlopeLayer}, сырой SAT ${pad.dxfRawHasBody}`
            );
        } else {
            const sat = dxfSatPayload(pad.dxf);
            if (!sat.includes('700 0 1 0') || !/\bbody\b/.test(sat) || !/\bface\b/.test(sat)) {
                problems.push('откосы: DXF 3DSOLID без SAT 700 / body / face (шифр или разбор)');
            } else if (pad.tin0) {
                const needle = ` ${String(pad.tin0.x)} ${String(pad.tin0.y)} ${String(pad.tin0.z)}`;
                if (!sat.includes(needle)) {
                    problems.push(
                        `откосы: в SAT нет точки TIN ${needle.trim()} — солид ушёл не в абсолютных`
                    );
                }
            }
        }
        if (!pad.exitClosed) {
            problems.push('откосы: линия выхода площадки не замкнута — контур на сцене должен быть кольцом');
        }
        if (pad.exitClosed && pad.exitDxfVerts !== pad.exitPoints) {
            problems.push(
                `откосы: кодировка линии выхода ${pad.exitDxfVerts} вершин при ${pad.exitPoints} в контуре — ` +
                `замыкание должно быть флагом, без повторной вершины`
            );
        }
        const kdo = await page.evaluate((id) => {
            const D = window.BimLvaDebug;
            const applied = D.setPadKdo(id, [
                { name: 'Покрытие', thickness: 0.10, color: '#111111' },
                { name: 'Основание', thickness: 0.20, color: '#888888' }
            ]);
            const dxf = D.slopeDxfPreview(applied?.id || id) || '';
            const southY = (ring) => {
                const pts = (ring || []).filter((p) => p.x > 20.5 && p.x < 23.5);
                if (!pts.length) return null;
                return Math.min(...pts.map((p) => p.y));
            };
            const pos = D.kdoLayerPositions(applied?.id || id) || [];
            const meshRatios = [];
            for (let i = 0; i < pos.length; i += 9) {
                const tri = [
                    { x: pos[i], y: pos[i + 1], z: pos[i + 2] },
                    { x: pos[i + 3], y: pos[i + 4], z: pos[i + 5] },
                    { x: pos[i + 6], y: pos[i + 7], z: pos[i + 8] }
                ];
                for (let a = 0; a < 3; a++) {
                    const p = tri[a], q = tri[(a + 1) % 3];
                    // Южная грань: образующая вдоль −Y, тот же X, разный Z.
                    if (Math.abs(p.x - q.x) > 0.08) continue;
                    if (Math.abs(p.z - q.z) < 0.04) continue;
                    if (p.y > 15.2 || q.y > 15.2) continue;
                    if (p.x < 20.5 || p.x > 23.5) continue;
                    meshRatios.push(Math.abs(p.y - q.y) / Math.abs(p.z - q.z));
                }
            }
            return {
                count: applied?.count,
                totalH: applied?.totalH,
                v0: applied?.layers?.[0]?.volume,
                v1: applied?.layers?.[1]?.volume,
                flare0: applied?.layers?.[0]?.flareBot,
                flare1: applied?.layers?.[1]?.flareBot,
                faces0: applied?.layers?.[0]?.faces,
                meanExit: applied?.meanExit,
                south0: southY(D.kdoRing(applied?.id || id, 0)),
                south10: southY(D.kdoRing(applied?.id || id, 0.10)),
                south30: southY(D.kdoRing(applied?.id || id, 0.30)),
                ratio: D.kdoSlopeRatio(applied?.id || id, 0, 0.10),
                meshRatio: meshRatios.length
                    ? meshRatios.reduce((a, b) => a + b, 0) / meshRatios.length
                    : null,
                meshN: meshRatios.length,
                dxfKdo: /КДО/.test(dxf),
                dxfSolids: (dxf.match(/\r\n3DSOLID\r\n/g) || []).length,
                dxfPolyface: (dxf.match(/\r\n70\r\n64\r\n/g) || []).length
            };
        }, pad.res.id);
        // Квадрат 4×4, 1:1.5: бока КДО на тех же лучах, что откос (южная бровка y=15).
        if (kdo.count !== 2 || Math.abs(kdo.totalH - 0.3) > 1e-9) {
            problems.push(`откосы: КДО слоёв ${kdo.count} / высота ${kdo.totalH} — ждали 2 сл. на 0.30 м`);
        }
        if (Math.abs((kdo.flare0 || 0) - 0.15) > 1e-9 || Math.abs((kdo.flare1 || 0) - 0.45) > 1e-9) {
            problems.push(`откосы: КДО уширение низа ${kdo.flare0} / ${kdo.flare1} вместо 0.15 / 0.45`);
        }
        if (!(kdo.v0 > 1.6 && kdo.v0 < 1.9) || !(kdo.v1 > 3.2 && kdo.v1 < 4.6)) {
            problems.push(`откосы: КДО объёмы ${kdo.v0} / ${kdo.v1} м³ — ждали больше вертикальных 1.6/3.2 и около призмоида`);
        }
        if (Math.abs((kdo.south0 ?? 0) - 15) > 0.04) {
            problems.push(`откосы: КДО верх южной бровки y=${kdo.south0} вместо 15`);
        }
        if (Math.abs((kdo.south10 ?? 0) - 14.85) > 0.04) {
            problems.push(`откосы: КДО на 0.10 м y=${kdo.south10} вместо 14.85 (тот же 1:1.5, что откос)`);
        }
        if (Math.abs((kdo.south30 ?? 0) - 14.55) > 0.04) {
            problems.push(`откосы: КДО на 0.30 м y=${kdo.south30} вместо 14.55`);
        }
        if (!(Math.abs((kdo.ratio ?? 0) - 1.5) < 0.04)) {
            problems.push(`откосы: заложение КДО ${kdo.ratio} вместо 1.5 (как откос 1:1.5)`);
        }
        if (!(kdo.meshN > 0) || !(Math.abs((kdo.meshRatio ?? 0) - 1.5) < 0.08)) {
            problems.push(
                `откосы: лофт КДО заложение ${kdo.meshRatio} по ${kdo.meshN} рёбрам юга — ждали 1.5`
            );
        }
        if (!(kdo.faces0 > 0)) {
            problems.push(`откосы: слой КДО без граней (${kdo.faces0})`);
        }
        if (!kdo.dxfKdo || kdo.dxfSolids !== 3 || kdo.dxfPolyface) {
            problems.push(`откосы: DXF КДО слой ${kdo.dxfKdo}, 3DSOLID ${kdo.dxfSolids} (ждали 1 TIN + 2 слоя), POLYFACE ${kdo.dxfPolyface}`);
        }
        // Откос с бровки верха: H=2, 1:1.5 → d=3.0.
        if (!(Math.abs((kdo.meanExit || 0) - 3.0) < 0.2)) {
            problems.push(`откосы: КДО откос с бровки d=${kdo.meanExit} вместо ≈3.0`);
        }
    }

    // Таблица площадок — как список полилиний: строка с именем, цветом, площадью
    // и объёмами. Переименование пишется в модель, не в бровку.
    const padsUi = await page.evaluate(() => {
        document.getElementById('btnPadList')?.click();
        const rows = [...document.querySelectorAll('#padsList .pad-row')];
        const row = rows.find((r) => r.querySelector('input.editInput')?.value === 'Откос-тест-площадка');
        const rec = (window.BimLvaDebug.pads || []).find((p) => p.name === 'Откос-тест-площадка');
        if (row) {
            const nameInput = row.querySelector('input.editInput');
            nameInput.value = 'Площадка-переименована';
            nameInput.dispatchEvent(new Event('change'));
        }
        const after = (window.BimLvaDebug.pads || []).find((p) => p.id === rec?.id);
        const block = row?.closest('.pad-block');
        const holes = block?.querySelector('.pad-holes');
        const kdo = block?.querySelector('.pad-kdo');
        const drawBtn = holes?.querySelector('[data-action="pad-hole-draw"]');
        return {
            shown: document.getElementById('padsModal')?.classList.contains('show'),
            count: Number(document.getElementById('padsCount')?.textContent),
            found: !!row,
            color: (row?.querySelector('input[type=color]')?.value || '').toLowerCase(),
            info: row?.querySelector('.pin-xyz')?.textContent || '',
            area: rec?.area,
            renamed: after?.name || null,
            holesShown: !!holes,
            holesInKdo: !!kdo?.querySelector('.pad-holes'),
            kdoOpen: !!kdo?.open,
            drawHole: (drawBtn?.textContent || '').trim(),
            holeHint: holes?.querySelector('.pad-kdo-hint')?.textContent || ''
        };
    });
    if (!padsUi.shown || !padsUi.found) {
        problems.push(`площадки: таблица не открылась или нет строки (${JSON.stringify(padsUi)})`);
    } else {
        if (padsUi.color !== '#ff00aa') {
            problems.push(`площадки: цвет в таблице ${padsUi.color} вместо #ff00aa`);
        }
        if (!(padsUi.area > 15.9 && padsUi.area < 16.1)) {
            problems.push(`площадки: площадь ${padsUi.area} вместо 16 м² (квадрат 4×4)`);
        }
        if (!/насыпь/.test(padsUi.info) || !/TIN/.test(padsUi.info)) {
            problems.push(`площадки: в строке нет объёмов (${padsUi.info})`);
        }
        if (padsUi.renamed !== 'Площадка-переименована') {
            problems.push(`площадки: переименование не записалось (${padsUi.renamed})`);
        }
        if (!(padsUi.count >= 1)) {
            problems.push(`площадки: счётчик ${padsUi.count}`);
        }
        if (!padsUi.holesShown || padsUi.holesInKdo || padsUi.kdoOpen) {
            problems.push(
                `площадки: вырез не на виду (shown=${padsUi.holesShown}, inKdo=${padsUi.holesInKdo}, kdoOpen=${padsUi.kdoOpen})`
            );
        }
        if (!/начертить вырез/.test(padsUi.drawHole || '')) {
            problems.push(`площадки: нет кнопки «начертить вырез» («${padsUi.drawHole}»)`);
        }
    }

    // Вырез островка 2×2 в квадрате 4×4: площадь 12; в дыре TIN нет.
    const island = await page.evaluate((g) => {
        const D = window.BimLvaDebug;
        const pad = (D.pads || []).find((p) => p.name === 'Площадка-переименована')
            || (D.pads || [])[0];
        if (!pad) return { ok: false };
        const holeId = D.createPolylineFromPoints(
            [
                { x: 21, y: 16, z: g + 2 }, { x: 23, y: 16, z: g + 2 },
                { x: 23, y: 18, z: g + 2 }, { x: 21, y: 18, z: g + 2 }
            ],
            { name: 'Откос-тест-остров', closed: false }
        );
        const holed = D.addPadHole(pad.id, holeId);
        return {
            ok: true,
            area: holed?.area,
            holes: holed?.holes?.length,
            hitHole: D.padHitAt(holed?.id, 22, 17),
            hitPad: D.padHitAt(holed?.id, 20.5, 17)
        };
    }, groundZ);
    if (!island.ok) {
        problems.push('откосы: вырез островка — площадка не найдена');
    } else {
        if (!(Math.abs((island.area || 0) - 12) < 1e-6) || island.holes !== 1) {
            problems.push(`откосы: вырез островка площадь ${island.area} / дыр ${island.holes} вместо 12 м² / 1`);
        }
        if (island.hitHole != null) {
            problems.push(`откосы: TIN площадки закрыл вырез (z=${island.hitHole} в центре островка)`);
        }
        if (island.hitPad == null) {
            problems.push('откосы: после выреза TIN не попал в тело площадки рядом с дырой');
        }
    }

    // Соседние откосы и площадки — целевая поверхность, а не «дырка до
    // исходного рельефа». Считаем аналитически на ровной площадке.
    const interact = await page.evaluate((g) => {
        const D = window.BimLvaDebug;
        const m = 1.5;
        // 1) Выход на чужую площадку: у A почти нет бортов (maxReach мал),
        //    середина есть. Бровка C в 2 м от края, H=4 → без площадки экзит
        //    6 м сквозь неё на рельеф; с площадкой — на её отметке, d=3 м.
        const padA = D.createPolylineFromPoints(
            [
                { x: -24, y: 28, z: g + 2 }, { x: -16, y: 28, z: g + 2 },
                { x: -16, y: 36, z: g + 2 }, { x: -24, y: 36, z: g + 2 }
            ],
            { name: 'Откос-тест-цель-площадка', closed: true }
        );
        D.buildSlopeOnPolyline(padA, { side: 'right', mFill: m, mCut: 1, step: 0.5, maxReach: 0.25 });
        const lineC = D.createPolylineFromPoints(
            [{ x: -14, y: 30, z: g + 4 }, { x: -14, y: 34, z: g + 4 }],
            { name: 'Откос-тест-на-площадку' }
        );
        const toPad = D.buildSlopeOnPolyline(lineC, { side: 'left', mFill: m, mCut: 1, step: 0.5, maxReach: 30 });
        const padHits = (toPad?.sides?.[0]?.exits || []).filter((e) => e.d != null);

        // 2) Выход на чужой откос: две параллельные бровки, зазор 4 м, обе
        //    на g+3, 1:1.5. Без учёта соседа экзит 4.5 м на рельеф; с учётом —
        //    встреча посередине, d=2 м, z = g+3 − 2/1.5. Прямые, не квадрат:
        //    у квадрата нормаль в углу — биссектриса, и аналитика разъезжается.
        const a2 = D.createPolylineFromPoints(
            [{ x: 8, y: -36, z: g + 3 }, { x: 8, y: -28, z: g + 3 }],
            { name: 'Откос-тест-сосед-A' }
        );
        D.buildSlopeOnPolyline(a2, { side: 'right', mFill: m, mCut: 1, step: 0.5, maxReach: 30 });
        const b2 = D.createPolylineFromPoints(
            [{ x: 12, y: -36, z: g + 3 }, { x: 12, y: -28, z: g + 3 }],
            { name: 'Откос-тест-сосед-B' }
        );
        const toSlope = D.buildSlopeOnPolyline(b2, { side: 'left', mFill: m, mCut: 1, step: 0.5, maxReach: 30 });
        const west = (toSlope?.sides?.[0]?.exits || []).filter((e) => e.d != null);

        // 3) Своя площадка: «в обе стороны» на замкнутом контуре — внутрь
        //    откос не идёт (own-pad), наружу — как раньше, d = H·m.
        const self = D.createPolylineFromPoints(
            [
                { x: -8, y: -36, z: g + 2 }, { x: -4, y: -36, z: g + 2 },
                { x: -4, y: -32, z: g + 2 }, { x: -8, y: -32, z: g + 2 }
            ],
            { name: 'Откос-тест-своя-площадка', closed: true }
        );
        const both = D.buildSlopeOnPolyline(self, { side: 'both', mFill: m, mCut: 1, step: 0.5, maxReach: 30 });
        const left = both?.sides?.find((s) => s.side === 'left');
        const right = both?.sides?.find((s) => s.side === 'right');
        const sideReasons = (s) => (s?.exits || []).map((e) => e.reason || e.mode);
        const sideD = (s) => (s?.exits || []).filter((e) => e.d != null).map((e) => e.d);
        return {
            padHits: padHits.map((e) => ({ d: e.d, x: e.x, z: e.z })),
            west: west.map((e) => ({ d: e.d, x: e.x, z: e.z })),
            left: sideReasons(left),
            right: sideReasons(right),
            leftD: sideD(left),
            rightD: sideD(right)
        };
    }, groundZ);
    const padHitOk = interact.padHits.length >= 2 &&
        interact.padHits.every((e) => Math.abs(e.d - 3) < 0.08 && Math.abs(e.x - (-17)) < 0.08 && Math.abs(e.z - (groundZ + 2)) < 0.08);
    if (!padHitOk) {
        problems.push(`откосы: выход на чужую площадку ${JSON.stringify(interact.padHits)} — ждали d≈3, x≈-17, z≈g+2`);
    }
    const wantZ = groundZ + 3 - 2 / 1.5;
    const slopeHitOk = interact.west.length >= 2 &&
        interact.west.every((e) => Math.abs(e.d - 2) < 0.08 && Math.abs(e.x - 10) < 0.08 && Math.abs(e.z - wantZ) < 0.08);
    if (!slopeHitOk) {
        problems.push(`откосы: выход на чужой откос ${JSON.stringify(interact.west)} — ждали d≈2, x≈10, z≈g+1.667`);
    }
    const inward = [interact.left, interact.right].find((r) => r.length && r.every((x) => x === 'own-pad'));
    const outwardD = [interact.leftD, interact.rightD].find((d) => d.length && d.every((x) => Math.abs(x - 3) < 0.08));
    if (!inward) {
        problems.push(`откосы: внутрь своей площадки откос не должен идти (лево ${JSON.stringify(interact.left)}, право ${JSON.stringify(interact.right)})`);
    }
    if (!outwardD) {
        problems.push(`откосы: наружу от своей площадки d лево ${JSON.stringify(interact.leftD)} право ${JSON.stringify(interact.rightD)} вместо ≈3`);
    }

    // Переход насыпь→выемка: линия выемки начинается от пересечения бровки
    // с землёй (шарнир), а не от угла площадки.
    const hinge = await page.evaluate((g) => {
        const D = window.BimLvaDebug;
        const id = D.createPolylineFromPoints(
            [{ x: 30, y: 8, z: g + 2 }, { x: 30, y: 18, z: g - 2 }],
            { name: 'Откос-тест-шарнир' }
        );
        const res = D.buildSlopeOnPolyline(id, { side: 'right', mFill: 1.5, mCut: 1, step: 0.5, maxReach: 30 });
        const side = res?.sides?.[0];
        const lines = (side?.exitPolylineIds || []).map((eid) => D.drawn.find((d) => d.id === eid)).filter(Boolean);
        const cutLine = lines.find((d) => /выемка/.test(d.name)) || lines[lines.length - 1];
        const pts = cutLine?.vertsAbs || [];
        const distPlan = (p, x, y) => Math.hypot(p.x - x, p.y - y);
        const nearHinge = pts.filter((p) => distPlan(p, 30, 13) < 0.25);
        const nearCorner = pts.filter((p) => distPlan(p, 30, 18) < 0.25);
        return {
            modes: (side?.exits || []).map((e) => e.mode || e.reason),
            hinges: side?.hinges || [],
            nLines: lines.length,
            cutName: cutLine?.name || null,
            cutPts: pts,
            nearHinge: nearHinge.length,
            nearCorner: nearCorner.length,
            fill: side?.fill,
            cut: side?.cut
        };
    }, groundZ);
    if (!hinge.hinges?.length) {
        problems.push(`откосы: переход насыпь/выемка не поставил шарнир на бровке (${JSON.stringify(hinge)})`);
    } else {
        const h0 = hinge.hinges[0];
        if (Math.abs(h0.x - 30) > 0.15 || Math.abs(h0.y - 13) > 0.15 || Math.abs(h0.z - groundZ) > 0.15) {
            problems.push(`откосы: шарнир ${JSON.stringify(h0)} — ждали (30, 13, g)`);
        }
        if (Math.abs((h0.t ?? 0.5) - 0.5) > 0.08) {
            problems.push(`откосы: шарнир t=${h0.t} вместо ≈0.5`);
        }
    }
    if (hinge.nearHinge < 1) {
        problems.push(`откосы: линия выемки не идёт от пересечения с землёй (${JSON.stringify(hinge.cutPts)})`);
    }
    if (hinge.nearCorner) {
        problems.push(`откосы: линия выемки сидит на угле бровки, а не на пересечении с землёй (${JSON.stringify(hinge.cutPts)})`);
    }
    if (!(hinge.fill > 0) || !(hinge.cut > 0)) {
        problems.push(`откосы: на переходе ждали и насыпь и выемку (насыпь ${hinge.fill}, выемка ${hinge.cut})`);
    }

    // Замкнутая площадка: вершина 0 — выемка. Шарнир на ребре «последняя→0»
    // иначе выкидывался (группа из одной точки), и линия выемки начиналась
    // с углового сечения, а не с пересечения бровки с землёй.
    const hingeClosed = await page.evaluate((g) => {
        const D = window.BimLvaDebug;
        const id = D.createPolylineFromPoints(
            [
                { x: 40, y: -8, z: g - 2 },
                { x: 48, y: -8, z: g - 2 },
                { x: 48, y: 0, z: g + 2 },
                { x: 40, y: 0, z: g + 2 }
            ],
            { name: 'Откос-тест-шарнир-кольцо', closed: true }
        );
        const res = D.buildSlopeOnPolyline(id, { side: 'both', mFill: 1.5, mCut: 1, step: 0.5, maxReach: 30 });
        const side = (res?.sides || []).find((s) =>
            (s.exits || []).some((e) => e.mode === 'fill' || e.mode === 'cut')
        ) || res?.sides?.[0];
        const lines = (side?.exitPolylineIds || []).map((eid) => D.drawn.find((d) => d.id === eid)).filter(Boolean);
        const cutLine = lines.find((d) => /выемка/.test(d.name));
        const fillLine = lines.find((d) => /насыпь/.test(d.name));
        const pts = cutLine?.vertsAbs || [];
        const distPlan = (p, x, y) => Math.hypot(p.x - x, p.y - y);
        return {
            hinges: side?.hinges || [],
            nLines: lines.length,
            cutName: cutLine?.name || null,
            fillName: fillLine?.name || null,
            cutPts: pts,
            nearHingeWrap: pts.filter((p) => distPlan(p, 40, -4) < 0.3).length,
            nearHingeFar: pts.filter((p) => distPlan(p, 48, -4) < 0.3).length,
            nearCorner0: pts.filter((p) => distPlan(p, 40, -8) < 0.25).length,
            fill: side?.fill,
            cut: side?.cut,
            modes: (side?.exits || []).map((e) => e.mode || e.reason)
        };
    }, groundZ);
    if ((hingeClosed.hinges || []).length < 2) {
        problems.push(`откосы: на замкнутой площадке ждали 2 шарнира (${JSON.stringify(hingeClosed)})`);
    }
    if (hingeClosed.nearHingeWrap < 1) {
        problems.push(
            `откосы: линия выемки замкнутой площадки не идёт от шарнира на ребре к вершине 0 (${JSON.stringify(hingeClosed.cutPts)})`
        );
    }
    if (hingeClosed.nearHingeFar < 1) {
        problems.push(
            `откосы: линия выемки замкнутой площадки не дошла до второго шарнира (${JSON.stringify(hingeClosed.cutPts)})`
        );
    }
    if (hingeClosed.nearCorner0) {
        problems.push(
            `откосы: линия выемки замкнутой площадки сидит на угле, а не на пересечении с землёй (${JSON.stringify(hingeClosed.cutPts)})`
        );
    }
    if (!(hingeClosed.fill > 0) || !(hingeClosed.cut > 0)) {
        problems.push(`откосы: на замкнутом переходе ждали и насыпь и выемку (насыпь ${hingeClosed.fill}, выемка ${hingeClosed.cut})`);
    }

    // Верхняя площадка садится на нижнюю и обходит её углы, а не режет
    // хордой по диагонали. Нижняя 20×16 на g+2, верхняя уже и правее на g+6;
    // 1:1.5 даёт посадку на верхней грани нижней, а СВ/ЮВ углы нижней
    // попадают в веер угла верхней.
    const padWrap = await page.evaluate((g) => {
        const D = window.BimLvaDebug;
        const low = D.createPolylineFromPoints(
            [
                { x: 80, y: 80, z: g + 2 }, { x: 100, y: 80, z: g + 2 },
                { x: 100, y: 96, z: g + 2 }, { x: 80, y: 96, z: g + 2 }
            ],
            { name: 'Откос-тест-низ', closed: true }
        );
        D.buildSlopeOnPolyline(low, { side: 'right', mFill: 1.5, mCut: 1, step: 0.5, maxReach: 0.25 });
        const high = D.createPolylineFromPoints(
            [
                { x: 104, y: 84, z: g + 6 }, { x: 116, y: 84, z: g + 6 },
                { x: 116, y: 92, z: g + 6 }, { x: 104, y: 92, z: g + 6 }
            ],
            { name: 'Откос-тест-верх', closed: true }
        );
        const res = D.buildSlopeOnPolyline(high, { side: 'both', mFill: 1.5, mCut: 1, step: 0.5, maxReach: 30 });
        const distPlan = (p, x, y) => Math.hypot(p.x - x, p.y - y);
        const pts = [];
        (res?.sides || []).forEach((s) => {
            (s.exitPolylineIds || []).forEach((eid) => {
                const line = D.drawn.find((d) => d.id === eid);
                (line?.vertsAbs || []).forEach((p) => pts.push(p));
            });
        });
        return {
            nSides: res?.sides?.length || 0,
            nPts: pts.length,
            nearNE: pts.filter((p) => distPlan(p, 100, 96) < 0.45).length,
            nearSE: pts.filter((p) => distPlan(p, 100, 80) < 0.45).length,
            onPad: pts.filter((p) => p.x > 90 && p.x < 100.2 && p.y > 83 && p.y < 93 && Math.abs(p.z - (g + 2)) < 0.15).length,
            sample: pts.slice(0, 12)
        };
    }, groundZ);
    if (padWrap.nearNE < 1 || padWrap.nearSE < 1) {
        problems.push(
            `откосы: верхняя площадка не обошла углы нижней (СВ ${padWrap.nearNE}, ЮВ ${padWrap.nearSE}, ${JSON.stringify(padWrap)})`
        );
    }
    if (padWrap.onPad < 2) {
        problems.push(`откосы: верхняя площадка не села на поверхность нижней (${JSON.stringify(padWrap)})`);
    }

    // Окно «△ Откосы» настоящими кликами, а не в обход через отладочный API:
    // проверяем, что кнопка в строке списка находит СВОЮ полилинию, поля
    // читаются с формы (а не остались значением по умолчанию из прошлого
    // открытия), и построение через кнопку «Построить» реально появляется в
    // сцене — то есть весь путь пользователя целиком, не только математику.
    await page.evaluate(([g, h]) => {
        window.BimLvaDebug.createPolylineFromPoints(
            [{ x: -20, y: 15, z: g + h }, { x: -15.6, y: 15, z: g + h }],
            { name: 'Откос-тест-UI' }
        );
    }, [groundZ, H1]);
    await page.evaluate(() => document.getElementById('btnPolylineList')?.click());
    const uiOpened = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#polylinesList .polyline-row')];
        const row = rows.find((r) => r.querySelector('input.editInput')?.value === 'Откос-тест-UI');
        const btn = [...(row?.querySelectorAll('button') || [])].find((b) => b.textContent.includes('Откосы'));
        btn?.click();
        return {
            found: !!btn,
            modalShown: document.getElementById('slopeModal')?.classList.contains('show'),
            selectHasIt: [...(document.getElementById('slopeSelect')?.options || [])]
                .some((o) => o.textContent === 'Откос-тест-UI'),
            mFill: document.getElementById('slopeMFill')?.value,
            mCut: document.getElementById('slopeMCut')?.value
        };
    });
    if (!uiOpened.found || !uiOpened.modalShown || !uiOpened.selectHasIt) {
        problems.push(`откосы: кнопка в списке не открыла окно как надо (${JSON.stringify(uiOpened)})`);
    }
    if (uiOpened.mFill !== '1.5' || uiOpened.mCut !== '1') {
        problems.push(`откосы: умолчания в окне 1:m — насыпь «${uiOpened.mFill}», выемка «${uiOpened.mCut}» (ждали 1.5 и 1)`);
    }
    await page.evaluate(() => { document.getElementById('slopeSide').value = 'both'; });
    await page.evaluate(() => document.getElementById('slopeApply')?.click());
    const afterApply = await page.evaluate(() => ({
        status: document.getElementById('slopeStatus')?.textContent || '',
        count: window.BimLvaDebug.slopes.length
    }));
    if (!afterApply.count || !/насыпь/i.test(afterApply.status)) {
        problems.push(`откосы: клик «Построить» в окне не дал результата (статус «${afterApply.status}»)`);
    }
    await page.evaluate(() => {
        document.getElementById('slopeCancel')?.click();
        document.getElementById('polylinesClose')?.click();
    });

    // «Убрать откосы» снимает поверхности и линии выхода; сами бровки (все
    // тестовые линии) убираем через «Удалить все» — к этому моменту в списке
    // не должно быть ничего чужого, checkDrawDxf чистит за собой сам.
    await page.evaluate(() => window.BimLvaDebug.clearSlopes());
    await page.evaluate(() => {
        document.getElementById('btnPolylineList')?.click();
        document.getElementById('polylinesClear')?.click();
        document.getElementById('polylinesClose')?.click();
    });

    return {
        fillVolume: fill.res?.sides?.[0]?.fill ?? 0,
        cutVolume: (cut.res?.sides || []).reduce((s, x) => s + x.cut, 0)
    };
}

/**
 * Поперечники по оси. Ось числами вдоль X на той же площадке, что откосы.
 * Смещение > 0 — вправо по ходу: при ходе на восток (+X) вправо это −Y.
 */
async function checkRoadCrossSections(page) {
    const groundZ = await page.evaluate(() => {
        const b = window.BimLvaDebug.modelBounds;
        return b.length ? Math.max(...b.map((m) => m.centerZ + m.sizeZ / 2)) : null;
    });
    if (groundZ == null) {
        problems.push('поперечники: нет отметки площадки — проверка пропущена');
        return null;
    }
    const defaults = await page.evaluate(() => ({
        half: window.BimLvaDebug.defaultRoadHalfWidth,
        L: document.getElementById('roadXsWidthL')?.value,
        R: document.getElementById('roadXsWidthR')?.value,
        mode: document.getElementById('roadCornerMode')?.value,
        rHidden: getComputedStyle(document.getElementById('roadCornerRadiusLab') || document.body).display === 'none'
    }));
    if (defaults.half !== 3.25) {
        problems.push(`поперечники: DEFAULT ширина ${defaults.half} вместо 3.25`);
    }
    if (defaults.L !== '3.25' || defaults.R !== '3.25') {
        problems.push(`поперечники: поля ширины ${defaults.L}/${defaults.R} вместо 3.25/3.25`);
    }
    if (defaults.mode !== 'miter' || !defaults.rHidden) {
        problems.push(`поперечники: углы по умолчанию ${JSON.stringify(defaults)} вместо прямой (miter)`);
    }
    const got = await page.evaluate((g) => {
        const D = window.BimLvaDebug;
        const id = D.createPolylineFromPoints(
            [
                { x: 20.5, y: 17, z: g + 0.5 },
                { x: 23.5, y: 17, z: g + 0.5 }
            ],
            { name: 'Ось-тест-поперечники' }
        );
        const res = D.buildRoadXs(id, {
            step: 1.5, widthL: 2, widthR: 2, sampleStep: 1, live: false
        });
        const dxf = D.roadXsDxfPreview() || '';
        return {
            res,
            dxfXs: /Поперечник/.test(dxf),
            dxfRoad: /Кромка/.test(dxf),
            dxfPolys: (dxf.match(/\r\nPOLYLINE\r\n/g) || []).length,
            dxf3d: (dxf.match(/\r\n70\r\n8\r\n/g) || []).length
        };
    }, groundZ);

    if (!got.res || got.res.stations !== 3) {
        problems.push(`поперечники: сечений ${got.res?.stations} вместо 3 (0 / 1.5 / 3)`);
    } else {
        if ((got.res.corridorTris || 0) < 20) {
            problems.push(`поперечники: полотно ${got.res.corridorTris} граней — «Построить» не протянуло шаблон`);
        }
        if ((got.res.template?.points?.length || 0) < 5) {
            problems.push(`поперечники: шаблон ${got.res.template?.points?.length} точек вместо ≥5 (L/CL/R/RB/LB)`);
        }
        if ((got.res.template?.shapes?.length || 0) < 1) {
            problems.push(`поперечники: в шаблоне нет формы покрытия`);
        }
        if (Math.abs(got.res.first.sta) > 1e-6 || Math.abs(got.res.last.sta - 3) > 1e-4) {
            problems.push(
                `поперечники: пикеты ${got.res.first.sta} … ${got.res.last.sta} вместо 0 … 3`
            );
        }
        if (Math.abs(got.res.first.x - 20.5) > 1e-4 || Math.abs(got.res.first.y - 17) > 1e-4) {
            problems.push(
                `поперечники: начало (${got.res.first.x}, ${got.res.first.y}) не на оси (20.5, 17)`
            );
        }
        if (Math.abs(got.res.last.x - 23.5) > 1e-4 || Math.abs(got.res.last.y - 17) > 1e-4) {
            problems.push(
                `поперечники: конец (${got.res.last.x}, ${got.res.last.y}) не на оси (23.5, 17)`
            );
        }
        // Вправо по ходу +X: ry = -1, offset +2 → y = 17-2 = 15
        const right = got.res.first.samples.find((s) => Math.abs(s.off - 2) < 1e-6);
        const left = got.res.first.samples.find((s) => Math.abs(s.off + 2) < 1e-6);
        const axis = got.res.first.samples.find((s) => Math.abs(s.off) < 1e-6);
        if (!right || Math.abs(right.y - 15) > 1e-3) {
            problems.push(`поперечники: вправо +2 ожидался Y=15, получили ${JSON.stringify(right)}`);
        }
        if (!left || Math.abs(left.y - 19) > 1e-3) {
            problems.push(`поперечники: влево −2 ожидался Y=19, получили ${JSON.stringify(left)}`);
        }
        if (!axis?.hit || Math.abs(axis.absZ - groundZ) > 0.05) {
            problems.push(
                `поперечники: земля под осью ${axis?.absZ} вместо ${groundZ.toFixed(3)}`
            );
        }
        if (axis?.work == null || Math.abs(axis.work - 0.5) > 0.05) {
            problems.push(`поперечники: рабочая под осью ${axis?.work} вместо 0.5`);
        }
        if (Math.abs((got.res.first.rx || 0) - 0) > 1e-6 || Math.abs((got.res.first.ry || 0) + 1) > 1e-6) {
            problems.push(
                `поперечники: правая нормаль (${got.res.first.rx}, ${got.res.first.ry}) вместо (0, -1)`
            );
        }
        const az = got.res.first.axisSceneZ;
        const dz = got.res.first.designZ;
        if (!(Math.abs((dz ?? NaN) - az) < 0.05)) {
            problems.push(`поперечники: синяя линия Z=${dz} не на оси ${az}`);
        }
        if (!(Math.abs((dz ?? az) - groundZ) > 0.2)) {
            problems.push(`поперечники: синяя линия на земле (${dz} ≈ ${groundZ}), а не на оси`);
        }
    }
    if (!got.dxfXs || !got.dxfRoad || got.dxfPolys < 3) {
        problems.push(
            `поперечники: DXF Поперечник ${got.dxfXs}, Кромка ${got.dxfRoad}, POLYLINE ${got.dxfPolys} (ждали оба слоя и ≥3)`
        );
    }

    // L-угол 90°: на PI одна секущая по биссектрисе, кромка справа в уголке.
    // tIn=(1,0) tOut=(0,1) → нормали (0,−1) и (1,0) → miter (0.707, −0.707),
    // scale √2; ширина 2 м → правая кромка (24,17)+(2,−2)=(26,15).
    const corner = await page.evaluate((g) => {
        const D = window.BimLvaDebug;
        const id = D.createPolylineFromPoints(
            [
                { x: 21, y: 17, z: g + 0.5 },
                { x: 24, y: 17, z: g + 0.5 },
                { x: 24, y: 20, z: g + 0.5 }
            ],
            { name: 'Ось-тест-угол', role: 'road-axis' }
        );
        const res = D.buildRoadXs(id, {
            step: 10, widthL: 2, widthR: 2, sampleStep: 1, live: false
        });
        const pi = (res?.corner || []).find((c) => Math.abs(c.x - 24) < 1e-3 && Math.abs(c.y - 17) < 1e-3);
        const rightPi = (res?.edges?.right || []).find((p) => Math.abs(p.x - 26) < 0.05 && Math.abs(p.y - 15) < 0.05);
        return {
            stations: res?.stations,
            pi,
            rightPi,
            rightN: res?.edges?.right?.length || 0,
            leftN: res?.edges?.left?.length || 0
        };
    }, groundZ);
    if (!corner.pi) {
        problems.push(`поперечники: на L-угле нет станции в PI (24, 17) — ${JSON.stringify(corner)}`);
    } else {
        const rx = corner.pi.rx, ry = corner.pi.ry;
        const want = Math.SQRT1_2;
        if (Math.abs(rx - want) > 0.02 || Math.abs(ry + want) > 0.02) {
            problems.push(
                `поперечники: биссектриса на угле (${rx?.toFixed(3)}, ${ry?.toFixed(3)}) вместо (0.707, −0.707)`
            );
        }
        if (Math.abs((corner.pi.miterScale || 0) - Math.SQRT2) > 0.05) {
            problems.push(`поперечники: miterScale ${corner.pi.miterScale} вместо √2`);
        }
        if (!corner.rightPi) {
            problems.push(`поперечники: правая кромка на угле не в (26, 15) — ${JSON.stringify(corner)}`);
        }
        if (corner.rightN < 3 || corner.leftN < 3) {
            problems.push(`поперечники: кромки L-угла left=${corner.leftN} right=${corner.rightN} (ждали по 3 вершины)`);
        }
    }

    const planEdit = await page.evaluate((g) => {
        const D = window.BimLvaDebug;
        const id = D.createPolylineFromPoints(
            [
                { x: 21, y: 18, z: g + 0.5 },
                { x: 25, y: 18, z: g + 0.5 },
                { x: 25, y: 22, z: g + 0.5 }
            ],
            { name: 'Ось-тест-план', role: 'road-axis' }
        );
        D.buildRoadXs(id, { step: 20, widthL: 2, widthR: 2, sampleStep: 1, live: false });
        const moved = D.planMoveVertex(id, 1, 26, 18);
        const afterMove = D.buildRoadXs(id, { step: 20, widthL: 2, widthR: 2, sampleStep: 1, live: false });
        D.setRoadWidths(id, 4.5, 5);
        const afterW = D.buildRoadXs(id, { step: 20, widthL: 4.5, widthR: 5, sampleStep: 1, live: false });
        const fillet = D.applyRoadCorners(id, 'fillet', 3);
        const filletSt = D.roadCornerState(id);
        const miter = D.applyRoadCorners(id, 'miter', 3);
        const miterSt = D.roadCornerState(id);
        const defId = D.createPolylineFromPoints(
            [
                { x: 30, y: 17, z: g + 0.5 },
                { x: 33, y: 17, z: g + 0.5 }
            ],
            { name: 'Ось-тест-ширина' }
        );
        const defW = D.buildRoadXs(defId, { step: 10, sampleStep: 1, live: false });
        return {
            moved,
            pi: (afterMove?.corner || []).find((c) => Math.abs(c.x - 26) < 1e-3 && Math.abs(c.y - 18) < 1e-3),
            widthL: afterW?.widthL,
            widthR: afterW?.widthR,
            htmlL: document.getElementById('roadXsWidthL')?.value,
            htmlR: document.getElementById('roadXsWidthR')?.value,
            filletR: fillet?.[1],
            filletMode: filletSt?.mode,
            miterR: miter?.[1],
            miterMode: miterSt?.mode,
            defL: defW?.widthL,
            defR: defW?.widthR
        };
    }, groundZ);
    if (!planEdit.moved || !planEdit.pi) {
        problems.push(`поперечники: на плане вершина не сдвинулась в (26, 18) — ${JSON.stringify(planEdit)}`);
    }
    if (Math.abs((planEdit.widthL || 0) - 4.5) > 1e-6 || Math.abs((planEdit.widthR || 0) - 5) > 1e-6) {
        problems.push(`поперечники: тяга ширины ${planEdit.widthL}/${planEdit.widthR} вместо 4.5/5`);
    }
    if (planEdit.htmlL !== '4.5' || planEdit.htmlR !== '5') {
        problems.push(`поперечники: поля ширины после правки ${planEdit.htmlL}/${planEdit.htmlR} вместо 4.5/5`);
    }
    if (!(planEdit.filletR > 0) || planEdit.filletMode !== 'fillet') {
        problems.push(`поперечники: скругление угла не записалось (${JSON.stringify(planEdit)})`);
    }
    if (planEdit.miterR !== 0 || planEdit.miterMode !== 'miter') {
        problems.push(`поперечники: прямой угол не сбросил радиус (${JSON.stringify(planEdit)})`);
    }
    if (Math.abs((planEdit.defL || 0) - 3.25) > 1e-6 || Math.abs((planEdit.defR || 0) - 3.25) > 1e-6) {
        problems.push(`поперечники: новая ось без ширины дала ${planEdit.defL}/${planEdit.defR} вместо 3.25/3.25`);
    }

    const labels = await page.evaluate((g) => {
        const D = window.BimLvaDebug;
        const id = D.createPolylineFromPoints(
            [
                { x: 21, y: 19, z: g + 0.5 },
                { x: 24, y: 19, z: g + 0.5 },
                { x: 24, y: 22, z: g + 0.5 }
            ],
            { name: 'Ось-тест-подписи', role: 'road-axis' }
        );
        D.buildRoadXs(id, { step: 20, widthL: 2, widthR: 2, sampleStep: 1, live: false });
        const defl0 = D.polylineDeflection(id, 1);
        D.openRoadProfile(id);
        D.fitRoadPlan();
        D.editPolyline(id, 'defl', 1, 45);
        const defl1 = D.polylineDeflection(id, 1);
        D.editPolyline(id, 'defl', 1, 90);
        D.editPolyline(id, 'radius', 1, 2);
        return { id, defl0, defl1, deflBack: D.polylineDeflection(id, 1) };
    }, groundZ);
    await page.waitForTimeout(250);
    const labelUi = await page.evaluate(() => window.BimLvaDebug.chartAnnot());
    if (Math.abs((labels.defl0 || 0) - 90) > 0.05) {
        problems.push(`поперечники: угол L-оси ${labels.defl0}° вместо 90`);
    }
    if (Math.abs((labels.defl1 || 0) - 45) > 0.05) {
        problems.push(`поперечники: правка угла поворота дала ${labels.defl1}° вместо 45`);
    }
    if (Math.abs((labels.deflBack || 0) - 90) > 0.05) {
        problems.push(`поперечники: возврат угла поворота дал ${labels.deflBack}° вместо 90`);
    }
    if ((labelUi.planAng || 0) < 1 || !/Δ90|Δ\+?90/.test(labelUi.plan || '')) {
        problems.push(`поперечники: на плане нет угла поворота Δ90° (${JSON.stringify(labelUi)})`);
    }
    if ((labelUi.planLen || 0) < 2 || !/3\.00\s*м/.test(labelUi.plan || '')) {
        problems.push(`поперечники: на плане нет длин звеньев 3.00 м (${JSON.stringify(labelUi)})`);
    }
    if ((labelUi.planR || 0) < 1 || !/R\s*2/.test(labelUi.plan || '')) {
        problems.push(`поперечники: на плане нет радиуса R 2 (${JSON.stringify(labelUi)})`);
    }
    if ((labelUi.profZ || 0) < 3 || (labelUi.profSeg || 0) < 2) {
        problems.push(`поперечники: на профиле L-оси нет отметок/уклонов (${JSON.stringify(labelUi)})`);
    }

    const vcurve = await page.evaluate(() => {
        const D = window.BimLvaDebug;
        const id = D.createPolylineFromPoints(
            [
                { x: 10, y: 30, z: 0 },
                { x: 50, y: 30, z: 8 },
                { x: 90, y: 30, z: 0 }
            ],
            { name: 'Ось-тест-вкривая' }
        );
        const before = D.drawn.find((d) => d.id === id);
        const pviZ = before.vertsAbs[1].z;
        const maxBefore = Math.max(...before.abs.map((p) => p.z));
        D.setPolylineVRadius(id, 1, 80);
        const after = D.drawn.find((d) => d.id === id);
        const maxAfter = Math.max(...after.abs.map((p) => p.z));
        D.openRoadProfile(id);
        const annot = D.chartAnnot();
        const axis = document.getElementById('polyProfileAxisLine')?.getAttribute('points') || '';
        const nAxis = axis.trim().split(/\s+/).filter(Boolean).length;
        const knot = document.querySelector('#polyProfileChart .pknot[data-idx="1"]');
        let menu = { knot: !!knot };
        if (knot) {
            knot.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 120
            }));
            menu.shown = !!document.getElementById('profileChartCtx')?.classList.contains('show');
            document.getElementById('ctxProfileVCurve')?.click();
            menu.modal = !!document.getElementById('filletModal')?.classList.contains('show');
            menu.title = document.getElementById('filletTitle')?.textContent || '';
            document.getElementById('filletCancel')?.click();
        }
        D.setPolylineVRadius(id, 1, 0);
        const restored = D.drawn.find((d) => d.id === id);
        const max0 = Math.max(...restored.abs.map((p) => p.z));
        D.deletePolyline(id);
        return {
            pviZ, maxBefore, maxAfter, max0,
            vR: after.vRadii?.[1],
            nAbs: after.abs.length,
            nAxis,
            annotVR: annot.profVR,
            menu
        };
    });
    if (!(vcurve.vR > 70)) {
        problems.push(`профиль: вертикальный радиус не записался (${JSON.stringify(vcurve)})`);
    }
    if (!(vcurve.maxAfter < vcurve.pviZ - 0.05)) {
        problems.push(`профиль: вертикальная кривая прошла через PVI (${JSON.stringify(vcurve)})`);
    }
    if (!(Math.abs(vcurve.max0 - vcurve.pviZ) < 0.02)) {
        problems.push(`профиль: 0 не убрал вертикальную кривую (${JSON.stringify(vcurve)})`);
    }
    if ((vcurve.nAxis || 0) < 6) {
        problems.push(`профиль: ось после кривой не дуга (${JSON.stringify(vcurve)})`);
    }
    if ((vcurve.annotVR || 0) < 1) {
        problems.push(`профиль: нет подписи Rв (${JSON.stringify(vcurve)})`);
    }
    if (!vcurve.menu?.shown || !vcurve.menu?.modal || !/Вертикальная/.test(vcurve.menu.title || '')) {
        problems.push(`профиль: ПКМ не открыл вертикальную кривую (${JSON.stringify(vcurve.menu)})`);
    }

    // Короткое плечо + R больше ширины: радиус сожмётся, внутренность без
    // правки выворачивается (кромка идёт назад, полотно — «ёжик»).
    const tightFillet = await page.evaluate((g) => {
        const D = window.BimLvaDebug;
        const id = D.createPolylineFromPoints(
            [
                { x: 20, y: 18, z: g + 0.5 },
                { x: 24, y: 18, z: g + 0.5 },
                { x: 24, y: 22, z: g + 0.5 }
            ],
            { name: 'Ось-тест-узкий-филет', role: 'road-axis' }
        );
        D.applyRoadCorners(id, 'fillet', 8);
        const res = D.buildRoadXs(id, {
            step: 1, widthL: 3.25, widthR: 3.25, sampleStep: 1, live: false
        });
        const travel = D.roadOffsetTravel(id);
        return {
            stations: res?.stations,
            tris: res?.corridorTris || 0,
            travel,
            radii: D.applyRoadCorners(id, 'fillet', 8)
        };
    }, groundZ);
    const tightRev = (tightFillet.travel?.left?.rev || 0) + (tightFillet.travel?.right?.rev || 0);
    if (tightRev > 0) {
        problems.push(`поперечники: на узком скруглении кромка вывернулась (${JSON.stringify(tightFillet.travel)})`);
    }
    if ((tightFillet.tris || 0) < 8) {
        problems.push(`поперечники: на узком скруглении полотно ${tightFillet.tris} граней`);
    }
    if (!(tightFillet.radii?.[1] > 0)) {
        problems.push(`поперечники: узкий филет без радиуса (${JSON.stringify(tightFillet.radii)})`);
    }

    // Прямая и кривая — разный шаг: на 80 м прямой не ставим сечение каждые 4 м.
    const splitStep = await page.evaluate((g) => {
        const D = window.BimLvaDebug;
        const id = D.createPolylineFromPoints(
            [
                { x: 20, y: 17, z: g + 0.5 },
                { x: 100, y: 17, z: g + 0.5 },
                { x: 100, y: 50, z: g + 0.5 }
            ],
            { name: 'Ось-тест-шаг-кривой', role: 'road-axis' }
        );
        D.applyRoadCorners(id, 'fillet', 12);
        const dense = D.buildRoadXs(id, {
            step: 4, stepCurve: 4, widthL: 2, widthR: 2, sampleStep: 1, live: false
        });
        const split = D.buildRoadXs(id, {
            step: 20, stepCurve: 4, widthL: 2, widthR: 2, sampleStep: 1, live: false
        });
        const pk = split?.pk || [];
        const tan = pk.filter((s) => s > 1 && s < 55);
        const gaps = [];
        for (let i = 1; i < tan.length; i++) gaps.push(tan[i] - tan[i - 1]);
        const med = gaps.length
            ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
            : 0;
        return {
            denseN: dense?.stations || 0,
            splitN: split?.stations || 0,
            stepCurve: split?.stepCurve,
            tanN: tan.length,
            medGap: med,
            pk: pk.map((s) => +s.toFixed(2))
        };
    }, groundZ);
    if ((splitStep.splitN || 0) >= (splitStep.denseN || 0)) {
        problems.push(
            `поперечники: раздельный шаг не сэкономил сечения ` +
            `(${splitStep.splitN} при шаге 20/4 против ${splitStep.denseN} при 4/4)`
        );
    }
    if ((splitStep.medGap || 0) < 12) {
        problems.push(
            `поперечники: на прямой шаг ${splitStep.medGap} м, ждали ≈20 ` +
            `(${JSON.stringify(splitStep)})`
        );
    }
    if ((splitStep.splitN || 0) < 8) {
        problems.push(`поперечники: раздельный шаг дал слишком мало сечений (${JSON.stringify(splitStep)})`);
    }

    const ui = await page.evaluate(() => {
        document.getElementById('btnPolylineList')?.click();
        const rows = [...document.querySelectorAll('#polylinesList .polyline-row')];
        const row = rows.find((r) => r.querySelector('input.editInput')?.value === 'Ось-тест-поперечники');
        const btn = [...(row?.querySelectorAll('button') || [])].find((b) => (b.title || '').includes('Поперечники'));
        btn?.click();
        const card = document.getElementById('roadXsCard');
        const cr = card?.getBoundingClientRect();
        const btns = [...(card?.querySelectorAll('button') || [])].map((b) => {
            const r = b.getBoundingClientRect();
            return { t: (b.textContent || '').trim(), left: r.left, w: r.width, h: r.height, id: b.id };
        });
        return {
            found: !!btn,
            shown: document.getElementById('roadXsModal')?.classList.contains('show'),
            titles: [...(card?.querySelectorAll('.rs-pane-title') || [])].map((t) => t.textContent.trim()),
            plan: !!document.getElementById('roadPlanChart'),
            splitH: !!document.getElementById('rsSplitH'),
            splitTable: !!document.getElementById('rsSplitProfileTable'),
            splitV: !!document.getElementById('rsSplitV'),
            stepCurve: !!document.getElementById('roadXsStepCurve'),
            grips: [...(card?.querySelectorAll('.rs-win-grip') || [])].map((g) => g.dataset.dir),
            applyTpl: (document.getElementById('roadXsApplyTpl')?.textContent || '').trim(),
            tpls: [...(card?.querySelectorAll('#roadXsTpls .rs-tpl') || [])].map((b) => b.textContent.replace(/\s+/g, ' ').trim()),
            palMin: !!card?.querySelector('.pal-min'),
            palDock: !!card?.querySelector('.pal-dock'),
            clashChrome: !!document.querySelector('#clashModalCard .pal-min'),
            left: cr?.left ?? -1,
            vw: innerWidth,
            w: Math.round(cr?.width || 0),
            h: Math.round(cr?.height || 0),
            btns
        };
    });
    if (!ui.found || !ui.shown) {
        problems.push(`поперечники: кнопка в списке не открыла окно (${JSON.stringify(ui)})`);
    } else if (ui.left < -1) {
        problems.push(`поперечники: окно уехало влево (${ui.left})`);
    } else {
        const apply = ui.btns.find((b) => b.id === 'roadXsApply' || b.t.includes('Построить'));
        if (!apply || apply.w < 4 || apply.left < -1) {
            problems.push(`поперечники: кнопка «Построить» не видна (${JSON.stringify(apply)})`);
        }
        if (!ui.titles.includes('План') || !ui.titles.includes('Профиль') || !ui.titles.includes('Поперечник')) {
            problems.push(`поперечники: нет панелей План/Профиль/Поперечник (${JSON.stringify(ui.titles)})`);
        }
        if (!ui.plan || !ui.splitH || !ui.splitV || !ui.splitTable || !ui.stepCurve || ui.grips.join(',') !== 'e,s,se') {
            problems.push(`поперечники: нет плана или ручек раскладки (${JSON.stringify({ plan: ui.plan, splitH: ui.splitH, splitV: ui.splitV, splitTable: ui.splitTable, stepCurve: ui.stepCurve, grips: ui.grips })})`);
        }
        if (ui.applyTpl !== 'Применить на ось' || ui.tpls.length < 5) {
            problems.push(`поперечники: нет каталога шаблонов (${JSON.stringify({ applyTpl: ui.applyTpl, tpls: ui.tpls })})`);
        }
        if ((ui.w || 0) < 700 || (ui.h || 0) < 360) {
            problems.push(`поперечники: окно слишком маленькое для трёх чертежей (${ui.w}×${ui.h})`);
        }
        if (!ui.palMin || !ui.palDock) {
            problems.push('поперечники: нет кнопок свернуть/закрепить на палитре');
        }
        if (!ui.clashChrome) {
            problems.push('окна: нет хрома свернуть/закрепить у коллизий');
        }
    }

    await page.waitForTimeout(250);
    const chart = await page.evaluate(() => {
        const html = document.getElementById('roadXsChart')?.innerHTML || '';
        return {
            hasBg: /fill="#f7f9fb"/.test(html),
            hasGround: /class="xs-ground"/.test(html),
            hasFill: /<path d=/.test(html),
            hasRoad: /fill="#e8c48a"/.test(html),
            hasEdge: /кромка/.test(html),
            hasKnots: /class="xs-pt"/.test(html),
            hasShape: /class="xs-shape"/.test(html),
            hasSlope: /class="xs-slope"/.test(html),
            hasDim: /class="xs-dim"/.test(html),
            profileBtn: !!document.getElementById('roadXsProfile'),
            slopeBtn: !!document.getElementById('roadXsSlope'),
            planPoly: /<polyline /.test(document.getElementById('roadPlanChart')?.innerHTML || ''),
            planVerts: document.querySelectorAll('#roadPlanChart .pkvert').length,
            planEdges: document.querySelectorAll('#roadPlanChart .pkedge').length,
            cornerMode: !!document.getElementById('roadCornerMode'),
            profSvg: (document.getElementById('polyProfileChart')?.innerHTML || '').length > 80,
            annot: window.BimLvaDebug.chartAnnot()
        };
    });
    if (!chart.hasBg || !chart.hasGround || !chart.hasFill || !chart.hasRoad || !chart.hasEdge) {
        problems.push(`поперечники: чертёж в окне пустой или без полосы дороги (${JSON.stringify(chart)})`);
    }
    if (!chart.hasDim) {
        problems.push('поперечники: на чертеже нет размерной цепочки');
    }
    if (!chart.planPoly || !chart.profSvg) {
        problems.push(`поперечники: план или профиль пустой (${JSON.stringify({ planPoly: chart.planPoly, profSvg: chart.profSvg })})`);
    }
    if ((chart.planVerts || 0) < 2 || (chart.planEdges || 0) < 2 || !chart.cornerMode) {
        problems.push(`поперечники: на плане нет ручек вершин/кромок (${JSON.stringify({ verts: chart.planVerts, edges: chart.planEdges, corner: chart.cornerMode })})`);
    }
    if ((chart.annot?.planLen || 0) < 1 || !/м/.test(chart.annot?.plan || '')) {
        problems.push(`поперечники: на плане нет подписи длины (${JSON.stringify(chart.annot)})`);
    }
    if ((chart.annot?.profZ || 0) < 2 || (chart.annot?.profSeg || 0) < 1) {
        problems.push(`поперечники: на профиле нет отметок или длины/уклона (${JSON.stringify(chart.annot)})`);
    }
    const profileTable = await page.evaluate(() => {
        const table = document.getElementById('polyProfileTable');
        const z = document.querySelector('#polyProfileAnnot .prof-vz-label');
        const axis0 = document.querySelector('#polyProfileTable input[data-edit="axis"]');
        const before = axis0 ? Number(axis0.value) : NaN;
        if (z) {
            z.click();
            const input = z.querySelector('input');
            if (input) {
                input.value = (before + 1.25).toFixed(3);
                input.dispatchEvent(new Event('blur', { bubbles: true }));
            }
        }
        const axis1 = document.querySelector('#polyProfileTable input[data-edit="axis"]');
        const h0 = Math.round(table?.getBoundingClientRect().height || 0);
        document.getElementById('roadXsCard')?.style.setProperty('--rs-prof-table', '180px');
        const h1 = Math.round(table?.getBoundingClientRect().height || 0);
        return {
            tableH: h0,
            tableH180: h1,
            zCount: document.querySelectorAll('#polyProfileAnnot .prof-vz-label').length,
            zTitle: z?.title || '',
            before,
            after: axis1 ? Number(axis1.value) : NaN
        };
    });
    if ((profileTable.tableH || 0) < 96) {
        problems.push(`профиль: таблица слишком низкая (${JSON.stringify(profileTable)})`);
    }
    if ((profileTable.tableH180 || 0) < 170) {
        problems.push(`профиль: ручка таблицы не растягивает (${JSON.stringify(profileTable)})`);
    }
    if ((profileTable.zCount || 0) < 2 || !/отметк/i.test(profileTable.zTitle || '')) {
        problems.push(`профиль: на вершинах нет подписи отметки (${JSON.stringify(profileTable)})`);
    }
    if (!(Math.abs((profileTable.after || 0) - (profileTable.before + 1.25)) < 0.02)) {
        problems.push(`профиль: клик по отметке на вершине не сменил Z (${JSON.stringify(profileTable)})`);
    }
    if (!chart.hasKnots || !chart.hasShape) {
        problems.push(`поперечники: на чертеже нет точек/формы шаблона (${JSON.stringify(chart)})`);
    }
    const xsCaptions = await page.evaluate(() => {
        const html = document.getElementById('roadXsChart')?.innerHTML || '';
        return {
            axis: />Ось</.test(html) || />Ось /.test(html) || html.includes('>Ось<') || /fill="#6a5420">Ось/.test(html),
            pave: /Покрытие/.test(html),
            latinCL: /fill="#6a5420">CL</.test(html)
        };
    });
    if (!xsCaptions.axis || !xsCaptions.pave) {
        problems.push(`поперечники: на чертеже нет кириллических подписей (${JSON.stringify(xsCaptions)})`);
    }
    if (xsCaptions.latinCL) {
        problems.push('поперечники: на чертеже остался латинский код CL вместо «Ось»');
    }
    if (!chart.profileBtn) {
        problems.push('поперечники: нет кнопки «Профиль»');
    }
    if (!chart.slopeBtn) {
        problems.push('поперечники: нет кнопки «Откосы»');
    }

    const zoom = await page.evaluate(() => {
        const D = window.BimLvaDebug;
        const before = D.roadXsViewSpan();
        D.zoomRoadXs(1 / 1.18);
        const mid = D.roadXsViewSpan();
        D.fitRoadXs();
        const after = D.roadXsViewSpan();
        return {
            hasFit: !!document.getElementById('roadXsFit'),
            hasFigure: !!document.getElementById('roadXsFigure'),
            before: before?.off,
            mid: mid?.off,
            after: after?.off
        };
    });
    if (!zoom.hasFit || !zoom.hasFigure) {
        problems.push(`поперечники: нет ⤢ или «＋ фигура» (${JSON.stringify(zoom)})`);
    }
    if (!(zoom.mid < zoom.before - 0.05)) {
        problems.push(`поперечники: зум не сузил окно смещений (${JSON.stringify(zoom)})`);
    }
    if (Math.abs((zoom.after ?? 0) - (zoom.before ?? 0)) > 0.05) {
        problems.push(`поперечники: ⤢ не вернул масштаб сечения (${JSON.stringify(zoom)})`);
    }
    const scale11 = await page.evaluate(() => {
        const D = window.BimLvaDebug;
        D.fitRoadXs();
        return D.roadXsViewSpan();
    });
    if (!scale11 || !(scale11.mPerPxOff > 0)
        || Math.abs(scale11.mPerPxOff - scale11.mPerPxZ) / scale11.mPerPxOff > 0.05) {
        problems.push(`поперечники: вертикальный масштаб не 1:1 (${JSON.stringify(scale11)})`);
    }

    const layer = await page.evaluate(() => {
        const D = window.BimLvaDebug;
        const thkEl = document.getElementById('roadXsLayerThk');
        const beforeThk = D.roadXsTemplate();
        const rb0 = beforeThk?.points?.find((p) => p.code === 'RB');
        if (thkEl) {
            thkEl.value = '0.35';
            thkEl.dispatchEvent(new Event('input', { bubbles: true }));
            thkEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const mid = D.roadXsTemplate();
        const rbMid = mid?.points?.find((p) => p.code === 'RB');
        D.setRoadXsLayerThickness(0.20);
        const before = D.roadXsTemplate();
        const res = D.addRoadXsLayer(0.30);
        const after = D.roadXsTemplate();
        const zMin = Math.min(...(after?.points || []).map((p) => p.dz));
        return {
            hasBtn: !!document.getElementById('roadXsAddLayer'),
            hasChk: !!document.getElementById('roadXsSlopeOn'),
            slopeLabel: document.getElementById('roadXsSlope')?.textContent || '',
            profileXs: !!document.getElementById('polyProfileXs'),
            bigDraw: !!document.querySelector('#btnRoadXs.rbtn-big'),
            bigRelief: !!document.querySelector('#btnRoadXsAnalyze.rbtn-big'),
            rb0: rb0?.dz,
            rbMid: rbMid?.dz,
            beforeShapes: before?.shapes?.length || 0,
            afterShapes: after?.shapes?.length || 0,
            beforePts: before?.points?.length || 0,
            afterPts: after?.points?.length || 0,
            code: res?.added?.code || '',
            zMin
        };
    });
    if (!layer.hasBtn || !layer.hasChk) {
        problems.push(`поперечники: нет «＋ слой» или галочки откосов (${JSON.stringify(layer)})`);
    }
    if (Math.abs((layer.rbMid ?? 0) + 0.35) > 1e-6) {
        problems.push(`поперечники: смена толщины слоя не сдвинула низ покрытия (${JSON.stringify(layer)})`);
    }
    if (!/Откосы до рельефа/.test(layer.slopeLabel)) {
        problems.push(`поперечники: кнопка откосов без подписи «до рельефа» (${layer.slopeLabel})`);
    }
    if (!layer.profileXs) problems.push('поперечники: нет кнопки в окне профиля');
    if (!layer.bigDraw || !layer.bigRelief) {
        problems.push('поперечники: кнопки на ленте не крупные (Черчение / Рельеф)');
    }
    if (layer.afterShapes !== layer.beforeShapes + 1 || layer.afterPts !== layer.beforePts + 2) {
        problems.push(
            `поперечники: «＋ слой» не добавил форму/точки (${JSON.stringify(layer)})`
        );
    }
    if (layer.code !== 'BASE') {
        problems.push(`поперечники: код второго слоя «${layer.code}» вместо BASE`);
    }
    if (Math.abs(layer.zMin + 0.5) > 1e-6) {
        problems.push(`поперечники: низ второго слоя ${layer.zMin} вместо −0.50`);
    }

    const live = await page.evaluate(() => {
        const D = window.BimLvaDebug;
        const before = D.roadXsTemplate();
        const left = before?.points?.find((p) => p.code === 'L');
        if (!left) return { ok: false, why: 'no L' };
        D.setRoadXsPoint(left.id, { dz: 0.4 });
        const after = D.roadXsTemplate();
        const moved = after?.points?.find((p) => p.id === left.id);
        const opened = D.openRoadProfile();
        const profilePane = document.getElementById('rstab-profile');
        const planPane = document.getElementById('rstab-plan');
        const xsPane = document.getElementById('rstab-xs');
        return {
            ok: true,
            dz: moved?.dz,
            tris: D.roadXs[0]?.corridorTris || 0,
            profile: !!document.getElementById('roadXsModal')?.classList.contains('show')
                && profilePane && !profilePane.hidden,
            panes: !!(planPane && xsPane && !planPane.hidden && !xsPane.hidden),
            alias: !!document.getElementById('polyProfileModal')?.classList.contains('show')
        };
    });
    if (!live.ok || Math.abs((live.dz || 0) - 0.4) > 1e-6) {
        problems.push(`поперечники: правка точки шаблона не сработала (${JSON.stringify(live)})`);
    }
    if ((live.tris || 0) < 20) {
        problems.push(`поперечники: после правки точки полотно пропало (${live.tris})`);
    }
    if (!live.profile) {
        problems.push('поперечники: «Профиль» не открыл продольный профиль оси');
    }
    if (!live.panes) {
        problems.push('поперечники: план и поперечник пропали, когда открыли профиль');
    }

    await page.waitForTimeout(250);
    const pair = await page.evaluate(() => {
        document.getElementById('polyProfileXs')?.click();
        const card = document.getElementById('roadXsCard');
        const xs = document.getElementById('rstab-xs');
        const prof = document.getElementById('rstab-profile');
        const plan = document.getElementById('rstab-plan');
        const chart = document.getElementById('roadXsChart');
        const cr = card?.getBoundingClientRect();
        return {
            ok: !!card && !!xs && !!prof && !!plan,
            xsOn: xs && !xs.hidden,
            profOn: prof && !prof.hidden,
            planOn: plan && !plan.hidden,
            chartH: Math.round(chart?.getBoundingClientRect().height || 0),
            planH: Math.round(document.getElementById('roadPlanChart')?.getBoundingClientRect().height || 0),
            cardH: Math.round(cr?.height || 0)
        };
    });
    if (!pair.ok) {
        problems.push('поперечники: нет панелей палитры трассы');
    } else if (!pair.xsOn || !pair.profOn || !pair.planOn) {
        problems.push(`поперечники: «⊟ сечение» спрятало одну из панелей (${JSON.stringify(pair)})`);
    } else if (pair.chartH < 80 || pair.planH < 60 || pair.cardH < 280) {
        problems.push(`поперечники: чертежи слишком малы (${JSON.stringify(pair)})`);
    }

    const paneLock = await page.evaluate(() => {
        const D = window.BimLvaDebug;
        const before = D.roadStudioPaneBox();
        const card = document.getElementById('roadXsCard');
        const split = document.getElementById('roadStudioSplit');
        const cr0 = card?.getBoundingClientRect();
        const sr0 = split?.getBoundingClientRect();
        const unused0 = cr0 && sr0 ? Math.round(cr0.bottom - sr0.bottom) : null;
        const h0 = card?.getBoundingClientRect().height || 0;
        if (card) {
            card.style.maxHeight = 'none';
            card.style.height = Math.round(h0 + 140) + 'px';
        }
        const afterGrow = D.roadStudioPaneBox();
        if (card) card.style.height = Math.round(h0) + 'px';
        const afterBack = D.roadStudioPaneBox();
        return { before, afterGrow, afterBack, h0, unused0 };
    });
    const dPlan = Math.abs((paneLock.afterGrow?.plan?.h || 0) - (paneLock.before?.plan?.h || 0));
    const dProf = (paneLock.afterGrow?.prof?.h || 0) - (paneLock.before?.prof?.h || 0);
    const dXs = (paneLock.afterGrow?.xs?.h || 0) - (paneLock.before?.xs?.h || 0);
    if (!paneLock.before?.locked) {
        problems.push(`поперечники: высоты панелей не зафиксировались (${JSON.stringify(paneLock.before)})`);
    } else if ((paneLock.unused0 || 0) > 48) {
        problems.push(`профиль: под чертежами пустое место ${paneLock.unused0} px, панель не забрала остаток`);
    } else if (dPlan > 2) {
        problems.push(`поперечники: высота плана уехала при росте окна (Δ ${dPlan})`);
    } else if (dProf < 80 || dXs < 80) {
        problems.push(
            `поперечники: профиль/сечение не забрали остаток окна ` +
            `(Δ план ${dPlan}, профиль ${dProf}, сечение ${dXs})`
        );
    }

    const slopes = await page.evaluate(() => {
        const D = window.BimLvaDebug;
        const left = D.roadXsTemplate()?.points?.find((p) => p.code === 'L');
        if (left) D.setRoadXsPoint(left.id, { dz: 0 });
        const res = D.buildRoadXsSlopes({ mFill: 1.5, mCut: 1, step: 0.5, maxReach: 30 });
        const html = document.getElementById('roadXsChart')?.innerHTML || '';
        return {
            res,
            hasRay: /class="xs-slope"/.test(html),
            hasGroundClass: /class="xs-ground"/.test(html),
            hasBtn: !!document.getElementById('roadXsSlope'),
            tin: res?.tinFaces || 0,
            fill: (res?.sides || []).reduce((n, s) => n + (s.fill || 0), 0),
            cut: (res?.sides || []).reduce((n, s) => n + (s.cut || 0), 0),
            n: res?.sides?.length || 0,
            ground: D.roadXsChartGround()
        };
    });
    if (!slopes.hasBtn) problems.push('поперечники: нет кнопки «Откосы»');
    if (!slopes.hasRay) problems.push('поперечники: на чертеже нет лучей откоса до земли');
    if (!slopes.hasGroundClass) problems.push('поперечники: на чертеже нет линии земли xs-ground');
    const gSlope = slopes.ground;
    if (!gSlope || gSlope.minOff == null) {
        problems.push(`поперечники: земля на сечении не снялась (${JSON.stringify(gSlope)})`);
    } else {
        if (gSlope.slopeL != null && gSlope.minOff > gSlope.slopeL + 0.05) {
            problems.push(`поперечники: земля слева ${gSlope.minOff} не дошла до откоса ${gSlope.slopeL}`);
        }
        if (gSlope.slopeR != null && gSlope.maxOff < gSlope.slopeR - 0.05) {
            problems.push(`поперечники: земля справа ${gSlope.maxOff} не дошла до откоса ${gSlope.slopeR}`);
        }
        if (gSlope.edgeL != null && gSlope.minOff > gSlope.edgeL + 0.05) {
            problems.push(`поперечники: земля слева ${gSlope.minOff} короче края шаблона ${gSlope.edgeL}`);
        }
        if (gSlope.edgeR != null && gSlope.maxOff < gSlope.edgeR - 0.05) {
            problems.push(`поперечники: земля справа ${gSlope.maxOff} короче края шаблона ${gSlope.edgeR}`);
        }
    }
    if (slopes.n !== 2) {
        problems.push(`поперечники: откосы сторон ${slopes.n} вместо 2 (${JSON.stringify(slopes.res)})`);
    }
    if (slopes.tin < 4) {
        problems.push(`поперечники: TIN откосов ${slopes.tin} граней — в модели не построилось`);
    }
    // Ось на 0.5 м над площадкой, кромки L/R с ΔZ=0, 1:1.5, длина 3 м, две стороны:
    // площадь 0.5·0.5·0.75 = 0.1875 → объём 0.1875·3·2 = 1.125 м³.
    if (Math.abs(slopes.fill - 1.125) > 0.08) {
        problems.push(`поперечники: объём откосов от кромок ${slopes.fill} вместо ≈1.125`);
    }
    if (Math.abs(slopes.cut) > 0.05) {
        problems.push(`поперечники: на насыпи от кромок набралась выемка ${slopes.cut}`);
    }

    const extras = await page.evaluate(() => {
        const D = window.BimLvaDebug;
        const before = D.roadXsTemplate();
        const r = before?.points?.find((p) => p.code === 'R');
        const fig = D.addRoadXsFigure('curb', r?.id);
        const afterFig = D.roadXsTemplate();
        const groundCurb = D.roadXsChartGround();
        const curbT = afterFig?.points?.find((p) => p.code === 'CURBT');
        const curbO = afterFig?.points?.find((p) => p.code === 'CURBO');
        D.setRoadXsPoint(r.id, { dz: 0.4 });
        const evFollow = curbT ? D.evalRoadXsPoint(curbT.id, 0) : null;
        D.setRoadXsPoint(r.id, { dz: 0 });
        if (curbT) D.setRoadXsPointRule(curbT.id, { when: 'work>', value: 0, thenHide: true });
        const evHide = curbT ? D.evalRoadXsPoint(curbT.id, 0) : null;
        const evChild = curbO ? D.evalRoadXsPoint(curbO.id, 0) : null;
        const evR = r ? D.evalRoadXsPoint(r.id, 0) : null;
        const left = D.roadXsTemplate()?.points?.find((p) => p.code === 'L');
        if (left) {
            D.setRoadXsPoint(left.id, { dz: 0 });
            D.setRoadXsPointRule(left.id, { when: 'work>', value: 0, thenDz: 0.2 });
        }
        const ev = left ? D.evalRoadXsPoint(left.id, 0) : null;
        const bar = document.getElementById('roadXsRuleBar');
        return {
            beforePts: before?.points?.length || 0,
            afterPts: afterFig?.points?.length || 0,
            beforeShapes: before?.shapes?.length || 0,
            afterShapes: afterFig?.shapes?.length || 0,
            code: fig?.added?.code || '',
            hasCurb: (afterFig?.shapes || []).some((s) => s.code === 'CURB'),
            parent: curbT?.parent,
            relDz: curbT?.relDz,
            childParent: curbO?.parent,
            followDz: evFollow?.dz,
            hide: evHide?.hide,
            childHide: evChild?.hide,
            rHide: evR?.hide,
            hasHideChk: !!document.getElementById('roadXsRuleThenHide'),
            base: ev?.baseDz,
            dz: ev?.dz,
            applies: ev?.applies,
            barShown: !!(bar && !bar.hidden),
            groundCurb
        };
    });
    if (extras.afterPts !== extras.beforePts + 3 || extras.afterShapes !== extras.beforeShapes + 1) {
        problems.push(`поперечники: «бордюр» не добавил 3 точки и форму (${JSON.stringify(extras)})`);
    }
    if (extras.code !== 'CURB' || !extras.hasCurb) {
        problems.push(`поперечники: код фигуры «${extras.code}» вместо CURB`);
    }
    if (extras.parent == null || Math.abs((extras.relDz ?? 0) - 0.15) > 1e-6) {
        problems.push(`поперечники: бордюр не привязан к якорю (${JSON.stringify(extras)})`);
    }
    if (Math.abs((extras.followDz ?? 0) - 0.55) > 1e-6) {
        problems.push(`поперечники: бордюр не поехал за якорем (${JSON.stringify(extras)})`);
    }
    if (!extras.hasHideChk || extras.hide !== true || extras.childHide !== true || extras.rHide === true) {
        problems.push(`поперечники: «скрыть» не спрятало детей бордюра (${JSON.stringify(extras)})`);
    }
    if (!extras.barShown) {
        problems.push('поперечники: панель условия точки не открылась');
    }
    if (extras.applies !== true || Math.abs((extras.base ?? -1)) > 1e-6
        || Math.abs((extras.dz ?? 0) - 0.2) > 1e-6) {
        problems.push(`поперечники: условие на точке L не дало ΔZ 0.2 при рабочей > 0 (${JSON.stringify(extras)})`);
    }
    const gCurb = extras.groundCurb;
    if (!gCurb || gCurb.edgeR == null || gCurb.maxOff < gCurb.edgeR - 0.05) {
        problems.push(`поперечники: земля не дошла до края бордюра (${JSON.stringify(gCurb)})`);
    }
    if (gCurb?.slopeR != null && gCurb.maxOff < gCurb.slopeR - 0.05) {
        problems.push(`поперечники: земля не дошла до откоса за бордюром (${JSON.stringify(gCurb)})`);
    }

    const shapeUx = await page.evaluate(() => {
        const D = window.BimLvaDebug;
        const curbTHide = D.roadXsTemplate()?.points?.find((p) => p.code === 'CURBT');
        if (curbTHide) D.setRoadXsPointRule(curbTHide.id, null);
        const fills = [...document.querySelectorAll('#roadXsChart .xs-shape')].map((el) => ({
            code: el.getAttribute('data-code') || '',
            fill: el.getAttribute('fill') || ''
        }));
        const byCode = Object.fromEntries(fills.map((f) => [f.code, f.fill]));
        const tpl0 = D.roadXsTemplate();
        const curb = (tpl0?.shapes || []).find((s) => s.code === 'CURB');
        const curbT0 = (tpl0?.points || []).find((p) => p.code === 'CURBT');
        const curbO0 = (tpl0?.points || []).find((p) => p.code === 'CURBO');
        const r0 = (tpl0?.points || []).find((p) => p.code === 'R');
        const box0 = curb && curbT0 && curbO0 ? {
            w: Math.abs(curbO0.off - curbT0.off),
            h: Math.abs(curbT0.dz - (tpl0.points.find((p) => p.id === curb.pts[0])?.dz ?? 0)),
            n: curb.pts.length,
            onR: curb.pts.includes(r0?.id)
        } : null;
        const moved = curb ? D.translateRoadXsShape(curb.id, 0.5, 0) : null;
        const curb1 = (moved?.shapes || []).find((s) => s.code === 'CURB');
        const curbT1 = (moved?.points || []).find((p) => p.code === 'CURBT');
        const curbO1 = (moved?.points || []).find((p) => p.code === 'CURBO');
        const r1 = (moved?.points || []).find((p) => p.code === 'R');
        const box1 = curb1 && curbT1 && curbO1 ? {
            w: Math.abs(curbO1.off - curbT1.off),
            h: Math.abs(curbT1.dz - (moved.points.find((p) => p.id === curb1.pts[0])?.dz ?? 0)),
            n: curb1.pts.length,
            onR: curb1.pts.includes(r1?.id)
        } : null;
        const back = curb ? D.translateRoadXsShape(curb.id, -0.5, 0) : null;
        const curb2 = (back?.shapes || []).find((s) => s.code === 'CURB');
        const r2 = (back?.points || []).find((p) => p.code === 'R');
        const afterDel = curb ? D.removeRoadXsShape(curb.id) : null;
        const stillCurb = (afterDel?.shapes || []).some((s) => s.code === 'CURB');
        const stillT = (afterDel?.points || []).some((p) => p.code === 'CURBT');
        const stillR = (afterDel?.points || []).some((p) => p.code === 'R');
        const html0 = document.getElementById('roadXsChart')?.innerHTML || '';
        const chk = document.getElementById('roadXsSlopeOn');
        if (chk) {
            chk.checked = false;
            chk.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const htmlOff = document.getElementById('roadXsChart')?.innerHTML || '';
        const groundOff = D.roadXsChartGround();
        if (chk) {
            chk.checked = true;
            chk.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const htmlOn = document.getElementById('roadXsChart')?.innerHTML || '';
        const groundOn = D.roadXsChartGround();
        return {
            fills,
            pvmt: byCode.PVMT || '',
            curb: byCode.CURB || '',
            base: byCode.BASE || '',
            unique: [...new Set(fills.map((f) => f.fill))].length,
            curbT0: curbT0?.off,
            curbT1: curbT1?.off,
            r0: r0?.off,
            r1: r1?.off,
            box0,
            box1,
            snappedBack: !!(curb2 && r2 && curb2.pts.includes(r2.id)),
            stillCurb,
            stillT,
            stillR,
            afterPts: afterDel?.points?.length || 0,
            slopeBefore: /class="xs-slope"/.test(html0),
            slopeOff: /class="xs-slope"/.test(htmlOff),
            slopeOn: /class="xs-slope"/.test(htmlOn),
            groundOff,
            groundOn,
            hasRemove: typeof D.removeRoadXsShape === 'function',
            hasTranslate: typeof D.translateRoadXsShape === 'function'
        };
    });
    if (!shapeUx.hasRemove || !shapeUx.hasTranslate) {
        problems.push('поперечники: нет API удаления/сдвига формы');
    }
    if (shapeUx.unique < 2 || !shapeUx.pvmt || !shapeUx.curb || shapeUx.pvmt === shapeUx.curb) {
        problems.push(`поперечники: формы одного цвета (${JSON.stringify(shapeUx)})`);
    }
    if (shapeUx.base && (shapeUx.base === shapeUx.pvmt || shapeUx.base === shapeUx.curb)) {
        problems.push(`поперечники: слой BASE того же цвета, что покрытие или бордюр (${JSON.stringify(shapeUx)})`);
    }
    if (!(Math.abs((shapeUx.curbT1 ?? 0) - (shapeUx.curbT0 ?? 0) - 0.5) < 1e-6)
        || Math.abs((shapeUx.r1 ?? 0) - (shapeUx.r0 ?? 0)) > 1e-6) {
        problems.push(`поперечники: сдвиг бордюра сдвинул кромку или не сдвинул CURBT (${JSON.stringify(shapeUx)})`);
    }
    if (shapeUx.box0 && (Math.abs(shapeUx.box1?.w - shapeUx.box0.w) > 1e-6
        || Math.abs(shapeUx.box1?.h - shapeUx.box0.h) > 1e-6
        || shapeUx.box1?.onR !== false)) {
        problems.push(`поперечники: сдвиг бордюра сломал жёсткость или не оторвал от R (${JSON.stringify({ box0: shapeUx.box0, box1: shapeUx.box1 })})`);
    }
    if (shapeUx.snappedBack !== true) {
        problems.push(`поперечники: возврат бордюра не примагнитился к R (${JSON.stringify({ snappedBack: shapeUx.snappedBack })})`);
    }
    if (shapeUx.stillCurb || shapeUx.stillT || !shapeUx.stillR) {
        problems.push(`поперечники: удаление бордюра не унесло форму/CURBT или сняло кромку R (${JSON.stringify(shapeUx)})`);
    }
    if (!shapeUx.slopeBefore || shapeUx.slopeOff || !shapeUx.slopeOn) {
        problems.push(`поперечники: галочка «откосы» не убирает/не возвращает лучи (${JSON.stringify({
            before: shapeUx.slopeBefore, off: shapeUx.slopeOff, on: shapeUx.slopeOn
        })})`);
    }
    if (shapeUx.groundOff?.edgeR != null && shapeUx.groundOff.maxOff < shapeUx.groundOff.edgeR - 0.05) {
        problems.push(`поперечники: без откоса земля короче края шаблона (${JSON.stringify(shapeUx.groundOff)})`);
    }
    if (shapeUx.groundOn?.slopeR != null && shapeUx.groundOn.maxOff < shapeUx.groundOn.slopeR - 0.05) {
        problems.push(`поперечники: с откосом земля короче выхода на рельеф (${JSON.stringify(shapeUx.groundOn)})`);
    }

    const studio = await page.evaluate(() => {
        const D = window.BimLvaDebug;
        const snap = D.applyRoadXsPreset('curb');
        const plan0 = D.roadPlanViewSpan();
        D.zoomRoadPlan(1 / 1.18);
        const mid = D.roadPlanViewSpan();
        D.fitRoadPlan();
        const after = D.roadPlanViewSpan();
        return {
            hasCurb: (snap?.shapes || []).some((s) => s.code === 'CURB'),
            curbN: (snap?.shapes || []).filter((s) => s.code === 'CURB').length,
            pts: snap?.points?.length || 0,
            plan0: plan0?.span,
            mid: mid?.span,
            after: after?.span,
            applyBtn: (document.getElementById('roadXsApplyTpl')?.textContent || '').trim()
        };
    });
    if (studio.applyBtn !== 'Применить на ось' || !studio.hasCurb || studio.curbN < 2) {
        problems.push(`поперечники: шаблон «С бордюром» не применился (${JSON.stringify(studio)})`);
    }
    if (!(studio.mid < studio.plan0 * 0.92)) {
        problems.push(`поперечники: зум плана не сузил окно (${JSON.stringify(studio)})`);
    }
    if (Math.abs((studio.after ?? 0) - (studio.plan0 ?? 0)) > Math.max(0.4, (studio.plan0 || 0) * 0.08)) {
        problems.push(`поперечники: ⤢ плана не вернул масштаб (${JSON.stringify(studio)})`);
    }

    const gost = await page.evaluate(() => {
        const D = window.BimLvaDebug;
        const sum = (id) => {
            const snap = D.buildRoadXsPreset(id);
            if (!snap) return { id, missing: true };
            const by = Object.fromEntries((snap.points || []).map((p) => [p.code, p]));
            const n = (c) => (snap.shapes || []).filter((s) => s.code === c).length;
            const curbT = (snap.points || []).find((p) => p.code === 'CURBT');
            const curbB = (snap.points || []).find((p) => p.code === 'CURBB');
            const shldOuter = [...new Set((snap.points || [])
                .filter((p) => p.code === 'SHLDO' || p.code === 'SHLDUO')
                .map((p) => Math.round(Math.abs(p.off) * 100) / 100))]
                .sort((a, b) => a - b);
            const dbi = (snap.points || []).find((p) => p.code === 'DBI');
            const dbix = (snap.points || []).find((p) => p.code === 'DBIX'
                && dbi && Math.sign(p.off) === Math.sign(dbi.off || 1));
            const ditchThk = dbi && dbix ? Math.hypot(dbi.off - dbix.off, dbi.dz - dbix.dz) : null;
            const ditchSh = (snap.shapes || []).find((s) => s.code === 'DITCH');
            const ditchPts = (ditchSh || {}).pts || [];
            const ditchRing = ditchPts.map((id) => (snap.points || []).find((p) => p.id === id)).filter(Boolean);
            const dbo = ditchRing.find((p) => p.code === 'DBO');
            const pip = (ring, off, dz) => {
                let n = 0;
                for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                    const a = ring[i], b = ring[j];
                    if (((a.dz > dz) !== (b.dz > dz))
                        && (off < (b.off - a.off) * (dz - a.dz) / ((b.dz - a.dz) || 1e-12) + a.off)) n++;
                }
                return n % 2 === 1;
            };
            /* Точка в канале (над днищем, внутри V) не должна попадать в полигон слоя. */
            const ditchFillsChannel = dbi && dbo
                ? pip(ditchRing, (dbi.off + dbo.off) / 2, (dbi.dz + dbo.dz) / 2 + 0.20)
                : null;
            const subb = (snap.shapes || []).find((s) => s.code === 'SUBB');
            const trough = (snap.shapes || []).find((s) => s.code === 'TROUGH');
            const troughShare = subb && trough
                ? (subb.pts || []).filter((id) => (trough.pts || []).includes(id)).length
                : 0;
            return {
                id,
                L: by.L?.off, R: by.R?.off,
                shld: n('SHLD') + n('SHLDU'), ditch: n('DITCH'), curb: n('CURB'),
                walk: n('WALK'), median: n('MEDIAN'),
                base: n('BASE'), subb: n('SUBB'), pvmt: n('PVMT'),
                wedge: n('WEDGE'), trough: n('TROUGH'), slope: n('SLOPE'), bed: n('BED'),
                embk: n('EMBK'),
                curbH: curbT && by.R ? curbT.dz - by.R.dz : null,
                curbBuried: curbB && by.R ? by.R.dz - curbB.dz : 0,
                shldOuter, ditchThk, ditchPts: ditchPts.length, ditchFillsChannel, troughShare
            };
        };
        const applied = D.applyRoadXsPreset('gost-iii');
        const html = document.getElementById('roadXsChart')?.innerHTML || '';
        const shldDrop = (snap, from, to) => {
            const a = (snap.points || []).find((p) => p.code === from);
            const b = (snap.points || []).find((p) => p.code === to && Math.sign(p.off) === Math.sign(a?.off || 1));
            if (!a || !b) return null;
            return (a.dz - b.dz) / Math.abs(b.off - a.off);
        };
        const iiiSnap = D.buildRoadXsPreset('gost-iii');
        return {
            ids: D.roadXsPresetIds(),
            cards: document.querySelectorAll('#roadXsTpls .rs-tpl').length,
            groups: [...document.querySelectorAll('#roadXsTpls .rs-catalog-label')].map((el) => el.textContent.trim()),
            iii: sum('gost-iii'),
            ia: sum('gost-ia'),
            street: sum('gost-local'),
            appliedDitch: (applied?.shapes || []).filter((s) => s.code === 'DITCH').length,
            appliedShld: (applied?.shapes || []).filter((s) => s.code === 'SHLD' || s.code === 'SHLDU').length,
            widthL: Number(document.getElementById('roadXsWidthL')?.value),
            corridorShared: D.roadXs[0]?.corridorSharedEdges,
            corridorTris: D.roadXs[0]?.corridorTris,
            dim350: /3,50/.test(html),
            perm20: /20‰/.test(html),
            perm40: /40‰/.test(html),
            ratio15: /1:1,5/.test(html),
            embkLab: /Земляное полотно/.test(html) || /id="xs-embk"/.test(html),
            shldGrade: shldDrop(iiiSnap, 'L', 'SHLDO'),
            ditchCapFills: (() => {
                if (typeof D.ditchCapTris !== 'function') return null;
                const U = [
                    { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: -1 }, { x: 2, y: 0, z: -1 }, { x: 3, y: 0, z: 0 },
                    { x: 3, y: 0, z: -0.2 }, { x: 2, y: 0, z: -1.2 }, { x: 1, y: 0, z: -1.2 }, { x: 0, y: 0, z: -0.2 }
                ];
                const p = { x: 1.5, z: -0.45 };
                const s = (a, b, q) => (b.x - a.x) * (q.z - a.z) - (b.z - a.z) * (q.x - a.x);
                const inTri = (a, b, c) => {
                    const d0 = s(a, b, p), d1 = s(b, c, p), d2 = s(c, a, p);
                    return (d0 >= -1e-9 && d1 >= -1e-9 && d2 >= -1e-9)
                        || (d0 <= 1e-9 && d1 <= 1e-9 && d2 <= 1e-9);
                };
                return D.ditchCapTris(U).some((tri) => inTri(tri[0], tri[1], tri[2]));
            })()
        };
    });
    const near = (a, b, eps = 1e-3) => Math.abs((a ?? 0) - b) <= eps;
    if (!gost.ids?.includes('curb') || !gost.ids?.includes('gost-iii') || gost.cards !== gost.ids.length) {
        problems.push(`поперечники: каталог ГОСТ (${JSON.stringify({ n: gost.cards, ids: gost.ids })})`);
    }
    if (!gost.groups?.some((g) => /СП 34/.test(g)) || !gost.groups?.some((g) => /СП 42/.test(g))) {
        problems.push(`поперечники: нет групп СП в каталоге (${JSON.stringify(gost.groups)})`);
    }
    if (!near(gost.iii?.L, -3.5) || !near(gost.iii?.R, 3.5)
        || (gost.iii?.shld || 0) < 4 || (gost.iii?.ditch || 0) < 2
        || !gost.iii?.base || !gost.iii?.subb || !gost.iii?.pvmt
        || !gost.iii?.wedge || !gost.iii?.trough
        || (gost.iii?.embk || 0) < 2
        || gost.appliedDitch < 2 || gost.appliedShld < 4 || !near(gost.widthL, 3.5)) {
        problems.push(`поперечники: шаблон III по СП 34 (${JSON.stringify(gost.iii)} appliedDitch=${gost.appliedDitch} shld=${gost.appliedShld} widthL=${gost.widthL})`);
    }
    if (!(gost.iii?.shldOuter || []).some((o) => near(o, 4.0, 0.05))
        || !(gost.iii?.shldOuter || []).some((o) => near(o, 6.0, 0.05))) {
        problems.push(`поперечники: обочина III не цепочкой 0,50+2,00 (${JSON.stringify(gost.iii?.shldOuter)})`);
    }
    if (!gost.dim350 || !gost.perm20 || !gost.perm40 || !gost.ratio15) {
        problems.push(`поперечники: нет размеров/уклонов типового чертежа (${JSON.stringify({
            dim350: gost.dim350, perm20: gost.perm20, perm40: gost.perm40, ratio15: gost.ratio15
        })})`);
    }
    if (!near(gost.shldGrade, 0.04, 0.005)) {
        problems.push(`поперечники: уклон обочины III не 40‰ (${gost.shldGrade})`);
    }
    if (!(gost.iii?.ditchPts >= 8) || !near(gost.iii?.ditchThk, 0.15, 0.04)
        || gost.iii?.ditchFillsChannel) {
        problems.push(`поперечники: кювет не слой (${JSON.stringify({
            pts: gost.iii?.ditchPts, thk: gost.iii?.ditchThk, fills: gost.iii?.ditchFillsChannel
        })})`);
    }
    if ((gost.iii?.troughShare || 0) < 2) {
        problems.push(`поперечники: корыто не стыкуется с низом одежды (share=${gost.iii?.troughShare})`);
    }
    if ((gost.corridorShared || 0) < 4 || (gost.corridorTris || 0) < 40) {
        problems.push(`поперечники: лофт полотна (${JSON.stringify({
            shared: gost.corridorShared, tris: gost.corridorTris
        })})`);
    }
    if (!gost.embkLab) {
        problems.push('поперечники: на чертеже нет земляного полотна');
    }
    if ((gost.ia?.median || 0) < 1 || !near(gost.ia?.L, -10.5) || (gost.ia?.ditch || 0) < 2) {
        problems.push(`поперечники: шаблон IA (${JSON.stringify(gost.ia)})`);
    }
    if ((gost.street?.curb || 0) < 2 || (gost.street?.walk || 0) < 2
        || !near(gost.street?.curbH, 0.15) || !near(gost.street?.curbBuried, 0.15)
        || (gost.street?.bed || 0) < 2 || !gost.street?.wedge || !gost.street?.trough) {
        problems.push(`поперечники: шаблон улицы ГОСТ 6665 (${JSON.stringify(gost.street)})`);
    }

    const dragChart = async (sel, button, dx) => {
        const box = await page.locator(sel).boundingBox();
        if (!box || box.width < 40 || box.height < 40) return false;
        const x = box.x + box.width * 0.16;
        const y = box.y + box.height * 0.2;
        await page.mouse.move(x, y);
        await page.mouse.down({ button });
        await page.mouse.move(x + dx, y + 18, { steps: 6 });
        await page.mouse.up({ button });
        return true;
    };
    const almost = (a, b, eps) => Math.abs((a ?? 0) - (b ?? 0)) <= eps;
    const pan0 = await page.evaluate(() => ({
        plan: window.BimLvaDebug.roadPlanViewSpan(),
        prof: window.BimLvaDebug.polyProfileViewSpan(),
        xs: window.BimLvaDebug.roadXsViewSpan()
    }));
    await dragChart('#roadPlanChart', 'left', 80);
    await dragChart('#polyProfileChart', 'left', 80);
    await dragChart('#roadXsChart', 'left', 80);
    const panL = await page.evaluate(() => ({
        plan: window.BimLvaDebug.roadPlanViewSpan(),
        prof: window.BimLvaDebug.polyProfileViewSpan(),
        xs: window.BimLvaDebug.roadXsViewSpan()
    }));
    if (!almost(panL.plan?.cx, pan0.plan?.cx, 0.08) || !almost(panL.plan?.cy, pan0.plan?.cy, 0.08)) {
        problems.push(`план: ЛКМ сдвинул вид (${JSON.stringify({ before: pan0.plan, after: panL.plan })})`);
    }
    if (!almost(panL.prof?.from, pan0.prof?.from, 0.08)) {
        problems.push(`профиль: ЛКМ сдвинул вид (${JSON.stringify({ before: pan0.prof, after: panL.prof })})`);
    }
    if (!almost(panL.xs?.offMin, pan0.xs?.offMin, 0.08) || !almost(panL.xs?.z0, pan0.xs?.z0, 0.08)) {
        problems.push(`поперечник: ЛКМ сдвинул вид (${JSON.stringify({ before: pan0.xs, after: panL.xs })})`);
    }
    await dragChart('#roadPlanChart', 'right', 80);
    await dragChart('#polyProfileChart', 'right', 80);
    await dragChart('#roadXsChart', 'right', 80);
    const panR = await page.evaluate(() => ({
        plan: window.BimLvaDebug.roadPlanViewSpan(),
        prof: window.BimLvaDebug.polyProfileViewSpan(),
        xs: window.BimLvaDebug.roadXsViewSpan()
    }));
    if (almost(panR.plan?.cx, pan0.plan?.cx, 0.15) && almost(panR.plan?.cy, pan0.plan?.cy, 0.15)) {
        problems.push(`план: ПКМ не сдвинул вид (${JSON.stringify({ before: pan0.plan, after: panR.plan })})`);
    }
    if (almost(panR.prof?.from, pan0.prof?.from, 0.15)) {
        problems.push(`профиль: ПКМ не сдвинул вид (${JSON.stringify({ before: pan0.prof, after: panR.prof })})`);
    }
    if (almost(panR.xs?.offMin, pan0.xs?.offMin, 0.15) && almost(panR.xs?.z0, pan0.xs?.z0, 0.15)) {
        problems.push(`поперечник: ПКМ не сдвинул вид (${JSON.stringify({ before: pan0.xs, after: panR.xs })})`);
    }

    await page.evaluate(() => document.getElementById('polyProfileClose')?.click());

    const menuXs = await page.evaluate(() => {
        document.getElementById('roadXsClose')?.click();
        const closed = !document.getElementById('roadXsModal')?.classList.contains('show');
        document.getElementById('btnRoadXs')?.click();
        const card = document.getElementById('roadXsCard');
        const cr = card?.getBoundingClientRect();
        return {
            closed,
            btn: !!document.getElementById('btnRoadXs'),
            analyze: !!document.getElementById('btnRoadXsAnalyze'),
            shown: !!document.getElementById('roadXsModal')?.classList.contains('show'),
            w: Math.round(cr?.width || 0),
            h: Math.round(cr?.height || 0)
        };
    });
    if (!menuXs.btn || !menuXs.analyze) {
        problems.push('поперечники: нет кнопки «Поперечники» на ленте (Черчение / Рельеф)');
    }
    if (!menuXs.closed || !menuXs.shown || menuXs.w < 200 || menuXs.h < 120) {
        problems.push(`поперечники: кнопка меню не открыла окно (${JSON.stringify(menuXs)})`);
    }

    await page.evaluate(() => {
        window.BimLvaDebug.clearRoadXs();
        document.getElementById('roadXsClose')?.click();
        document.getElementById('btnPolylineList')?.click();
        document.getElementById('polylinesClear')?.click();
        document.getElementById('polylinesClose')?.click();
    });

    const axisBtn = await page.evaluate(() => {
        const btn = document.getElementById('btnRoadAxis');
        const analyze = document.getElementById('btnRoadAxisAnalyze');
        btn?.click();
        const D = window.BimLvaDebug;
        const on = {
            text: (btn?.textContent || '').replace(/\s+/g, ' ').trim(),
            analyze: (analyze?.textContent || '').replace(/\s+/g, ' ').trim(),
            disabled: !!btn?.disabled,
            on: !!btn?.classList.contains('on'),
            analyzeOn: !!analyze?.classList.contains('on'),
            drawMode: !!D.drawMode,
            road: !!D.drawingRoadAxis
        };
        btn?.click();
        return {
            ...on,
            after: {
                drawMode: !!D.drawMode,
                road: !!D.drawingRoadAxis,
                on: !!btn?.classList.contains('on')
            }
        };
    });
    if (!axisBtn.text.includes('Ось трассы') || !axisBtn.analyze.includes('Ось трассы') || axisBtn.disabled) {
        problems.push(`ось трассы: кнопки нет или выключена (${JSON.stringify(axisBtn)})`);
    }
    if (!axisBtn.on || !axisBtn.analyzeOn || !axisBtn.drawMode || !axisBtn.road) {
        problems.push(`ось трассы: клик не включил черчение (${JSON.stringify(axisBtn)})`);
    }
    if (axisBtn.after.drawMode || axisBtn.after.road || axisBtn.after.on) {
        problems.push(`ось трассы: повторный клик не выключил режим (${JSON.stringify(axisBtn.after)})`);
    }

    const draft = await page.evaluate((g) => {
        const D = window.BimLvaDebug;
        D.startRoadAxisDraw();
        D.addDrawWorldPoint(21, 17, g + 0.5);
        D.addDrawWorldPoint(24, 17, g + 0.5);
        const edges = D.roadAxisDraftEdges;
        document.getElementById('btnRoadAxis')?.click();
        return edges;
    }, groundZ);
    if (!draft || draft.left < 2 || draft.right < 2 || !draft.axisDashed || draft.edgeDashed) {
        problems.push(`ось трассы: ждали пунктир оси и сплошные кромки (${JSON.stringify(draft)})`);
    }
    if (draft?.edgeColor && draft.edgeColor !== '#f4f7fb') {
        problems.push(`ось трассы: кромки в черновике ${draft.edgeColor} вместо #f4f7fb`);
    }
    const finished = await page.evaluate(() => {
        const D = window.BimLvaDebug;
        const rec = [...D.drawn].reverse().find((d) => d.role === 'road-axis') || D.drawn[D.drawn.length - 1];
        if (!rec) return null;
        const st0 = D.polylineStyle(rec.id);
        const defaults = { layer: st0?.layer, edgeLayer: st0?.edgeLayer };
        D.stylePolyline(rec.id, {
            color: '#22cc88', width: 4, layer: 'МояОсь',
            edgeColor: '#ffeecc', edgeWidth: 3, edgeLayer: 'МояКромка'
        });
        const st = D.polylineStyle(rec.id);
        const dxf = D.dxfPreview() || '';
        return {
            st,
            defaults,
            dxfAxis: /МояОсь/.test(dxf),
            dxfRoad: /МояКромка/.test(dxf)
        };
    });
    if (!finished?.st?.dashed) {
        problems.push(`ось трассы: готовая ось не пунктир (${JSON.stringify(finished?.st)})`);
    }
    if (finished?.st?.edgeDashed) {
        problems.push(`ось трассы: кромки готовой оси пунктирные, должны быть сплошные`);
    }
    if (finished?.st?.edgeMaterialColor !== '#ffeecc') {
        problems.push(`ось трассы: цвет кромок ${finished?.st?.edgeMaterialColor} вместо #ffeecc`);
    }
    if (finished?.st?.edgeMaterialWidth !== 3) {
        problems.push(`ось трассы: толщина кромок ${finished?.st?.edgeMaterialWidth} вместо 3`);
    }
    if (finished?.defaults?.layer !== 'Ось' || finished?.defaults?.edgeLayer !== 'Кромка') {
        problems.push(`ось трассы: слои по умолчанию ${finished?.defaults?.layer}/${finished?.defaults?.edgeLayer} вместо Ось/Кромка`);
    }
    if (finished?.st?.layer !== 'МояОсь' || finished?.st?.edgeLayer !== 'МояКромка') {
        problems.push(`ось трассы: слои ${finished?.st?.layer}/${finished?.st?.edgeLayer}`);
    }
    if (finished && (!finished.dxfAxis || !finished.dxfRoad)) {
        problems.push(`ось трассы: DXF без слоёв оси/кромок (AXIS ${finished.dxfAxis}, ROAD ${finished.dxfRoad})`);
    }
    await page.evaluate(() => {
        window.BimLvaDebug.clearRoadXs();
        document.getElementById('roadXsClose')?.click();
        document.getElementById('btnPolylineList')?.click();
        document.getElementById('polylinesClear')?.click();
        document.getElementById('polylinesClose')?.click();
    });

    return {
        stations: got.res?.stations || 0,
        hits: got.res?.hits || 0
    };
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

    // Ортогональная проекция: камера подменяется целиком, поэтому проверяем не
    // флаг, а что после переключения по сцене всё ещё можно попасть кликом —
    // луч в орто строится иначе, и здесь это ломается в первую очередь.
    await page.evaluate(() => document.getElementById('vcProjection').click());
    const mode = await page.evaluate(() => window.BimLvaDebug.projection);
    if (mode !== 'ortho') problems.push(`проекция не переключилась: ${mode}`);

    const box = await page.locator('#stage canvas').boundingBox();
    let pickedInOrtho = false;
    for (const [dx, dy] of [[0, 0], [0.08, 0.05], [-0.08, -0.05], [0.15, -0.1]]) {
        await page.mouse.click(box.x + box.width * (0.5 + dx), box.y + box.height * (0.5 + dy));
        pickedInOrtho = await page
            .waitForFunction(() => /ExpressID/i.test(document.querySelector('#props')?.textContent || ''),
                { timeout: 1200 })
            .then(() => true).catch(() => false);
        if (pickedInOrtho) break;
    }
    if (!pickedInOrtho) problems.push('в ортогональной проекции клик перестал выделять элементы');

    // Колесо в орто должно зумить (менять фрустум), а не таскать камеру вбок —
    // раньше дальность камеры до цели двигалась, а параллельная проекция от
    // неё не зависит, и выглядело как смещение по XY вместо приближения.
    // Мы уже в орто-режиме (переключились выше перед проверкой пикинга).
    const orthoBefore = await page.evaluate(() => window.BimLvaDebug.orthoFrustumHeight);
    const stageBox = await page.locator('#stage canvas').boundingBox();
    await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(150);
    const orthoAfter = await page.evaluate(() => window.BimLvaDebug.orthoFrustumHeight);
    if (!(orthoAfter < orthoBefore * 0.98)) {
        problems.push(
            `колесо в орто не зумит: высота кадра ${orthoBefore.toFixed(2)} → ${orthoAfter.toFixed(2)} м`
        );
    }

    const back = await page.evaluate(() => window.BimLvaDebug.projection);
    if (back !== 'ortho') problems.push(`проекция неожиданно переключилась: ${back}`);
    await page.evaluate(() => document.getElementById('vcProjection').click());
    const backPersp = await page.evaluate(() => window.BimLvaDebug.projection);
    if (backPersp !== 'persp') problems.push(`проекция не вернулась в перспективу: ${backPersp}`);
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

    // Реальный путь: экспорт ведомости без выделения. Кнопка на вкладке «Анализ».
    // Дерево появляется до конца loadFilesSequentially — кнопка ещё disabled.
    await page.evaluate(() => {
        document.querySelector('.rtab[data-rp="analysis"]')?.click();
        document.querySelectorAll('.toast .toast-close').forEach((b) => b.click());
    });
    await page.waitForFunction(
        () => {
            const b = document.getElementById('btnSchedule');
            return !!b && !b.disabled;
        },
        { timeout: 15_000 }
    ).catch(() => {});
    await page.evaluate(() => document.getElementById('btnSchedule')?.click());
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
 * Вкладки боковых панелей: Структура/Файлы/Классы и Свойства/Pset/Ведомость.
 * Не заглушки — список файлов совпадает с loadedModels, классы из IFC,
 * ведомость по текущему выделению. В конце возвращаем вкладки по умолчанию.
 */
async function checkPanelTabs(page) {
    const defaults = await page.evaluate(() => {
        const vis = (panel, pane) => {
            const body = document.querySelector(`#${panel} > .pane-body[data-pane="${pane}"]`);
            return !!(body && !body.hidden);
        };
        return {
            tree: vis('treePanel', 'tree'),
            props: vis('sidePanel', 'props'),
            leftTabs: [...document.querySelectorAll('#treePanel > .panel-head .ptab')].map((t) => t.dataset.pane),
            rightTabs: [...document.querySelectorAll('#sidePanel > .panel-head .ptab')].map((t) => t.dataset.pane)
        };
    });
    if (JSON.stringify(defaults.leftTabs) !== JSON.stringify(['tree', 'files', 'classes'])) {
        problems.push(`левые вкладки панелей: ${defaults.leftTabs.join(',')} вместо tree,files,classes`);
    }
    if (JSON.stringify(defaults.rightTabs) !== JSON.stringify(['props', 'pset', 'schedule'])) {
        problems.push(`правые вкладки панелей: ${defaults.rightTabs.join(',')} вместо props,pset,schedule`);
    }
    if (!defaults.tree) problems.push('вкладка «Структура» должна быть открыта по умолчанию');
    if (!defaults.props) problems.push('вкладка «Свойства» должна быть открыта по умолчанию');

    await page.evaluate(() => document.querySelector('#treePanel .ptab[data-pane="files"]')?.click());
    const files = await page.waitForFunction(() => {
        const body = document.querySelector('#treePanel > .pane-body[data-pane="files"]');
        const tree = document.querySelector('#treePanel > .pane-body[data-pane="tree"]');
        const rows = document.querySelectorAll('#filesList .frow').length;
        return body && !body.hidden && tree?.hidden && rows > 0 ? rows : false;
    }, { timeout: 5000 }).catch(() => 0);
    if (!files) problems.push('вкладка «Файлы»: список моделей пуст или панель не открылась');

    await page.evaluate(() => document.querySelector('#treePanel .ptab[data-pane="classes"]')?.click());
    const classes = await page.waitForFunction(() => {
        const body = document.querySelector('#treePanel > .pane-body[data-pane="classes"]');
        const rows = document.querySelectorAll('#classesList .cls-row').length;
        return body && !body.hidden && rows > 0 ? rows : false;
    }, { timeout: 30_000 }).catch(() => 0);
    if (!classes) problems.push('вкладка «Классы»: список IFC-классов пуст (индекс не собрался?)');

    await page.evaluate(() => document.querySelector('#treePanel .ptab[data-pane="tree"]')?.click());

    await page.evaluate(() => document.querySelector('#sidePanel .ptab[data-pane="pset"]')?.click());
    const psetOpen = await page.evaluate(() => {
        const body = document.querySelector('#sidePanel > .pane-body[data-pane="pset"]');
        return !!(body && !body.hidden);
    });
    if (!psetOpen) problems.push('вкладка «Pset» не открылась');

    await page.evaluate(() => document.querySelector('#sidePanel .ptab[data-pane="schedule"]')?.click());
    const sched = await page.waitForFunction(() => {
        const body = document.querySelector('#sidePanel > .pane-body[data-pane="schedule"]');
        const rows = document.querySelectorAll('#scheduleList .sched-table tbody tr').length;
        return body && !body.hidden && rows > 0 ? rows : false;
    }, { timeout: 5000 }).catch(() => 0);
    if (!sched) problems.push('вкладка «Ведомость»: таблица пуста при ненулевом выделении');

    await page.evaluate(() => document.querySelector('#sidePanel .ptab[data-pane="props"]')?.click());
    return { files: Number(files) || 0, classes: Number(classes) || 0, schedule: Number(sched) || 0 };
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

/**
 * Догрузка файла в непустую сцену не должна ни сбрасывать камеру, ни стирать
 * назначенный цвет.
 *
 * Оба симптома владелец нашёл руками, и оба шли от одного места: добавление
 * файла до-центрирует сцену, та двигает вершины и пересобирает меши. Меши
 * создавались из ИСХОДНЫХ цветов фрагментов (appearanceByID не читался), а
 * камера вписывалась после каждой пачки, а не только после первой.
 */
/**
 * Режимы отображения модели: тонированный, каркас, с кромками, реалистичный.
 */
async function checkModelDisplayModes(page) {
    const modes = await page.evaluate(() => {
        const D = window.BimLvaDebug;
        const snap = (mode) => {
            D.setModelDisplayMode(mode);
            return D.modelDisplaySample();
        };
        return {
            shaded: snap('shaded'),
            wire: snap('wireframe'),
            edges: snap('shaded-edges'),
            real: snap('realistic')
        };
    });
    if (!modes.shaded?.mesh) {
        problems.push('режим отображения: нет меша для проверки');
        return null;
    }
    if (modes.shaded.wireframe) {
        problems.push(`режим отображения: тонированный с wireframe (${JSON.stringify(modes.shaded)})`);
    }
    if (!modes.wire.wireframe) {
        problems.push(`режим отображения: каркас без wireframe (${JSON.stringify(modes.wire)})`);
    }
    if (!modes.edges.edges) {
        problems.push(`режим отображения: «с кромками» без линий (${JSON.stringify(modes.edges)})`);
    }
    if (!modes.real.standard || modes.real.wireframe) {
        problems.push(`режим отображения: реалистичный (${JSON.stringify(modes.real)})`);
    }
    return modes;
}

async function checkAddFileKeepsStateForModel(page) {
    const a = path.join(ROOT, 'tools', 'fixtures', 'smoke-add-a.ifc');
    const b = path.join(ROOT, 'tools', 'fixtures', 'smoke-add-b.ifc');
    const base = { worldX: 431_000, worldY: 6_171_000, worldZ: 40, count: 40, cols: 8 };
    await fs.writeFile(a, makeGeoIfc({ ...base, seed: 11, name: 'smoke-add-a.ifc' }));
    await fs.writeFile(b, makeGeoIfc({ ...base, worldX: base.worldX + 300, seed: 77, name: 'smoke-add-b.ifc' }));
    const PAINT = 0xff00aa;
    try {
        await page.setInputFiles('#localFileInput', a);
        await page.waitForFunction(
            () => (window.BimLvaDebug?.modelBounds || []).some((m) => /smoke-add-a\.ifc$/i.test(m.file)),
            { timeout: 90_000 }
        );
        await page.waitForTimeout(500);

        // Красим первый попавшийся элемент через ту же функцию, что и кнопка
        // «Применить оформление» — проверяем рабочий путь, а не обходной.
        const ref = await page.evaluate((hex) => {
            const D = window.BimLvaDebug;
            const first = D.firstElementRef?.();
            if (!first) return null;
            D.paintElement(first.modelID, first.expressID, hex);
            return first;
        }, PAINT);
        if (!ref) {
            problems.push('догрузка: не нашли элемент, который можно покрасить');
            return null;
        }
        const painted = await page.evaluate(
            (r) => window.BimLvaDebug.meshAppearance(r.modelID, r.expressID), ref
        );
        if (painted.meshColor !== PAINT) {
            problems.push(`покраска не дошла до материала: ${painted.meshColor?.toString(16)} вместо ff00aa`);
            return null;
        }

        const camBefore = await page.evaluate(() => window.BimLvaDebug.cameraPos);
        await page.setInputFiles('#localFileInput', b);
        await page.waitForFunction(
            () => (window.BimLvaDebug?.modelBounds || []).some((m) => /smoke-add-b\.ifc$/i.test(m.file)),
            { timeout: 90_000 }
        );
        await page.waitForTimeout(1200);

        const after = await page.evaluate(
            (r) => window.BimLvaDebug.meshAppearance(r.modelID, r.expressID), ref
        );
        const camAfter = await page.evaluate(() => window.BimLvaDebug.cameraPos);
        const moved = Math.hypot(
            camAfter.x - camBefore.x, camAfter.y - camBefore.y, camAfter.z - camBefore.z
        );
        if (after.meshColor !== PAINT) {
            problems.push(
                `после догрузки цвет слетел: ${after.meshColor?.toString(16)} вместо ff00aa`
            );
        }
        if (moved > 0.01) {
            problems.push(`догрузка сдвинула камеру на ${moved.toFixed(2)} м — вид сбрасывать не надо`);
        }
        // Свечение выделения не должно остаться на покрашенном элементе.
        if (after.emissive) {
            problems.push(`на покрашенном элементе осталась подсветка (emissive ${after.emissive.toString(16)})`);
        }
        return { moved, color: after.meshColor };
    } finally {
        await page.evaluate(() => document.getElementById('clear')?.click());
        await page.waitForTimeout(400);
        await fs.rm(a, { force: true });
        await fs.rm(b, { force: true });
    }
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
        const reason = req.failure()?.errorText || '';
        // ERR_ABORTED — запрос отменили (закрыли панель, ушли со страницы), это
        // не битый ресурс. Проверка ловит отсутствующие файлы, а не отмены.
        if (/ERR_ABORTED/i.test(reason)) return;
        const line = `${req.url()} — ${reason}`;
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
    let selectSimilar = null;
    let toast = null;
    let clash = null;
    let dxfBlocks = null;
    let geoFed = null;
    let addKeep = null;
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
                const displayModes = await checkModelDisplayModes(page);
                if (displayModes) {
                    console.log(
                        `режимы:   тонир ${displayModes.shaded.lambert ? 'Lambert' : 'Std'}, ` +
                        `каркас ${displayModes.wire.wireframe}, кромки ${displayModes.edges.edges}, ` +
                        `PBR ${displayModes.real.standard}`
                    );
                }
                const panelTabs = await checkPanelTabs(page);
                if (panelTabs) {
                    console.log(
                        `панели:    файлов ${panelTabs.files}, классов ${panelTabs.classes}, строк ведомости ${panelTabs.schedule}`
                    );
                }
                selectSimilar = await checkSelectSimilar(page);
                if (selectSimilar?.ok && selectSimilar.after !== 2100) {
                    problems.push(
                        `«Выбрать подобные»: выделила ${selectSimilar.after} вместо 2100 (все IFCWALL в smoke-grid.ifc)`
                    );
                }
                await page.evaluate(() => document.getElementById('btnClearSelection')?.click());

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
                    dxfEntities = await checkDxfEntities(page);
                    coordPin = await checkCoordPin(page);
                    ruler = await checkRuler(page);
                    // BVH снимаем до обновления: новая модель маленькая и своего
                    // дерева не строит, а финальная проверка смотрит на итог сцены
                    bvhPeak = await page.evaluate(() => window.BimLvaDebug?.bvhCount ?? -1);
                    draw = await checkDrawDxf(page);
                    sweep = await checkSweep(page);
                    slope = await checkSlopeToTerrain(page);
                    roadXs = await checkRoadCrossSections(page);
                    viewCube = await checkViewCube(page);
                    reload = await checkReload(page, port);
                    geoFed = await checkGeoFederation(page);
                    addKeep = await checkAddFileKeepsStateForModel(page);
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

    // Счётчик памяти в статус-баре: он должен что-то показывать при загруженной
    // модели. Пустая строка тут — не «ноль памяти», а незамеченная поломка.
    const memReadout = await page.evaluate(() => {
        const el = document.getElementById('memReadout');
        if (!el) return null;
        return { hidden: el.hidden, text: (el.textContent || '').trim() };
    });
    if (!memReadout) {
        problems.push('счётчик памяти #memReadout пропал из статус-бара');
    } else if (memReadout.hidden || !/\d/.test(memReadout.text)) {
        problems.push(`счётчик памяти ничего не показывает: «${memReadout.text}» (скрыт: ${memReadout.hidden})`);
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
    if (memReadout) console.log(`память:    ${memReadout.text}`);
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
    if (dxfEntities) {
        console.log(
            `сущности DXF: в дереве ${dxfEntities.entities}, диапазонов ${dxfEntities.spans}, ` +
            `опознание по вершине верное`
        );
    }
    if (draw) {
        console.log(
            `черчение:  полилиний ${draw.polylines}, вершин в DXF ${draw.vertices}, ` +
            `мировая X ${draw.x.toFixed(2)}, привязок поймано ${draw.snaps}`
        );
    }
    if (sweep) {
        console.log(
            `тело по оси: объём ${sweep.volume.toFixed(2)} м³, кольцо трубы ` +
            `${sweep.pipeArea.toFixed(4)} м², граней на повороте ${sweep.triangles}`
        );
    }
    if (slope) {
        console.log(
            `откосы:    насыпь ${slope.fillVolume.toFixed(2)} м³, выемка ${slope.cutVolume.toFixed(2)} м³ ` +
            '(сошлись с аналитикой на ровной площадке)'
        );
    }
    if (roadXs) {
        console.log(
            `поперечники: сечений ${roadXs.stations}, точек земли ${roadXs.hits}`
        );
    }
    if (viewCube) console.log('видовой куб: 6 видов по осям, орто-проекция с пикингом');
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
    if (selectSimilar) {
        console.log(`подобные:  ${selectSimilar.ok ? `${selectSimilar.before} → ${selectSimilar.after}` : 'НЕ РАБОТАЕТ'}`);
    }
    if (toast) console.log(`тосты:     API ${toast.shown ? 'ок' : 'НЕТ'}, из UI ${toast.fromUi ? 'ок' : 'НЕТ'}`);
    if (clash) console.log(`коллизии:  пар ${clash.pairs}, за ${clash.ms} мс`);
    if (dxfBlocks) console.log(`блоки DXF: ${dxfBlocks.ok ? `раскрыты верно, габарит ${dxfBlocks.size}` : 'ОШИБКА'}`);
    if (geoFed) console.log(`геосводка: ${geoFed.ok ? `взаимное положение сохранено (${geoFed.dist.toFixed(0)} м)` : `СЛОМАНО (${geoFed.dist.toFixed(0)} м вместо 800)`}`);
    if (addKeep) {
        console.log(`догрузка:  цвет сохранён (#${addKeep.color.toString(16)}), камера на месте (${addKeep.moved.toFixed(3)} м)`);
    }
    if (draw?.vert) {
        console.log(`верт. переход: +${draw.vert.added} вершины, середина на ${draw.vert.target} м, стояки вертикальны`);
    }

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
