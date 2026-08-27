# Mode B — Interactive 3D Tour: Task Checklist

> Track execution here. Check off each task as it lands on `main`.  
> Effort ranges are p50 estimates for one developer familiar with the codebase.  
> See [MODE_B_IMPLEMENTATION_PLAN.md](MODE_B_IMPLEMENTATION_PLAN.md) for milestone objectives and exit criteria.  
> See [MODE_B_TECHNICAL_DESIGN.md](MODE_B_TECHNICAL_DESIGN.md) for module interfaces and design details.

---

## Critical Path

```
M0 (toolchain) → M1 (reconstruction) → M2 (nav graph) → M3 (viewer) → M5 (gauntlet) → M6 (dashboard)
                                                           └──────────────► M4 (measurement)
```

M4 depends only on M3 (viewer + collider) and can start in parallel with M5.

---

## M0 — Environment & Toolchain Setup

**Estimated effort: 1–2 days**

- [ ] Install COLMAP locally and verify `colmap feature_extractor --help` runs
- [ ] Install nerfstudio (or clone `gaussian-splatting` repo) and verify `ns-train` or `train.py` is executable
- [ ] Install `@mkkellogg/gaussian-splats-3d` npm package and confirm it can be imported
- [ ] Install Three.js r165+ and confirm it imports cleanly
- [ ] Create `backends/tour/` directory with `index.js`, `reconstruct.js`, `bake-nav-graph.js`, `build-viewer.js` stubs
- [ ] Create `src/preflight-tour.js` stub (checks COLMAP, Python, nerfstudio, photo count ≥50)
- [ ] Create `src/build-tour.js` stub (calls backends/tour/index.js, not implemented)
- [ ] Add `inputs/test-scene/` with ≥20 synthetic cube-room photos for offline testing
- [ ] Add `npm run preflight:tour`, `npm run build:tour`, `npm run dev:tour-demo` scripts to `package.json`
- [ ] Verify `npm run preflight:tour` exits 0 (stub) and 1 when COLMAP is missing
- [ ] Update `.gitignore` to exclude `output/tour/` and any 3DGS checkpoint directories

---

## M1 — Reconstruction Pipeline

**Estimated effort: 1 week**  
**Critical path: blocks M2, M3, M4**

### COLMAP SfM

- [ ] `backends/tour/reconstruct.js`: spawn `colmap feature_extractor` on `inputs/listing-photos/`
- [ ] Spawn `colmap exhaustive_matcher` (or `sequential_matcher` for video input)
- [ ] Spawn `colmap mapper` → produces sparse model in `work/colmap/sparse/`
- [ ] Spawn `colmap image_undistorter` → undistorted images for MVS
- [ ] Spawn `colmap patch_match_stereo` → dense depth maps
- [ ] Spawn `colmap stereo_fusion` → `work/colmap/dense/fused.ply` (dense point cloud)
- [ ] Verify metric scale: parse `cameras.bin` focal length vs EXIF sensor size; emit warning if mismatch >10%

### Mesh extraction

- [ ] Run `colmap poisson_mesher` on dense cloud → `work/colmap/dense/meshed-poisson.ply`
- [ ] Post-process: decimate to ≤50k triangles using Open3D or Blender CLI
- [ ] Export `scene/collider.glb` from decimated mesh

### 3DGS Training

- [ ] `backends/tour/reconstruct.js`: invoke nerfstudio `ns-train gaussian-splatting` with COLMAP poses
- [ ] Cap training to 30k iterations (≈30 min on RTX 3060)
- [ ] Export `.ksplat` (compressed) using `ksplat-encoder` or `@mkkellogg/gaussian-splats-3d` converter
- [ ] Output `scene/splat.ksplat`

### Tests

- [ ] Unit test: `reconstruct.js` called with `inputs/test-scene/` produces `scene/splat.ksplat` and `scene/collider.glb`
- [ ] Unit test: output files are non-empty (>1 KB)
- [ ] Unit test: `manifest.json` `bounds` field is populated and non-zero

---

## M2 — Navigation Graph Baking

**Estimated effort: 3–4 days**  
**Critical path: blocks M3 nav, M4**

