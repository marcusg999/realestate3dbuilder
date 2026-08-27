# realestate3dbuilder — Listing Walkthrough Studio

Builds one assembled property **walkthrough video** from an approved storyboard +
the listing's photos + floor plan, tuned to match professional property
walkthroughs.

> **Two-mode direction:** this is **Mode A — Cinematic Walkthrough Video** (shipped).
> **Mode B — Interactive 3D Tour** (Matterport-style) is planned behind the same
> shared intake. See **[ROADMAP.md](ROADMAP.md)**.

## Mode B status — Interactive 3D Tour

| | |
|---|---|
| **Status** | Planning — implementation has not started |
| **Goal** | Matterport-style navigable tour: click-to-move, free-look, dollhouse view, room measurement |
| **Reconstruction** | COLMAP (metric poses) + 3D Gaussian Splatting (photoreal render) + lightweight mesh collider |
| **Viewer** | Three.js / WebGL, self-contained static output at `output/tour/` |
| **Milestones** | M0 Toolchain → M1 Reconstruction → M2 Nav graph → M3 Viewer → M4 Measurement → M5 Gauntlet → M6 Dashboard |

Planning documents:

- **[docs/MODE_B_IMPLEMENTATION_PLAN.md](docs/MODE_B_IMPLEMENTATION_PLAN.md)** — scope, acceptance criteria, architecture, reconstruction strategy, data contracts, milestone objectives, risks
- **[docs/MODE_B_TECHNICAL_DESIGN.md](docs/MODE_B_TECHNICAL_DESIGN.md)** — module layout, render-backend interface, viewer subsystem design, performance targets, security notes
- **[docs/MODE_B_TASK_CHECKLIST.md](docs/MODE_B_TASK_CHECKLIST.md)** — granular task checklist by milestone with effort estimates and critical-path notes

This repo currently contains the **walkthrough-video generation step scaffold**:
the full pipeline code and the builder/critic gauntlet harness, ready to run the
moment real assets are dropped in. **No AI generation runs by itself** — clip
generation is driven through the Higgsfield MCP by the orchestrating agent, and
the gate (`src/preflight.js`) blocks until inputs are present.

## Pipeline

```
inputs/storyboard.json ─┐
inputs/listing-photos/ ─┼─► build-shot-plan ─► Higgsfield generate_video ─► work/clips/
inputs/floorplan/ ──────┘                                                        │
                                                                                 ▼
        progress.html ◄── progress ◄── state.json          assemble (ffmpeg) ─► output/walkthrough.mp4
                                         ▲                          │
                                         │                          ▼
        gauntlet (builder+critic loop) ──┴──────── compare-harness (blind vs bar)
```

## The seven judgeable pieces

Each is built and judged on its own, looped until a harsh critic picks **ours**
over the reference bar **blind**, or flagged after 3 non-improving rounds
(`config/pieces.json`):

1. **camera-motion** — smoothness, speed, natural path, no warping
2. **transitions** — room-to-room handoffs, match cuts
3. **framing** — composition, level horizon, hero feature
4. **pacing** — hold time vs. reveal, cut rhythm
5. **color** — lighting/white-balance consistency across clips
6. **captions** — lower-third / room-label treatment
7. **assembly** — sequence, total length vs. property size, music

## Intake dashboard (recommended)

A local drag-drop dashboard to drop in every asset, set the Matterport URL,
edit/save the storyboard, watch preflight go green, run the pipeline steps, and
play the latest render — no dependencies:

```
npm run dashboard              # -> http://localhost:4300
```

Drop reference frames, listing photos, and the floor plan into their zones; paste
the Matterport URL; load/edit the storyboard; then **Build shot plan → Generate
clips (Higgsfield) → Assemble** — all local, no agent. Set your Higgsfield API key
once in `.env` (see **[docs/HIGGSFIELD_SETUP.md](docs/HIGGSFIELD_SETUP.md)**). No
key yet? Use **Generate placeholder clips (test)** to preview the pipeline with no
credits.

## Quick start (CLI)

```
node src/preflight.js          # gate: lists missing inputs until ready
node src/build-shot-plan.js    # storyboard -> work/shot-plan.json
# (agent) generate each shot via Higgsfield MCP -> work/clips/<id>.mp4
node src/assemble.js           # -> output/walkthrough.mp4
node src/progress.js           # -> progress.html (live board)
```

Full procedure incl. the gauntlet subagent prompts: **[RUNBOOK.md](RUNBOOK.md)**.

## Try the mechanics with no assets / no credits

Generates local ffmpeg placeholder clips (not Higgsfield) and runs the whole
assembly + progress path end-to-end:

```
npm run dev:demo               # -> output/walkthrough.mp4 + progress.html
```

## Requirements

- Node ≥ 16
- ffmpeg/ffprobe with the `drawtext` and `xfade` filters
  (`ffmpeg -filters | grep -E 'drawtext|xfade'`; BtbN `*-gpl` static build has both)
- Higgsfield MCP with credits (clip generation, for real runs)

## Layout

```
config/pieces.json          seven pieces: knobs, critic rubric, gauntlet state
config/pipeline.config.json paths, video/audio settings, ffmpeg resolution
schemas/storyboard.schema.json   input contract
inputs/                     reference-frames/, listing-photos/, floorplan/, storyboard.json
src/dashboard.js            local drag-drop intake + control dashboard
public/dashboard.html       dashboard front-end
src/preflight.js            input gate
src/build-shot-plan.js      storyboard -> Higgsfield generation specs
src/assemble.js             clips + captions + transitions + color + music -> walkthrough
src/compare-harness.js      blind ours-vs-bar frame set for the critic
src/gauntlet.js             loop rules (win / 3-round flag) + dry-run plan
src/progress.js             live progress board
src/lib/                    ffmpeg, captions, transitions, color, state, config
work/  output/              generated (gitignored)
```
