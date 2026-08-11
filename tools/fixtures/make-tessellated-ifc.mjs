/**
 * IFC4 с тесселированной геометрией и ПОВЁРНУТОЙ вставкой — как выгрузка через
 * ODA (Renga/nanoCAD), с которой пришла жалоба «здание село не туда».
 *
 * Отличий от `make-geo-ifc.mjs` два, и оба принципиальны:
 *   1. геометрия — `IfcPolygonalFaceSet` + `IfcCartesianPointList3D`: вершины
 *      ЛОКАЛЬНЫЕ, мировое положение живёт во вставке;
 *   2. вставка повёрнута вокруг Z, а не только сдвинута.
 */
const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

function guid(seed) {
    let out = '';
    let x = seed * 2654435761 % 2 ** 32;
    for (let i = 0; i < 22; i++) {
        x = (x * 1103515245 + 12345) % 2 ** 31;
        out += B64[x % 64];
    }
    return out;
}

/**
 * @param {object} o
 * @param {number} o.worldX,worldY,worldZ — начало вставки (мировые метры)
 * @param {number} o.rotationDeg — поворот вставки вокруг Z, градусы
 * @param {number} o.boxes — сколько коробок в ряд
 * @param {number} o.step — шаг коробок в ЛОКАЛЬНЫХ координатах
 * @param {number} o.size — сторона коробки
 * @param {number} o.lengthToMetres — 1 (метры) или 0.001 (миллиметры)
 * @param {boolean} o.worldInContext — куда положить мировое преобразование:
 *        false — во вставку площадки (обычный путь),
 *        true  — в `WorldCoordinateSystem` контекста представления. Так делает
 *        экспортёр ODA: geometry остаётся локальной, а Navisworks показывает
 *        это как «преобразование сцены». web-ifc такой контекст игнорирует.
 */
export function makeTessellatedIfc({
    worldX = 0, worldY = 0, worldZ = 0, rotationDeg = 0,
    boxes = 4, step = 10, size = 4, seed = 1, name = 'tess.ifc', lengthToMetres = 1,
    worldInContext = false
} = {}) {
    const a = rotationDeg * Math.PI / 180;
    const refDir = [Math.cos(a), Math.sin(a), 0];
    const k = 1 / lengthToMetres;                 // метр → единица файла
    const isMm = Math.abs(lengthToMetres - 0.001) < 1e-12;
    const f = (v) => v.toFixed(6);
    const u = (metres) => (metres * k).toFixed(6);  // длины в единицах файла

    const head = [
        'ISO-10303-21;',
        'HEADER;',
        "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
        `FILE_NAME('${name}','2026-01-01T00:00:00',(''),(''),'ODA IFC SDK','tess-fixture','');`,
        "FILE_SCHEMA(('IFC4'));",
        'ENDSEC;',
        'DATA;',
        '#1=IFCCARTESIANPOINT((0.,0.,0.));',
        '#2=IFCDIRECTION((0.,0.,1.));',
        '#3=IFCDIRECTION((1.,0.,0.));',
        '#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);',
        `#5=IFCSIUNIT(*,.LENGTHUNIT.,${isMm ? '.MILLI.' : '$'},.METRE.);`,
        '#6=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);',
        '#7=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);',
        '#8=IFCUNITASSIGNMENT((#5,#6,#7));',
        `#9=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${worldInContext ? '#22' : '#4'},$);`,
        `#10=IFCPROJECT('${guid(seed + 1)}',$,'TessTest',$,$,$,$,(#9),#8);`,
        // Вставка площадки: сдвиг + поворот вокруг Z
        `#20=IFCCARTESIANPOINT((${u(worldX)},${u(worldY)},${u(worldZ)}));`,
        `#21=IFCDIRECTION((${f(refDir[0])},${f(refDir[1])},0.));`,
        '#22=IFCAXIS2PLACEMENT3D(#20,#2,#21);',
        `#11=IFCLOCALPLACEMENT($,${worldInContext ? '#4' : '#22'});`,
        `#12=IFCSITE('${guid(seed + 2)}',$,'Site',$,$,#11,$,$,.ELEMENT.,$,$,$,$,$);`,
        '#13=IFCLOCALPLACEMENT(#11,#4);',
        `#14=IFCBUILDING('${guid(seed + 3)}',$,'Building',$,$,#13,$,$,.ELEMENT.,$,$,$);`,
        '#15=IFCLOCALPLACEMENT(#13,#4);',
        `#16=IFCBUILDINGSTOREY('${guid(seed + 4)}',$,'Level 0',$,$,#15,$,$,.ELEMENT.,0.);`
    ];

    const body = [];
    const products = [];
    let id = 100;
    for (let i = 0; i < boxes; i++) {
        const ox = i * step * k;
        const sz = size * k;
        const v = [
            [ox, 0, 0], [ox + sz, 0, 0], [ox + sz, sz, 0], [ox, sz, 0],
            [ox, 0, sz], [ox + sz, 0, sz], [ox + sz, sz, sz], [ox, sz, sz]
        ];
        const list = id++;
        const faceIds = [];
        body.push(`#${list}=IFCCARTESIANPOINTLIST3D((${v.map(p => `(${f(p[0])},${f(p[1])},${f(p[2])})`).join(',')}));`);
        // Индексы в IFC — с единицы
        const faces = [
            [1, 2, 3, 4], [5, 8, 7, 6], [1, 5, 6, 2],
            [2, 6, 7, 3], [3, 7, 8, 4], [4, 8, 5, 1]
        ];
        faces.forEach(face => {
            const fid = id++;
            faceIds.push(`#${fid}`);
            body.push(`#${fid}=IFCINDEXEDPOLYGONALFACE((${face.join(',')}));`);
        });
        const faceSet = id++;
        const shape = id++;
        const prodShape = id++;
        const placement = id++;
        const proxy = id++;
        body.push(
            `#${faceSet}=IFCPOLYGONALFACESET(#${list},$,(${faceIds.join(',')}),$);`,
            `#${shape}=IFCSHAPEREPRESENTATION(#9,'Body','Tessellation',(#${faceSet}));`,
            `#${prodShape}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${shape}));`,
            `#${placement}=IFCLOCALPLACEMENT(#15,#4);`,
            `#${proxy}=IFCBUILDINGELEMENTPROXY('${guid(seed + 20 + i)}',$,'Box ${i + 1}',$,$,#${placement},#${prodShape},$,$);`
        );
        products.push(`#${proxy}`);
    }

    const rels = [
        `#${id++}=IFCRELAGGREGATES('${guid(seed + 5)}',$,$,$,#10,(#12));`,
        `#${id++}=IFCRELAGGREGATES('${guid(seed + 6)}',$,$,$,#12,(#14));`,
        `#${id++}=IFCRELAGGREGATES('${guid(seed + 7)}',$,$,$,#14,(#16));`,
        `#${id++}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(seed + 8)}',$,$,$,(${products.join(',')}),#16);`
    ];

    return [...head, ...body, ...rels, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
}

/** Ожидаемый центр набора коробок в мировых координатах. */
export function tessellatedCentre({
    worldX = 0, worldY = 0, worldZ = 0, rotationDeg = 0, boxes = 4, step = 10, size = 4
} = {}) {
    const a = rotationDeg * Math.PI / 180;
    const lx = ((boxes - 1) * step + size) / 2;
    const ly = size / 2;
    return {
        e: worldX + lx * Math.cos(a) - ly * Math.sin(a),
        n: worldY + lx * Math.sin(a) + ly * Math.cos(a),
        h: worldZ + size / 2
    };
}
