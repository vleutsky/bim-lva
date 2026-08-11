/**
 * DXF-фикстура с геодезическими координатами: сетка 3DFACE вокруг заданной
 * мировой точки. Нужна, чтобы проверять сводку «DWG/DXF + IFC», где ноль сцены
 * может задать любой из них.
 *
 * Формат — ASCII R12, только ENTITIES: этого хватает загрузчику вьювера.
 */
export function makeGeoDxf({ worldX = 0, worldY = 0, worldZ = 0, cols = 6, rows = 6, step = 10, size = 6 } = {}) {
    const out = [];
    const g = (code, value) => { out.push(String(code)); out.push(String(value)); };
    const n = (v) => v.toFixed(4);

    g(0, 'SECTION'); g(2, 'ENTITIES');
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const x = worldX + c * step;
            const y = worldY + r * step;
            g(0, '3DFACE'); g(8, 'GEO');
            g(10, n(x)); g(20, n(y)); g(30, n(worldZ));
            g(11, n(x + size)); g(21, n(y)); g(31, n(worldZ));
            g(12, n(x + size)); g(22, n(y + size)); g(32, n(worldZ));
            g(13, n(x)); g(23, n(y + size)); g(33, n(worldZ));
        }
    }
    g(0, 'ENDSEC'); g(0, 'EOF');
    return out.join('\r\n') + '\r\n';
}

/** Центр сетки фикстуры в абсолютных координатах. */
export function geoDxfCentre({ worldX = 0, worldY = 0, worldZ = 0, cols = 6, rows = 6, step = 10, size = 6 } = {}) {
    return {
        e: worldX + ((cols - 1) * step + size) / 2,
        n: worldY + ((rows - 1) * step + size) / 2,
        h: worldZ
    };
}
