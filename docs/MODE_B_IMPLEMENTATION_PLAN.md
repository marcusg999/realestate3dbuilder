# Mode B — Interactive 3D Tour: Implementation Plan

> **Status:** Planning / pre-implementation  
> **Depends on:** Mode A pipeline tested on real listings (see ROADMAP.md)  
> **Owner:** TBD  
> **Last revised:** 2026-08-27

---

## 1. Scope

Mode B turns a listing's dense photo set (and optionally a short video walkthrough) into a **navigable, browser-based 3D tour** that a buyer can self-explore — no plugin, no download.

### In scope

| Capability | Description |
|---|---|
| Click-to-move navigation | Buyer clicks a floor-spot or nav arrow to step to that location |
| Free-look camera | Mouse/touch drag pans the view from any standing point |
| Dollhouse view | Zoomed-out top-angled 3D shell of the full property |
| Floor-plan view | Overhead 2D/2.5-D map with the buyer's current position marked |
| Room measurement | Point-to-point tape measure on surfaces (requires metric reconstruction) |
| Shared intake | Uses the same `inputs/` assets and `storyboard.json` room model as Mode A |
| Local output | `output/tour/` — a self-contained directory serveable with `npx serve` |

### Non-goals (v1)

- Real-time multiplayer / agent-hosted tours (Matterport Showcase API replacement)
- iOS/Android native app
- Server-side rendering or streaming reconstruction
- LiDAR / depth-sensor capture (phone camera photos only for now)
- BIM / IFC export
- Live camera feed or video-call integration

---

## 2. Product Requirements & Acceptance Criteria

### 2.1 Navigation

**Requirement:** Buyer can traverse the full property by clicking nav nodes on the floor or using on-screen arrow controls.

| Acceptance criterion | How to verify |
|---|---|
| Every room in `storyboard.json` has ≥1 reachable nav node | `npm run preflight:tour` reports zero unreachable rooms |
| Navigation transition ≤400 ms on a mid-range 2021 laptop (Chrome) | Lighthouse custom timing script |
| No nav node is inside a wall (>5 cm penetration) | Automated geometry check in reconstruction post-process |
| Keyboard arrows and WASD move between adjacent nodes | Manual QA checklist |

### 2.2 Free-Look Camera

**Requirement:** At any nav node the buyer can pan ±180° horizontal, ±90° vertical by dragging.

| Acceptance criterion | How to verify |
|---|---|
| Drag panning is smooth ≥30 fps on mobile (mid-range 2023 Android) | DevTools FPS overlay |
| Camera never clips through geometry | Automated render-side frustum test |
| Gyroscope/device-tilt free-look on mobile when permission granted | Manual QA on physical device |
| Inertia damping: view coasts to a stop after a fast drag | Visual QA |

### 2.3 Dollhouse View

**Requirement:** A "dollhouse" button reveals the full 3D mesh/splat from a bird's-eye angled perspective; the buyer can orbit and re-enter.

| Acceptance criterion | How to verify |
|---|---|
| Dollhouse loads within 3 s on a 10 Mbps connection | Chrome DevTools throttle + timing |
| Clicking a room in dollhouse transitions into that room's nearest nav node | E2E Playwright test |
| Dollhouse orbit is touch-friendly (pinch-zoom, rotate) | Manual QA on tablet |
| LOD switches at 5 m / 15 m / 30 m camera distance | Visual QA + shader log |

### 2.4 Room Measurement

**Requirement:** Buyer can measure distances between two clicked surface points; result displayed in feet and meters.

| Acceptance criterion | How to verify |
|---|---|
| Measurement error ≤3 cm on a known-size test room | Physical tape vs. tool reading |
| Both metric and imperial displayed simultaneously | Visual QA |
| Measurement persists until user clears it or starts a new one | Manual QA |
| Measurement tool disabled in dollhouse mode (only active in walk view) | Manual QA |

---

## 3. Architecture Proposal

```
                 ┌─────────────── shared intake (unchanged) ─────────────────┐
                 │  inputs/listing-photos/  inputs/floorplan/  inputs/storyboard.json   │
                 │  dashboard (npm run dashboard)  •  preflight gate                    │
                 └──────────────────────────────────┬──────────────────────────────────┘
                                                    │ room model (storyboard.json)
                              ┌─────────────────────┴──────────────────────────┐
                              ▼                                                 ▼
                  Mode A backend (existing)                    Mode B backend (new)
               backends/video/  →  output/walkthrough.mp4   backends/tour/  →  output/tour/
```

