# Mode B — Interactive 3D Tour: Technical Design

> **Status:** Planning / pre-implementation  
> **Companion doc:** [MODE_B_IMPLEMENTATION_PLAN.md](MODE_B_IMPLEMENTATION_PLAN.md)  
> **Last revised:** 2026-08-27

---

## 1. New Files & Modules

```
src/
  preflight-tour.js           Mode B preflight gate (photo count, tool availability)
  build-tour.js               Orchestrator: runs reconstruction → viewer build

backends/
  tour/
    reconstruct.js            Wraps COLMAP SfM + MVS, then 3DGS training
    bake-nav-graph.js         Derives nav nodes from mesh + floor plan
    build-viewer.js           Bundles viewer with baked scene assets

public/
  tour-viewer/
    index.html                Viewer entry point (self-contained)
    viewer.js                 Main Three.js scene entry
    CameraController.js       Snap-to-node + free-look + orbit (dollhouse)
    NavGraph.js               Node graph loader + pathfinding
    DollhouseMode.js          Orbit camera, room highlight, click-to-enter
    MeasurementTool.js        Point-to-point raycaster + label display
    MiniMap.js                SVG floor-plan overlay + position dot
    SceneLoader.js            Splat + collider async loader, progress events
    styles.css

schemas/
  tour.schema.json            Output manifest + nav graph JSON schema

inputs/
  test-scene/                 Synthetic cube-room photos for offline unit tests (M0)
```

No existing files are modified except:
- `config/pieces.json` — 3D pieces added alongside existing video pieces (M5)
- `public/dashboard.html` — mode selector added (M6)
- `src/preflight.js` — mode routing (M6)

---

## 2. Render-Backend Interface

Both Mode A and Mode B implement a common thin contract so the dashboard orchestrator can call either without knowing the internals.

### Contract (JSDoc)

```js
/**
 * @typedef {Object} RenderBackendResult
 * @property {string}   outputDir   Absolute path to the output directory
 * @property {object}   manifest    Parsed manifest JSON (walkthrough.mp4 path for A, tour manifest for B)
 * @property {string[]} warnings    Non-fatal warnings from the build
 */

/**
 * @param {object[]} rooms    Room objects from storyboard.json
 * @param {object}   inputs   { photosDir, floorplanPath, referenceFramesDir }
 * @param {object}   config   Loaded pipeline.config.json (augmented with mode-specific keys)
 * @returns {Promise<RenderBackendResult>}
 */
async function build(rooms, inputs, config) { /* ... */ }

module.exports = { build };
```

### Mode A conformance (existing, to be wrapped)

`backends/video/index.js` (thin wrapper to add when M6 refactors the orchestration):

```js
const buildShotPlan = require('../../src/build-shot-plan');
const assemble = require('../../src/assemble');

async function build(rooms, inputs, config) {
  const shots = await buildShotPlan.run(rooms, inputs, config);
  const result = await assemble.run(shots, config);
  return {
    outputDir: result.outputDir,
    manifest: { video: result.videoPath },
    warnings: result.warnings,
  };
}
module.exports = { build };
```

### Mode B conformance (`backends/tour/index.js`)

```js
const reconstruct = require('./reconstruct');
const bakeNavGraph = require('./bake-nav-graph');
const buildViewer = require('./build-viewer');

async function build(rooms, inputs, config) {
  const scene = await reconstruct.run(inputs, config);
  const graph = await bakeNavGraph.run(scene, rooms, inputs.floorplanPath, config);
  const viewer = await buildViewer.run(scene, graph, rooms, config);
  return {
    outputDir: viewer.outputDir,
    manifest: viewer.manifest,
    warnings: [...scene.warnings, ...graph.warnings, ...viewer.warnings],
  };
}
module.exports = { build };
```

---

## 3. Viewer Subsystem Design

### 3.1 Scene Loading (`SceneLoader.js`)

```
SceneLoader.load(manifestPath)
  → fetch manifest.json
  → parallel: load splat (large) + load collider GLB (small)
  → sequential after both: load nav graph JSON (tiny)
  → emit 'ready' event
```

Progress is weight-averaged across the three assets based on expected file size
(splat ≈ 80% of total bytes, collider ≈ 19%, nav graph ≈ 1%). The UI progress
bar shows a single 0–100% value derived from `(splatPct*0.80 + colliderPct*0.19 + graphPct*0.01)`.

- Splat loaded via `@mkkellogg/gaussian-splats-3d` `KSplatLoader`
- Collider loaded via `THREE.GLTFLoader`; set `mesh.visible = false`; added to scene for raycasting only
- Splat and collider loads run in parallel; nav graph load starts after both complete

### 3.2 Camera Controller (`CameraController.js`)

Three modes, switched via `setMode(mode)`:

| Mode | Camera behavior |
|---|---|
| `'walk'` | Locked to nav nodes. Click a neighbor node → slerp camera position over 400 ms. Drag → yaw/pitch free-look (pointer lock on desktop; touch delta on mobile). |
| `'dollhouse'` | Orbit camera (`THREE.OrbitControls`) around scene centre. Click room mesh highlight → `setMode('walk')` at nearest node. |
| `'floorplan'` | Top-down orthographic camera locked 5 m above floor. Pan only. |

State machine:

```
walk ──dollhouse-button──► dollhouse ──click-room──► walk
walk ──floorplan-button──► floorplan ──floorplan-button──► walk
```

### 3.3 Nav Graph (`NavGraph.js`)

```js
class NavGraph {
  constructor(graphJson) { /* build adjacency list */ }
  nearest(worldPos)        // → nodeId closest to worldPos
  neighbors(nodeId)        // → nodeId[]
  roomOf(nodeId)           // → roomId string
  pathTo(fromId, toId)     // → nodeId[] (A* — for "teleport to room" feature)
}
```

