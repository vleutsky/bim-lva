/**
 * Генератор IFC-сетки из N коробок для дымового теста.
 *
 * Одна коробка (12 треугольников) для теста бесполезна: вьювер батчит модели
 * от 2000 фрагментов, а BVH строит от 4000 треугольников — на маленьком файле
 * оба пути остались бы непроверенными. Здесь модель заведомо больше обоих
 * порогов, и клик идёт через смёрженный батч с деревом.
 */

const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

/** Детерминированный GlobalId: тест должен давать одинаковый файл при каждом прогоне. */
function guid(seed) {
    let out = '';
    let x = seed * 2654435761 % 2 ** 32;
    for (let i = 0; i < 22; i++) {
        x = (x * 1103515245 + 12345) % 2 ** 31;
        out += B64[x % 64];
    }
    return out;
}

export function makeGridIfc(count = 400, cols = 20, step = 6) {
    const head = [
        'ISO-10303-21;',
        'HEADER;',
        "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
        `FILE_NAME('smoke-grid.ifc','2026-01-01T00:00:00',('BIM.LVA'),('BIM.LVA'),'tools/fixtures/make-grid-ifc.mjs','smoke','');`,
        "FILE_SCHEMA(('IFC4'));",
        'ENDSEC;',
        'DATA;',
        '#1=IFCCARTESIANPOINT((0.,0.,0.));',
        '#2=IFCDIRECTION((0.,0.,1.));',
        '#3=IFCDIRECTION((1.,0.,0.));',
        '#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);',
        '#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
        '#6=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);',
        '#7=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);',
        '#8=IFCUNITASSIGNMENT((#5,#6,#7));',
        "#9=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#4,$);",
        `#10=IFCPROJECT('${guid(1)}',$,'SmokeGrid',$,$,$,$,(#9),#8);`,
        '#11=IFCLOCALPLACEMENT($,#4);',
        `#12=IFCSITE('${guid(2)}',$,'Site',$,$,#11,$,$,.ELEMENT.,$,$,$,$,$);`,
        '#13=IFCLOCALPLACEMENT(#11,#4);',
        `#14=IFCBUILDING('${guid(3)}',$,'Building',$,$,#13,$,$,.ELEMENT.,$,$,$);`,
        '#15=IFCLOCALPLACEMENT(#13,#4);',
        `#16=IFCBUILDINGSTOREY('${guid(4)}',$,'Level 0',$,$,#15,$,$,.ELEMENT.,0.);`,
        '#17=IFCCARTESIANPOINT((0.,0.));',
        '#18=IFCAXIS2PLACEMENT2D(#17,$);',
        "#19=IFCRECTANGLEPROFILEDEF(.AREA.,'BoxProfile',#18,3.,3.);"
    ];

    const body = [];
    const walls = [];
    let id = 100;
    for (let i = 0; i < count; i++) {
        const x = (i % cols) * step;
        const y = Math.floor(i / cols) * step;
        const pt = id++;
        const axis = id++;
        const placement = id++;
        const solid = id++;
        const shape = id++;
        const product = id++;
        const wall = id++;
        body.push(
            `#${pt}=IFCCARTESIANPOINT((${x.toFixed(1)},${y.toFixed(1)},0.));`,
            `#${axis}=IFCAXIS2PLACEMENT3D(#${pt},#2,#3);`,
            `#${placement}=IFCLOCALPLACEMENT(#15,#${axis});`,
            `#${solid}=IFCEXTRUDEDAREASOLID(#19,#4,#2,3.);`,
            `#${shape}=IFCSHAPEREPRESENTATION(#9,'Body','SweptSolid',(#${solid}));`,
            `#${product}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${shape}));`,
            `#${wall}=IFCWALL('${guid(10 + i)}',$,'Wall ${i + 1}',$,$,#${placement},#${product},$,$);`
        );
        walls.push(`#${wall}`);
    }

    const rels = [
        `#${id++}=IFCRELAGGREGATES('${guid(5)}',$,$,$,#10,(#12));`,
        `#${id++}=IFCRELAGGREGATES('${guid(6)}',$,$,$,#12,(#14));`,
        `#${id++}=IFCRELAGGREGATES('${guid(7)}',$,$,$,#14,(#16));`,
        `#${id++}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid(8)}',$,$,$,(${walls.join(',')}),#16);`
    ];

    return [...head, ...body, ...rels, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
}