### Entry points (new files)

| File | Role |
|---|---|
| `src/preflight-tour.js` | Mode B preflight: coverage density check, colmap/ffmpeg presence |
| `src/build-tour.js` | Orchestrator: calls reconstruction → viewer build → nav-graph bake |
| `backends/tour/reconstruct.js` | Wraps chosen reconstruction tool (COLMAP / nerfstudio / 3DGS) |
| `backends/tour/bake-nav-graph.js` | Derives walk nodes from reconstruction + floor plan |
| `backends/tour/build-viewer.js` | Bundles the WebGL viewer with the baked scene |
| `public/tour-viewer/` | Static viewer assets (Three.js scene, CSS, UI controls) |
| `schemas/tour.schema.json` | Output manifest / data contract |

### Render-backend interface (thin contract)

Both backends implement:

```js
// renderBackend.build(rooms, inputs, config) → Promise<{ outputDir, manifest }>
//   rooms   — array of room objects from storyboard.json
//   inputs  — { photosDir, floorplanPath, referenceFramesDir }
//   config  — { outputDir, quality, ... } from pipeline.config.json
```

Mode A already satisfies this shape via `build-shot-plan.js` + `assemble.js`.  
Mode B satisfies it via `src/build-tour.js`.

---

## 4. Reconstruction Strategy Comparison

| Approach | Fidelity | Compute | Capture effort | Metric scale | Recommended for |
|---|---|---|---|---|---|
| **Classical photogrammetry (COLMAP → mesh)** | High geometry accuracy | Medium (CPU/GPU, ~1–3 h for 200 photos) | Dense overlap needed (80% overlap recommended) | Yes — calibrated via SfM | Ground-truth measurement tool; floor-plan alignment |
| **Gaussian Splatting (3DGS)** | Photoreal appearance | High GPU (training ~30–60 min on RTX 3080) | Same dense overlap | No (requires fusion with SfM poses) | Photoreal dollhouse / free-look; no mesh needed |
| **Hybrid (COLMAP poses → 3DGS render + mesh collider)** | Best of both | High (both pipelines) | Dense overlap | Yes | **Recommended for Mode B v1** |
| **Hosted SDK (Polycam, Luma AI, RealityCapture cloud)** | Variable | None local | Moderate | Usually yes | Fast prototype; vendor lock-in risk |

### Recommendation: Hybrid (COLMAP + 3DGS)

1. Run COLMAP to recover **camera poses and a sparse point cloud** → metric scale, needed for measurement tool and nav graph grounding.
2. Train **3DGS on the COLMAP poses** → photoreal splat for the viewer render.
3. Extract a **lightweight mesh** from the COLMAP dense cloud (or use the Poisson mesh) as an invisible **collision/navigation collider** only.
4. Viewer renders: splat for visuals, mesh for physics (click-to-floor, measurement raycasting).

This decouples render quality from geometric accuracy and avoids per-vendor lock-in; COLMAP and nerfstudio/3DGS are both MIT/Apache licensed.

---

## 5. Data Contracts & Output Artifacts

### Output directory layout

```
output/tour/
├── index.html                  viewer entry point (self-contained)
├── manifest.json               tour manifest (schema: schemas/tour.schema.json)
├── scene/
│   ├── splat.ksplat            compressed Gaussian splat (or .splat)
│   ├── collider.glb            lightweight navigation/collision mesh
│   └── floorplan.svg           processed floor plan overlay
├── nav/
│   └── graph.json              navigation node graph
├── rooms/
│   └── <room-id>/
│       └── metadata.json       per-room label, area, measurements
└── assets/
    ├── viewer.bundle.js        bundled Three.js viewer
    └── styles.css
```

### `manifest.json` schema (shape)

```jsonc
{
  "version": "1.0",
  "generatedAt": "2026-08-27T00:00:00Z",
  "propertyId": "string",
  "rooms": [
    {
      "id": "string",           // matches storyboard.json room id
      "label": "string",
      "navNodeIds": ["string"]  // IDs in nav/graph.json
    }
  ],
  "navGraph": "nav/graph.json",
  "splat": "scene/splat.ksplat",
  "collider": "scene/collider.glb",
  "floorplan": "scene/floorplan.svg",
  "startNodeId": "string",
  "bounds": {
    "minX": 0, "maxX": 0,
    "minY": 0, "maxY": 0,
    "minZ": 0, "maxZ": 0
  }
}
```

