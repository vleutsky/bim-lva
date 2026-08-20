/**
 * IFC-фикстура с настоящей геодезической привязкой: SITE стоит в мировых
 * координатах (как в дорожных выгрузках Civil 3D), а не в нуле.
 * Нужна, чтобы воспроизвести «несколько файлов схлопнулись в кучу».
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
 * @param {number} o.worldX,worldY,worldZ — мировые координаты площадки (метры)
 * @param {string} o.schema — FILE_SCHEMA
 * @param {number} o.count — сколько коробок
 * @param {number} o.seed — чтобы GlobalId файлов не совпадали
 * @param {number} o.tilt — уклон площадки по X (м высоты на метр). Нужен там,
 *   где важен ПЕРЕХОД насыпь↔выемка: на плоской площадке ось либо везде выше
 *   земли, либо везде ниже, и стык двух режимов не воспроизводится вовсе.
 * @param {number} o.boxSize — сторона коробки в плане, м (по умолчанию 3).
 *        ⚠️ IFCRECTANGLEPROFILEDEF задаёт ПОЛНЫЕ размеры, а не полуразмеры:
 *        при `step > boxSize` между коробками остаются дыры, и луч выборки
 *        рельефа в них проваливается. Нужен сплошной слой земли — ставьте
 *        `step === boxSize` (и лучше крупные коробки: слой 210 м это 49 штук
 *        при boxSize 30 против 4900 при 3).
 * @param {number} o.lengthToMetres — 1 (метры) или 0.001 (миллиметры, как у
 *        выгрузок Renga/nanoCAD через ODA): величины в файле пишутся в его
 *        единицах, а IFCSIUNIT получает приставку .MILLI.
 */
export function makeGeoIfc({ worldX = 0, worldY = 0, worldZ = 0, schema = 'IFC4', count = 400, cols = 20, step = 6, boxSize = 3, seed = 0, name = 'geo.ifc', lengthToMetres = 1, application = 'test', booleanOps = 0, tilt = 0 } = {}) {
    // Коэффициент «метр → единица файла»
    const k = 1 / lengthToMetres;
    const isMm = Math.abs(lengthToMetres - 0.001) < 1e-12;
    const u = (metres, digits = 3) => (metres * k).toFixed(digits);
    const head = [
        'ISO-10303-21;',
        'HEADER;',
        "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
        `FILE_NAME('${name}','2026-01-01T00:00:00',('BIM.LVA'),('BIM.LVA'),'geo-fixture','${application}','');`,
        `FILE_SCHEMA(('${schema}'));`,
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
        "#9=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#4,$);",
        `#10=IFCPROJECT('${guid(seed + 1)}',$,'GeoTest',$,$,$,$,(#9),#8);`,
        // ВОТ ОНО: площадка стоит в мировых координатах
        `#20=IFCCARTESIANPOINT((${u(worldX)},${u(worldY)},${u(worldZ)}));`,
        '#21=IFCAXIS2PLACEMENT3D(#20,#2,#3);',
        '#11=IFCLOCALPLACEMENT($,#21);',
        `#12=IFCSITE('${guid(seed + 2)}',$,'Site',$,$,#11,$,$,.ELEMENT.,$,$,$,$,$);`,
        '#13=IFCLOCALPLACEMENT(#11,#4);',
        `#14=IFCBUILDING('${guid(seed + 3)}',$,'Building',$,$,#13,$,$,.ELEMENT.,$,$,$);`,
        '#15=IFCLOCALPLACEMENT(#13,#4);',
        `#16=IFCBUILDINGSTOREY('${guid(seed + 4)}',$,'Level 0',$,$,#15,$,$,.ELEMENT.,0.);`,
        '#17=IFCCARTESIANPOINT((0.,0.));',
        '#18=IFCAXIS2PLACEMENT2D(#17,$);',
        `#19=IFCRECTANGLEPROFILEDEF(.AREA.,'BoxProfile',#18,${u(boxSize)},${u(boxSize)});`
    ];

    const body = [];
    const walls = [];
    let id = 100;
    for (let i = 0; i < count; i++) {
        const x = (i % cols) * step * k;
        const y = Math.floor(i / cols) * step * k;
        const pt = id++, axis = id++, placement = id++, solid = id++, shape = id++, product = id++, wall = id++;
        body.push(
            `#${pt}=IFCCARTESIANPOINT((${x.toFixed(1)},${y.toFixed(1)},0.));`,
            `#${axis}=IFCAXIS2PLACEMENT3D(#${pt},#2,#3);`,
            `#${placement}=IFCLOCALPLACEMENT(#15,#${axis});`,
            `#${solid}=IFCEXTRUDEDAREASOLID(#19,#4,#2,${u(Math.max(0.5, 3 + tilt * x / k))});`,
            `#${shape}=IFCSHAPEREPRESENTATION(#9,'Body','SweptSolid',(#${solid}));`,
            `#${product}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${shape}));`,
            `#${wall}=IFCWALL('${guid(seed + 10 + i)}',$,'Wall ${i + 1}',$,$,#${placement},#${product},$,$);`
        );
        walls.push(`#${wall}`);
    }

    // Пустышки-вырезы: вьювер считает их (sampleIfcBooleanOps) и по количеству
    // решает, открывать ли файл со сбросом координат. Геометрию не трогают —
    // нужен именно СЧЁТ, как у настоящей выгрузки Tekla с вырезами.
    for (let i = 0; i < booleanOps; i++) {
        body.push(`#${id++}=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#19,#19);`);
    }

    const rels = [
        `#${id++}=IFCRELAGGREGATES('${guid(seed + 5)}',$,$,$,#10,(#12));`,
        `#${id++}=IFCRELAGGREGATES('${guid(seed + 6)}',$,$,$,#12,(#14));`,
        `#${id++}=IFCRELAGGREGATES('${guid(seed + 7)}',$,$,$,#14,(#16));`,
        `#${id++}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(seed + 8)}',$,$,$,(${walls.join(',')}),#16);`
    ];

    return [...head, ...body, ...rels, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
}
