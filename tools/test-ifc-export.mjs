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

    /* Кириллица в STEP — только `\X2\<UTF-16 hex>\X0\`. Сырой UTF-8 читатель
     * разбирает как ANSI, и в дереве Navisworks вместо имён иероглифы (так и
     * было). Проверяем ОБА конца: сырых не-ASCII в файле нет вовсе, а обратный
     * разбор escape-последовательностей даёт настоящее русское слово — без
     * второй половины проверка прошла бы и на файле, где имена просто
     * выброшены. */
    const unescapeStep = (s) => s.replace(/\\X2\\((?:[0-9A-F]{4})+)\\X0\\/g,
        (_, hex) => hex.match(/.{4}/g).map((h) => String.fromCharCode(parseInt(h, 16))).join(''));
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
