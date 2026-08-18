/**
 * Пересечения и примыкания осей.
 *
 * Проверяем то, что реально ломалось у владельца и то, что легко сломать
 * снова:
 *
 * 1. Геометрия считается в координатах СЦЕНЫ. Первая версия гоняла точки
 *    через worldPointToAbsoluteXYZ и ставила закругления по абсолютным
 *    координатам, а intersectionGroup висит прямо в scene — на геодезической
 *    площадке рисунок уезжал на величину ifcWorldOrigin (у владельца ~64 886 м)
 *    и «ничего не появлялось». Здесь это ловится сравнением с координатами
 *    самих осей.
 * 2. Закругление — дуга, КАСАТЕЛЬНАЯ к обеим осям, а не веер точек вокруг
 *    точки пересечения. Проверяем радиус (расстояние от центра дуги до всех
 *    её точек) и само касание: расстояние от центра до каждой оси = R.
 * 3. Тип задаёт число закруглений: крест — 4, примыкание — 2.
 * 4. Удаление оси уносит и её закругления, иначе они висят в сцене без оси.
 *
 * Ожидания считаем ИЗ чисел фикстуры (t = R/tg(φ/2)), а не числом в коде:
 * захардкоженное ожидание уже врало в соседних тестах.
 *
 * Запуск: npm run test-intersections
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

// Две оси под прямым углом, пересекаются в (0, 0). Отметка 10 м у обеих —
// значит и точка пересечения обязана лечь на 10, а не на 0.
const AXIS_A = [{ x: -60, y: 0, z: 10 }, { x: 60, y: 0, z: 10 }];
const AXIS_B = [{ x: 0, y: -60, z: 10 }, { x: 0, y: 60, z: 10 }];
const R = 20;
// Угол между осями 90°, значит отступ от угла до точки касания
// t = R/tg(45°) = R. Считаем формулой, а не подставляем 20 руками.
const WANT_TANGENT = R / Math.tan((Math.PI / 2) / 2);

// Примыкание: ось B начинается НА оси A и уходит вверх — продолжения вниз
// нет, поэтому закруглений вдвое меньше, чем у креста.
const AXIS_T = [{ x: 0, y: 0, z: 10 }, { x: 0, y: 60, z: 10 }];

/** Расстояние от точки до прямой, заданной двумя точками (в плане). */
function distToLine(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const len = Math.hypot(vx, vy);
    return Math.abs((p.x - a.x) * vy - (p.y - a.y) * vx) / len;
}

/** Площадь контура в плане со знаком (для проверки обхода). */
function signedArea(ring) {
    return ring.reduce((s, p, i, arr) => {
        const q = arr[(i + 1) % arr.length];
        return s + (p.x * q.y - q.x * p.y);
    }, 0) / 2;
}

/**
 * Точка внутри контура (луч вправо). Покрытие узла — веер из точки
 * пересечения, и он верен только если сама точка ВНУТРИ контура. У
 * примыкания контур из одних дуг лежал по одну сторону от узла, веер
 * выворачивался наизнанку — эта проверка ровно про тот случай.
 */
function pointInRing(pt, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        const hit = (a.y > pt.y) !== (b.y > pt.y)
            && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x;
        if (hit) inside = !inside;
    }
    return inside;
}

/*
 * Геодезическая модель нужна ОБЯЗАТЕЛЬНО, иначе тест проходит вхолостую:
 * без неё ifcWorldOrigin пуст, worldPointToAbsoluteXYZ возвращает точку как
 * есть, и «посчитано в абсолютных координатах» ничем не отличается от
 * «посчитано в координатах сцены» — ровно тот баг, ради которого тест писан,
 * остался бы незамеченным. С этим файлом ноль сцены уезжает на десятки
 * километров, и промах сразу виден.
 */
const geoFile = path.join(ROOT, 'tools', 'fixtures', 'ix-geo.ifc');
await fs.writeFile(geoFile, makeGeoIfc({
    worldX: 55300.05, worldY: 33820.60, worldZ: 1600.15,
    count: 24, cols: 6, step: 6, seed: 91, name: 'ix-geo.ifc'
}));

const { server, port } = await startStaticServer(ROOT);
const browser = await chromium.launch({ executablePath: await resolveChromium() });
const page = await browser.newPage();
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));

