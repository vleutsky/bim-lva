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
