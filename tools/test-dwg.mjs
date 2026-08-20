/**
 * Выгрузка в DWG: пишем из браузера и читаем обратно НЕЗАВИСИМЫМ движком.
 *
 * Проверять сам факт «файл скачался» бессмысленно — DWG закрытый, и
 * ошибку видно только при чтении. Читаем dwgdxf (acadrust), которым и так
 * открываем чужие DWG, и сверяем координаты с тем, что чертили.
 *
 * Запуск: npm run test-dwg
 */
import { chromium } from 'playwright';
import { convertDwgToDxf } from 'dwgdxf';
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

// Чертим числами: координаты известны заранее, их и ищем в файле.
const PTS = [{ x: 10, y: 20, z: 5 }, { x: 110, y: 20, z: 5 }, { x: 110, y: 70, z: 5 }];

const { server, port } = await startStaticServer(ROOT);
const browser = await chromium.launch({ executablePath: await chrome() });
const page = await browser.newPage();
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
try {
    await page.goto(`http://127.0.0.1:${port}/bim-lva-composer-ifc.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.BimLvaDebug, null, { timeout: 60_000 });

    const out = await page.evaluate(async (pts) => {
        const D = window.BimLvaDebug;
        D.clearPolylines();
        D.createPolylineFromPoints(pts, { name: 'Проверка DWG' });
        try { return await D.dwgBytes(); } catch (e) { return { error: String(e?.message || e) }; }
    }, PTS);

    check(!out.error, `DWG собран${out.error ? ': ' + out.error : ''}`);
    if (out.error) throw new Error(out.error);

    const bytes = new Uint8Array(out.bytes);
    const sig = new TextDecoder('latin1').decode(bytes.slice(0, 6));
    console.log(`  файл: ${bytes.length} байт, сигнатура «${sig}», полилиний ${out.lines}, точек ${out.points}`);
    check(/^AC10\d\d$/.test(sig), `сигнатура DWG на месте (${sig})`);
    check(bytes.length > 1000, `файл не пустой (${bytes.length} б)`);

    // Читаем обратно ЧУЖИМ движком — единственная честная проверка.
    const dxf = new TextDecoder().decode(await convertDwgToDxf(bytes));
    const ent = dxf.indexOf('ENTITIES');
    const body = ent >= 0 ? dxf.slice(ent, dxf.indexOf('ENDSEC', ent)) : '';
    check(ent >= 0, 'независимый движок прочитал файл (секция ENTITIES есть)');
    const nLine = (body.match(/\r?\nLINE\r?\n/g) || []).length;
    console.log(`  прочитано: LINE ${nLine} (ждали ${PTS.length - 1} — полилиния пишется отрезками)`);
    check(nLine === PTS.length - 1, `звенья полилинии дошли до файла (${nLine})`);

    // Координаты: сверяем с тем, что чертили.
    const nums = [...body.matchAll(/\r?\n\s*(10|20|30)\r?\n\s*(-?[\d.]+)/g)].map((m) => [m[1], Number(m[2])]);
    const xs = nums.filter((n) => n[0] === '10').map((n) => n[1]);
    const ys = nums.filter((n) => n[0] === '20').map((n) => n[1]);
    const zs = nums.filter((n) => n[0] === '30').map((n) => n[1]);
    console.log(`  X: ${xs.join(', ')} · Y: ${ys.join(', ')} · Z: ${zs.join(', ')}`);
    const all = [...xs.map((x, i) => [x, ys[i], zs[i]]),
        ...[...body.matchAll(/\r?\n\s*(11|21|31)\r?\n\s*(-?[\d.]+)/g)]
            .reduce((acc, m, i, arr) => { if (m[1] === '11') acc.push([Number(m[2]), Number(arr[i + 1]?.[2]), Number(arr[i + 2]?.[2])]); return acc; }, [])];
    for (const p of PTS) {
        const hit = all.some((q) => Math.abs(q[0] - p.x) < 1e-6 && Math.abs(q[1] - p.y) < 1e-6 && Math.abs(q[2] - p.z) < 1e-6);
        check(hit, `вершина (${p.x}, ${p.y}, ${p.z}) найдена в прочитанном файле`);
    }
    check(zs.some((z) => Math.abs(z - PTS[0].z) < 1e-6), `отметка ${PTS[0].z} сохранилась (3D-полилиния, а не плоская)`);

    /* Тела: 3DSOLID этой библиотекой не выгрузить — её писатель модельной
     * геометрии выводит флаги и каркас, а саму ACIS-геометрию не пишет
     * вовсе, тело вышло бы пустым. Пишем сеткой 3DFACE и проверяем, что
     * грани реально доехали до файла. */
    const withBody = await page.evaluate(async () => {
        const D = window.BimLvaDebug;
        // Узел даёт покрытие — это и есть тело, которое надо выгрузить.
        D.clearPolylines();
        D.setAutoNodes(true);
        const a = D.createPolylineFromPoints(
            [{ x: -60, y: 0, z: 5 }, { x: 60, y: 0, z: 5 }], { name: 'A', role: 'road-axis' });
        D.setRoadWidths(a, 5, 5);
        D.createPolylineFromPoints(
            [{ x: 0, y: -60, z: 5 }, { x: 0, y: 60, z: 5 }], { name: 'B', role: 'road-axis' });
        return { nodes: D.intersections.length, ...(await D.dwgBytes()) };
    });
    check(withBody.nodes === 1, `узел для проверки тел построен (${withBody.nodes})`);
    console.log(`  во второй выгрузке: отрезков ${withBody.lines}, тел ${withBody.solids}, граней ${withBody.faces}`);
    check((withBody.solids || 0) > 0, `тела ушли 3DSOLID, а не сеткой (${withBody.solids || 0})`);
    if ((withBody.solids || 0) + (withBody.faces || 0) > 0) {
        const dxf2 = new TextDecoder().decode(await convertDwgToDxf(new Uint8Array(withBody.bytes)));
        const e2 = dxf2.indexOf('ENTITIES');
        const b2 = e2 >= 0 ? dxf2.slice(e2, dxf2.indexOf('ENDSEC', e2)) : '';
        const n3d = (b2.match(/\r?\n3DFACE\r?\n/g) || []).length;
        const nSol = (b2.match(/\r?\n3DSOLID\r?\n/g) || []).length;
        console.log(`  прочитано: 3DSOLID ${nSol}, 3DFACE ${n3d}`);
        check(nSol === (withBody.solids || 0), `тела дошли до файла (${nSol} из ${withBody.solids || 0})`);
        check(n3d === (withBody.faces || 0), `грани дошли до файла (${n3d} из ${withBody.faces || 0})`);
        /* ⚠️ «3DSOLID есть» ещё не значит «тело не пустое»: именно так вело
         * себя НЕПРОПАТЧЕННОЕ acad-ts — сущность на месте, ACIS внутри нет,
         * и в CAD это пустышка. Поэтому лезем в сами байты.
         * Читаем НЕ через dwgdxf: он ACIS в свой DXF не выкладывает, и по нему
         * пустое тело от полного не отличить (проверка так и провалилась на
         * заведомо верном файле). Читаем родным DwgReader — он разбирает
         * ровно ту раскладку, которую пишет патч, и отдаёт `binaryData`. */
        const acad = await import(path.join(ROOT, 'assets', 'vendor', 'acad-ts', 'index.js'));
        const raw = new Uint8Array(withBody.bytes);
        const backDoc = new acad.DwgReader(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length)).read();
        const solids3d = [...(backDoc.modelSpace?.entities ?? [])].filter((e) => e instanceof acad.Solid3D);
        const acisBytes = solids3d.reduce((n, e) => n + (e.binaryData?.length || 0), 0);
        const acisText = solids3d.map((e) => new TextDecoder().decode(e.binaryData || new Uint8Array(0))).join('');
        console.log(`  ACIS в теле: ${acisBytes} байт, записей SAT ${(acisText.match(/#/g) || []).length}`);
        check(acisBytes > 0, `у 3DSOLID есть сама ACIS-геометрия (${acisBytes} байт), а не пустая оболочка`);
        check(/End-of-ACIS-data/.test(acisText), 'SAT дошёл целиком (есть хвост End-of-ACIS-data)');
        check(/^700 0/.test(acisText), 'SAT начинается заголовком версии 700');
    } else {
        check(false, 'в выгрузку не попало ни одного тела — тела в DWG не поехали');
    }
} catch (e) {
    problems.push('исключение: ' + (e?.message || e));
} finally {
    await browser.close();
    server.close();
}
console.log('');
if (problems.length) { console.error(`Проблемы (${problems.length}):`); problems.forEach((p) => console.error('  · ' + p)); process.exit(1); }
console.log('OK — DWG пишется и читается независимым движком, координаты совпадают.');
