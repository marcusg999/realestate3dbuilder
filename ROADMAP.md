# Roadmap & Architecture — two-mode Listing Walkthrough Studio

realestate3dbuilder turns a listing's assets into a property walkthrough. It is
built to ship **two complementary output modes** from one shared intake, so an
agent can hand a buyer both a push asset and a pull asset.

| | **Mode A — Cinematic Walkthrough Video** | **Mode B — Interactive 3D Tour** |
|---|---|---|
| Status | **Shipped** (this repo) | **Planned** — starts after Mode A is tested on real listings |
| What it is | A fixed `.mp4` film: AI camera-motion clips through each room, cut together with transitions/captions/pacing/color | A navigable Matterport-style model: viewer steers the camera, free-look, dollhouse/floor views |
| Feels like | *Watching* a professional property film | *Exploring* the space yourself |
| Sales role | Push — email / social / MLS, autoplays, sells the feel in 60–90s | Pull — serious buyer explores on their own time |
| Render backend | Higgsfield image-to-video → ffmpeg assembly | 3D reconstruction (photogrammetry / gaussian splatting) → WebGL viewer |
| Viewer | Any video player | Web (Three.js / WebGL canvas) |

## Why both

They're complementary, not redundant. The video wins attention and travels
well; the interactive tour converts intent once a buyer is engaged. Agents want
both, and this repo is structured so the second mode is an addition, not a
rewrite.

## Shared architecture (the seam that makes "both" cheap)

Everything **upstream of rendering is shared** and format-agnostic:

```
                 ┌─────────────────── shared intake ───────────────────┐
                 │  dashboard (npm run dashboard)                        │
  listing photos │  reference frames · listing photos · floor plan       │
  floor plan     │  Matterport sample URL · approved storyboard/rooms    │
  storyboard     │  preflight gate                                       │
                 └───────────────────────┬──────────────────────────────┘
                                         │  same room/shot model
                          ┌──────────────┴───────────────┐
                          ▼                               ▼
              Mode A render backend            Mode B render backend
        (Higgsfield clips → ffmpeg)     (reconstruction → WebGL viewer)
                          ▼                               ▼
              output/walkthrough.mp4          output/tour/ (viewer + model)
```

Shared, already built: `src/dashboard.js` + `public/dashboard.html` (intake),
`inputs/` (photos, floor plan, storyboard), `schemas/storyboard.schema.json`
(room/shot model), `src/preflight.js` (gate), `config/pieces.json` (per-piece
gauntlet — the video pieces today; a 3D piece set can be added alongside).

Mode-specific: only the **render backend** differs. Mode A =
`build-shot-plan.js` + `assemble.js`. Mode B will be a sibling module behind the
same room model.

### The render-backend interface (to define when Mode B starts)

Introduce a thin contract both backends implement, e.g. `renderBackend.build(rooms, inputs, config)`:
- **Mode A** (`backends/video/`): rooms → shot specs → Higgsfield clips → ffmpeg → `walkthrough.mp4`
- **Mode B** (`backends/tour/`): rooms + photo sets → reconstruction → `tour/` (WebGL viewer + model + navigation graph)

The dashboard gains a mode selector; preflight grows mode-specific input checks
(Mode B needs denser coverage — see below).

## Mode B — notes for when we start

- **Capture matters most.** A cinematic video needs one good photo per room; a
  faithful 3D reconstruction needs **dense, overlapping coverage** per room (or a
  slow video pan). If listings are shot with Mode B in mind, capture denser from
  the start — retrofitting from sparse photos limits fidelity.
- **Reconstruction options** (evaluate at kickoff): classical photogrammetry
  (COLMAP-style) for meshes; **gaussian splatting** for photoreal free-viewpoint
  playback; or a hosted capture SDK. Trade fidelity vs. compute vs. capture effort.
- **Viewer**: web-based (Three.js / WebGL), navigation constrained to a walk
  graph + free-look, with dollhouse and floor-plan views. Floor plan (already an
  intake asset) drives room labels and the navigation map.
- **Quality bar**: same method as Mode A — a harsh critic loop against the
  Matterport sample, judged blind, but on 3D-specific pieces (reconstruction
  cleanliness, navigation feel, load time, dollhouse accuracy).

## Sequence

1. **Now:** test Mode A on real listings (drop assets in the dashboard → generate
   clips via the agent → run the gauntlet).
2. **Then:** kick off Mode B — define the render-backend interface, pick a
   reconstruction approach, build the WebGL viewer, add a 3D piece set to the
   gauntlet. **Planning docs:** [docs/MODE_B_IMPLEMENTATION_PLAN.md](docs/MODE_B_IMPLEMENTATION_PLAN.md), [docs/MODE_B_TECHNICAL_DESIGN.md](docs/MODE_B_TECHNICAL_DESIGN.md), [docs/MODE_B_TASK_CHECKLIST.md](docs/MODE_B_TASK_CHECKLIST.md).
3. **Ship both** behind the shared dashboard with a mode selector.