### `nav/graph.json` schema (shape)

```jsonc
{
  "nodes": [
    {
      "id": "string",
      "position": { "x": 0, "y": 0, "z": 0 },  // meters, metric COLMAP frame
      "roomId": "string",
      "neighbors": ["string"]   // adjacent node IDs (bidirectional)
    }
  ]
}
```

---

## 6. Phased Milestones

### M0 — Environment & Toolchain Setup (1–2 days)
**Objective:** Confirm local reconstruction toolchain works end-to-end on a synthetic test scene.

| Task | Dependency |
|---|---|
| Install COLMAP (CLI or GUI) and verify `colmap feature_extractor` runs | None |
| Install nerfstudio or gaussian-splatting repo and verify training on provided sample | COLMAP poses |
| Install Three.js and `@mkkellogg/gaussian-splats-3d` viewer lib | None |
| Create `backends/tour/` directory skeleton | None |
| Add `npm run preflight:tour` stub | None |

**Exit criteria:** `npm run preflight:tour` runs without crash; COLMAP + 3DGS each produce output on the synthetic test scene.

---

### M1 — Reconstruction Pipeline (1 week)
**Objective:** Given a folder of dense listing photos, produce a metric COLMAP reconstruction and a trained 3DGS splat.

| Task | Dependency |
|---|---|
| `backends/tour/reconstruct.js`: wrap COLMAP SfM + MVS | M0 |
| `backends/tour/reconstruct.js`: train 3DGS on COLMAP poses | M0, COLMAP |
| Extract Poisson mesh from dense cloud for collider | COLMAP MVS |
| Output: `scene/splat.ksplat`, `scene/collider.glb` | 3DGS, MVS |
| Unit test: verify output files exist and are non-empty | All above |

**Exit criteria:** Running `node backends/tour/reconstruct.js --input inputs/listing-photos/` produces `scene/splat.ksplat` and `scene/collider.glb`.

---

### M2 — Navigation Graph Baking (3–4 days)
**Objective:** Derive a walk-node graph aligned to the metric reconstruction and floor plan.

| Task | Dependency |
|---|---|
| `backends/tour/bake-nav-graph.js`: project floor plan into metric frame | M1 |
| Sample nav nodes on floor surface (gravity-cast from ceiling-height down to floor mesh) | M1 collider |
| Remove nodes inside walls (cast outward 8 directions, reject if all blocked within 0.15 m) | M1 collider |
| Connect adjacent nodes (Delaunay + line-of-sight filter) | Node set |
| Map each node to a `roomId` from storyboard.json | Floor plan alignment |
| Output `nav/graph.json` | All above |

**Exit criteria:** Graph JSON validates against `schemas/tour.schema.json`; no node is inside geometry; all storyboard rooms have ≥1 node.

---

### M3 — WebGL Viewer (1–1.5 weeks)
**Objective:** A working browser viewer: splat render + navigation + free-look.

| Task | Dependency |
|---|---|
| `public/tour-viewer/index.html` + viewer scaffold (Three.js) | None |
| Load and render splat (`scene/splat.ksplat`) via `@mkkellogg/gaussian-splats-3d` | M1 |
| Load collision mesh (invisible), enable raycasting | M1 |
| Camera controller: snap-to-node on nav click, slerp transition 400 ms | M2 graph |
| Free-look drag (pointer lock on desktop, touch drag on mobile) | Camera controller |
| HUD: minimap (SVG floor plan + current node dot) | M2 graph |
| Dollhouse mode: orbit camera, room click → jump to nearest node | Camera controller |
| Floor-plan overlay toggle | Floor plan SVG |

**Exit criteria:** Browser opens `output/tour/index.html`; buyer can navigate all rooms; dollhouse transitions work; fps ≥30 on test device.

---

### M4 — Measurement Tool (2–3 days)
**Objective:** Point-to-point tape measure on reconstructed surfaces.

| Task | Dependency |
|---|---|
| Raycaster: on click project ray into collision mesh, record hit point | M3 viewer + M1 collider |
| First click sets anchor, second click completes measurement | Raycaster |
| Display line + distance label (ft + m) in world space | First/second hit |
| Clear button; disable in dollhouse mode | UI |

