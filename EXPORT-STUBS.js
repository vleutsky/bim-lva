// STEP Export (occt-wasm) — реализовано в bim-lva-composer-ifc.html
// Функции: buildStep(), exportDrawingStep()
// Поддерживает:
// - Полилинии как line segments
// - Поверхности TIN как triangular faces
// - Экспорт в STEP формат через OcctKernel

// DWG Export (@node-projects/acad-ts) — реализовано в bim-lva-composer-ifc.html
// Функции: buildDwg(), exportDrawingDwg()
// Поддерживает:
// - Полилинии как POLYLINE 2D
// - Координатные точки как POINT
// - Поверхности как 3D-полилинии (упрощённо)
// - Экспорт в DWG формат через CadDocument

// Расширения для будущих версий:
// - BSpline интерполяция для кривых STEP (вместо line segments)
// - 3DSOLID для поверхностей в DWG (через внешний конвертер)
// - Параметризация экспорта (выбор формата, уровень детализации)
