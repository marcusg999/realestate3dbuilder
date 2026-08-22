# realestate3dbuilder — Listing Walkthrough Studio

Builds one assembled property **walkthrough video** from an approved storyboard +
the listing's photos + floor plan, tuned to match professional property
walkthroughs.

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

## Quick start

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
src/preflight.js            input gate
src/build-shot-plan.js      storyboard -> Higgsfield generation specs
src/assemble.js             clips + captions + transitions + color + music -> walkthrough
src/compare-harness.js      blind ours-vs-bar frame set for the critic
src/gauntlet.js             loop rules (win / 3-round flag) + dry-run plan
src/progress.js             live progress board
src/lib/                    ffmpeg, captions, transitions, color, state, config
work/  output/              generated (gitignored)
```
