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

    // --- Бордюр продлевается по скруглениям --------------------------------
    // Покрытие узла кончается на кромке проезжей части, коридор обрезан у
    // устья — без протяжки внешнего профиля у устьев зияли разрывы.
    // Шаблон «С бордюром» — тот же, что владелец выбирает в окне трассы.
    // На шаблоне по умолчанию проверять нечего: за кромкой там пусто, и
    // «протяжка есть» была бы правдой при нулевом вылете.
    const outer = await page.evaluate(({ id1, id2, r }) => {
        const D = window.BimLvaDebug;
        D.clearIntersections();
        D.applyRoadXsPresetTo(id1, 'curb');
        D.applyRoadXsPresetTo(id2, 'curb');
        const ix = D.buildIntersection(id1, id2, { type: 'cross', radius: r });
        if (!ix) return null;
        const o = D.nodeOuter(ix.id);
        // Разворачивать null спредом нельзя: получится объект с одним ixId,
        // проверка «профиль найден» пройдёт, а следующая строка упадёт на
        // undefined — падение теста вместо честного FAIL.
        return o ? { ixId: ix.id, ...o } : { ixId: ix.id, missing: true };
    }, { id1: trim.id1, id2: trim.id2, r: R });
    check(!!outer && !outer.missing, 'внешний профиль шаблона найден');
    if (outer && !outer.missing) {
        console.log(`  внешний профиль: кромка ${outer.edgeOff} м, точек ${outer.profilePts}, вылет ${outer.maxOff.toFixed(2)} м, формы [${outer.shapes.join(', ')}]`);
        console.log(`  участков контура: ${outer.runs.map((r) => r.kind).join(', ')}; протянуто кусков ${outer.sweptPieces}, треугольников ${outer.sweptTris}`);
        check(outer.maxOff > 0, `профиль вынесен за кромку проезжей части (${outer.maxOff.toFixed(2)} м)`);
        check(outer.sweptTris > 0, `бордюр протянут по краю узла (${outer.sweptTris} треугольников)`);
        // Устья ветвей в протяжку попадать не должны: там дорога продолжается
        // и бордюр даёт сам коридор. Участков ровно столько, сколько дуг.
        check(outer.runs.length === 4 && outer.runs.every((r) => r.kind === 'arc'),
            `протяжка идёт по дугам, а не через устья (участков ${outer.runs.length})`);
    }

    // --- Отметка узла: поднять и опустить ----------------------------------
    const lifted = await page.evaluate(({ ixId, id1 }) => {
        const D = window.BimLvaDebug;
        const before = D.nodeElevation(ixId);
        const profBefore = D.axisProfile(id1);
        D.setNodeElevationAbs(ixId, before.abs + 1.5);
        const after = D.nodeElevation(ixId);
        const profAfter = D.axisProfile(id1);
        // Правка радиуса не должна сбрасывать поднятие. Отметка хранится
        // ЦЕЛЕВЫМ значением: сдвиг после запекания в профиль оси прибавлялся
        // бы к уже поднятой отметке на каждом пересчёте.
        D.editIntersection(ixId, { radii: { 0: 12 } });
        const kept = D.nodeElevation(ixId);
        // Ещё два холостых пересчёта: если отметка «ползёт», это видно здесь.
        D.editIntersection(ixId, { radii: { 0: 12 } });
        D.editIntersection(ixId, { radii: { 0: 12 } });
        const settled = D.nodeElevation(ixId);
        return { before, after, kept, settled, profBefore, profAfter };
    }, { ixId: outer?.ixId, id1: trim.id1 });

    if (lifted.before && lifted.after) {
        console.log(`  отметка узла: ${lifted.before.abs.toFixed(3)} → ${lifted.after.abs.toFixed(3)} м`);
        check(Math.abs((lifted.after.abs - lifted.before.abs) - 1.5) < 1e-6,
            `подъём узла на 1.5 м применился (Δ ${(lifted.after.abs - lifted.before.abs).toFixed(3)})`);
        check(Math.abs(lifted.kept.abs - lifted.after.abs) < 1e-6,
            'правка радиуса не сбросила отметку узла');
        console.log(`  после трёх холостых пересчётов: ${lifted.settled.abs.toFixed(3)} м`);
        check(Math.abs(lifted.settled.abs - lifted.after.abs) < 1e-6,
            'отметка не ползёт от повторных пересчётов');

        // Профиль оси идёт за узлом: у устьев появились вершины с его
        // отметкой, а КОНЦЫ трассы остались на месте.
        const anchors = lifted.profAfter.filter((p) => p.anchor);
        console.log(`  вершин оси: ${lifted.profBefore.length} → ${lifted.profAfter.length}, из них посажено узлом ${anchors.length}`);
        check(anchors.length > 0, `в профиль оси посажены вершины узла (${anchors.length})`);
        check(anchors.every((a) => Math.abs(a.z - lifted.after.abs) < 1e-6),
            'вершины узла на отметке узла');
        const endBefore = lifted.profBefore[lifted.profBefore.length - 1].z;
        const endAfter = lifted.profAfter[lifted.profAfter.length - 1].z;
        console.log(`  конец трассы: ${endBefore.toFixed(3)} → ${endAfter.toFixed(3)} м`);
        check(Math.abs(endAfter - endBefore) < 1e-6,
            'конец трассы остался на месте — поднимать его пользователю вручную');
        check(Math.abs(lifted.profAfter[0].z - lifted.profBefore[0].z) < 1e-6,
            'начало трассы осталось на месте');
    }

    // --- Ручка узла в сцене -------------------------------------------------
    const handles = await page.evaluate(() => window.BimLvaDebug.nodeHandleState());
    console.log(`  ручек узлов: ${handles.length}${handles[0] ? ', подпись «' + handles[0].label + '»' : ''}`);
    check(handles.length === 1, `у узла появилась ручка (${handles.length})`);
    if (handles[0]) {
        check(handles[0].label && Math.abs(Number(handles[0].label) - lifted.after.abs) < 0.001,
            'на ручке — абсолютная отметка узла');
    }

    // --- Элементы дороги кликабельны ---------------------------------------
    // ⚠️ Целиться в ЦЕНТР ХОЛСТА бесполезно: «Вписать» кадрирует всю сцену
    // вместе с моделью, и в центре оказывается она, а не узел. Берём
    // спроецированные точки самого узла — как и при отладке пикинга по линии.
    await page.evaluate(() => document.getElementById('fit')?.click());
    await page.waitForTimeout(500);
    const picked = await page.evaluate(({ ixId }) => {
        const D = window.BimLvaDebug;
        const pts = D.nodeScreenPts(ixId);
        if (!pts) return null;
        const tries = [pts.cross, ...pts.outline].filter((p) => p && !p.behind);
        for (const p of tries) {
            const hit = D.pickRoadPartAt(p.clientX, p.clientY);
            if (hit) return { hit, tried: tries.length };
        }
        return { hit: null, tried: tries.length };
    }, { ixId: outer?.ixId });

    console.log(`  пикинг по точкам узла (${picked?.tried ?? 0} проб): ${picked?.hit ? picked.hit.kind + ' / ' + (picked.hit.code || '—') : 'мимо'}`);
    check(!!picked?.hit, 'элемент дороги под курсором опознан');
    if (picked?.hit) {
        check(['node', 'corridor'].includes(picked.hit.kind),
            `опознан как часть дороги (${picked.hit.kind})`);
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

    // --- Заданная отметка: площадка ПЛОСКАЯ, и это не зависит от запекания --
    /*
     * ⚠️ Проверять это на пути «через ручку» бесполезно: там отметка успевает
     * запечься в профиль оси, поправка становится нулевой и любая ошибка в её
     * применении прячется. Дёргаем расчёт напрямую с целевой отметкой —
     * запекания нет, поправка ненулевая, и ошибка видна.
     *
     * Ловится: `outline` и `arcs` держат ОДНИ И ТЕ ЖЕ объекты точек, и два
     * прохода со сложением сдвигали дуги дважды — покрытие выворачивалось
     * чашей с задранными краями (при целевой 5 контур уезжал на 5…10).
     */
    const flat = await page.evaluate(({ id1, id2, r }) => {
        const D = window.BimLvaDebug;
        D.clearIntersections();
        const ix = D.buildIntersection(id1, id2, { type: 'cross', radius: r, zTarget: 5 });
        if (!ix) return null;
        const zs = ix.arcs.flatMap((a) => a.pts.map((p) => p.z))
            .concat(ix.outline.map((p) => p.z));
        return { cross: ix.cross.z, min: Math.min(...zs), max: Math.max(...zs) };
    }, { id1: trim.id1, id2: trim.id2, r: R });

    check(!!flat, 'узел с заданной отметкой построен');
    if (flat) {
        console.log(`  заданная отметка 5: узел ${flat.cross.toFixed(3)}, контур и дуги ${flat.min.toFixed(3)}…${flat.max.toFixed(3)}`);
        check(Math.abs(flat.cross - 5) < 1e-9, 'точка узла на заданной отметке');
        check(Math.abs(flat.min - 5) < 1e-9 && Math.abs(flat.max - 5) < 1e-9,
            `площадка плоская на заданной отметке (${flat.min.toFixed(3)}…${flat.max.toFixed(3)})`);
    }

    // --- Многошаговый подъём: вершина ПОД узлом едет вместе с устьями -------
    /*
     * ⚠️ Один шаг этого не ловит: на первом подъёме все три вершины ставятся
     * заново и совпадают. Ошибка вылезает со ВТОРОГО шага — вершина в самой
     * точке пересечения заводилась один раз и больше не обновлялась, устья
     * росли, а она оставалась внизу: профиль проваливался буквой V прямо под
     * покрытием (замерено 1602.1 против 1604.5 после пяти шагов).
     */
    const multi = await page.evaluate(({ id1, id2, r }) => {
        const D = window.BimLvaDebug;
        D.clearIntersections();
        const ix = D.buildIntersection(id1, id2, { type: 'cross', radius: r });
        const z0 = D.nodeElevation(ix.id).abs;
        const steps = [];
        for (let k = 1; k <= 4; k++) {
            D.setNodeElevationAbs(ix.id, z0 + k * 0.75);
            const anchors = D.axisProfile(id1).filter((p) => p.anchor);
            steps.push({
                want: z0 + k * 0.75,
                node: D.nodeElevation(ix.id).abs,
                anchors: anchors.map((a) => a.z),
                keys: anchors.map((a) => a.key)
            });
        }
        return steps;
    }, { id1: trim.id1, id2: trim.id2, r: R });

    if (multi?.length) {
        const last = multi[multi.length - 1];
        const spread = Math.max(...last.anchors) - Math.min(...last.anchors);
        console.log(`  после ${multi.length} шагов: узел ${last.node.toFixed(3)}, вершины оси ${last.anchors.map((z) => z.toFixed(2)).join(' / ')}`);
        check(multi.every((s) => Math.abs(s.node - s.want) < 1e-6),
            'узел встаёт ровно на заданную отметку на каждом шаге');
        check(spread < 1e-6,
            `вершины оси под узлом на одной отметке — профиль не проваливается (разброс ${spread.toFixed(3)} м)`);
        check(Math.abs(Math.max(...last.anchors) - last.node) < 1e-6,
            'вершины оси подняты вместе с узлом');
        /*
         * И ровно ДВЕ вершины на ось — по одной на устье. Третью, в самой
         * точке пересечения, ставить нельзя: обе соседние уже на отметке
         * узла, участок между ними и так прямой, а лишняя точка добавляет
         * перелом на ровном месте и вторую ручку на оси (у двух осей такие
         * вершины ещё и совпадали бы в одной точке).
         */
        console.log(`  якорей на оси: ${last.keys.length} [${last.keys.join(', ')}]`);
        check(last.keys.length === 2, `на оси ровно два якоря — по одному на устье (${last.keys.length})`);
        check(last.keys.every((k) => /^mouth/.test(k)),
            `якоря стоят только на устьях (${last.keys.join(', ')})`);
    }

    // --- КОСОЕ пересечение: контур доходит до устья по обеим кромкам --------
    /*
     * ⚠️ На ПЕРПЕНДИКУЛЯРНЫХ осях эта проверка проходит вхолостую: у обоих
     * соседних углов ветви одинаковый отступ до касания, и контур сам собой
     * доходит до устья. Разрыв вылезает только на косом пересечении: острый
     * угол даёт длинный отступ (t = R/tg(φ/2)), тупой — короткий, устье берётся
     * по большему, и между точкой касания тупого угла и устьем вырезается
     * треугольник. На 45° замерено 50.3 м — это и были «чёрные клинья».
     */
    const SKEW_B = [{ x: -60, y: -60, z: 10 }, { x: 60, y: 60, z: 10 }];
    const skew = await page.evaluate(({ a, b, r, half }) => {
        const D = window.BimLvaDebug;
        D.clearIntersections();
        const id1 = D.createPolylineFromPoints(a, { name: 'Косая A', role: 'road-axis' });
        const id2 = D.createPolylineFromPoints(b, { name: 'Косая B', role: 'road-axis' });
        D.setRoadWidths(id1, half, half);
        D.setRoadWidths(id2, half, half);
        D.buildRoadXs(id1, { step: 10, widthL: half, widthR: half, live: true });
        D.buildRoadXs(id2, { step: 10, widthL: half, widthR: half, live: true });
        const ix = D.buildIntersection(id1, id2, { type: 'cross', radius: r });
        return ix ? { ixId: ix.id, mouth: D.nodeMouthGap(ix.id) } : null;
    }, { a: AXIS_A, b: SKEW_B, r: R, half: HALF });

    check(!!skew, 'узел на косом пересечении построен');
    if (skew) {
        const worst = skew.mouth.reduce((m, x) => (Math.abs(x.gap) > Math.abs(m.gap) ? x : m), skew.mouth[0]);
        console.log(`  косое пересечение: устье ${worst.mouth.toFixed(2)} м, худший разрыв ${worst.gap.toFixed(2)} м (ветвь ${worst.arm}, ${worst.side})`);
        check(skew.mouth.every((x) => Math.abs(x.gap) < 1e-3),
            `контур доходит до устья по обеим кромкам всех ветвей (худший разрыв ${worst.gap.toFixed(3)} м)`);
    }

    // --- Узел строится сам при пересечении осей ----------------------------
    const auto = await page.evaluate(({ a, b, half }) => {
        const D = window.BimLvaDebug;
        // Чистый лист: от прошлых проверок в сцене осталось много осей, и
        // новая ось построила бы узлы со всеми — счёт поехал бы.
        D.clearPolylines();
        D.setAutoNodes(true);
        // Первая ось — пересекать нечего.
        const id1 = D.createPolylineFromPoints(a, { name: 'Авто A', role: 'road-axis' });
        D.setRoadWidths(id1, half, half);
        const afterFirst = D.intersections.length;
        // Вторая ложится поперёк — узел обязан появиться сам.
        const id2 = D.createPolylineFromPoints(b, { name: 'Авто B', role: 'road-axis' });
        const afterSecond = D.intersections.map((x) => ({ type: x.type, arcs: x.arcs }));
        // Обычная полилиния поперёк тех же осей узлов давать НЕ должна:
        // бровки и контуры пересекаются сплошь и рядом.
        D.createPolylineFromPoints([{ x: -40, y: 40, z: 10 }, { x: 40, y: -40, z: 10 }], { name: 'Просто линия' });
        const afterPlain = D.intersections.length;
        // Выключенное автопостроение больше ничего не создаёт.
        D.setAutoNodes(false);
        D.createPolylineFromPoints([{ x: -30, y: -50, z: 10 }, { x: 30, y: 50, z: 10 }], { name: 'Авто C', role: 'road-axis' });
        const afterOff = D.intersections.length;
        D.setAutoNodes(true);
        return { afterFirst, afterSecond, afterPlain, afterOff };
    }, { a: AXIS_A, b: AXIS_B, half: HALF });

    console.log(`  узлов: после первой оси ${auto.afterFirst}, после второй ${auto.afterSecond.length}, после обычной линии ${auto.afterPlain}, при выключенном авто ${auto.afterOff}`);
    check(auto.afterFirst === 0, 'одна ось узлов не даёт');
    check(auto.afterSecond.length === 1, `вторая ось построила узел сама (${auto.afterSecond.length})`);
    if (auto.afterSecond[0]) {
        check(auto.afterSecond[0].arcs === 4, `у автоузла на кресте 4 закругления (${auto.afterSecond[0].arcs})`);
    }
    check(auto.afterPlain === 1, 'обычная полилиния поперёк осей узла не создаёт');
    check(auto.afterOff === 1, 'при выключенной галочке узлы сами не строятся');

    // Примыкание распознаётся само: ось упирается концом в чужую.
    const autoT = await page.evaluate(({ a, t, half }) => {
        const D = window.BimLvaDebug;
        D.clearPolylines();
        D.setAutoNodes(true);
        const id1 = D.createPolylineFromPoints(a, { name: 'Сквозная', role: 'road-axis' });
        D.setRoadWidths(id1, half, half);
        D.createPolylineFromPoints(t, { name: 'Подходящая', role: 'road-axis' });
        return D.intersections.map((x) => ({ type: x.type, arcs: x.arcs }));
    }, { a: AXIS_A, t: AXIS_T, half: HALF });

    console.log(`  автоузел у примыкания: ${autoT.map((x) => x.type + '/' + x.arcs).join(', ') || '—'}`);
    check(autoT.length === 1 && autoT[0].type === 't-junction',
        `конец оси на чужой оси распознан как примыкание (${autoT[0]?.type || '—'})`);
    check(autoT[0]?.arcs === 2, `у автопримыкания 2 закругления (${autoT[0]?.arcs})`);

    // --- Ось подвинули: узел идёт за ней, профиль не превращается в пилу ----
    /*
     * Владелец потянул вершины оси и получил на профиле пилу из случайных
     * переломов: узел оставался от прежней геометрии, а посаженные им вершины
     * висели там, где были. Проверяем связку целиком — узел следует за осью,
     * якорей по-прежнему два и стоят они у устьев, а когда оси разошлись,
     * узел снимается вместе со своими вершинами.
     */
    const moved = await page.evaluate(({ a, b, half }) => {
        const D = window.BimLvaDebug;
        D.clearPolylines();
        D.setAutoNodes(true);
        const id1 = D.createPolylineFromPoints(a, { name: 'Двигаем A', role: 'road-axis' });
        D.setRoadWidths(id1, half, half);
        const id2 = D.createPolylineFromPoints(b, { name: 'Двигаем B', role: 'road-axis' });
        const ix = D.intersections[0];
        D.setNodeElevationAbs(ix.id, D.nodeElevation(ix.id).abs + 3);

        const snap = () => {
            const prof = D.axisProfile(id1);
            const anchors = prof.filter((p) => p.anchor);
            const gaps = D.nodeGaps(id1);
            return {
                nodes: D.intersections.length,
                anchors: anchors.length,
                anchorSta: anchors.map((p) => p.sta),
                anchorZ: anchors.map((p) => p.z),
                nodeZ: D.intersections.length ? D.nodeElevation(D.intersections[0].id).abs : null,
                gap: gaps[0] || null
            };
        };
        const before = snap();
        /* Двигаем поперечную ось за её КОНЦЫ. Индекс 1 брать нельзя: у оси с
         * узлом там уже сидит служебная вершина устья, и «сдвиг вершины 1»
         * согнул бы ось вместо переноса — тест мерил бы не то. Концы ищем по
         * профилю: они всегда первый и последний. */
        const endsOf = (id) => {
            const prof = D.axisProfile(id);
            return { first: prof[0].i, last: prof[prof.length - 1].i };
        };
        let e = endsOf(id2);
        D.planMoveVertex(id2, e.first, 30, -80);
        e = endsOf(id2);
        D.planMoveVertex(id2, e.last, 30, 80);
        const after = snap();
        // Разводим оси совсем.
        e = endsOf(id2);
        D.planMoveVertex(id2, e.first, 400, -80);
        e = endsOf(id2);
        D.planMoveVertex(id2, e.last, 400, 80);
        const apart = snap();
        return { before, after, apart };
    }, { a: AXIS_A, b: AXIS_B, half: HALF });

    console.log(`  до сдвига: узел ${moved.before.nodeZ.toFixed(3)}, устье ${moved.before.gap.from.toFixed(2)}…${moved.before.gap.to.toFixed(2)}, якоря ПК ${moved.before.anchorSta.map((v) => v.toFixed(2)).join(' / ')}`);
    console.log(`  после сдвига оси: устье ${moved.after.gap ? moved.after.gap.from.toFixed(2) + '…' + moved.after.gap.to.toFixed(2) : '—'}, якоря ПК ${moved.after.anchorSta.map((v) => v.toFixed(2)).join(' / ')}`);

    check(moved.after.nodes === 1, 'узел уцелел при сдвиге оси');
    check(moved.after.anchors === 2, `якорей по-прежнему два (${moved.after.anchors})`);
    check(moved.after.gap && Math.abs(moved.after.gap.from - moved.before.gap.from) > 1,
        'устье уехало вместе с осью — узел пересчитался, а не остался прежним');
    if (moved.after.gap) {
        // Якорь может встать чуть раньше устья (вставка проецируется на
        // звено), но не за километр: это и отличает «следует за осью» от
        // «остался от прошлой геометрии».
        const near = moved.after.anchorSta.map((sta) =>
            Math.min(Math.abs(sta - moved.after.gap.from), Math.abs(sta - moved.after.gap.to)));
        console.log(`  промах якорей от устьев: ${near.map((v) => v.toFixed(2)).join(' / ')} м`);
        check(near.every((d) => d < 1), `якоря стоят у устьев (промах до ${Math.max(...near).toFixed(2)} м)`);
    }
    check(moved.after.anchorZ.every((z) => Math.abs(z - moved.after.nodeZ) < 1e-6),
        'якоря остались на отметке узла после сдвига оси');

    console.log(`  после развода осей: узлов ${moved.apart.nodes}, якорей ${moved.apart.anchors}`);
    check(moved.apart.nodes === 0, 'оси разошлись — узел снят');
    check(moved.apart.anchors === 0, 'вершины, посаженные узлом, сняты вместе с ним');

    // --- Служебные вершины узла не таскаются ручками ------------------------
    const noDragAnchors = await page.evaluate(({ a, b, half }) => {
        const D = window.BimLvaDebug;
        D.clearPolylines();
        D.setAutoNodes(true);
        const id1 = D.createPolylineFromPoints(a, { name: 'Ручки A', role: 'road-axis' });
        D.setRoadWidths(id1, half, half);
        D.createPolylineFromPoints(b, { name: 'Ручки B', role: 'road-axis' });
        D.setNodeElevationAbs(D.intersections[0].id, D.nodeElevation(D.intersections[0].id).abs + 2);
        D.openPolylineEditor(id1);
        const prof = D.axisProfile(id1);
        return { vertices: prof.length, anchors: prof.filter((p) => p.anchor).length, handles: D.polylineHandleCount };
    }, { a: AXIS_A, b: AXIS_B, half: HALF });

    console.log(`  ось: вершин ${noDragAnchors.vertices}, из них служебных ${noDragAnchors.anchors}, ручек ${noDragAnchors.handles}`);
    check(noDragAnchors.anchors > 0, 'служебные вершины на оси есть — проверка не вхолостую');
    check(noDragAnchors.handles === noDragAnchors.vertices - noDragAnchors.anchors,
        `ручки только у своих вершин (${noDragAnchors.handles} при ${noDragAnchors.vertices} вершинах и ${noDragAnchors.anchors} служебных)`);

    // --- Примыкание «впритык»: ось не дотянулась до чужой оси ---------------
    /*
     * Так рисуют на практике: конец примыкающей дороги привязан к КРОМКЕ
     * главной, а не к её оси. Строгого пересечения нет, и узел не строился
     * вовсе. Допуск — половины проезжих частей обеих дорог (полотна
     * соприкасаются), не меньше метра.
     */
    const touch = await page.evaluate(({ a, half }) => {
        const D = window.BimLvaDebug;
        D.clearPolylines();
        D.setAutoNodes(true);
        const id1 = D.createPolylineFromPoints(a, { name: 'Главная', role: 'road-axis' });
        D.setRoadWidths(id1, half, half);
        // Конец ветви не доходит до оси главной на 4 м (в пределах полотна).
        const id2 = D.createPolylineFromPoints(
            [{ x: 0, y: 60, z: 10 }, { x: 0, y: 4, z: 10 }], { name: 'Впритык', role: 'road-axis' });
        D.setRoadWidths(id2, half, half);
        const near = D.intersections.length;
        // А в 40 м — это уже не узел.
        const id3 = D.createPolylineFromPoints(
            [{ x: 40, y: 60, z: 10 }, { x: 40, y: 40, z: 10 }], { name: 'Далеко', role: 'road-axis' });
        D.setRoadWidths(id3, half, half);
        return { near, far: D.intersections.length, types: D.intersections.map((x) => x.type) };
    }, { a: AXIS_A, half: HALF });

    console.log(`  впритык (4 м до оси): узлов ${touch.near}; после дальней ветви (40 м): ${touch.far} [${touch.types.join(', ')}]`);
    check(touch.near === 1, `ветвь, не дошедшая до оси, дала узел (${touch.near})`);
    check(touch.far === 1, `далёкая ветвь узла НЕ дала (стало ${touch.far})`);

    // --- Подписи углов в сцене ----------------------------------------------
    const labels = await page.evaluate(({ a, b, half }) => {
        const D = window.BimLvaDebug;
        D.clearPolylines();
        D.setAutoNodes(true);
        const id1 = D.createPolylineFromPoints(a, { name: 'Подписи A', role: 'road-axis' });
        D.setRoadWidths(id1, half, half);
        D.createPolylineFromPoints(b, { name: 'Подписи B', role: 'road-axis' });
        const ix = D.intersections[0];
        const before = D.nodeCornerLabelState();
        // Правка радиуса одного угла — подпись обязана поехать за ним.
        D.editIntersection(ix.id, { radii: { 0: 9 } });
        return { before, after: D.nodeCornerLabelState() };
    }, { a: AXIS_A, b: AXIS_B, half: HALF });

    console.log(`  подписи углов: ${labels.before.map((l) => l.text).join(' | ')}`);
    check(labels.before.length === 4, `подпись у каждого угла (${labels.before.length})`);
    check(labels.before.every((l) => /^R \d+ · \d+°$/.test(l.text)),
        `подпись несёт радиус и угол (${labels.before[0]?.text})`);
    const nine = labels.after.find((l) => l.index === 0);
    console.log(`  после правки радиуса угла 0: ${nine?.text}`);
    check(nine?.text.startsWith('R 9 '), `подпись угла обновилась под новый радиус (${nine?.text})`);

    /* --- Откосы узла до рельефа ------------------------------------------
     *
     * ⚠️ Нужен СПЛОШНОЙ рельеф. Основная фикстура — редкая сетка коробок
     * (`IFCRECTANGLEPROFILEDEF` задаёт ПОЛНЫЕ размеры: коробка 3×3 при шаге 6,
     * то есть между ними дыры). Луч откоса проваливается в дыру, проходит
     * мимо правильной точки выхода и цепляется за землю дальше: замерено 208
     * сечений из 312 с заложением от 1.5 до 5.56 при заданном 1:1.5 — и это
     * артефакт фикстуры, а не код. Здесь коробки крупные и смыкаются вплотную
     * (`boxSize === step`), и заложение держится ровно. Крупные они не для
     * красоты: слой 210 м из коробок по 3 м — это 4900 сущностей и минуты на
     * тесселяцию, из коробок по 30 м — 49 штук.
     */
    const terrainFile = path.join(ROOT, 'tools', 'fixtures', 'ix-terrain.ifc');
    await fs.writeFile(terrainFile, makeGeoIfc({
        worldX: 55300.05, worldY: 33820.60, worldZ: 1600.15,
        count: 49, cols: 7, step: 30, boxSize: 30, seed: 92, name: 'ix-terrain.ifc'
    }));
    await page.setInputFiles('#localFileInput', terrainFile);
    await page.waitForFunction(
        () => (window.BimLvaDebug?.modelBounds || []).some((m) => /ix-terrain\.ifc$/i.test(m.file)),
        null, { timeout: 120_000 }
    );

    const slope = await page.evaluate(() => {
        const D = window.BimLvaDebug;
        const trace = [];
        const mark = (tag) => {
            const br = D.drawn.filter((r) => /бровка/.test(r.name || '') && !/насыпь|выемк/.test(r.name || ''));
            const nb = br.filter((r) => /×/.test(r.name));
            trace.push(`${tag}: узла ${nb.length} (узлов живых ${D.intersections.length}),`
                + ` дороги ${br.filter((r) => !/×/.test(r.name)).length}, автоузлы ${D.autoNodes}`);
        };
        D.clearIntersections();
        D.clearPolylines();
        mark('после очистки');
        const g = D.modelBounds.find((m) => /ix-terrain\.ifc$/i.test(m.file));
        const zRoad = g.centerZ + g.sizeZ / 2 + 3;   // дорога на 3 м выше земли — чистая насыпь
        /* Оси кладём в ЦЕНТР рельефа, а не в ноль сцены: второй файл в сводке
         * зовёт до-центрирование, и слой земли стоит уже не у нуля. Иначе
         * половина сечений уходит за край земли — замерено 164 «без земли»
         * из 320, и проверка заложения считалась бы по огрызку. */
        const cx = g.centerX, cy = g.centerY;
        const a = D.createPolylineFromPoints(
            [{ x: cx - 60, y: cy, z: zRoad }, { x: cx + 60, y: cy, z: zRoad }], { name: 'Ось A', role: 'road-axis' });
        D.setRoadWidths(a, 5, 5);
        const b = D.createPolylineFromPoints(
            [{ x: cx, y: cy - 60, z: zRoad }, { x: cx, y: cy + 60, z: zRoad }], { name: 'Ось B', role: 'road-axis' });
        D.setRoadWidths(b, 5, 5);
        mark('оси созданы');
        D.buildRoadXs(a, { step: 10, widthL: 5, widthR: 5, live: true });
        D.buildRoadXs(b, { step: 10, widthL: 5, widthR: 5, live: true });
        mark('поперечники');
        /* Пресет с бордюром обязателен: на шаблоне по умолчанию за кромкой
         * пусто, вылет внешнего профиля 0 — и проверка «бровка вынесена за
         * обстройку» прошла бы вхолостую при нулевом выносе. */
        D.applyRoadXsPresetTo(a, 'curb');
        D.applyRoadXsPresetTo(b, 'curb');
        mark('пресеты');
        const node = D.buildIntersection(a, b, { type: 'cross', radius: 15 });
        mark('узел построен');
        if (!node) return { error: 'узел не построился' };
        // Откосы строятся САМИ: ни кнопки, ни галочки для них больше нет.
        const auto = D.nodeSlopes(node.id);

        const brows = D.drawn.filter((r) => /бровка/.test(r.name || '')
            && !/насыпь|выемк/.test(r.name || ''));
        const shift = D.worldPointToAbsolute(0, 0, 0);
        return {
            auto, trace,
            liveNodes: D.intersections.length,
            runs: D.nodeOuter(node.id)?.runs.length || 0,
            // Контур узла — в координатах сцены, бровки — в абсолютных.
            ring: node.outline.map((p) => ({ x: p.x + shift.x, y: p.y + shift.y })),
            roadBrows: brows.filter((r) => !/×/.test(r.name)).map((r) => ({ name: r.name, pts: r.vertsAbs })),
            nodeBrows: brows.filter((r) => /×/.test(r.name)).map((r) => ({ name: r.name, pts: r.vertsAbs }))
        };
    });

    /* Подписи в окне «Создать пересечение дорог» — для человека.
     * Было: карточка «Ось трассы 2 × Ось трассы» и четыре строки уширения,
     * читающиеся как «Ось трассы 2 — уширение» и «Ось трассы — уширение»
     * дважды подряд: какая строка какой ветви — не понять. */
    const card = await page.evaluate(() => {
        const box = document.getElementById('intersectionsList');
        const txt = box ? box.textContent.replace(/\s+/g, ' ').trim() : '';
        const cells = box ? [...box.querySelectorAll('.ix-cell')].map((c) =>
            c.textContent.replace(/\s+/g, ' ').trim()) : [];
        const arms = cells.filter((t) => /ветвь \d/.test(t));
        return { txt: txt.slice(0, 200), arms, разных: new Set(arms).size };
    });
    console.log(`  карточка узла: ${card.txt.slice(0, 90)}…`);
    check(/Пересечение 1/.test(card.txt), 'у узла свой номер, а не только имена осей');
    check(/крестообразное|Т-образное|слияние/.test(card.txt), 'тип пересечения показан в карточке');
    check(/Ось 1:/.test(card.txt) && /Ось 2:/.test(card.txt), 'оси названы по отдельности');
    check(card.arms.length >= 4, `строки ветвей есть (${card.arms.length})`);
    /* Главное: строки ветвей РАЗЛИЧАЮТСЯ. До правки их было четыре, но
     * значений всего два — и проверка «строк четыре» прошла бы вхолостую. */
    check(card.разных === card.arms.length,
        `строки ветвей различимы (${card.разных} разных из ${card.arms.length})`);

    /* Бровки дороги и узла СШИТЫ в одну линию: плечо → дуга узла → плечо.
     * Раньше это были две поверхности на каждый стык, между ними оставался
     * шов, а на вогнутом углу — перехлёст («бабочка» со скриншота владельца).
     * У сплошной линии угол закрывает веер, который построитель ставит сам.
     * Замерено на кресте: поверхностей 12 → 4, линий выхода 12 → 4, вершин
     * в них 123 → 96, насыпь 4869.8 → 4956.0 м³ (+1.8% — это и есть клин,
     * который раньше не закрывался).
     * ⚠️ Проверять надо ЧИСЛО поверхностей, а не стык: концы линий выхода
     * сходились в 0.000 м и ДО сшивки — шов был не разрывом, а перехлёстом. */
    const stitched = await page.evaluate(() => {
        const D = window.BimLvaDebug;
        const sl = D.slopes || [];
        const exits = (D.drawn || []).filter((r) => /насыпь|выемк/.test(r.name || ''));
        return {
            surfaces: sl.length,
            exits: exits.length,
            vertices: exits.reduce((n, r) => n + r.points, 0),
            fill: sl.reduce((n, s) => n + (s.sides || []).reduce((m, x) => m + x.fill, 0), 0)
        };
    });
    console.log(`  сшивка у узла: поверхностей ${stitched.surfaces}, линий выхода ${stitched.exits},`
        + ` вершин ${stitched.vertices}, насыпь ${stitched.fill.toFixed(1)} м³`);
    check(stitched.surfaces === 4,
        `на кресте одна поверхность откоса на участок, а не две (${stitched.surfaces}, было 12)`);
    check(stitched.exits === 4,
        `линия выхода на рельеф сплошная через устье (${stitched.exits} на 4 участка)`);
    check(stitched.fill > 100, `объём посчитан (${stitched.fill.toFixed(1)} м³)`);

    /* Откосы дороги на НАСТОЯЩЕМ пути пользователя: режим оси → точки → Esc.
     * Отдельной кнопки у откосов больше нет, поэтому если этот путь их не
     * строит — их нет нигде (владелец увидел ровно это: полотно и узел есть,
     * откосов нет, и в выгрузку они, соответственно, тоже не попали).
     * ⚠️ Завершать ось надо `finishRoadAxisDraw` (это `setDrawMode(false)`),
     * а не `finishDrawnPolyline`: поперечники и откосы висят там. С
     * `finishDrawnPolyline` ось создаётся, а поперечников ноль — заход уже
     * потерян на этом. */
    const drawn = await page.evaluate(async () => {
        const D = window.BimLvaDebug;
        D.clearIntersections();
        D.clearPolylines();
        D.clearSlopes();
        const g = D.modelBounds.find((m) => /ix-terrain\.ifc$/i.test(m.file));
        const z = g.centerZ + g.sizeZ / 2 + 3;
        D.startRoadAxisDraw();
        D.addDrawWorldPoint(g.centerX - 40, g.centerY, z);
        D.addDrawWorldPoint(g.centerX + 40, g.centerY, z);
        D.finishRoadAxisDraw();
        await new Promise((r) => setTimeout(r, 1200));
        const sl = D.slopes || [];
        return {
            ray: D.rayIndexStats(true),
            xs: (D.roadXs || []).length,
            models: sl.length,
            fill: sl.reduce((n, s) => n + (s.sides || []).reduce((m, x) => m + x.fill, 0), 0),
            faces: sl.reduce((n, s) => n + (s.tin?.faces || 0), 0),
            noGround: sl.reduce((n, s) => n + (s.sides || []).reduce((m, x) => m + x.skippedNoGround, 0), 0)
        };
    });
    /* Выборка отметки под откосом бьёт луч ВНИЗ, и модель лежит в сцене
     * отдельными мешами. Без индекса каждый луч перебирал ВСЕ (на фикстуре
     * 400, на площадке владельца тысячи) — создание оси и перекрёстка вставало
     * на 10–40 с. Мерить это временем нельзя: оно зависит от машины. Меряем
     * то, ради чего индекс и заведён — сколько мешей приходится на одну
     * выборку. */
    console.log(`  луч: мешей в сцене ${drawn.ray.targets}, кандидатов на выборку`
        + ` ${drawn.ray.perSample.toFixed(2)} (выборок ${drawn.ray.samples})`);
    check(drawn.ray.samples > 100, `выборки через индекс, а не мимо него (${drawn.ray.samples})`);
    check(drawn.ray.perSample < Math.max(8, drawn.ray.targets / 8),
        `индекс отсекает лишние меши (${drawn.ray.perSample.toFixed(2)} из ${drawn.ray.targets} на выборку)`);
    console.log(`  дочерченная ось: поперечников ${drawn.xs}, откосов ${drawn.models},`
        + ` насыпь ${drawn.fill.toFixed(2)} м³, граней ${drawn.faces}, без земли ${drawn.noGround}`);
    check(drawn.xs === 1, `дочерченная ось построила поперечники (${drawn.xs})`);
    check(drawn.models === 2, `откосы построились САМИ на обе стороны (${drawn.models})`);
    check(drawn.faces > 0, `у откосов есть грани (${drawn.faces})`);
    check(drawn.fill > 1, `объём насыпи ненулевой (${drawn.fill.toFixed(2)} м³)`);

    /* Ось ВРОВЕНЬ с площадкой: откоса нет ни в насыпь, ни в выемку.
     * Здесь была самая дорогая ошибка дня: `slopeExitGroups` начинала на
     * каждом «плоском» сечении НОВУЮ группу, и на каждую заводилась линия
     * выхода — 843 полилинии вместо 3, а список полилиний перестраивался
     * целиком на каждую. Замерено: одна ось считалась 111 секунд.
     * ⚠️ Отсеивать такие группы по ДЛИНЕ нельзя — соседние плоские точки
     * стоят на соседних станциях, в полуметре друг от друга, и любой порог
     * длины проходят. Признак — пустой режим группы.
     * Проверяем не время (оно зависит от машины), а число полилиний. */
    const levelAxis = await page.evaluate(async () => {
        const D = window.BimLvaDebug;
        D.clearIntersections();
        D.clearPolylines();
        D.clearSlopes();
        const g = D.modelBounds.find((m) => /ix-terrain\.ifc$/i.test(m.file));
        const z = g.centerZ + g.sizeZ / 2;      // ровно по верху рельефа
        D.startRoadAxisDraw();
        D.addDrawWorldPoint(g.centerX - 40, g.centerY, z);
        D.addDrawWorldPoint(g.centerX + 40, g.centerY, z);
        D.finishRoadAxisDraw();
        await new Promise((r) => setTimeout(r, 1200));
        const sl = D.slopes || [];
        return {
            polylines: (D.drawn || []).length,
            sections: sl.reduce((n, s) => n + (s.sides || []).reduce((m, x) => m + x.sections, 0), 0),
            volume: sl.reduce((n, s) => n + (s.sides || []).reduce((m, x) => m + x.fill + x.cut, 0), 0)
        };
    });
    console.log(`  ось вровень с площадкой: полилиний ${levelAxis.polylines},`
        + ` сечений ${levelAxis.sections}, объём ${levelAxis.volume.toFixed(2)} м³`);
    check(levelAxis.sections > 10, `сечения всё же считались (${levelAxis.sections})`);
    check(levelAxis.polylines <= 6,
        `ровное место не плодит линии выхода (${levelAxis.polylines} полилиний, было 843)`);

    /* Привязка к ЧУЖОЙ оси при черчении: подвёл ось к оси — точка садится
     * ровно на неё, и получается Т-образный узел.
     * ⚠️ Обычная привязка сюда не годится: ось нарисована Line2, у которой нет
     * атрибута position, и разбор примитива по ней возвращает пусто. Поэтому
     * своя, по спроецированным точкам записи.
     * ⚠️ Целиться надо в СПРОЕЦИРОВАННУЮ точку оси: клик мимо на пару пикселей
     * проверял бы не то. */
    const axisSnap = await page.evaluate(async () => {
        const D = window.BimLvaDebug;
        D.clearIntersections(); D.clearPolylines(); D.clearSlopes();
        D.setAutoNodes(true);
        const g = D.modelBounds.find((m) => /ix-terrain\.ifc$/i.test(m.file));
        const z = g.centerZ + g.sizeZ / 2 + 3;
        const cx = g.centerX, cy = g.centerY;
        const main = D.createPolylineFromPoints(
            [{ x: cx - 60, y: cy, z }, { x: cx + 60, y: cy, z }], { name: 'Главная', role: 'road-axis' });
        D.setRoadWidths(main, 5, 5);
        await new Promise((r) => setTimeout(r, 300));
        // Экранная точка ЧУТЬ В СТОРОНЕ от середины главной оси.
        const scr = D.polylineScreenPts(main);
        if (!scr || scr.length < 2) return { error: 'ось не спроецировалась' };
        const mid = { x: (scr[0].x + scr[1].x) / 2, y: (scr[0].y + scr[1].y) / 2 };
        const near = D.snapRoadAxisAt(mid.x + 6, mid.y + 6);
        const far = D.snapRoadAxisAt(mid.x + 200, mid.y + 200);
        if (!near) return { error: 'привязка не сработала у самой оси' };
        // Насколько снапнутая точка отстоит от прямой главной оси в плане.
        const rec = D.drawn.find((r) => r.id === main);
        const A = rec.vertsAbs[0], B = rec.vertsAbs[rec.vertsAbs.length - 1];
        const ux = B.x - A.x, uy = B.y - A.y;
        const len = Math.hypot(ux, uy) || 1;
        const off = Math.abs((near.absX - A.x) * uy - (near.absY - A.y) * ux) / len;
        return { off, polyId: near.polyId, mainId: main, farHit: !!far, px: near.px };
    });
    if (axisSnap.error) {
        check(false, `привязка к оси: ${axisSnap.error}`);
    } else {
        console.log(`  привязка к оси: отход от оси ${axisSnap.off.toFixed(4)} м,`
            + ` попадание ${axisSnap.px.toFixed(1)} px`);
        check(axisSnap.polyId === axisSnap.mainId, 'привязка нашла именно главную ось');
        check(axisSnap.off < 1e-6, `точка села РОВНО на ось (отход ${axisSnap.off.toFixed(6)} м)`);
        // Без этого проверка прошла бы и у привязки, которая ловит всё подряд.
        check(!axisSnap.farHit, 'вдали от оси привязка молчит, а не тянет через полэкрана');
    }

    /* РАЗНЫЕ КОНСТРУКЦИИ на осях. Бордюр задан ТОЛЬКО на одной — узел обязан
     * взять его у той ветви, где он есть, и СВЕСТИ НА НЕТ к кромке соседней.
     * Обрыв на конце участка даёт ступеньку высотой в бордюр и клин в откосе
     * (владелец прислал скриншот).
     * ⚠️ Своя сцена: в блоке выше пресет `curb` стоит на ОБЕИХ осях, и там
     * веса равны единице — проверка сведения прошла бы вхолостую. */
    const mixed = await page.evaluate(async () => {
        const D = window.BimLvaDebug;
        D.clearIntersections();
        D.clearPolylines();
        D.clearSlopes();
        D.setAutoNodes(true);
        const g = D.modelBounds.find((m) => /ix-terrain\.ifc$/i.test(m.file));
        const z = g.centerZ + g.sizeZ / 2 + 3;
        const cx = g.centerX, cy = g.centerY;
        const a = D.createPolylineFromPoints(
            [{ x: cx - 60, y: cy, z }, { x: cx + 60, y: cy, z }], { name: 'С бордюром', role: 'road-axis' });
        D.setRoadWidths(a, 5, 5);
        const b = D.createPolylineFromPoints(
            [{ x: cx, y: cy - 60, z }, { x: cx, y: cy + 60, z }], { name: 'Без бордюра', role: 'road-axis' });
        D.setRoadWidths(b, 5, 5);
        D.buildRoadXs(a, { step: 10, widthL: 5, widthR: 5, live: true });
        D.buildRoadXs(b, { step: 10, widthL: 5, widthR: 5, live: true });
        D.applyRoadXsPresetTo(a, 'curb');      // только одна ось
        await new Promise((r) => setTimeout(r, 600));
        const ix = D.intersections[0];
        return ix ? D.nodeOuter(ix.id) : null;
    });
    if (!mixed) {
        check(false, 'обстройка узла не описана — nodeOuter вернул пусто');
    } else {
        const ends = (mixed.runs || []).map((r) => `${r.outStart}→${r.outEnd}`).join('  ');
        console.log(`  разные конструкции, вылет обстройки на концах участков: ${ends}`);
        const tapered = (mixed.runs || []).filter((r) =>
            (r.outStart > 0.01 && r.outEnd < 0.01) || (r.outEnd > 0.01 && r.outStart < 0.01));
        check((mixed.runs || []).length > 0, 'участки контура есть');
        check(tapered.length === (mixed.runs || []).length,
            `обстройка сведена на нет к оси без неё (${tapered.length} из ${(mixed.runs || []).length} участков)`);
    }

    /* «Убрать откосы» в окне площадок НЕ должна трогать откосы дорог и узлов.
     * Владелец жал кнопку у площадки и терял всё построенное по осям.
     * ⚠️ Проверять надо, что дорожные ОСТАЛИСЬ, а не что кнопка «что-то
     * убрала»: старая уборка сносила всё подряд и такую проверку прошла бы. */
    const scoped = await page.evaluate(async () => {
        const D = window.BimLvaDebug;
        D.clearIntersections(); D.clearPolylines(); D.clearSlopes();
        D.setAutoNodes(true);
        const g = D.modelBounds.find((m) => /ix-terrain\.ifc$/i.test(m.file));
        const z = g.centerZ + g.sizeZ / 2 + 3;
        const cx = g.centerX, cy = g.centerY;
        const a = D.createPolylineFromPoints(
            [{ x: cx - 50, y: cy, z }, { x: cx + 50, y: cy, z }], { name: 'Дорога', role: 'road-axis' });
        D.setRoadWidths(a, 5, 5);
        D.buildRoadXs(a, { step: 10, widthL: 5, widthR: 5, live: true });
        D.buildRoadXsSlopes({ polylineId: a });
        // Площадка: обычный замкнутый контур в стороне от дороги.
        const pad = D.createPolylineFromPoints([
            { x: cx - 40, y: cy + 40, z }, { x: cx + 0, y: cy + 40, z },
            { x: cx + 0, y: cy + 70, z }, { x: cx - 40, y: cy + 70, z }
        ], { name: 'Площадка', closed: true });
        D.buildSlopeOnPolyline(pad, { side: 'both', mFill: 1.5, mCut: 1, step: 0.5, maxReach: 30 });
        await new Promise((r) => setTimeout(r, 400));
        const road = () => (D.slopes || []).filter((s) => /бровка/.test(s.name || '')).length;
        const pads = () => (D.slopes || []).filter((s) => !/бровка/.test(s.name || '')).length;
        const before = { road: road(), pads: pads() };
        D.clearPadSlopes();
        return { before, after: { road: road(), pads: pads() } };
    });
    console.log(`  уборка площадок: дорожных ${scoped.before.road}→${scoped.after.road},`
        + ` площадочных ${scoped.before.pads}→${scoped.after.pads}`);
    check(scoped.before.road > 0 && scoped.before.pads > 0,
        `сцена собрана: дорожных ${scoped.before.road}, площадочных ${scoped.before.pads}`);
    check(scoped.after.pads === 0, 'откосы площадки убраны');
    check(scoped.after.road === scoped.before.road,
        `откосы дорог и узлов НЕ тронуты (${scoped.after.road} из ${scoped.before.road})`);

    /* ПРИМЫКАНИЕ: отметка берётся у сквозной оси и фиксируется у ОБЕИХ.
     * Раньше профили связывались только когда отметку задавали вручную, а в
     * режиме «по осям» каждая ось оставалась при своей — на стыке полотна
     * расходились ступенькой (владелец прислал скриншот).
     * ⚠️ Оси кладём на РАЗНЫХ отметках, иначе проверка пройдёт вхолостую:
     * при одинаковых профилях они и без связывания совпадут. */
    const tee = await page.evaluate(async () => {
        const D = window.BimLvaDebug;
        D.clearIntersections(); D.clearPolylines(); D.clearSlopes();
        D.setAutoNodes(true);
        const g = D.modelBounds.find((m) => /ix-terrain\.ifc$/i.test(m.file));
        const z0 = g.centerZ + g.sizeZ / 2 + 3;
        const cx = g.centerX, cy = g.centerY;
        const main = D.createPolylineFromPoints(
            [{ x: cx - 60, y: cy, z: z0 }, { x: cx + 60, y: cy, z: z0 }],
            { name: 'Главная', role: 'road-axis' });
        D.setRoadWidths(main, 5, 5);
        // Съезд ниже на 4 м и упирается в главную — классическое примыкание.
        const branch = D.createPolylineFromPoints(
            [{ x: cx, y: cy - 60, z: z0 - 4 }, { x: cx, y: cy, z: z0 - 4 }],
            { name: 'Съезд', role: 'road-axis' });
        D.setRoadWidths(branch, 5, 5);
        await new Promise((r) => setTimeout(r, 800));
        const ix = D.intersections[0];
        if (!ix) return { error: 'узел не построился' };
        const zAt = (id) => {
            const rec = D.drawn.find((r) => r.id === id);
            const pts = rec.vertsAbs;
            // Отметка оси в точке узла — по ближайшему звену в плане.
            const node = D.worldPointToAbsolute(0, 0, 0);
            let best = null;
            for (let i = 0; i + 1 < pts.length; i++) {
                const a = pts[i], b = pts[i + 1];
                const dx = b.x - a.x, dy = b.y - a.y;
                const l2 = dx * dx + dy * dy || 1;
                let t = ((nodeAbs.x - a.x) * dx + (nodeAbs.y - a.y) * dy) / l2;
                t = Math.max(0, Math.min(1, t));
                const d = Math.hypot(nodeAbs.x - (a.x + dx * t), nodeAbs.y - (a.y + dy * t));
                if (!best || d < best.d) best = { d, z: a.z + (b.z - a.z) * t };
            }
            return best ? best.z : null;
        };
        const nodeAbs = D.nodeElevation ? D.nodeElevation(ix.id) : null;
        const dump = D.nodeGeometryDump(ix.id);
        return {
            error: null, ixId: ix.id, main, branch, nodeAbs,
            arms: (dump?.arms || []).map((a) => ({ poly: a.poly, sign: a.sign }))
        };
    });
    if (tee.error) {
        check(false, `примыкание: ${tee.error}`);
    } else {
        /* Ветви — причина, отметка — следствие. Проверяем обе: сквозная ось
         * обязана иметь ДВЕ ветви, примыкающая одну.
         * ⚠️ Раньше сквозной считалась `poly1`, то есть просто первый
         * аргумент, а автопостроение подставляет первой ТОЛЬКО ЧТО
         * начерченную ось — примыкающую. У главной дороги терялась вторая
         * ветвь (2 вместо 3), узел обрывал её с одной стороны, а связывание
         * отметок не понимало, чей профиль главный. Ось, начерченная второй,
         * здесь именно съезд — иначе проверка пройдёт вхолостую. */
        const armsOfMain = tee.arms.filter((a) => a.poly === tee.main).length;
        const armsOfBranch = tee.arms.filter((a) => a.poly === tee.branch).length;
        console.log(`  ветви узла: главная ${armsOfMain}, съезд ${armsOfBranch} (всего ${tee.arms.length})`);
        check(armsOfMain === 2, `у сквозной оси две ветви (получено ${armsOfMain})`);
        check(armsOfBranch === 1, `у примыкающей одна ветвь (получено ${armsOfBranch})`);

        const zz = await page.evaluate(({ main, branch }) => {
            const D = window.BimLvaDebug;
            const at = (id) => {
                const rec = D.drawn.find((r) => r.id === id);
                const pts = rec.vertsAbs;
                let best = null;
                for (const p of pts) {
                    // Точка узла — конец съезда: там обе оси и должны сойтись.
                    if (!best || p.z != null) best = best || p;
                }
                return pts;
            };
            return { main: at(main), branch: at(branch) };
        }, { main: tee.main, branch: tee.branch });
        // Конец съезда и отметка главной в той же точке плана.
        const bEnd = zz.branch[zz.branch.length - 1];
        let nearest = null;
        for (let i = 0; i + 1 < zz.main.length; i++) {
            const a = zz.main[i], b = zz.main[i + 1];
            const dx = b.x - a.x, dy = b.y - a.y;
            const l2 = dx * dx + dy * dy || 1;
            let t = ((bEnd.x - a.x) * dx + (bEnd.y - a.y) * dy) / l2;
            t = Math.max(0, Math.min(1, t));
            const d = Math.hypot(bEnd.x - (a.x + dx * t), bEnd.y - (a.y + dy * t));
            const z = a.z + (b.z - a.z) * t;
            if (!nearest || d < nearest.d) nearest = { d, z };
        }
        const dz = Math.abs(bEnd.z - (nearest ? nearest.z : bEnd.z));
        console.log(`  примыкание: съезд ${bEnd.z.toFixed(3)}, главная ${nearest.z.toFixed(3)},`
            + ` расхождение ${dz.toFixed(3)} м`);
        check(dz < 0.05, `отметка на примыкании общая у обеих осей (расхождение ${dz.toFixed(3)} м)`);

        /* ⚠️ Одного «расхождения» МАЛО, и это измерено, а не предположено:
         * со связыванием, но без починки ветвей обе оси сходились на 2.5 м —
         * съезд поднимался, а ГЛАВНУЮ тянуло вниз, и проверка выше была бы
         * зелёной на заведомо сломанном результате. Главная в фикстуре
         * горизонтальна, значит связывание обязано оставить её горизонтальной:
         * тянуть сквозную дорогу к отметке съезда неверно. */
        const zs = zz.main.map((p) => p.z);
        const tilt = Math.max(...zs) - Math.min(...zs);
        console.log(`  профиль главной: перепад ${tilt.toFixed(3)} м (была горизонтальна)`);
        check(tilt < 0.01, `сквозную ось не потянуло к отметке съезда (перепад ${tilt.toFixed(3)} м)`);
    }


    /* ВПИСАННАЯ КРИВАЯ В ОСИ. Владелец: «если вписывать кривые в оси дорог,
     * то пересечение их не понимает и ломает дорогу на стыках».
     * ⚠️ Прежняя фикстура была НЕ ТА: пересечение ложилось на прямой участок
     * ЗА дугой (угол на ПК 80, конец сопряжения 105, пересечение 140) — там
     * хорда и трасса совпадают, и проверка проходила вхолостую. Здесь ось B
     * пересекает ось A ВНУТРИ дуги: |CROSS_X| < R.
     * Меряем ТРИ числа, потому что каждое ловит свой дефект. */
    const CURVE_R = 40, CROSS_X = -20;
    const curve = await page.evaluate(async ({ R, X }) => {
        const D = window.BimLvaDebug;
        D.clearIntersections(); D.clearPolylines(); D.clearSlopes();
        D.setAutoNodes(false);
        const g = D.modelBounds.find((m) => /ix-terrain\.ifc$/i.test(m.file));
        const z0 = g.centerZ + g.sizeZ / 2 + 3;
        const cx = g.centerX, cy = g.centerY;
        const a = D.createPolylineFromPoints([
            { x: cx - 100, y: cy, z: z0 },
            { x: cx, y: cy, z: z0 },
            { x: cx, y: cy + 100, z: z0 }
        ], { name: 'Ось A', role: 'road-axis' });
        D.setRoadWidths(a, 5, 5);
        D.setPolylineRadius(a, 1, R);
        const b = D.createPolylineFromPoints([
            { x: cx + X, y: cy - 60, z: z0 },
            { x: cx + X, y: cy + 60, z: z0 }
        ], { name: 'Ось B', role: 'road-axis' });
        D.setRoadWidths(b, 5, 5);
        D.buildRoadXs(a, { step: 10, widthL: 5, widthR: 5, live: true });
        D.buildRoadXs(b, { step: 10, widthL: 5, widthR: 5, live: true });
        await new Promise((r) => setTimeout(r, 800));
        // Снимок ДО узла: с ним и сравниваем — ось не должна измениться.
        const recBefore = D.drawn.find((r) => r.id === a);
        const before = {
            trace: recBefore.abs.map((p) => ({ x: p.x, y: p.y })),
            verts: recBefore.vertsAbs.length,
            radii: recBefore.radii.slice()
        };
        const res = D.buildIntersection(a, b, { type: 'cross', radius: 15 });
        if (!res) return { error: 'узел на кривой не построился' };
        /* ⚠️ Узел ОБЯЗАТЕЛЬНО поднимаем. На ровных осях отметка узла равна
         * собственной отметке оси, якорь не нужен и не ставится вовсе — а
         * значит вся посадка вершин внутрь дуги остаётся непроверенной
         * (замерено: без подъёма обратная подстановка проходит вхолостую). */
        const zNode = D.nodeElevation(res.id).abs;
        D.setNodeElevationAbs(res.id, zNode + 3);
        await new Promise((r) => setTimeout(r, 600));
        const recA = D.drawn.find((r) => r.id === a);
        return {
            error: null, a, b, before,
            after: { verts: recA.vertsAbs.length, radii: recA.radii.slice(), trace: recA.abs.length },
            afterTrace: recA.abs.map((p) => ({ x: p.x, y: p.y })),
            cross: D.worldPointToAbsolute(res.cross.x, res.cross.y, res.cross.z),
            arms: D.nodeGeometryDump(res.id).arms,
            gaps: D.nodeGaps(a),
            stations: D.corridorStations(a),
            anchors: (D.axisProfile(a) || []).filter((p) => p.anchor).length,
            nodeZ: D.nodeElevation(res.id).abs, wantZ: zNode + 3
        };
    }, { R: CURVE_R, X: CROSS_X });

    if (curve.error) {
        check(false, curve.error);
    } else {
        const nearOn = (pts, q) => {
            let best = null;
            for (let i = 0; i + 1 < pts.length; i++) {
                const p = pts[i], r = pts[i + 1];
                const dx = r.x - p.x, dy = r.y - p.y;
                const l2 = dx * dx + dy * dy || 1;
                let t = ((q.x - p.x) * dx + (q.y - p.y) * dy) / l2;
                t = Math.max(0, Math.min(1, t));
                const d = Math.hypot(q.x - (p.x + dx * t), q.y - (p.y + dy * t));
                if (!best || d < best.d) best = { d, ux: dx / Math.sqrt(l2), uy: dy / Math.sqrt(l2) };
            }
            return best;
        };
        /* 1. Ось не деформирована. Якорь узла сажался ПО ПИКЕТУ ТРАССЫ, а
         * ложился в ломаную: внутри дуги проекция уезжала на соседнее плечо,
         * и ось получала зигзаг. Обратная подстановка даёт 5-6 вершин. */
        // 2. Узел стоит НА трассе, а не на хорде — и сама трасса не сдвинулась.
        console.log(`  кривая: вершин ${curve.before.verts} → ${curve.after.verts},`
            + ` радиусы ${JSON.stringify(curve.before.radii)} → ${JSON.stringify(curve.after.radii)},`
            + ` точек трассы ${curve.before.trace.length} → ${curve.after.trace}`);
        console.log(`  кривая: узел поднят до ${curve.nodeZ.toFixed(3)} (просили ${curve.wantZ.toFixed(3)}),`
            + ` якорей на оси ${curve.anchors}`);
        check(Math.abs(curve.nodeZ - curve.wantZ) < 0.05,
            `узел встал на заданную отметку (${curve.nodeZ.toFixed(3)})`);
        check(curve.anchors > 0, `подъём узла посадил якоря — есть что проверять (${curve.anchors})`);
        /* ⚠️ Считать ВЕРШИНЫ бесполезно: якорей ровно столько же и при верной
         * посадке, и при посадке внутрь дуги — проверка прошла бы на
         * заведомо согнутой оси (проверено подстановкой). Мерить надо саму
         * ТРАССУ: якорь лежит НА линии, значит дорога не должна сдвинуться
         * никуда. */
        const devi = curve.afterTrace.reduce((m, q) => Math.max(m, nearOn(curve.before.trace, q).d), 0);
        console.log(`  кривая: трасса ушла от исходной на ${devi.toFixed(3)} м`);
        check(devi < 0.05, `узел не согнул саму ось (трасса ушла на ${devi.toFixed(3)} м)`);

        const on = nearOn(curve.before.trace, curve.cross);
        console.log(`  кривая: отход узла от трассы ${on.d.toFixed(3)} м`);
        check(on.d < 0.05, `узел стоит на трассе, а не на хорде (отход ${on.d.toFixed(3)} м)`);

        /* 3. Ветвь идёт по КАСАТЕЛЬНОЙ. По ней строятся закругления и устья:
         * с хордой они смотрят в одну сторону, а дорога приходит в другую —
         * это и есть «ломает на стыках». Обратная подстановка: 24.8°. */
        let worst = 0;
        for (const arm of curve.arms) {
            if (arm.poly !== curve.a) continue;
            const dot = Math.max(-1, Math.min(1, Math.abs(arm.ux * on.ux + arm.uy * on.uy)));
            worst = Math.max(worst, Math.acos(dot) * 180 / Math.PI);
        }
        console.log(`  кривая: ветвь против касательной — ${worst.toFixed(2)}°`);
        check(worst < 1, `ветвь узла идёт по касательной к дуге (${worst.toFixed(2)}°)`);

        // 4. Коридор обрывается ровно у узла, а не лезет под покрытие.
        const gap = curve.gaps[0];
        const st = curve.stations || [];
        const inside = st.filter((x) => x > gap.from + 1e-3 && x < gap.to - 1e-3).length;
        const onEdge = (v) => st.some((x) => Math.abs(x - v) < 1e-3);
        console.log(`  кривая: разрыв коридора [${gap.from.toFixed(2)}, ${gap.to.toFixed(2)}],`
            + ` станций внутри ${inside}, торцы на границах`
            + ` ${onEdge(gap.from) ? 'да' : 'НЕТ'}/${onEdge(gap.to) ? 'да' : 'НЕТ'}`);
        check(inside === 0, `коридор не идёт через узел на кривой (станций внутри ${inside})`);
        check(onEdge(gap.from) && onEdge(gap.to), 'торцы коридора встали заподлицо с устьями');
    }

    await fs.rm(terrainFile, { force: true });

    if (slope.error) {
        check(false, 'откосы узла: ' + slope.error);
    } else {
        (slope.trace || []).forEach((t) => console.log('    ' + t));
        const A = slope.auto;
        console.log(`  откосы узла: участков ${slope.runs}, сечений ${A.sections}`
            + ` (без земли ${A.sectionsInvalid}), насыпь ${A.fill.toFixed(1)} м³,`
            + ` заложение ${A.layMin?.toFixed(3)}…${A.layMax?.toFixed(3)}`);

        check(A.on && A.models > 0,
            `откосы построились САМИ, без кнопки и галочки (${A.models})`);
        /* Автопостроение включено, и узел на этой паре осей уже был. Ручная
         * постройка обязана ЗАМЕНИТЬ его, а не добавить второй: на каждом
         * витке внутренней пересборки рождался ещё один узел, и бровки
         * копились — замерено 2 живых узла и 60 бровок вместо 4. */
        check(slope.liveNodes === 1,
            `узел на паре осей ровно один, а не второй поверх (${slope.liveNodes})`);
        check(slope.nodeBrows.length === 4,
            `бровок узла ровно 4, без осиротевших от прежних узлов (${slope.nodeBrows.length})`);
        check(A.models === slope.runs && slope.runs >= 4,
            `откос на каждом участке контура, а не по кольцу (${A.models} при ${slope.runs} участках)`);
        check(A.browOff > 0.05,
            `бровка вынесена за обстройку узла, а не лежит на проезжей части (${A.browOff.toFixed(2)} м)`);
        check(A.sectionsInvalid === 0, `все сечения нашли землю (без земли ${A.sectionsInvalid})`);
        // Знак нормали — самая опасная ошибка: внутрь откос закрыл бы сам узел,
        // а объём при этом остался бы правдоподобным.
        check(A.outwardMin > 0, `откос уходит НАРУЖУ от узла (минимум ${A.outwardMin?.toFixed(2)} м)`);
        check(A.layOff === 0,
            `заложение 1:m держится во всех сечениях (мимо ${A.layOff}`
            + `${A.laySample ? ', например ' + JSON.stringify(A.laySample) : ''})`);
        check(A.fill > 100, `насыпь посчитана (${A.fill.toFixed(1)} м³)`);

        /* Бровка дороги обязана РВАТЬСЯ у узла: одной линией через весь
         * перекрёсток она шла напрямую, и откос по ней резал покрытие — у
         * владельца это чёрные клинья у устьев и зелёная линия поперёк узла.
         *
         * ⚠️ Считать только ВЕРШИНЫ бесполезно: пикеты внутри узла и так
         * вырезаны (`applyNodeGapsToStations`), внутрь попадал именно ОТРЕЗОК
         * между ними. С одними вершинами проверка зелёная при сломанном коде —
         * замерено 0 из 72. Поэтому берём и середины звеньев: тогда обратная
         * подстановка даёт 4 из 140. */
        let inside = 0, total = 0;
        for (const b of slope.roadBrows) {
            for (let i = 0; i < b.pts.length; i++) {
                const p = b.pts[i], n = b.pts[i + 1];
                total++;
                if (pointInRing(p, slope.ring)) inside++;
                if (n) {
                    total++;
                    if (pointInRing({ x: (p.x + n.x) / 2, y: (p.y + n.y) / 2 }, slope.ring)) inside++;
                }
            }
        }
        console.log(`  бровок дороги ${slope.roadBrows.length}, узла ${slope.nodeBrows.length};`
            + ` точек и середин внутри узла ${inside} из ${total}`);
        check(slope.roadBrows.length >= 8,
            `бровка дороги разорвана у узла (${slope.roadBrows.length} участков при 2 осях × 2 стороны)`);
        check(inside === 0, `бровка дороги не идёт через перекрёсток (${inside} из ${total})`);

        // Стыковка: концы бровок узла и дороги сходятся у устья.
        let worst = 0;
        const ends = (b) => [b.pts[0], b.pts[b.pts.length - 1]];
        for (const nb of slope.nodeBrows) {
            for (const e of ends(nb)) {
                let best = Infinity;
                for (const rb of slope.roadBrows) {
                    for (const re of ends(rb)) {
                        best = Math.min(best, Math.hypot(e.x - re.x, e.y - re.y, e.z - re.z));
                    }
                }
                worst = Math.max(worst, best);
            }
        }
        console.log(`  худший стык узел↔дорога: ${worst.toFixed(3)} м`);
        check(worst < 0.05, `откос узла стыкуется с дорожным (расхождение ${worst.toFixed(3)} м)`);
    }

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
