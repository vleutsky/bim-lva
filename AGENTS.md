# AGENTS.md

## Cursor Cloud specific instructions

### What this repo is
Static, dependency-free website for the BIM.LVA portfolio (Russian-language). Everything is plain HTML/CSS/vanilla JS ES modules. There is **no package manager, no build step, no backend, and no database** (no `package.json`, lockfiles, Dockerfile, etc.). The files are the deliverable (deployable to any static host / GitHub Pages).

Key pages:
- `index.html` — main landing/portfolio page.
- `plugin_ksi.html`, `case_inventor.html` — marketing/case-study pages.
- `ifc-viewer.html` — in-browser IFC 3D model viewer (Three.js + web-ifc WASM). The real interactive app.
- `IFC_FBX_Viewer.html` — viewer variant that also loads FBX.

### Running / developing
- Serve the folder over HTTP (do NOT open the viewers via `file://` — ES module `importmap` + WASM fetch require HTTP): `python3 -m http.server 8000`, then open e.g. `http://localhost:8000/ifc-viewer.html`.
- The static marketing pages work over `file://` too, but use the HTTP server for consistency.

### Non-obvious caveats
- **All runtime libraries load from CDNs** (`cdn.tailwindcss.com`, `unpkg.com` for Three.js `0.161.0` and web-ifc `0.0.57` + its `.wasm`, `cdnjs` Font Awesome, Google Fonts). Outbound internet access is REQUIRED for the viewers and styling to work; there is nothing vendored locally.
- The IFC viewer waits for the web-ifc WASM engine to initialize; the status bar shows `движок готов` ("engine ready") once loading of a model is possible. Loading a model before it is ready alerts "Движок еще грузится..." ("engine still loading").
- Load models via the `⬆ ЛОКАЛЬНО` button (file picker, `.ifc`), drag-and-drop onto the stage, or a Yandex.Disk public link. No sample `.ifc` file ships in the repo.

### Lint / test / build
- None configured. There are no tests, no linters, and no build/CI pipeline in this repo.
