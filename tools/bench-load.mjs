/**
 * Где уходит время при открытии IFC: разбор STEP или тесселяция?
 *
 * От ответа зависело, что вообще имеет смысл кэшировать. Меряем без браузера,
 * прямо на web-ifc — тот же WASM, что и во вьювере, только без шума от three.js
 * и DOM.
 *
 * Запуск: npm run bench-load [число коробок]
 */
import * as WebIFC from 'web-ifc';
import { makeGridIfc } from './fixtures/make-grid-ifc.mjs';

const COUNT = Number(process.argv[2] || 20000);
const bytes = new TextEncoder().encode(makeGridIfc(COUNT, 200, 6));
console.log(`фикстура: ${(bytes.length / 1048576).toFixed(1)} МБ, коробок ${COUNT.toLocaleString('ru-RU')}`);

const api = new WebIFC.IfcAPI();
await api.Init();

const t1 = performance.now();
const id = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false, USE_FAST_BOOLS: true });
const tOpen = performance.now() - t1;

const t2 = performance.now();
let frags = 0, floats = 0, idx = 0;
api.StreamAllMeshes(id, (flat) => {
    const g = flat.geometries;
    for (let i = 0; i < g.size(); i++) {
        const pg = g.get(i);
        const geom = api.GetGeometry(id, pg.geometryExpressID);
        floats += geom.GetVertexDataSize();
        idx += geom.GetIndexDataSize();
        frags++;
    }
});
const tStream = performance.now() - t2;

const t3 = performance.now();
let rels = 0;
for (const type of [WebIFC.IFCRELAGGREGATES, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE]) {
    const r = api.GetLineIDsWithType(id, type);
    for (let i = 0; i < r.size(); i++) { api.GetLine(id, r.get(i)); rels++; }
}
const tTree = performance.now() - t3;
const total = tOpen + tStream + tTree;

console.log(`OpenModel       ${tOpen.toFixed(0).padStart(6)} мс — разбор STEP`);
console.log(`StreamAllMeshes ${tStream.toFixed(0).padStart(6)} мс — тесселяция (${frags.toLocaleString('ru-RU')} фрагментов)`);
console.log(`связи дерева    ${tTree.toFixed(0).padStart(6)} мс — ${rels} отношений`);
console.log(`доля тесселяции ${(100 * tStream / total).toFixed(0)} % — столько и экономит кэш геометрии`);
// Столько же примерно займёт запись в кэш: вершины float32 + нормали + индексы.
const cacheMb = (floats * 4 + idx * 4) / 1048576;
console.log(`геометрия на диск ≈ ${cacheMb.toFixed(0)} МБ (${(cacheMb / (bytes.length / 1048576)).toFixed(1)}× от IFC)`);