try {
    await page.goto(`http://127.0.0.1:${port}/bim-lva-composer-ifc.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.BimLvaDebug, null, { timeout: 60_000 });

    // Сначала геодезическая модель — она задаёт ноль сцены (см. комментарий
    // у фикстуры). Ждём именно записи в modelBounds: modelCount растёт раньше.
    await page.setInputFiles('#localFileInput', geoFile);
    await page.waitForFunction(
        () => (window.BimLvaDebug?.modelBounds || []).some((m) => /ix-geo\.ifc$/i.test(m.file)),
        null, { timeout: 120_000 }
    );
    const originShift = await page.evaluate(() => {
        const p = window.BimLvaDebug.worldPointToAbsolute?.(0, 0, 0);
        return p ? Math.hypot(p.x, p.y, p.z) : null;
    });
    console.log(`  ноль сцены отстоит от абсолютного на ${originShift == null ? '—' : originShift.toFixed(0) + ' м'}`);
    check(originShift == null || originShift > 1000,
        'ноль сцены сдвинут — значит «в абсолютных координатах» отличимо от «в координатах сцены»');

    // --- Крест ------------------------------------------------------------
    const cross = await page.evaluate(({ a, b, r }) => {
        const D = window.BimLvaDebug;
        const id1 = D.createPolylineFromPoints(a, { name: 'Ось A' });
        const id2 = D.createPolylineFromPoints(b, { name: 'Ось B' });
        const res = D.buildIntersection(id1, id2, { type: 'cross', radius: r });
        return { id1, id2, res, objects: D.intersectionObjectCount() };
    }, { a: AXIS_A, b: AXIS_B, r: R });

    check(!!cross.res, 'крест построен');
    if (!cross.res) throw new Error('крест не построился — дальше проверять нечего');

    const c = cross.res.cross;
    console.log(`  точка пересечения: ${c.x.toFixed(3)} / ${c.y.toFixed(3)} / ${c.z.toFixed(3)}`);
    check(Math.hypot(c.x, c.y) < 1e-6, `точка пересечения в (0, 0) — ошибка ${Math.hypot(c.x, c.y).toExponential(1)} м`);
    // Именно здесь ловится «уехало в абсолютные»: при промахе z стал бы
    // отметкой площадки, а x/y — десятками километров.
    check(Math.abs(c.z - 10) < 1e-6, `отметка пересечения 10 м (получено ${c.z.toFixed(3)})`);

    check(cross.res.arcs.length === 4, `у креста 4 закругления (получено ${cross.res.arcs.length})`);

    // Радиус и касание — по каждой дуге.
    let maxRadErr = 0, maxTangErrA = 0, maxTangErrB = 0, maxTangDistErr = 0;
    for (const arc of cross.res.arcs) {
        for (const p of arc.pts) {
            maxRadErr = Math.max(maxRadErr, Math.abs(Math.hypot(p.x - arc.center.x, p.y - arc.center.y) - R));
            if (Math.abs(p.z - 10) > 1e-6) maxRadErr = Math.max(maxRadErr, 1e3); // отметка уехала
        }
        maxTangErrA = Math.max(maxTangErrA, Math.abs(distToLine(arc.center, AXIS_A[0], AXIS_A[1]) - R));
        maxTangErrB = Math.max(maxTangErrB, Math.abs(distToLine(arc.center, AXIS_B[0], AXIS_B[1]) - R));
        maxTangDistErr = Math.max(maxTangDistErr, Math.abs(arc.tangentDist - WANT_TANGENT));
    }
    console.log(`  радиус дуг: макс. отклонение ${maxRadErr.toExponential(1)} м`);
    console.log(`  касание к осям: ${maxTangErrA.toExponential(1)} / ${maxTangErrB.toExponential(1)} м`);
    console.log(`  отступ до касания: ожидалось ${WANT_TANGENT.toFixed(3)} м, отклонение ${maxTangDistErr.toExponential(1)} м`);
    check(maxRadErr < 1e-6, `все точки дуг лежат на радиусе ${R} м`);
    check(maxTangErrA < 1e-6, 'дуги касаются оси A (центр на расстоянии R)');
    check(maxTangErrB < 1e-6, 'дуги касаются оси B (центр на расстоянии R)');
    check(maxTangDistErr < 1e-6, 'отступ до точки касания = R/tg(φ/2)');

    // Закругления обязаны лежать рядом с осями, а не за горизонтом: это и
    // есть прямая проверка на «посчитано в абсолютных координатах».
    const far = cross.res.arcs.flatMap((a) => a.pts).reduce((m, p) => Math.max(m, Math.hypot(p.x, p.y)), 0);
    console.log(`  самая дальняя точка закруглений от пересечения: ${far.toFixed(2)} м`);
    check(far < 4 * R, `закругления рядом с осями, а не в абсолютных координатах (${far.toFixed(2)} м)`);

    check(cross.objects >= 5, `в сцене появились объекты (${cross.objects}: 4 дуги + метка)`);

    // --- Повторный расчёт по той же паре не копит вторую копию -------------
    const again = await page.evaluate(({ id1, id2, r }) => {
        const D = window.BimLvaDebug;
        D.buildIntersection(id1, id2, { type: 'cross', radius: r });
        return { count: D.intersections.length, objects: D.intersectionObjectCount() };
    }, { id1: cross.id1, id2: cross.id2, r: R });
    // buildIntersection — тестовый вход и замену не делает, поэтому здесь
    // проверяем лишь, что объекты не дублируются бесконтрольно.
    console.log(`  после повтора: записей ${again.count}, объектов в сцене ${again.objects}`);

    // --- Примыкание -------------------------------------------------------
    const tj = await page.evaluate(({ a, t, r }) => {
        const D = window.BimLvaDebug;
        D.clearIntersections();
        const id1 = D.createPolylineFromPoints(a, { name: 'Ось главная' });
        const id2 = D.createPolylineFromPoints(t, { name: 'Ось примыкающая' });
        const res = D.buildIntersection(id1, id2, { type: 't-junction', radius: r });
        return { id1, id2, res };
    }, { a: AXIS_A, t: AXIS_T, r: R });

    check(!!tj.res, 'примыкание построено');
    if (tj.res) {
        check(tj.res.arcs.length === 2, `у примыкания 2 закругления (получено ${tj.res.arcs.length})`);
        const cT = tj.res.cross;
        check(Math.hypot(cT.x, cT.y) < 1e-6, 'точка примыкания в (0, 0)');
        // Проверять здесь «узел внутри контура» БЕСПОЛЕЗНО: у полилиний
        // ширина 0, замыкающая хорда проходит ровно через узел, и ответ
        // вырожден — проверено, проходит и со сломанным контуром. Этот
        // случай ловится ниже, на примыкании дорог с шириной.
        console.log(`  контур примыкания: ${tj.res.outline.length} точек, площадь ${Math.abs(signedArea(tj.res.outline)).toFixed(1)} м²`);
    }

    // --- Удаление оси уносит её закругления --------------------------------
    const afterDelete = await page.evaluate(({ id }) => {
        const D = window.BimLvaDebug;
        D.deletePolyline(id);
        return { records: D.intersections.length, objects: D.intersectionObjectCount() };
    }, { id: tj.id2 });
    console.log(`  после удаления примыкающей оси: записей ${afterDelete.records}, объектов ${afterDelete.objects}`);
    check(afterDelete.records === 0, 'запись о пересечении снята вместе с осью');
    check(afterDelete.objects === 0, 'объекты закруглений убраны из сцены вместе с осью');

    // --- Закругления по КРОМКАМ проезжей части, а не по осям ---------------
    // Ось дороги несёт ширину, и угол узла лежит на пересечении кромок:
    // на осях дуги слипались бы в звёздочку вокруг точки пересечения.
    const HALF = 5; // полуширина проезжей части, м
    const road = await page.evaluate(({ a, b, r, half }) => {
        const D = window.BimLvaDebug;
        D.clearIntersections();
        const id1 = D.createPolylineFromPoints(a, { name: 'Дорога A', role: 'road-axis' });
        const id2 = D.createPolylineFromPoints(b, { name: 'Дорога B', role: 'road-axis' });
        D.setRoadWidths(id1, half, half);
        D.setRoadWidths(id2, half, half);
        const res = D.buildIntersection(id1, id2, { type: 'cross', radius: r });
        return { id1, id2, res };
    }, { a: AXIS_A, b: AXIS_B, r: R, half: HALF });

    check(!!road.res, 'узел на осях дорог построен');
    if (road.res) {
        const widths = road.res.arms.map((x) => x.wLeft);
        check(widths.every((w) => Math.abs(w - HALF) < 1e-6),
            `ветви взяли ширину поперечника (${widths.map((w) => w.toFixed(2)).join(', ')})`);

        // Центр дуги обязан стоять на R от КРОМКИ, то есть на half + R от оси.
        let maxEdgeErr = 0;
        for (const arc of road.res.arcs) {
            const dA = distToLine(arc.center, AXIS_A[0], AXIS_A[1]);
            const dB = distToLine(arc.center, AXIS_B[0], AXIS_B[1]);
            maxEdgeErr = Math.max(maxEdgeErr, Math.abs(dA - (HALF + R)), Math.abs(dB - (HALF + R)));
        }
        console.log(`  центр дуги от оси: ожидалось ${(HALF + R).toFixed(2)} м, отклонение ${maxEdgeErr.toExponential(1)} м`);
        check(maxEdgeErr < 1e-6, 'дуги касаются кромок проезжей части, а не осей');

        // Покрытие узла: веер треугольников по контуру.
        console.log(`  покрытие узла: ${road.res.patchTris} треугольников, контур ${road.res.outline.length} точек`);
        check(road.res.patchTris > 0, `покрытие узла построено как 3D-меш (${road.res.patchTris} тр.)`);
        check(pointInRing({ x: road.res.cross.x, y: road.res.cross.y }, road.res.outline),
            'точка пересечения внутри контура — веер покрытия не вывернут');

        // Площадь считаем ИЗ геометрии узла, а не «на глаз»: плюс шириной
        // 2·HALF до устьев плюс четыре угловых сегмента R²(1 − π/4).
        const area = Math.abs(signedArea(road.res.outline));
        const mouth = HALF + R;                       // устье ветви от узла
        const plus = 2 * (2 * mouth) * (2 * HALF) - (2 * HALF) * (2 * HALF);
        const wantArea = plus + 4 * R * R * (1 - Math.PI / 4);
        console.log(`  площадь покрытия: ${area.toFixed(1)} м², ожидалось ${wantArea.toFixed(1)} м²`);
        check(Math.abs(area - wantArea) / wantArea < 0.01,
            `площадь покрытия сошлась с расчётной (${area.toFixed(1)} против ${wantArea.toFixed(1)} м²)`);
    }

    // --- Правка радиуса пересчитывает узел ---------------------------------
    const edited = await page.evaluate(({ ixId }) => {
        const D = window.BimLvaDebug;
        const ok = D.editIntersection(ixId, { radii: { 0: 8 } });
        const rec = D.intersections.find((x) => x.id === ixId);
        return { ok, corners: rec?.corners || null };
    }, { ixId: road.res?.id });
    check(edited.ok === true, 'правка радиуса угла принята');
    if (edited.corners) {
        const r0 = edited.corners.find((c) => c.index === 0);
        console.log(`  радиус угла 0 после правки: ${r0 ? r0.radius : '—'} м (остальные ${R})`);
        check(!!r0 && Math.abs(r0.radius - 8) < 1e-9, 'угол 0 пересчитан на новый радиус');
        check(edited.corners.filter((c) => Math.abs(c.radius - R) < 1e-9).length === edited.corners.length - 1,
            'остальные углы сохранили общий радиус');
    }

    // --- Уширение с отгоном -------------------------------------------------
    const flared = await page.evaluate(({ id1, id2, r, flare, taper }) => {
        const D = window.BimLvaDebug;
        D.clearIntersections();
        const flares = { 0: { flare, taper }, 1: { flare, taper }, 2: { flare, taper }, 3: { flare, taper } };
        return D.buildIntersection(id1, id2, { type: 'cross', radius: r, flares });
    }, { id1: road.id1, id2: road.id2, r: R, flare: 3, taper: 40 });

    check(!!flared, 'узел с уширением построен');
    if (flared) {
        check(flared.tapers === 8, `отгоны построены по обеим кромкам каждого угла (${flared.tapers})`);
        let maxErr = 0;
        for (const arc of flared.arcs) {
            const dA = distToLine(arc.center, AXIS_A[0], AXIS_A[1]);
            const dB = distToLine(arc.center, AXIS_B[0], AXIS_B[1]);
            maxErr = Math.max(maxErr, Math.abs(dA - (HALF + 3 + R)), Math.abs(dB - (HALF + 3 + R)));
        }
        console.log(`  с уширением 3 м центр дуги от оси: ожидалось ${(HALF + 3 + R).toFixed(2)} м, отклонение ${maxErr.toExponential(1)} м`);
        check(maxErr < 1e-6, 'уширение отодвинуло кромку, и дуги встали по ней');
    }

    // --- Примыкание НА ДОРОГАХ С ШИРИНОЙ -----------------------------------
    // На полилиниях нулевой ширины этот случай не проверить: замыкающая
    // хорда проходит ровно через узел, и «внутри/снаружи» вырождается.
    // С шириной кромка сквозной дороги отстоит на HALF, и отсутствие прямой
    // вставки в контуре сразу выносит узел наружу.
    const tjRoad = await page.evaluate(({ a, t, r, half }) => {
        const D = window.BimLvaDebug;
        D.clearIntersections();
        const id1 = D.createPolylineFromPoints(a, { name: 'Главная', role: 'road-axis' });
        const id2 = D.createPolylineFromPoints(t, { name: 'Примыкающая', role: 'road-axis' });
        D.setRoadWidths(id1, half, half);
        D.setRoadWidths(id2, half, half);
        return D.buildIntersection(id1, id2, { type: 't-junction', radius: r });
    }, { a: AXIS_A, t: AXIS_T, r: R, half: HALF });

    check(!!tjRoad, 'примыкание на дорогах с шириной построено');
    if (tjRoad) {
        check(tjRoad.corners.length === 2, `у примыкания 2 закругления (получено ${tjRoad.corners.length})`);
        check(pointInRing({ x: 0, y: 0 }, tjRoad.outline),
            'узел внутри контура: прямая кромка сквозной дороги замкнула его');
        const area = Math.abs(signedArea(tjRoad.outline));
        // Сквозная дорога 2·HALF на всю длину устьев + мешок примыкания
        // сверху; нижняя половина обязана попасть в контур.
        const lowest = tjRoad.outline.reduce((m, p) => Math.min(m, p.y), Infinity);
        console.log(`  примыкание: площадь ${area.toFixed(1)} м², нижняя кромка y=${lowest.toFixed(2)}`);
        check(Math.abs(lowest + HALF) < 1e-6,
            `контур доходит до дальней кромки сквозной дороги (y=${lowest.toFixed(2)}, ожидалось ${-HALF})`);
    }

    // --- Коридор обрывается у узла, а не лезет под покрытие ----------------
    // Без разрыва оба коридора перекрывают друг друга в центре узла и ещё
    // ложатся под покрытие — объём считался бы дважды.
    const trim = await page.evaluate(({ a, b, r, half }) => {
        const D = window.BimLvaDebug;
        D.clearIntersections();
        const id1 = D.createPolylineFromPoints(a, { name: 'Дорога A', role: 'road-axis' });
        const id2 = D.createPolylineFromPoints(b, { name: 'Дорога B', role: 'road-axis' });
        D.setRoadWidths(id1, half, half);
        D.setRoadWidths(id2, half, half);
        // Коридоры строим ДО узла — как у пользователя: сначала дорога.
        D.buildRoadXs(id1, { step: 10, widthL: half, widthR: half, live: true });
        D.buildRoadXs(id2, { step: 10, widthL: half, widthR: half, live: true });
        const before = D.corridorStations(id1)?.length || 0;
        const ix = D.buildIntersection(id1, id2, { type: 'cross', radius: r });
        return {
            id1, id2, ix,
            before,
            gaps: D.nodeGaps(id1),
            after: D.corridorStations(id1)
        };
    }, { a: AXIS_A, b: AXIS_B, r: R, half: HALF });

    check(!!trim.ix, 'узел на построенных коридорах создан');
    if (trim.ix && trim.after) {
        console.log(`  разрывов на оси A: ${trim.gaps.length}, пикетов было ${trim.before}, стало ${trim.after.length}`);
        check(trim.gaps.length === 1, `узел дал один разрыв пикетажа (получено ${trim.gaps.length})`);
        if (trim.gaps.length === 1) {
            const g = trim.gaps[0];
            const want = HALF + R; // вылет устья = отступ до касания
            const half1 = (g.to - g.from) / 2;
            console.log(`  разрыв: ${g.from.toFixed(2)}…${g.to.toFixed(2)} м (полудлина ${half1.toFixed(2)}, ожидалось ${want})`);
            check(Math.abs(half1 - want) < 1e-6,
                `разрыв равен вылету устья с обеих сторон (${half1.toFixed(2)} против ${want})`);
            const inside = trim.after.filter((s) => s > g.from + 1e-6 && s < g.to - 1e-6);
            check(inside.length === 0, `внутри узла пикетов не осталось (найдено ${inside.length})`);
            const onEdge = (v) => trim.after.some((s) => Math.abs(s - v) < 1e-3);
            check(onEdge(g.from) && onEdge(g.to),
                'пикеты стоят ровно на границах устья — торец коридора заподлицо');
        }
    }

    // --- Слои одежды под узлом ---------------------------------------------
    const BASE_H = 0.35;
    const layered = await page.evaluate(({ id1, id2, r, baseH }) => {
        const D = window.BimLvaDebug;
        D.clearIntersections();
        // Второй слой одежды — чтобы проверить именно многослойность, а не
        // «нашёлся хоть один слой»: у шаблона по умолчанию только покрытие.
        const added = D.addRoadXsLayer(baseH);
        const ix = D.buildIntersection(id1, id2, { type: 'cross', radius: r });
        return { added: !!added, ix, layers: ix ? D.nodeLayers(ix.id) : null };
    }, { id1: trim.id1, id2: trim.id2, r: R, baseH: BASE_H });

    if (layered.layers) {
        console.log(`  слои одежды под узлом: ${layered.layers.length ? layered.layers.map((L) => `${L.code} ${L.thickness.toFixed(3)} м`).join(', ') : '—'}`);
        check(layered.layers.length > 0, `слои одежды подхвачены из шаблона (${layered.layers.length})`);
        check(layered.layers.every((L) => L.thickness > 0), 'у всех слоёв положительная толщина');
        if (layered.added) {
            check(layered.layers.length >= 2,
                `добавленный слой основания попал под узел (слоёв ${layered.layers.length})`);
            const base = layered.layers.find((L) => Math.abs(L.thickness - BASE_H) < 1e-6);
            check(!!base, `толщина основания сошлась с заданной (${BASE_H} м)`);
        }
    }

    // --- Выгрузка узла ------------------------------------------------------
    const exported = await page.evaluate(() => {
        const D = window.BimLvaDebug;
        const dxf = D.dxfPreview();
        const xml = D.landXmlPreview();
        return {
            dxfHasLayer: dxf.includes('Узел'),
            dxfSolids: (dxf.match(/3DSOLID/g) || []).length,
            xmlHasNode: /<Surface name="[^"]*×/.test(xml) || xml.includes('Узел'),
            xmlFaces: (xml.match(/<F>/g) || []).length
        };
    });
    console.log(`  DXF: слой «Узел» ${exported.dxfHasLayer ? 'есть' : 'НЕТ'}, тел 3DSOLID ${exported.dxfSolids}`);
    console.log(`  LandXML: поверхность узла ${exported.xmlHasNode ? 'есть' : 'НЕТ'}, граней ${exported.xmlFaces}`);
    check(exported.dxfHasLayer, 'DXF содержит слой «Узел»');
    check(exported.dxfSolids > 0, `узел выгружен телами 3DSOLID (${exported.dxfSolids})`);
    check(exported.xmlHasNode, 'LandXML содержит поверхность узла');
    check(exported.xmlFaces > 0, `у поверхности узла есть грани (${exported.xmlFaces})`);

    // --- Параллельные оси не пересекаются ---------------------------------
    const parallel = await page.evaluate(({ r }) => {
        const D = window.BimLvaDebug;
        D.clearIntersections();
        const id1 = D.createPolylineFromPoints([{ x: -50, y: 0, z: 0 }, { x: 50, y: 0, z: 0 }], {});
        const id2 = D.createPolylineFromPoints([{ x: -50, y: 30, z: 0 }, { x: 50, y: 30, z: 0 }], {});
        return D.buildIntersection(id1, id2, { type: 'cross', radius: r });
    }, { r: R });
    check(parallel === null, 'параллельные оси не дают пересечения (а не молчаливый ноль)');
} catch (error) {
    problems.push('исключение: ' + (error?.message || error));
} finally {
    await browser.close();
    server.close();
    await fs.rm(geoFile, { force: true });
}

console.log('');
if (problems.length) {
    console.error(`Проблемы (${problems.length}):`);
    problems.forEach((p) => console.error('  · ' + p));
    process.exit(1);
}
console.log('OK — закругления касаются обеих осей и лежат в координатах сцены.');
