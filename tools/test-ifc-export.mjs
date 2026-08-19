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
    count: 24, cols: 6, step: 6, seed: 77, name: '_ifc-exp-geo.ifc'
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
        /* Одежда обязательна: без неё покрытие узла — плоский лист, габарит
         * по Z нулевой, и «тело выгрузилось» было бы правдой при нулевой
         * толщине. Со слоями тело настоящее. */
        D.buildRoadXs(a, { step: 10, widthL: 5, widthR: 5, live: true });
        D.buildRoadXs(b, { step: 10, widthL: 5, widthR: 5, live: true });
        D.applyRoadXsPresetTo(a, 'curb');
        D.addRoadXsLayer(0.35);
        D.editIntersection(D.intersections[0].id, { radii: {} });
        D.applyRoadXsPresetTo(a, 'curb');
        D.addRoadXsLayer(0.35);
        try { return { nodes: D.intersections.length, layers: D.nodeLayers(D.intersections[0].id).length, ...D.ifcExport() }; }
        catch (e) { return { error: String(e?.message || e) }; }
    });

    check(!made.error, `IFC собран${made.error ? ': ' + made.error : ''}`);
    if (made.error) throw new Error(made.error);
    console.log(`  узлов ${made.nodes}, слоёв одежды ${made.layers}, тел ${made.solids} (${made.tris} треугольников), сегментов ${made.curves}, сущностей ${made.entities}`);
    check(made.solids > 0, `тела попали в файл (${made.solids})`);
    check(made.curves > 0, `сегменты трассы попали в файл (${made.curves})`);

    // Правильные классы — смотрим прямо в тексте.
    for (const cls of ['IFCPAVEMENT', 'IFCALIGNMENT', 'IFCROAD', 'IFCTRIANGULATEDFACESET']) {
        check(made.text.includes(cls), `в файле есть ${cls}`);
    }
    check(!made.text.includes('IFCBUILDINGELEMENTPROXY'), 'нет заглушек IfcBuildingElementProxy — классы настоящие');

    /* Мировой сдвиг обязан лежать в размещении IfcSite, а не в каждой
     * вершине: иначе файл раздут и точность float съедена. */
    const siteHasShift = new RegExp(`IFCCARTESIANPOINT\\(\\(${Math.round(shift.x)}`).test(made.text.replace(/\s/g, ''));
    const bigVertex = /IFCCARTESIANPOINTLIST3D\(\(\(5\d{4}\./.test(made.text);
    check(siteHasShift, `сдвиг ${Math.round(shift.x)} м вынесен в размещение площадки`);
    check(!bigVertex, 'вершины тел в координатах сцены, а не в абсолютных');

    // Круговая проверка: открываем свой файл тем же движком, что и чужие.
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
        // Толщина: тело, а не лист. Слои одежды дают высоту по Z.
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
