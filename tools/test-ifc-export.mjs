/**
 * Выгрузка в IFC 4.3: собираем файл и читаем его ОБРАТНО тем же web-ifc,
 * которым вьювер открывает чужие модели. Проверять сам текст бессмысленно —
 * ошибку в схеме видно только при разборе и построении геометрии.
 *
 * Запуск: npm run test-ifc-export
 */
import { chromium } from 'playwright';
import { makeGeoIfc } from './fixtures/make-geo-ifc.mjs';
import { startStaticServer } from './static-server.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) problems.push(what); };
/**
 * Мини-разбор STEP: id → {type, args}. Скобки и кавычки считаем честно —
 * регуляркой по `);` разбор ломается на первой же строке с вложенным списком.
 */
function parseStep(text) {
    const map = new Map();
    for (const line of text.split('\n')) {
        const m = /^#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(/.exec(line.trim());
        if (!m) continue;
        const body = line.trim().slice(m[0].length, line.trim().lastIndexOf(')'));
        map.set('#' + m[1], { type: m[2], args: splitArgs(body) });
    }
    return map;
}
function splitArgs(s) {
    const out = []; let depth = 0, quote = false, cur = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (quote) { cur += ch; if (ch === "'") quote = (s[i + 1] === "'") && (cur += s[++i], true); continue; }
        if (ch === "'") { quote = true; cur += ch; continue; }
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    out.push(cur.trim());
    return out;
}
const refList = (s) => (s.match(/#\d+/g) || []);
const unescapeStep = (s) => String(s || '').replace(/\\X2\\((?:[0-9A-F]{4})+)\\X0\\/g,
    (_, hex) => hex.match(/.{4}/g).map((h) => String.fromCharCode(parseInt(h, 16))).join(''));
const stepName = (args) => unescapeStep(String(args?.[2] || '').replace(/^'|'$/g, ''));
const stepEnum = (s) => String(s || '').replace(/\./g, '');
const nestsOf = (map, relatingId) => {
    const kids = [];
    for (const e of map.values()) {
        if (e.type !== 'IFCRELNESTS') continue;
        if (e.args[4] === relatingId) kids.push(...refList(e.args[5]));
    }
    return kids;
};
const xyOf = (map, ref) => {
    const inner = String(map.get(ref)?.args?.[0] || '').replace(/[()]/g, '');
    const [x, y] = inner.split(',').map(Number);
    return { x, y };
};
const angDiff = (a, b) => {
    let d = a - b;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
};
/* Горизонталь: LINE P1 = P0 + L·(cosθ, sinθ);
 * CIRCULARARC Δ = L/R, центр в P0 + R·(−sinθ, cosθ), знак R — против часовой. */
function stepHor(sg) {
    const c = Math.cos(sg.dir), s = Math.sin(sg.dir);
    if (sg.type === 'LINE' || Math.abs(sg.r) < 1e-12) {
        return { x: sg.x + sg.len * c, y: sg.y + sg.len * s, dir: sg.dir };
    }
    const dAng = sg.len / sg.r;
    const cx = sg.x + sg.r * (-s);
    const cy = sg.y + sg.r * c;
    const dir = sg.dir + dAng;
    return { x: cx + sg.r * Math.sin(dir), y: cy - sg.r * Math.cos(dir), dir };
}
/* Вертикаль в осях (пикет, отметка). HorizontalLength — по пикету, не длина дуги. */
function stepVer(sg) {
    const sta = sg.sta + sg.len;
    if (sg.type === 'CONSTANTGRADIENT' || sg.r == null || !Number.isFinite(sg.r)) {
        return { sta, z: sg.z + sg.g0 * sg.len, g: sg.g0 };
    }
    const th = Math.atan(sg.g0);
    const Cs = sg.sta + sg.r * (-Math.sin(th));
    const Cz = sg.z + sg.r * Math.cos(th);
    const sin1 = Math.sin(th) + sg.len / sg.r;
    const th1 = Math.asin(Math.max(-1, Math.min(1, sin1)));
    return { sta, z: Cz - sg.r * Math.cos(th1), g: Math.tan(th1) };
}

async function chrome() {
    if (process.env.SMOKE_CHROMIUM) return process.env.SMOKE_CHROMIUM;
    const b = process.env.PLAYWRIGHT_BROWSERS_PATH; if (!b) return undefined;
    for (const d of (await fs.readdir(b)).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
        const p = path.join(b, d, 'chrome-linux', 'chrome');
        if (await fs.access(p).then(() => 1, () => 0)) return p;
    }
}

/* Модель нужна по двум причинам: без рельефа не строятся поперечники (а
 * значит и одежда узла), и без неё ноль сцены совпадает с абсолютным —
 * вынос мирового сдвига в размещение IfcSite остался бы непроверенным. */
const geoFile = path.join(ROOT, 'tools', 'fixtures', '_ifc-exp-geo.ifc');
await fs.writeFile(geoFile, makeGeoIfc({
    worldX: 55300.05, worldY: 33820.60, worldZ: 1600.15,
    /* Уклон обязателен: на плоской площадке ось либо везде выше земли, либо
     * везде ниже, выемки не возникает вовсе, и проверка её тела прошла бы
     * вхолостую. */
    count: 24, cols: 6, step: 6, seed: 77, tilt: 0.35, name: '_ifc-exp-geo.ifc'
}));

const { server, port } = await startStaticServer(ROOT);
const browser = await chromium.launch({ executablePath: await chrome() });
const page = await browser.newPage();
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
const outFile = path.join(ROOT, 'tools', 'fixtures', '_ifc-export.ifc');
try {
    await page.goto(`http://127.0.0.1:${port}/bim-lva-composer-ifc.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.BimLvaDebug, null, { timeout: 60_000 });

    await page.setInputFiles('#localFileInput', geoFile);
    await page.waitForFunction(
        () => (window.BimLvaDebug?.modelBounds || []).some((m) => /_ifc-exp-geo/i.test(m.file)),
        null, { timeout: 120_000 }
    );
    const shift = await page.evaluate(() => window.BimLvaDebug.worldPointToAbsolute(0, 0, 0));
    console.log(`  ноль сцены в абсолютных: ${shift.x.toFixed(1)} / ${shift.y.toFixed(1)} / ${shift.z.toFixed(1)}`);

    const made = await page.evaluate(() => {
        const D = window.BimLvaDebug;
        D.clearPolylines();
        D.setAutoNodes(true);
        const a = D.createPolylineFromPoints(
            [{ x: -60, y: 0, z: 5 }, { x: 60, y: 0, z: 5 }], { name: 'Ось A', role: 'road-axis' });
        D.setRoadWidths(a, 5, 5);
        const b = D.createPolylineFromPoints(
            [{ x: 0, y: -60, z: 5 }, { x: 0, y: 60, z: 5 }], { name: 'Ось B', role: 'road-axis' });
        D.setRoadWidths(b, 5, 5);
        const c = D.createPolylineFromPoints([
            { x: -200, y: -200, z: 10 },
            { x: -100, y: -200, z: 16 },
            { x: -100, y: -100, z: 10 },
            { x: 40, y: -100, z: 14 }
        ], { name: 'Ось C', role: 'road-axis' });
        D.setPolylineRadius(c, 1, 30);
        D.setPolylineRadius(c, 2, 25);
        D.setPolylineVRadius(c, 1, 900);
        D.setPolylineVRadius(c, 2, 700);
        D.buildRoadXs(a, { step: 10, widthL: 5, widthR: 5, live: true });
        D.buildRoadXs(b, { step: 10, widthL: 5, widthR: 5, live: true });
        D.applyRoadXsPresetTo(a, 'curb');
        D.addRoadXsLayer(0.35);
        D.editIntersection(D.intersections[0].id, { radii: {} });
        D.applyRoadXsPresetTo(a, 'curb');
        D.addRoadXsLayer(0.35);
        try { return { nodes: D.intersections.length, layers: D.nodeLayers(D.intersections[0].id).length, axisC: c, ...D.ifcExport() }; }
        catch (e) { return { error: String(e?.message || e) }; }
    });

    /* Три схемы — три разных файла, и различия НЕ косметические: в IFC4 нет
     * дорожных классов и IfcAlignment, в IFC2x3 нет ещё и тесселяции, а
     * IfcOwnerHistory там обязателен. Проверяем каждую отдельно и каждую
     * читаем обратно. */
    const legacy = await page.evaluate(() => {
        const D = window.BimLvaDebug;
        const out = {};
        for (const sch of ['IFC4', 'IFC2X3']) {
            try { out[sch] = D.ifcExport(sch); } catch (e) { out[sch] = { error: String(e?.message || e) }; }
        }
        return out;
    });
    for (const sch of ['IFC4', 'IFC2X3']) {
        const r = legacy[sch];
        check(!r.error, `${sch} собран${r.error ? ': ' + r.error : ''}`);
        if (r.error) continue;
        console.log(`  ${sch}: тел ${r.solids} (${r.tris} треугольников), сущностей ${r.entities}`);
        check(r.text.includes(`FILE_SCHEMA(('${sch}'))`), `${sch}: схема в заголовке`);
        check(r.solids > 0, `${sch}: тела попали в файл (${r.solids})`);
        // Дорожных классов в этих схемах НЕТ — если просочились, файл соврал.
        for (const cls of ['IFCPAVEMENT', 'IFCKERB', 'IFCEARTHWORKSFILL', 'IFCALIGNMENT', 'IFCROAD']) {
            check(!r.text.includes(cls), `${sch}: нет класса ${cls}, которого в схеме не существует`);
        }
        check(r.text.includes('IFCBUILDINGELEMENTPROXY'), `${sch}: тела универсальным классом`);
        check(r.text.includes('IFCANNOTATION'), `${sch}: ось не потеряна (аннотация с ломаной)`);
    }
    // Тесселяции в 2x3 нет — только оболочка из граней.
    check(!legacy.IFC2X3.text?.includes('IFCTRIANGULATEDFACESET'),
        'IFC2X3: нет IfcTriangulatedFaceSet, которого в схеме не существует');
    check(!!legacy.IFC2X3.text?.includes('IFCOPENSHELL'), 'IFC2X3: геометрия оболочкой из граней');
    check(!!legacy.IFC2X3.text?.includes('IFCOWNERHISTORY'),
        'IFC2X3: есть IfcOwnerHistory — в этой схеме он обязателен');
    check(legacy.IFC4.text?.includes('IFCTRIANGULATEDFACESET'),
        'IFC4: тесселяция на месте (в IFC4 она есть)');

    check(!made.error, `IFC собран${made.error ? ': ' + made.error : ''}`);
    if (made.error) throw new Error(made.error);
    console.log(`  узлов ${made.nodes}, слоёв одежды ${made.layers}, тел ${made.solids} (${made.tris} треугольников), сегментов ${made.curves}, сущностей ${made.entities}`);
    check(made.solids > 0, `тела попали в файл (${made.solids})`);
    check(made.curves > 0, `сегменты трассы попали в файл (${made.curves})`);

    for (const cls of ['IFCPAVEMENT', 'IFCALIGNMENT', 'IFCROAD', 'IFCTRIANGULATEDFACESET']) {
        check(made.text.includes(cls), `в файле есть ${cls}`);
    }
    check(!made.text.includes('IFCBUILDINGELEMENTPROXY'), 'нет заглушек IfcBuildingElementProxy — классы настоящие');
    check((made.arcs2d || 0) >= 2, `кривые плана Оси C выгружены (${made.arcs2d})`);
    check((made.varcs || 0) >= 2, `вертикальные кривые Оси C выгружены (${made.varcs})`);
    check(/IFCALIGNMENTHORIZONTALSEGMENT/.test(made.text), 'есть IfcAlignmentHorizontalSegment');
    check(/CIRCULARARC/.test(made.text), 'в alignment есть дуги CIRCULARARC');

    /* Раскладка трассы Оси C: не «дуги есть в тексте», а геометрия сегментов.
     * Без изломов (R плана 30 и 25, Rв 900 и 700) проверки прошли бы вхолостую
     * на одних отрезках. */
    {
        const map = parseStep(made.text);
        const alignments = [...map.entries()].filter(([, e]) => e.type === 'IFCALIGNMENT');
        const axisC = alignments.find(([, e]) => /Ось C/.test(stepName(e.args)));
        check(!!axisC, 'в файле есть IfcAlignment «Ось C»');
        if (axisC) {
            const nested = nestsOf(map, axisC[0]).map((id) => [id, map.get(id)]);
            const horEnt = nested.find(([, e]) => e?.type === 'IFCALIGNMENTHORIZONTAL');
            const verEnt = nested.find(([, e]) => e?.type === 'IFCALIGNMENTVERTICAL');
            check(!!horEnt, 'Ось C: горизонталь вложена через IfcRelNests');
            check(!!verEnt, 'Ось C: профиль вложен через IfcRelNests');

            const horSegs = (horEnt ? nestsOf(map, horEnt[0]) : []).map((id) => {
                const h = map.get(map.get(id).args[map.get(id).args.length - 1]);
                const pt = xyOf(map, h.args[2]);
                return {
                    type: stepEnum(h.args[8]),
                    x: pt.x, y: pt.y,
                    dir: Number(h.args[3]),
                    r: Number(h.args[4]),
                    len: Number(h.args[6])
                };
            });
            const arcs = horSegs.filter((s) => s.type === 'CIRCULARARC');
            check(arcs.length >= 2, `Ось C: дуг плана ${arcs.length}`);
            if (arcs.length >= 2) {
                check(arcs[0].r > 0, `Ось C: первый поворот левый (R=${arcs[0].r.toFixed(3)} > 0)`);
                check(arcs[1].r < 0, `Ось C: второй поворот правый (R=${arcs[1].r.toFixed(3)} < 0)`);
            }

            let worstC0 = 0, worstC1 = 0;
            for (let i = 0; i < horSegs.length; i++) {
                const end = stepHor(horSegs[i]);
                if (i + 1 >= horSegs.length) {
                    const dx = end.x - 40, dy = end.y - (-100);
                    const dEnd = Math.hypot(dx, dy);
                    check(dEnd < 0.05,
                        `Ось C: конец трассы = последняя вершина (40, −100), ушло ${dEnd.toFixed(4)} м`);
                    break;
                }
                const nxt = horSegs[i + 1];
                const d0 = Math.hypot(end.x - nxt.x, end.y - nxt.y);
                const d1 = Math.abs(angDiff(end.dir, nxt.dir));
                worstC0 = Math.max(worstC0, d0);
                worstC1 = Math.max(worstC1, d1);
            }
            check(horSegs.length >= 2, `Ось C: сегментов горизонтали ${horSegs.length}`);
            check(worstC0 < 0.01, `Ось C: C0 горизонтали ≤ 0.01 м (худшее ${worstC0.toFixed(5)} м)`);
            check(worstC1 < 1e-3, `Ось C: C1 горизонтали ≤ 0.001 рад (худшее ${worstC1.toFixed(6)} рад)`);
            const dStart = horSegs.length
                ? Math.hypot(horSegs[0].x - (-200), horSegs[0].y - (-200)) : Infinity;
            check(dStart < 0.05, `Ось C: начало трассы = первая вершина (−200, −200)`);

            const verSegs = (verEnt ? nestsOf(map, verEnt[0]) : []).map((id) => {
                const v = map.get(map.get(id).args[map.get(id).args.length - 1]);
                const rRaw = v.args[7];
                return {
                    type: stepEnum(v.args[8]),
                    sta: Number(v.args[2]),
                    len: Number(v.args[3]),
                    z: Number(v.args[4]),
                    g0: Number(v.args[5]),
                    g1: Number(v.args[6]),
                    r: rRaw === '$' ? null : Number(rRaw)
                };
            });
            const varcs = verSegs.filter((s) => s.type === 'CIRCULARARC');
            check(varcs.length >= 2, `Ось C: вертикальных кривых ${varcs.length}`);
            for (const a of varcs) {
                const sg = Math.sign(a.g1 - a.g0) || 0;
                const sr = Math.sign(a.r) || 0;
                check(sr === sg,
                    `Ось C: sign(R)=sign(g1−g0) у вертикали (R=${a.r}, Δg=${(a.g1 - a.g0).toFixed(6)})`);
            }
            let vC0 = 0, vC1 = 0;
            for (let i = 0; i < verSegs.length; i++) {
                const end = stepVer(verSegs[i]);
                if (i + 1 >= verSegs.length) {
                    check(Math.abs(end.z - 14) < 0.05,
                        `Ось C: конец профиля = отметка последней вершины 14 м (стало ${end.z.toFixed(4)})`);
                    break;
                }
                const nxt = verSegs[i + 1];
                vC0 = Math.max(vC0, Math.hypot(end.sta - nxt.sta, end.z - nxt.z));
                vC1 = Math.max(vC1, Math.abs(end.g - nxt.g0));
            }
            check(verSegs.length >= 2, `Ось C: сегментов профиля ${verSegs.length}`);
            check(vC0 < 0.01, `Ось C: C0 вертикали ≤ 0.01 м (худшее ${vC0.toFixed(5)} м)`);
            check(vC1 < 1e-3, `Ось C: C1 вертикали ≤ 0.001 (худшее ${vC1.toExponential(2)})`);
        }
    }

    /* Тело дороги по оси и слои одежды из поперечника. Раньше в файл уходили
     * только откосы, узлы и сами оси — владелец получил выгрузку без самой
     * дороги. Меши коридора уже посчитаны, второй раз лофтить нельзя: файл
     * разошёлся бы с картинкой. */
    check(made.solids >= 6, `тела коридора попали в файл (всего тел ${made.solids}, было 3)`);
    check(/IFCPAVEMENT/.test(made.text), 'покрытие дороги ушло IfcPavement');

    /* Выемка — ОТДЕЛЬНОЕ тело и отдельный класс: в 4.3 это IfcEarthworksCut,
     * а не насыпь с другим именем. Раньше насыпь и выемка сваливались в один
     * TIN, и в файле их было не различить. */
    check(/IFCEARTHWORKSFILL/.test(made.text), 'насыпь ушла IfcEarthworksFill');
    check(/IFCEARTHWORKSCUT/.test(made.text), 'выемка ушла ОТДЕЛЬНЫМ телом IfcEarthworksCut');

    /* Объём — свойством элемента, иначе в Navisworks выемку от насыпи не
     * отличить числом. */
    const vols = (made.text.match(/IFCQUANTITYVOLUME\('NetVolume',\$,\$,([-\d.eE]+)/g) || []);
    check(vols.length >= 2, `объёмы записаны свойством (${vols.length} шт.)`);
    check(/IFCRELDEFINESBYPROPERTIES/.test(made.text), 'объём привязан к элементу');

    /* Обстройка УЗЛА: бордюр по скруглениям. Владелец заметил, что по осям он
     * есть, а по перекрёстку нет — сама обстройка строилась, но в структуру не
     * попадала. ⚠️ Имена в файле закодированы \X2\, искать по сырому тексту
     * бесполезно: раскодируем. */
    const plain = made.text.replace(/\\X2\\((?:[0-9A-F]{4})+)\\X0\\/g,
        (_, hex) => hex.match(/.{4}/g).map((h) => String.fromCharCode(parseInt(h, 16))).join(''));
    /* ⚠️ Имя узла — это «Ось B × Ось A», слова «Узел» в нём нет: искать по
     * нему бесполезно (уже потрачен заход). Признак узла — «×» в имени.
     * И код обстройки зависит от того, у КАКОЙ оси узел взял шаблон: если у
     * той, где бордюра нет, обстройка уходит обочиной. Поэтому проверяем сам
     * факт, что тела обстройки узла в файле есть. */
    const nodeOuter = plain.split('\n').filter((l) =>
        /^#\d+=IFC(KERB|COURSE|PAVEMENT)\(/.test(l) && /×/.test(l));
    console.log('  тела узла: ' + (nodeOuter
        .map((l) => (l.match(/,'([^']*)'/) || [])[1]).join(', ') || 'нет'));
    check(nodeOuter.length >= 4,
        `обстройка узла (бордюр/обочина по скруглениям) ушла в файл (${nodeOuter.length} тел)`);
    /* Бордюр задан ТОЛЬКО на оси A (`applyRoadXsPresetTo(a, 'curb')`), а узел
     * раньше брал один профиль на весь перекрёсток — от «более мощной» оси, и
     * бордюр до узла не доезжал вовсе (уходил обочиной). Теперь профиль
     * участковый: берётся у той ветви, где обстройка есть, и огибает
     * закругление до кромки соседней дороги.
     * ⚠️ Проверка не вхолостую: до правки здесь стояло «Обочина». */
    const nodeKerbs = nodeOuter.filter((l) => /Бордюр/.test(l));
    check(nodeKerbs.length >= 4,
        `бордюр с одной оси обошёл все закругления узла (${nodeKerbs.length} из ${nodeOuter.length})`);

    /* Цвет: без стиля читатель красит всё серым, и дорога в дереве
     * неотличима от откоса.
     * ⚠️ `IfcPresentationStyleAssignment` в IFC4X3 УДАЛЁН (в IFC4 лишь
     * устарел) — в 4.3 стиль обязан лежать в IfcStyledItem напрямую. */
    for (const [sch, r] of Object.entries({ IFC4X3_ADD2: made, ...legacy })) {
        if (!r?.text) continue;
        check(/IFCSTYLEDITEM/.test(r.text), `${sch}: у тел есть стиль (IfcStyledItem)`);
        check(/IFCCOLOURRGB/.test(r.text), `${sch}: цвет записан (IfcColourRgb)`);
        const wrapped = /IFCPRESENTATIONSTYLEASSIGNMENT/.test(r.text);
        check(sch === 'IFC4X3_ADD2' ? !wrapped : wrapped,
            `${sch}: обёртка стиля по схеме (${wrapped ? 'есть' : 'нет'})`);
    }
    /* Цвета РАЗНЫЕ: один стиль на всё прошёл бы проверку выше вхолостую. */
    const colours = new Set((made.text.match(/IFCCOLOURRGB\([^)]*\)/g) || []));
    check(colours.size >= 2, `цвета элементов различаются (${colours.size} разных)`);

    /* КОНВЕРТАЦИЯ СХЕМЫ. Требование владельца: класса нет в целевой схеме —
     * геометрия НЕ пропадает, элемент остаётся с универсальным классом, а
     * настоящее имя уходит в ObjectType.
     * ⚠️ Проверять это можно только на файле, где такие классы ЕСТЬ: наш 4.3
     * с дорожными. На обычном файле заменять было бы нечего, и проверка
     * прошла бы вхолостую. */
    const conv = await page.evaluate((src) => window.BimLvaDebug.ifcConvertText(src, 'IFC4'), made.text);
    const cntBefore = (made.text.match(/^#\d+=IFC/gmi) || []).length;
    const cntAfter = (conv.text.match(/^#\d+=IFC/gmi) || []).length;
    console.log(`  конвертация 4.3 → IFC4: заменено ${conv.changed} классов`
        + ` (${Object.keys(conv.byClass).join(', ') || '—'}), сущностей ${cntBefore} → ${cntAfter}`);
    check(/FILE_SCHEMA\(\('IFC4'\)\)/.test(conv.text), 'конвертация: схема в заголовке переписана');
    check(conv.changed > 0, `конвертация: дорожные классы заменены (${conv.changed})`);
    for (const cls of ['IFCPAVEMENT', 'IFCKERB', 'IFCEARTHWORKSFILL', 'IFCEARTHWORKSCUT']) {
        check(!conv.text.includes(cls + '('), `конвертация: в IFC4 нет ${cls}`);
    }
    check(cntAfter === cntBefore,
        `конвертация: ни одна сущность не потеряна (${cntAfter} из ${cntBefore})`);
    check(/IFCBUILDINGELEMENTPROXY/.test(conv.text), 'конвертация: тела под универсальным классом');
    check(/'IFCPAVEMENT'/.test(conv.text), 'конвертация: настоящее имя класса сохранено в ObjectType');

    /* Кириллица в STEP — только `\X2\<UTF-16 hex>\X0\`. Сырой UTF-8 читатель
     * разбирает как ANSI, и в дереве Navisworks вместо имён иероглифы (так и
     * было). Проверяем ОБА конца: сырых не-ASCII в файле нет вовсе, а обратный
     * разбор escape-последовательностей даёт настоящее русское слово — без
     * второй половины проверка прошла бы и на файле, где имена просто
     * выброшены. */
    for (const [sch, r] of Object.entries({ IFC4X3_ADD2: made, ...legacy })) {
        if (!r?.text) continue;
        const raw = [...r.text].filter((c) => c.codePointAt(0) > 127);
        check(raw.length === 0,
            `${sch}: сырой кириллицы в файле нет (${raw.length ? 'найдено ' + raw.length + ': ' + raw.slice(0, 8).join('') : 'чисто'})`);
        check(/\\X2\\[0-9A-F]+\\X0\\/.test(r.text), `${sch}: имена ушли escape-последовательностями \\X2\\`);
        check(unescapeStep(r.text).includes('Площадка'),
            `${sch}: обратный разбор \\X2\\ даёт «Площадка»`);
    }

    /* ⚠️ У точки площадки скобок ДВЕ (`IFCCARTESIANPOINT((55300.05,…))`), а не
     * три: с тремя проверка не сходится никогда и падает на верном файле.
     * А `bigVertex` — регулярное ВЫРАЖЕНИЕ, в нём `\\(` это литеральный
     * обратный слэш плюс группа: такая регулярка не совпадёт ни с чем, и
     * `check(!bigVertex, …)` проходит вхолостую при любом файле. */
    const siteHasShift = new RegExp(`IFCCARTESIANPOINT\\(\\(${Math.round(shift.x)}`).test(made.text.replace(/\s/g, ''));
    const bigVertex = /IFCCARTESIANPOINTLIST3D\(\(\(5\d{4}\./.test(made.text);
    check(siteHasShift, `сдвиг ${Math.round(shift.x)} м вынесен в размещение площадки`);
    check(!bigVertex, 'вершины тел в координатах сцены, а не в абсолютных');

    for (const sch of ['IFC4', 'IFC2X3']) {
        const f = path.join(ROOT, 'tools', 'fixtures', `_ifc-${sch}.ifc`);
        await fs.writeFile(f, legacy[sch].text);
        await page.evaluate(() => window.BimLvaDebug.clearPolylines());
        await page.setInputFiles('#localFileInput', f);
        const ok = await page.waitForFunction(
            (n) => (window.BimLvaDebug?.modelBounds || []).find((m) => m.file.includes(n)) || null,
            `_ifc-${sch}`, { timeout: 120_000 }
        ).then((h) => h.jsonValue()).catch(() => null);
        check(!!ok && (ok.sizeX || 0) > 1, `${sch}: файл читается обратно и геометрия строится`
            + (ok ? ` (${(ok.sizeX || 0).toFixed(1)}×${(ok.sizeY || 0).toFixed(1)})` : ''));
        await fs.rm(f, { force: true });
    }

    await fs.writeFile(outFile, made.text);
    await page.evaluate(() => window.BimLvaDebug.clearPolylines());
    await page.setInputFiles('#localFileInput', outFile);
    const loaded = await page.waitForFunction(
        () => (window.BimLvaDebug?.modelBounds || []).find((m) => /_ifc-export/i.test(m.file)) || null,
        null, { timeout: 120_000 }
    ).then((h) => h.jsonValue()).catch(() => null);

    check(!!loaded, 'вьювер открыл собственный IFC');
    if (loaded) {
        console.log(`  прочитано: габарит ${loaded.sizeX?.toFixed(1)}×${loaded.sizeY?.toFixed(1)}×${loaded.sizeZ?.toFixed(1)} м`);
        check((loaded.sizeX || 0) > 1 && (loaded.sizeY || 0) > 1,
            `геометрия построилась, а не схлопнулась (${(loaded.sizeX || 0).toFixed(1)}×${(loaded.sizeY || 0).toFixed(1)})`);
        check((loaded.sizeZ || 0) > 0.05,
            `тело объёмное, а не плоский лист (высота ${(loaded.sizeZ || 0).toFixed(2)} м)`);
    }
} catch (e) {
    problems.push('исключение: ' + (e?.message || e));
} finally {
    await browser.close();
    server.close();
    await fs.rm(outFile, { force: true });
    await fs.rm(geoFile, { force: true });
}
console.log('');
if (problems.length) { console.error(`Проблемы (${problems.length}):`); problems.forEach((p) => console.error('  · ' + p)); process.exit(1); }
console.log('OK — IFC 4.3 собирается дорожными классами и читается обратно.');
