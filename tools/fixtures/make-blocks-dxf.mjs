/**
 * DXF с блоками и заранее известными габаритами — проверка раскрытия INSERT.
 *
 * Настоящий DWG в репозиторий не кладём: чужой файл неясного происхождения.
 * А математику переноса блоков — смещение, масштаб, поворот, вложенность —
 * проверить надо, и здесь она проверяется на числах, которые считаются руками.
 */

/** Квадрат 10×10 в начале координат — содержимое базового блока. */
const SQUARE = [[0, 0], [10, 0], [10, 10], [0, 10]];

function lwpolyline(points, layer = 'SRC') {
    const head = ['0', 'LWPOLYLINE', '8', layer, '90', String(points.length), '70', '1'];
    const body = points.flatMap(([x, y]) => ['10', x.toFixed(6), '20', y.toFixed(6)]);
    return [...head, ...body];
}

function insert(name, [x, y, z], { scale = [1, 1, 1], rotation = 0, layer = 'REF' } = {}) {
    return [
        '0', 'INSERT', '8', layer, '2', name,
        '10', x.toFixed(6), '20', y.toFixed(6), '30', z.toFixed(6),
        '41', String(scale[0]), '42', String(scale[1]), '43', String(scale[2]),
        '50', String(rotation)
    ];
}

function block(name, base, body) {
    return [
        '0', 'BLOCK', '2', name,
        '10', String(base[0]), '20', String(base[1]), '30', String(base[2]),
        ...body,
        '0', 'ENDBLK'
    ];
}

/**
 * Собирает чертёж и возвращает вместе с ожидаемым габаритом.
 *
 * Состав:
 *   SQ    — квадрат 10×10, база в (0,0)
 *   NEST  — содержит одну вставку SQ со смещением (100,0)
 * В ENTITIES:
 *   SQ    в (0,0) без преобразований      → занимает 0..10 по X и Y
 *   SQ    в (50,0), масштаб 2             → 50..70 по X, 0..20 по Y
 *   SQ    в (0,50), поворот 90°           → -10..0 по X, 50..60 по Y
 *   NEST  в (0,0)                         → вложенная SQ даёт 100..110 по X
 * Итого: X от -10 до 110, Y от 0 до 60.
 */
export function makeBlocksDxf() {
    const blocks = [
        ...block('SQ', [0, 0, 0], lwpolyline(SQUARE)),
        ...block('NEST', [0, 0, 0], insert('SQ', [100, 0, 0]))
    ];

    const entities = [
        ...insert('SQ', [0, 0, 0]),
        ...insert('SQ', [50, 0, 0], { scale: [2, 2, 1] }),
        ...insert('SQ', [0, 50, 0], { rotation: 90 }),
        ...insert('NEST', [0, 0, 0])
    ];

    const codes = [
        '0', 'SECTION', '2', 'HEADER',
        '9', '$INSUNITS', '70', '6', // метры: масштабировать нечего
        '0', 'ENDSEC',
        '0', 'SECTION', '2', 'BLOCKS', ...blocks, '0', 'ENDSEC',
        '0', 'SECTION', '2', 'ENTITIES', ...entities, '0', 'ENDSEC',
        '0', 'EOF'
    ];

    return {
        text: codes.join('\n') + '\n',
        // Габарит после раскрытия блоков. Без раскрытия чертёж пуст.
        expected: { minX: -10, maxX: 110, minY: 0, maxY: 60 }
    };
}
