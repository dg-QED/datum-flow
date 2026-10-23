# Datum Suite — Engineering Handoff

As of 2026-10-23. Prepared for the incoming engineer; the same content lives in each of the four app repos as `HANDOFF.md`.

## Summary

Datum is an open-source (GPL-3.0-or-later) suite of browser-based architecture, engineering and planning tools built for QED Architecture & Engineering. Five apps exist; four were built in this workstream (Form, Atlas, Field, Flow) and all are tested, versioned and pushed to GitHub. No app is deployed to a QED server yet.

| App | What it is | Current version | Repo |
| --- | --- | --- | --- |
| Datum (BIM/CAD) | Open/inspect/edit Revit, IFC, DWG/DXF, meshes; schedules/BOM; FastAPI engine + React web | 0.1.0 (pre-existing, not part of this workstream) | Nerdifitronix/datum |
| Datum Form | Rhino-style NURBS modeller + Grasshopper-style node graph, drawings/layouts, sun studies | 3.1.0 | Nerdifitronix/datum-form |
| Datum Atlas | Browser GIS: layers, symbology, table, geoprocessing, terrain, web services, PDF map layouts, site analysis | 3.1.0 | Nerdifitronix/datum-atlas |
| Datum Field | Forma-style early-stage massing + environmental analysis (sun, daylight, wind, noise, solar, comfort, energy, carbon) | 1.0.0 | Nerdifitronix/datum-field |
| Datum Flow | Crowd, egress and pedestrian simulation | 1.0.0 | dg-QED/datum-flow |

Form, Atlas and Field exchange sites and massing through the `.dsite.json` package and a massing GeoJSON (spec in `docs/dsite-format.md` in Form, Atlas and Field). A related sibling, `Nerdifitronix/datum-batten` (stage/production design), exists on GitHub but was not part of this work.

## Repositories, branches and live links

Every repo's `main` holds the latest release; each release also has a `release/vX.Y` branch. No git tags were created for Form/Atlas/Field/Flow (the build session could not push tags or create GitHub releases) — tag manually if wanted.

