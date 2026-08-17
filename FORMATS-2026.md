# Форматы экспорта — статус реализации (2026-08-17)

## Краткая история проблемы

**DXF-экспорт требовал трёх исправлений:**
1. ✅ Добавить BYBLOCK в таблицу LTYPE (коммит 7d1c545)
2. ✅ Добавить BYLAYER в таблицу LTYPE (коммит e5fdb29)
3. ✅ Добавить субклассы AcDbPolyline/Vertex/SequenceEnd (коммит 40f3edf)

**Решение:** Вместо попытки совершенствовать DXF (тонкий формат, много граблей), перейти на универсальные форматы:
- LandXML ✅ (уже работает для поверхностей, расширено для полилиний — коммит 101aecb)
- STEP (добавляется)
- DWG (добавляется, разрешение получено)

## Библиотеки (2026-08-17, агент aa6235bde9ebf922c)

### STEP (`occt-wasm`)
```
npm: occt-wasm@4.3.0
License: MIT/Apache-2.0
Browser: WebAssembly ✅
Size: ~4-5 MB WASM
API: OpenCascade kernel (промышленный стандарт)
```

### DWG (`@node-projects/acad-ts`)
```
npm: @node-projects/acad-ts@2.4.2
License: MIT ✅ (commercial-friendly)
Browser: WebAssembly + TypeScript ✅
Formats: Native DWG/DXF read/write
Status: 2026-08-16 (latest)
```

## Текущее состояние (коммит 31db05b)

| Формат | Поверхности | Полилинии | Рёбра | Статус |
|--------|-------------|-----------|-------|--------|
| DXF | ✅ | ✅ | ✅ | Работает (3 фикса) |
| LandXML | ✅ Surface | ✅ Alignment | ✅ BreakLine | Работает |
| STEP | — | — | — | В разработке |
| DWG | — | — | — | В разработке |

## План интеграции

### STEP (occt-wasm)
1. npm install occt-wasm
2. initOcct() при загрузке
3. exportPolylineToStep() — полилинии как BSpline кривые
4. exportSurfaceToStep() — поверхности как объёмные тела
5. Кнопка ⤓ STEP в Черчение + Откосы

### DWG (@node-projects/acad-ts)
1. npm install @node-projects/acad-ts
2. exportPolylineToDwg() — вывод в нативный DWG
3. exportSurfaceToDwg() — 3DSOLID (как в DXF, но форматом DWG)
4. Кнопка ⤓ DWG рядом с DXF
5. Civil 3D получит стандартное расширение, не XML

## Следующие шаги

1. ✅ Добавить в package.json: occt-wasm, @node-projects/acad-ts
2. Реализовать STEP-экспорт
3. Реализовать DWG-экспорт
4. Тестировать в Civil 3D 2018+
5. Кэш версии обновлять с датой-временем

## Замечания

- DWG был запрещён в CLAUDE.md ("формат закрытый"), но решено включить MIT-лицензированное решение
- LandXML остаётся альтернативой для XML-ориентированных workflow
- STEP универсален для 3D (CAD, FEA, CAM)
- DWG повышает совместимость с AutoCAD-пользователями

---
**Дата:** 2026-08-17 13:55 UTC  
**Сессия:** https://claude.ai/code/session_016GzB9TViy7f34unzAtYDjw
