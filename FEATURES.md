# BIM.LVA Composer — план фич (память)

Трекер доработок вьювера. После каждого пункта: коммит + пуш (+ merge в `main` по готовности).

Легенда: `[ ]` todo · `[~]` в работе · `[x]` сделано

## Приоритет сейчас

1. **[~] Координация** — абсолютные XYZ, origin, IFC↔LandXML, без ложных знаков осей
2. **[~] Быстродействие на крупных сводках** — авто ⚡, агрессивный батч/квантование цвета, BasicMaterial, меньше raycast на mousemove; дальше: LOD/этажи, BVH pick, скрытие мелкой внутрянки по умолчанию

## Отложено

- [ ] **Мобильный браузер** — адаптация UI + touch-навигация (pinch-zoom, orbit/pan жестами), одноколоночный layout, авто «быстрый режим», упор на просмотр/замер/свойства. PWA/viewport уже есть; полноценный mobile UX **пока не делаем** (решение 2026-07-17). Вернуться после стабилизации координации и perf.
- [ ] **NWC / NWD / NWF (Navisworks)** — в браузере не читаются (проприетарный формат). **У Navisworks нет нормального экспорта в IFC** (это aggregator, не authoring). Реалистичные пути:
  1. **Сейчас в Composer:** Navisworks → **Export → FBX** → открыть FBX у нас (геометрия/материалы; BIM-свойства почти не переносятся)
  2. Плагин **glTF/GLB** для Navisworks → GLB в Composer
  3. Лучше взять **исходники** (IFC/RVT/DWG), из которых собирали NWC/NWD
  4. **Позже:** облачный конвертер (ODA BimNv / Navisworks .NET API на сервере) → glTF или упрощённый IFC
  5. `.nwc` — кэш для ускорения открытия, не формат обмена; для шаринга обычно `.nwd`

## Очередь (закрыто)

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
14. [x] **PWA / офлайн-кэш**
15. [x] **RVT/Tekla → IFC** — подсказка / заготовка под конвейер

## Уже есть (не трогать без нужды)

- IFC edit / bulk / merge / normalize / export
- Navis-like orbit (pivot under cursor), zoom-to-cursor
- GeoTIFF/ECW локально, Yandex Disk (модели + GeoTIFF)
- DXF 3DFACE/MESH/3DSOLID→mesh
- LandXML / Civil 3D XML (TIN Surfaces + boundary/invisible faces, Contours, CgPoints, Alignments, Parcels, PipeNetworks, Roadways/Corridors, PlanFeatures; smart geo origin / axis swap vs IFC)
- First large model sets scene world origin; later georeferenced IFC/DXF/FBX/LandXML share it (WebGL float precision)
- IFC length units normalized to meters before origin (fixes IFC mm vs LandXML m fly-apart)
- Status bar: cursor + selection coordinates (absolute meters when origin set)
- Generic mm→m heuristic for DXF/FBX/etc. and LandXML millimeter units
- View → near-clip (Auto by zoom distance, or manual 0.01–0.05) so close zoom does not cut geometry
- Selection outline, box select, measure distance, Z-clip
- Perf mode / batching (расширяется: авто на тяжёлых сценах, квантование цвета, BasicMaterial)

## Заметки

- Канонический файл: `bim-lva-composer-ifc.html`
- Ветка агента: `cursor/<topic>-37f9` → PR → merge в `main`
- Браузер-only: без серверного Revit/Tekla SDK
- На больших моделях: ⚡ Быстрый режим, фильтр классов (скрыть мебель/MEP), изоляция этажа — сильнее всего бьют по FPS