Graph JSON is loaded once at startup; no runtime reconstruction.

### 3.4 Dollhouse Mode (`DollhouseMode.js`)

- On enter: disable splat; enable mesh with per-room color material; OrbitControls active
- On room hover: highlight room mesh with emissive tint
- On room click: call `CameraController.setMode('walk')` at nearest nav node
- On exit: re-enable splat; disable mesh color material; OrbitControls disabled

Performance note: the dollhouse mesh is the same `collider.glb` used for physics, just with a visible material swapped in — no extra geometry load.

### 3.5 Measurement Tool (`MeasurementTool.js`)

```
state: idle → anchor-placed → measurement-complete
  idle:             click → raycast into collider → place anchor sphere → state = anchor-placed
  anchor-placed:    click → raycast → place second sphere → draw line + label → state = measurement-complete
  measurement-complete: click "clear" → state = idle
```

- Raycaster: `THREE.Raycaster` against the hidden collider mesh (not the splat)
- Distance: `anchorPoint.distanceTo(secondPoint)` in metric (COLMAP frame = meters)
- Label: `THREE.CSS2DObject` showing `"X.XX m / X.XX ft"`
- Disabled in dollhouse and floorplan modes

### 3.6 MiniMap (`MiniMap.js`)

- SVG floor plan loaded as `<img>` overlay (bottom-left HUD)
- Current nav node projected to floor-plan 2D coordinates via a precomputed affine transform stored in `manifest.json` (`floorplanTransform: [[a,b,c],[d,e,f]]`)
- Position dot updated on every nav transition

---

## 4. Performance Targets

| Metric | Target | Fallback |
|---|---|---|
| Initial load (splat + collider + graph) | ≤8 s on 10 Mbps | Progressive loading; show mesh-only view first |
| Nav transition | ≤400 ms | Reduce slerp frames if behind budget |
| Walk-mode fps (desktop Chrome, RTX 3060) | ≥60 fps | Reduce splat point count |
| Walk-mode fps (mid-range 2023 Android) | ≥30 fps | Mobile LOD: switch to mesh-only render if GPU score <threshold |
| Dollhouse load (switch from walk) | ≤200 ms | Mesh always loaded; instant material swap |
| Splat file size | ≤150 MB compressed | Limit 3DGS training iterations; prune low-opacity Gaussians |
| Collider GLB size | ≤5 MB | Decimate mesh: target ≤50k triangles |

### Mobile fallback

Detect `navigator.gpu` and run a quick FPS benchmark on the first 30 frames. If median FPS <25, switch to `MeshOnlyRenderer` (collider mesh + baked lightmap texture). Users can override via a "quality" toggle.

### Observability hooks

```js
// Emitted by SceneLoader
scene.on('load:progress', ({ phase, pct }) => { /* update progress bar */ });
scene.on('load:complete', ({ ms }) => { /* log to console + perf entry */ });

// Emitted by CameraController
camera.on('nav:transition', ({ from, to, ms }) => { /* log navigation telemetry */ });
camera.on('fps:drop', ({ fps }) => { /* warn in dev console */ });
```

In production these are no-ops unless `config.debug = true`.

---

## 5. Security & Privacy Considerations

### Local-only assets

All reconstruction inputs (`inputs/listing-photos/`) and outputs (`output/tour/`) are local filesystem paths. No data leaves the machine during reconstruction.

- `output/tour/` is added to `.gitignore` (same as `output/walkthrough.mp4`)
- `inputs/listing-photos/` is already gitignored

### When serving the tour

`npx serve output/tour` binds to localhost by default. To share externally:
- Copy `output/tour/` to a static host (S3, Vercel, etc.) — no server-side code needed
- Do not commit `output/` to git (already gitignored)
- Consider stripping EXIF GPS data from photos before reconstruction if location privacy matters (`exiftool -gps:all= inputs/listing-photos/*`)

### Viewer dependencies

All viewer JS runs client-side. No external API calls from the viewer at runtime. The only network request the viewer makes is to load its own bundle assets from the same origin.

### Dependency audit

Run `npm audit` before adding new viewer deps. Prefer MIT/Apache-2 licensed packages. Avoid packages with known supply-chain incidents.

---

## 6. `schemas/tour.schema.json`

To be created in M0. Minimal structure:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "TourManifest",
  "type": "object",
  "required": ["version", "rooms", "navGraph", "splat", "collider", "startNodeId"],
  "properties": {
    "version":        { "type": "string" },
    "generatedAt":    { "type": "string", "format": "date-time" },
    "propertyId":     { "type": "string" },
    "rooms":          { "type": "array", "items": { "$ref": "#/definitions/Room" } },
    "navGraph":       { "type": "string" },
    "splat":          { "type": "string" },
    "collider":       { "type": "string" },
    "floorplan":      { "type": "string" },
    "floorplanTransform": { "type": "array", "items": { "type": "array", "items": { "type": "number" } } },
    "startNodeId":    { "type": "string" },
    "bounds":         { "$ref": "#/definitions/Bounds" }
  },
  "definitions": {
    "Room": {
      "type": "object",
      "required": ["id", "label", "navNodeIds"],
      "properties": {
        "id":          { "type": "string" },
        "label":       { "type": "string" },
        "navNodeIds":  { "type": "array", "items": { "type": "string" } }
      }
    },
    "Bounds": {
      "type": "object",
      "required": ["minX","maxX","minY","maxY","minZ","maxZ"],
      "properties": {
        "minX": { "type": "number" }, "maxX": { "type": "number" },
        "minY": { "type": "number" }, "maxY": { "type": "number" },
        "minZ": { "type": "number" }, "maxZ": { "type": "number" }
      }
    }
  }
}
```