- [ ] `backends/tour/bake-nav-graph.js`: load `scene/collider.glb` via Three.js (Node.js headless)
- [ ] Load and parse floor plan SVG; detect room polygons from layer names or storyboard.json `rooms[].floorplanRegion`
- [ ] Align floor plan 2D to COLMAP metric 3D frame (manual scale/offset from config, or auto via corner correspondences)
- [ ] Sample nav node candidates: grid at 0.8 m spacing across floor bounding box
- [ ] Gravity-cast each candidate downward from ceiling height; keep hits within 0.1–2.5 m above floor
- [ ] Wall rejection: cast 8 horizontal rays from each candidate; reject if ≥6 are blocked within 0.15 m
- [ ] Build adjacency: connect nodes within 2.5 m that have clear line-of-sight (raycasted)
- [ ] Delaunay triangulation + LoS filter to prune crossing edges
- [ ] Map each node to a `roomId` from storyboard.json via floor-plan polygon containment
- [ ] Verify every storyboard room has ≥1 node; emit error if not
- [ ] Write `nav/graph.json` and validate against `schemas/tour.schema.json`
- [ ] Write `floorplanTransform` affine matrix into `manifest.json`
- [ ] Unit test: all nodes are ≥0.1 m above floor and ≤2.5 m above floor
- [ ] Unit test: no node penetrates a wall face (dot-product test)
- [ ] Unit test: every storyboard room maps to ≥1 node

---

## M3 — WebGL Viewer

**Estimated effort: 1–1.5 weeks**  
**Critical path: blocks M4, M5, M6**

### Scaffold

- [ ] `public/tour-viewer/index.html`: minimal HTML, load `viewer.bundle.js`
- [ ] `public/tour-viewer/viewer.js`: Three.js scene init, resize handling
- [ ] `public/tour-viewer/SceneLoader.js`: fetch manifest → parallel-load splat + collider + nav graph; emit progress events
- [ ] `public/tour-viewer/styles.css`: full-viewport canvas, HUD overlays

### Camera & Navigation

- [ ] `public/tour-viewer/CameraController.js`: `setMode('walk' | 'dollhouse' | 'floorplan')`
- [ ] Walk mode: click nav node neighbor → slerp position 400 ms, preserve look direction
- [ ] Walk mode: pointer-lock free-look on desktop (mouse drag)
- [ ] Walk mode: touch-delta free-look on mobile
- [ ] Inertia: ease-out yaw/pitch after fast drag
- [ ] `public/tour-viewer/NavGraph.js`: load `nav/graph.json`; `nearest()`, `neighbors()`, `pathTo()`, `roomOf()`
- [ ] Render nav node dots in walk mode (visible arrows/circles on floor); hide in dollhouse

### Dollhouse Mode

- [ ] `public/tour-viewer/DollhouseMode.js`: swap splat→mesh; OrbitControls active
- [ ] Per-room mesh coloring from storyboard room data
- [ ] Room hover highlight (emissive tint)
- [ ] Room click → `CameraController.setMode('walk')` at nearest node
- [ ] Pinch-zoom + rotate on mobile

### Floor-Plan Overlay

- [ ] `public/tour-viewer/MiniMap.js`: SVG overlay bottom-left
- [ ] Compute affine transform from `manifest.json.floorplanTransform`
- [ ] Update position dot on every nav transition
- [ ] Toggle show/hide via HUD button

### HUD & UI

- [ ] Dollhouse button (top-right)
- [ ] Floor-plan button (top-right)
- [ ] Room label (top-left, updates on nav)
- [ ] Loading progress bar (full-screen overlay until 100%)

### Tests

- [ ] Playwright E2E: `npx playwright test` — opens `output/tour/index.html` (served), clicks 3 nav nodes, asserts room label changes
- [ ] Playwright E2E: dollhouse button → orbit → click room → walk mode enters
- [ ] Vitest unit test: `NavGraph.nearest()` returns correct node for known position
- [ ] Vitest unit test: `NavGraph.pathTo()` returns a connected path

---

## M4 — Measurement Tool

