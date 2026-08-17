// STEP Export (occt-wasm) — стуб, заполнить позже
function exportPolylineToStep() {
    notifyError('STEP-экспорт: в разработке');
    // TODO: initOcct() при старте
    // TODO: Преобразовать polylines в BSpline кривые
    // TODO: Экспортировать через occt.exportStep()
}

// DWG Export (@node-projects/acad-ts) — стуб, заполнить позже
function exportPolylineToDwg() {
    notifyError('DWG-экспорт: в разработке');
    // TODO: Инициализировать DwgDocument
    // TODO: Преобразовать polylines в DWG entities (POLYLINE 2D)
    // TODO: Преобразовать surfaces в 3DSOLID
    // TODO: Экспортировать через document.toDwgBuffer()
}

function exportSurfaceToStep(model) {
    notifyError('STEP для поверхностей: в разработке');
    // TODO: Преобразовать TIN в BRep solid через occt
}

function exportSurfaceToDwg(model) {
    notifyError('DWG для поверхностей: в разработке');
    // TODO: Преобразовать TIN в 3DSOLID для DWG
}