| Repo | `main` at release | Release branches | Other branches |
| --- | --- | --- | --- |
| [Nerdifitronix/datum-form](https://github.com/Nerdifitronix/datum-form) | f2ded94 (3.1.0) | release/v1.0, v2.0, v3.0, v3.1 | v2, v3, v3.1 (working branches, same commits as releases) |
| [Nerdifitronix/datum-atlas](https://github.com/Nerdifitronix/datum-atlas) | 8f63189 (3.1.0) | release/v1.0, v2.0, v3.0, v3.1 | v2, v3, v3.1 |
| [Nerdifitronix/datum-field](https://github.com/Nerdifitronix/datum-field) | cee95fd (1.0.0) | release/v1.0 | — |
| [dg-QED/datum-flow](https://github.com/dg-QED/datum-flow) | 9d12c9a (1.0.0) | release/v1.0 | — |
| [Nerdifitronix/datum](https://github.com/Nerdifitronix/datum) | 6a32d09 (0.1.0, tag v0.1.0) | — | v0.2-repo-ci, v0.2-trusted-identity-header (open PRs #1 and #2, not from this workstream) |

`main` in each app repo is one commit ahead of the commit above: the commit that adds this `HANDOFF.md`.

Note: `datum-flow` lives under the **dg-QED** GitHub account; the others are under **Nerdifitronix**.

**Hosted copies:** each app is also published as a private claude.ai page tied to the outgoing owner's claude.ai account. An incoming engineer should not rely on them and should deploy from the repos.

## How to build, run and test

All four apps are Node projects (built and tested on Node 22; Node 20+ expected). Build output (`dist/`) is not committed — build it.

```bash
git clone https://github.com/Nerdifitronix/datum-form   # or datum-atlas, datum-field, dg-QED/datum-flow
cd datum-form
npm install
npm run dev      # dev server, usually http://localhost:5173
npm run build    # type-check + one self-contained dist/index.html (open it directly in a browser, or serve it)
```

Tests need Playwright's Chromium for the browser checks (`npx playwright install chromium`, or set `PLAYWRIGHT_BROWSERS_PATH`). Headless WebGL was run with `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`.

| App | Unit / node tests | Browser (e2e) tests | Last result |
| --- | --- | --- | --- |
| Form | `npm run smoke` (booleans, site, engine, drawings, sun, graph) | `npm run check` (smoke + `scripts/headless-check.mjs`) | 69/69 browser checks pass; `scripts/atlas-roundtrip.mjs` and `scripts/rhino-roundtrip.ts` pass |
| Atlas | `npm run test:tools`, `test:v2`, `test:v3`, `test:v31` | `npm run test:e2e` (Python Playwright: `tests/e2e*.py`, mock services in `tests/mock_services.py`) | all pass |
| Field | `npm test` (31 physics checks vs known answers) | `npm run e2e` (48 checks) | all pass |
| Flow | `npm test` (8 model tests) | `npm run test:e2e` (16 checks) | all pass |

**Docker / self-hosting:** Form has a `Dockerfile` (nginx serving the built page). Atlas has `proxy/` (`server.mjs`, `allowlist.json`, `Dockerfile`, `docker-compose.yml`) that serves `dist/` plus a same-origin `/proxy?url=` for map services; edit `allowlist.json` to add hosts. Neither Docker image has been built or run — there was no Docker daemon in the build environment.

## Architecture and shared conventions

Each app is an independent static web app: Vite 6 + React 18 + TypeScript, built to one self-contained `dist/index.html` (vite-plugin-singlefile). There is no backend for Form, Atlas, Field or Flow; projects live in files the user saves and opens.

File hand-offs between apps (no shared runtime):

| From | To | File |
| --- | --- | --- |
| Atlas | Form, Field | site package `.dsite.json` |
| Form, Field | Atlas | massing GeoJSON (`datum.source = "form"`, `height_m`, `base_m`) |
| Field | Form | proposed massing as `.dsite.json` |
| Form (layouts), Datum (BIM/CAD) | Flow | DXF plans |

The site package format is specified in `docs/dsite-format.md` (version 1): local metres in the site's WGS 84 UTM zone, origin lon/lat, layers, optional terrain grid. Form ↔ Atlas ↔ Field round-trips are covered by `datum-form/scripts/atlas-roundtrip.mjs`.

**Conventions every app follows**

- Look: the same CSS tokens (dark drafting palette, amber `#f2a93b` accent, Inter Tight + JetBrains Mono) copied from Datum's `web/src/styles.css`; phone layout with a bottom tab bar and bottom sheet.
- No runtime network fetches: all WASM (manifold-3d booleans and QuickJS in Form, sql.js in Atlas) is inlined as base64 and instantiated lazily. The only exception is Form's lazy `rhino3dm` load from jsDelivr for `.3dm` import/export.
- Every file save goes through one `download()` helper (`datum-atlas/src/io.ts`; copies in the other apps). It uses the claude.ai host's `downloads` capability when present, else a normal link download.
- Heavy computation runs in Web Workers (Field analyses, Flow simulation, Atlas terrain shadows, Form scripts).
- Each repo has a README (features, shortcuts, architecture, licences of dependencies) and, for Field and Flow, `docs/METHODS.md` with formulas, parameters and sources.
- Licence: GPL-3.0-or-later in every repo; dependency licences are listed in each README.

## Per-app status

All four apps are feature-complete for their current version and pass their own test suites; the limits below are known and documented in each README.

### Datum Form 3.1.0

- **Modeller:** command line with typed coordinates, 4 viewports, snaps, gumball, layers, user text, 46+ NURBS commands (verb-nurbs).
- **Graph:** about 90 components, data trees, live preview and bake, clusters, Site components, a JavaScript Script component sandboxed in QuickJS (WASM, Web Worker, 64 MB / 2 s / 8 MB output limits).
- **Solids:** BooleanUnion/Difference/Intersection/Split via manifold-3d.
- **Drawings:** Make2D, Section, Elevation, Contour with exact or fitted NURBS output; dimensions, leaders, text; layout sheets (Arch D/E, ISO A0–A3, Letter/Tabloid) with title block, auto-fit scale; export PDF, SVG, DXF (SPLINE/ELLIPSE/ARC/CIRCLE).
- **Sun:** sun position (within 0.005° of NREL SPA), live shadows, shadow-study grid, direct sun hours.
- **Files:** `.dform.json`, `.dgraph.json`, `.dcluster.json`, OBJ/STL/GLB export, `.3dm` import/export (rhino3dm, loaded at runtime from jsDelivr; tested in Node, not in a browser), `.dsite.json` import, massing GeoJSON export.
- **Limits:** boolean results are meshes; perspective Make2D is drawn as parallel projection; DXF dimensions are exploded to lines/text; meshes in drawings are polylines; Script timeouts report no line number; first script run takes about 1.5 s; bundle 3.56 MB.

### Datum Atlas 3.1.0

- **Data:** SHP (zip), GeoJSON, KML, GPX, CSV, GeoTIFF, FlatGeobuf, GeoPackage import; GeoJSON/CSV/KML/SHP/GPKG export; reprojection via proj4.
- **Map:** layers, single/categorised/graduated styles, labels, 3D extrusion, heatmaps, attribute table with expression filter, field calculator, CSV joins, stats and charts.
- **Tools:** 20+ geoprocessing tools; terrain (hillshade, slope, aspect, contours, profiles); terrain- and building-aware shadows and sun hours; slope-aware walk/wheelchair/cycling isochrones and routing; viewshed; site metrics (coverage, FSI, setbacks).
- **Services:** XYZ, WMS, WMTS, WFS, ArcGIS REST, OGC API Features; presets for NRCan, StatCan and Ontario LIO (verified on publisher pages, not live-tested); optional same-origin proxy in `proxy/`.
- **Output:** PDF/PNG map layouts with title block, legend, scale bar, north arrow, grid, inset; Send to Form (`.dsite.json`); Form massing import.
- **Limits:** live basemap tiles and real government services were never reachable from the build sandbox (only mocks were tested); rasters downsampled to 2,048 px; GeometryCollections not editable; isochrones use one speed per profile; bundle 4.73 MB.

### Datum Field 1.0.0

- **Massing:** typology tools (bar, tower + podium, courtyard, L, U, point tower), free footprints, per-floor use mix, zoning panel with live KPIs (GFA, FSI, coverage, open space, height, setbacks, units, parking).
- **Analyses (Web Worker):** sun hours, daylight (VSC/SVF), pedestrian wind (2D Lattice-Boltzmann on GPU with CPU fallback, Lawson comfort), road noise (RLS-90 + Maekawa), solar/PV, UTCI comfort, ISO 13790 monthly energy, embodied carbon.
- **Output:** scenario comparison, PDF report, KPI CSV, `.dfield.json`, massing GeoJSON, `.dsite.json`, GLB.
- **Limits:** the default wind rose is illustrative (paste real Trenton station data in the Wind lens); solar cloud fractions are assumptions; noise uses RLS-90, not the Ontario method; 2D wind model misses downwash; energy use profiles and carbon quantities are assumed typical values. Sources and assumptions are in `docs/METHODS.md`.

### Datum Flow 1.0.0

- **Plans:** multi-level walls, doors, exits, stairs/ramps, seating generator, spawn zones, attractors with queues, one-way barriers; DXF import with layer-to-role mapping and scale calibration.
- **Model:** Helbing social force with fast-marching floor fields, 5 people profiles, groups, pre-movement distributions, seeded runs; Monte-Carlo P50/P90.
- **Results:** Fruin LOS density maps, door flows, exit usage, cumulative evacuated, queues; SFPE hydraulic and OBC 3.4.3.2 cross-checks; PDF, CSV, WebM video, `.dflow.json`.
- **Performance:** 5,000 agents at about 6× real time; 20,000 at about 1.2× (2-vCPU sandbox).
- **Limits:** two documented calibration changes to the 2000 model plus a deadlock nudge; straight single-run stairs only; no fire/smoke; ingress seats people at their block, not their exact seat; planning tool only, not a life-safety analysis.

## Open items not done

These were started, planned or could not be verified in the build environment. None blocks running the apps from the repos.

- [ ] Deploy Form, Atlas, Field and Flow to QED servers behind Keystone SSO (Authentik, `id.qed.ventures`). Planned, not started. Datum's existing `docker-compose.yml` (oauth2-proxy in front of the app) is the pattern to copy.
- [ ] Build and run the Docker images (Form `Dockerfile`; Atlas `proxy/Dockerfile` + `docker-compose.yml`). Never built; no Docker daemon was available.
- [ ] Create git tags / GitHub releases (`v1.0` … `v3.1` for Form and Atlas, `v1.0` for Field and Flow). Release branches exist; tags do not.
- [ ] Test `.3dm` import/export in a browser (Form). Verified only in Node against rhino3dm 8.17.
- [ ] Test Atlas against the real NRCan / StatCan / Ontario LIO services and live basemap tiles, with and without the proxy.
- [ ] Replace Field's illustrative wind rose and solar cloud assumptions with measured Trenton data (ECCC), and decide whether to adopt the Ontario road-noise method.
- [ ] Review Flow's calibration changes (`docs/METHODS.md`) before using results for any decision.
- [ ] Review open PRs #1 and #2 on `Nerdifitronix/datum` (`v0.2-repo-ci`, `v0.2-trusted-identity-header`); they predate and are separate from this work.

## Access and accounts

The incoming engineer needs write access to these GitHub accounts, granted by their owner before the hand-over:

| GitHub account | Repos |
| --- | --- |
| Nerdifitronix | datum, datum-form, datum-atlas, datum-field (and datum-batten) |
| dg-QED | datum-flow |

- No secrets, API keys or credentials are stored in any of the four repos. Keystone client secrets are only needed at deployment (see Datum's `.env.example`).
- The private claude.ai copies of each app belong to the outgoing owner's account; share or retire them from each page's Share menu.
- Commit history records the build sessions (each commit carries a `Claude-Session` trailer) for anyone tracing how a change was made.