**Estimated effort: 2–3 days**  
**Can run in parallel with M5 after M3 is complete**

- [ ] `public/tour-viewer/MeasurementTool.js`: state machine `idle → anchor-placed → measurement-complete`
- [ ] Raycaster: `THREE.Raycaster` against hidden collider mesh on click
- [ ] Place anchor sphere (small semi-transparent sphere) at first hit
- [ ] Place second sphere at second hit
- [ ] Draw `THREE.Line` between the two points
- [ ] `THREE.CSS2DObject` label: `"X.XX m / X.XX ft"`
- [ ] "Clear measurement" button in HUD (appears after first click)
- [ ] Disable measurement tool in dollhouse and floorplan modes
- [ ] Unit test: `distanceTo()` on two known points returns correct value to within 0.001 m
- [ ] Manual QA checklist: measure a wall in the test scene; compare to known dimension

---

## M5 — Gauntlet Integration & Quality Bar

**Estimated effort: 3–4 days**

- [ ] Define 5 tour-specific pieces in `config/pieces.json` (add alongside existing video pieces, do not remove):
  - `reconstruction-cleanliness` (artifacts, holes, blurry regions)
  - `navigation-feel` (transition smoothness, node density)
  - `load-time` (seconds to interactive on test connection)
  - `dollhouse-accuracy` (room shape vs floor plan)
  - `measurement-accuracy` (cm error vs known reference)
- [ ] Extend `src/compare-harness.js` to capture frame sets from the 3D viewer via Playwright screenshots
- [ ] Critic prompt for each 3D piece (analogous to existing video piece prompts)
- [ ] Gauntlet loop: `src/gauntlet.js` accepts `--mode tour`; runs critic on each 3D piece
- [ ] Add `npm run gauntlet:tour` script to `package.json`
- [ ] Verify gauntlet loop runs end-to-end on test scene (doesn't require Matterport access)

---

## M6 — Dashboard Integration & Polish

**Estimated effort: 3–4 days**

- [ ] `public/dashboard.html`: add Mode A / Mode B radio selector to the top of the pipeline controls section
- [ ] Mode selector persists in localStorage
- [ ] Mode B pipeline buttons: "Preflight (Tour)" → "Build Tour" (replaces "Build shot plan" + "Generate clips" + "Assemble" for Mode B)
- [ ] Progress tail: stream `backends/tour/reconstruct.js` stdout to dashboard log panel (SSE or websocket from `src/dashboard.js`)
- [ ] `src/preflight.js`: route to `src/preflight-tour.js` when mode = B
- [ ] `src/build-tour.js`: full orchestrator (not stub); calls `backends/tour/index.js`
- [ ] "Open Tour" button in dashboard that opens `output/tour/index.html` in new tab after successful build
- [ ] Update `RUNBOOK.md` with Mode B end-to-end procedure
- [ ] Update `README.md` Mode B status section to "Beta — see RUNBOOK.md"
- [ ] Manual QA: full end-to-end from `npm run dashboard` → drop photos → Build Tour → tour opens in browser

---

## Cross-Cutting / Ongoing

- [ ] All new JS files pass existing ESLint config (run `npm run lint` if configured)
- [ ] `output/tour/` confirmed in `.gitignore` before any real listing data is processed
- [ ] `inputs/test-scene/` photos are synthetic (not real listing data) — safe to commit
- [ ] Security: `npm audit` passes with 0 high/critical after adding viewer deps
- [ ] Documentation: each new `src/` and `backends/` file has a one-line header comment describing its role

---

## Effort Summary

| Milestone | Estimate | Critical path |
|---|---|---|
| M0 — Toolchain | 1–2 days | Yes |
| M1 — Reconstruction | 5–7 days | Yes |
| M2 — Nav graph | 3–4 days | Yes |
| M3 — Viewer | 7–10 days | Yes |
| M4 — Measurement | 2–3 days | No (parallel with M5) |
| M5 — Gauntlet | 3–4 days | Yes |
| M6 — Dashboard | 3–4 days | Yes |
| **Total** | **~4–6 weeks** | |

Assumes one developer, no major blockers with GPU hardware or COLMAP installation.
