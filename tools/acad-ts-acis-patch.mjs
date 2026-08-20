/**
 * Дописать в acad-ts запись ACIS-геометрии для 3DSOLID / BODY / REGION.
 *
 * Зачем: у библиотеки `_writeModelerGeometry` выводит только флаги, каркас и
 * силуэты, а сам бит «acis empty» пишет ЕДИНИЦЕЙ — то есть тело уходит в файл
 * пустым. Из-за этого тела (площадки, слои одежды, коридоры, откосы) шли в DWG
 * сеткой 3DFACE: грани, а не тело, объём по ним CAD не посчитает.
 *
 * Раскладку НЕ угадываем: её задаёт ЧИТАТЕЛЬ той же библиотеки
 * (`DwgObjectReader._readModelerGeometry` / `_readModelerGeometryData`), и
 * писатель делается его зеркалом:
 *
 *     B  : acis empty                       ← у нас 0, когда есть данные
 *     если не пусто:
 *        B  : (служебный бит)
 *        BS : версия формата
 *        версия 1: блоки { BL длина; байты }, ноль в длине — конец
 *        версия 2: сырой SAB
 *
 * Шифр версии 1 выведен ИЗ обратного преобразования читателя, а не из памяти:
 * читатель делает `0x20…0x7E → 0x9F − b` и `0x09 → 0x20`. Значит писатель
 * обязан отдавать пробел как 0x09, а остальное печатаемое как `0x9F − b` —
 * тогда разбор возвращает исходный текст побайтно. Пробел через `0x9F − b`
 * дал бы 0x7F, который читатель уже не тронет, и текст поехал бы.
 *
 * Патч ЖИВЁТ ОТДЕЛЬНО от вендора: `npm run vendor` перезаписывает дерево
 * `assets/vendor/acad-ts` целиком, поэтому после копирования он применяется
 * заново. Если библиотека обновится и якорь не найдётся — падаем с ошибкой,
 * а не пишем молча тела-пустышки.
 */

const ANCHOR = `    _writeModelerGeometry(geometry) {
        if (!this.r2013Plus) {
            this._writer.writeBit(true);
        }`;

const REPLACEMENT = `    _writeModelerGeometry(geometry) {
        const acisBytes = geometry.binaryData && geometry.binaryData.length
            ? geometry.binaryData
            : null;
        if (!this.r2013Plus) {
            this._writer.writeBit(!acisBytes);
            if (acisBytes) {
                this._writeModelerGeometryData(geometry, acisBytes);
            }
        }`;

const DATA_METHOD = `    _writeModelerGeometryData(geometry, data) {
        this._writer.writeBit(false);
        const version = geometry.modelerFormatVersion || 1;
        this._writer.writeBitShort(version);
        if (version !== 1) {
            this._writer.writeBytes(data);
            return;
        }
        const enc = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) {
            const b = data[i];
            enc[i] = b === 0x20 ? 0x09 : (b >= 0x21 && b <= 0x7e ? 0x9f - b : b);
        }
        const CHUNK = 4096;
        for (let off = 0; off < enc.length; off += CHUNK) {
            const part = enc.subarray(off, Math.min(off + CHUNK, enc.length));
            this._writer.writeBitLong(part.length);
            this._writer.writeBytes(part);
        }
        this._writer.writeBitLong(0);
    }
`;

const WIRE_ANCHOR = '    _writeModelerGeometryWire(wire) {';

export function patchAcisWriter(source) {
    if (source.includes('_writeModelerGeometryData')) return { text: source, changed: false };
    if (!source.includes(ANCHOR)) {
        throw new Error('acad-ts: якорь _writeModelerGeometry не найден — библиотека изменилась, патч ACIS надо пересобрать');
    }
    if (!source.includes(WIRE_ANCHOR)) {
        throw new Error('acad-ts: якорь _writeModelerGeometryWire не найден — патч ACIS надо пересобрать');
    }
    const text = source
        .replace(ANCHOR, REPLACEMENT)
        .replace(WIRE_ANCHOR, DATA_METHOD + WIRE_ANCHOR);
    return { text, changed: true };
}

export const ACIS_WRITER_FILE = 'IO/DWG/DwgStreamWriters/DwgObjectWriter.js';
