# BIM.LVA Composer — план фич (память)

Трекер доработок вьювера. После каждого пункта: коммит + пуш (+ merge в `main` по готовности).

Легенда: `[ ]` todo · `[~]` в работе · `[x]` сделано

## Очередь

1. [ ] **Разрезы X/Y/Z + коробка сечения** — плоскости по осям и section box
2. [ ] **Изоляция выделения + сохранённые виды** — isolate / unisolate, save/restore camera+visibility
3. [ ] **Замеры** — площадь, угол, перепад Z, цепочка расстояний
4. [ ] **Цвет по классу / Pset + легенда**
5. [ ] **BCF-заметки** — точка + комментарий + камера → экспорт
6. [ ] **Выравнивание моделей** — сдвиг/поворот сводки
7. [ ] **Яндекс.Диск: JPEG+world и ECW** (как GeoTIFF)
8. [ ] **Простые коллизии** — AABB/mesh между двумя IFC
9. [ ] **Фильтр по классу** — стены / трубы / …
10. [ ] **Сравнение двух версий IFC**
11. [ ] **Ведомость** — таблица выделенного → CSV
12. [ ] **CRS / northing** — смещение/привязка координат
13. [ ] **Шаринг вида** — состояние в URL
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
