# BIM.LVA Composer — план фич (память)

Трекер доработок вьювера. После каждого пункта: коммит + пуш (+ merge в `main` по готовности).

Легенда: `[ ]` todo · `[~]` в работе · `[x]` сделано

## Очередь

1. [x] **Разрезы X/Y/Z + коробка сечения** — плоскости по осям и section box
2. [x] **Изоляция выделения + сохранённые виды** — isolate / unisolate, save/restore camera+visibility
3. [x] **Замеры** — площадь, угол, перепад Z, цепочка расстояний
4. [x] **Цвет по классу / Pset + легенда**
5. [x] **BCF-заметки** — точка + комментарий + камера → экспорт
6. [x] **Выравнивание моделей** — сдвиг/поворот сводки
7. [x] **Яндекс.Диск: JPEG+world и ECW** (как GeoTIFF)
8. [x] **Простые коллизии** — AABB/mesh между двумя IFC
9. [x] **Фильтр по классу** — стены / трубы / …
10. [x] **Сравнение двух версий IFC**
11. [x] **Ведомость** — таблица выделенного → CSV
12. [x] **CRS / northing** — смещение/привязка координат
13. [x] **Шаринг вида** — состояние в URL
14. [ ] **PWA / офлайн-кэш**
15. [ ] **RVT/Tekla → IFC** — подсказка / заготовка под конвейер

## Уже есть (не трогать без нужды)

- IFC edit / bulk / merge / normalize / export
- Navis-like orbit (pivot under cursor), zoom-to-cursor
- GeoTIFF/ECW локально, Yandex Disk (модели + GeoTIFF)
- DXF 3DFACE/MESH/3DSOLID→mesh
- Selection outline, box select, measure distance, Z-clip
- Perf mode / batching

## Заметки

- Канонический файл: `bim-lva-composer-ifc.html`
- Ветка: `cursor/ifc-bulk-edit-37f9` → периодически merge в `main`
- Браузер-only: без серверного Revit/Tekla SDK