**Exit criteria:** Measured distance on a known-dimension test wall is within 3 cm of physical tape measure.

---

### M5 — Gauntlet Integration & Quality Bar (3–4 days)
**Objective:** Mode B has its own critic loop comparable to Mode A's 7-piece gauntlet.

| Task | Dependency |
|---|---|
| Add 3D-specific pieces to `config/pieces.json` (reconstruction-cleanliness, navigation-feel, load-time, dollhouse-accuracy, measurement-accuracy) | M3, M4 |
| Extend `src/compare-harness.js` to support frame-set captures from the 3D viewer | M3 |
| Gauntlet loop: critic compares our tour frames vs Matterport sample frames | Harness |
| `npm run gauntlet:tour` script | All above |

**Exit criteria:** `npm run gauntlet:tour` runs end-to-end; at least 3 of 5 pieces pass on a test listing.

---

### M6 — Dashboard Integration & Polish (3–4 days)
**Objective:** Mode selector in the shared dashboard; one-click local tour generation.

| Task | Dependency |
|---|---|
| Add Mode A / Mode B selector to `public/dashboard.html` | M3 viewer live |
| `src/preflight-tour.js`: Mode B input checks (coverage density, COLMAP availability) | M1 |
| `src/build-tour.js`: orchestrator that calls M1→M4 in sequence | M1–M4 |
| Progress bar for reconstruction (COLMAP can take 1–3 h — show live tail) | Dashboard |
| Update README + RUNBOOK for Mode B | All |
| Final QA: end-to-end from `inputs/` → `output/tour/index.html` | All |

**Exit criteria:** `npm run dashboard` → mode selector → drop photos → click "Build Tour" → `output/tour/index.html` opens in browser.

---

## 7. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Capture quality** — sparse, blurry, or low-overlap photos cause reconstruction failure | High | High | `preflight-tour.js` checks photo count (≥50 recommended) and EXIF for GPS/timestamp clustering; show coverage map in dashboard before running |
| **Metric scale calibration** — scale drift from COLMAP degrades measurement accuracy | Medium | High | Include a known-size reference object in at least one photo; or use GPS EXIF to anchor; measurement tool shows confidence indicator |
| **Reflective / transparent surfaces** — mirrors, windows, glass cause COLMAP artifacts | High | Medium | Document capture guidance (tape paper over mirrors); post-process: mask reflective regions via SAM segmentation before SfM |
| **Performance budget** — large splat (>200 MB) causes slow load or low fps on mobile | Medium | High | Cap splat at 150 MB via training iteration limit; serve compressed `.ksplat`; mobile fallback: render mesh-only at <30 fps threshold |
| **3DGS training time** — 30–60 min GPU blocks interactive use | Low (run offline) | Medium | Run reconstruction as async background job; dashboard shows progress; provide pre-baked demo scene for dev/test |
| **COLMAP unavailable on Windows without WSL** | Medium | Medium | Document WSL2 setup; provide Docker compose alternative; evaluate Meshroom as a no-build-needed alternative |
| **Floor-plan alignment drift** — metric frame and floor-plan SVG units mismatch | Medium | Medium | Auto-align via room-corner correspondences; expose a manual scale/offset correction UI in dashboard |

---

## 8. Local Development & Testing Strategy

### Prerequisites

```bash
# System deps
colmap --version          # ≥ 3.8
python3 -c "import nerfstudio"   # or gaussian-splatting repo
node --version            # ≥ 16
ffmpeg -version
```

### Demo / synthetic test scene

A small synthetic test scene (cube room, known dimensions) lives at `inputs/test-scene/` (added in M0). Used for unit tests without running full reconstruction:

```bash
npm run test:tour          # unit tests only (no GPU)
npm run dev:tour-demo      # runs reconstruction on test-scene → opens viewer
```

### Full pipeline local run

```bash
npm run preflight:tour
npm run build:tour         # reconstruction + nav bake + viewer build
npx serve output/tour      # open http://localhost:3000
```

### Playwright E2E tests (added in M3)

```bash
npm run test:tour:e2e      # headless browser: nav, dollhouse, measurement
```

### Viewer unit tests

Viewer modules (`public/tour-viewer/`) tested with Vitest (or Jest) against jsdom + a mock splat loader. No GPU required.
