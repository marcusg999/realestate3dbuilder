# Runbook — Listing Walkthrough Studio: walkthrough-video generation step

This is the turnkey procedure for producing one assembled walkthrough video from
an approved storyboard + listing photos + floor plan, and running the
builder/critic gauntlet until each piece beats the reference bar blind.

**Nothing here runs until the inputs are present.** `src/preflight.js` is the gate.

---

## 0. One-time environment

- **Node** ≥ 16.
- **ffmpeg + ffprobe** on `PATH` (or set `FFMPEG_BIN`/`FFPROBE_BIN`, or fill
  `config/pipeline.config.json`). The build **must include the `drawtext`
  filter** (needed for captions) and `xfade` (transitions). Verify:
  `ffmpeg -filters | grep -E 'drawtext|xfade'`. The johnvansickle static build
  omits `drawtext`; the BtbN `*-gpl` build includes both.
- **Higgsfield MCP** reachable with credits (clip generation).

## 1. Drop in the inputs

| Put | Where |
|-----|-------|
| Reference frames (the quality **bar**) | `inputs/reference-frames/*.png\|jpg` |
| Matterport sample URL (live fallback bar) | one line in `inputs/matterport.url.txt` |
| Listing photos (source imagery) | `inputs/listing-photos/*.jpg\|png` |
| Floor plan | `inputs/floorplan/*` |
| Approved storyboard | `inputs/storyboard.json` (shape: `inputs/storyboard.example.json`, schema: `schemas/storyboard.schema.json`) |

## 2. Preflight (the gate)

```
node src/preflight.js        # exits non-zero and lists what's missing until ready
```

## 3. Build the shot plan

```
node src/build-shot-plan.js  # inputs/storyboard.json -> work/shot-plan.json
```

Each entry has a `higgsfield` block that maps directly onto a `generate_video`
call, and an `outClip` path the clip must be saved to.

## 4. Generate clips (Higgsfield MCP — done by the orchestrating agent)

For every shot in `work/shot-plan.json`:
- Call the Higgsfield MCP `generate_video` (image-to-video) with
  `spec.higgsfield` (`startImage`, `prompt`, `motion`, `seconds`, `aspect`).
  If unsure of the model, `models_explore(action:'recommend')` first.
- Save the returned clip to `spec.outClip` (`work/clips/<id>.mp4`).

Independent shots can be generated in a batch (`generate_video_batch` +
`jobs_wait`).

## 5. Assemble

```
node src/assemble.js         # work/clips/* -> output/walkthrough.mp4
node src/progress.js         # refresh the progress board
```

`output/walkthrough.mp4` is the always-current assembled walkthrough.

---

## 6. The gauntlet (per piece, looped)

Pieces are defined in `config/pieces.json`. Loop each **independently**, with a
**fresh-context builder** and a **separate fresh-context critic** every round.

`node src/gauntlet.js` prints the plan. The loop for one piece:

**Builder subagent** (fresh context) — prompt template:
> You are improving ONE piece of a real-estate walkthrough video: **{piece.title}**.
> It is judged on: {piece.judged}. Your tunable knobs: {piece.knobs}.
> Current render: `output/walkthrough.mp4`. Latest critic verdict + biggest gap:
> "{criticVerdict}" / "{remainingGap}".
> Change ONLY this piece's knobs to close that gap. For camera-motion/framing,
> adjust the shot's `motion`/`framing` in the storyboard and regenerate the
> affected clip(s) via Higgsfield; for pacing/color/captions/transitions/assembly,
> adjust `config/pieces.json` knobs and/or the storyboard and re-run
> `node src/assemble.js`. Do not touch other pieces. Report exactly what you changed.

**Critic subagent** (fresh context, harsh) — prompt template:
> You are a harsh critic. Do NOT praise. Open EVERY image in
> `inputs/reference-frames/` and load the Matterport sample at the URL in
> `inputs/matterport.url.txt` in a browser. Play `output/walkthrough.mp4`.
> Then run `node src/compare-harness.js` and open the blind items in
> `work/compare-frames/` (labels stripped). Rank them for: "which looks like a
> frame from a professional property walkthrough a listing agent would send a
> high-end client?" ONLY THEN open `work/compare-frames/ANSWER-KEY.sealed.json`.
> Judge specifically on **{piece.title}** ({piece.judged}, rubric: {piece.rubric}).
> Output: (1) did OURS win blind — yes/no; (2) whether it improved vs last round;
> (3) the SINGLE biggest remaining gap in one sentence. Hand back to the builder.

After each round, record it:
```
node -e "require('./src/gauntlet').recordRound('<piece-id>', {won:<bool>, improved:<bool>, verdict:'...', remainingGap:'...', bestRender:'output/walkthrough.mp4'})"
node src/progress.js
```

**Stop conditions** (enforced by `gauntlet.shouldStop`):
- Critic picks **OURS** blind → piece `won`. Stop.
- **3 consecutive non-improving rounds** → piece `flagged`. Stop looping it,
  surface the current render + named remaining gap to the human, move to the next
  piece. Do not loop forever.

## 7. Keep it live

Re-run `node src/progress.js` after every round. `progress.html` shows each
piece's status, rounds, critic verdict, remaining gap, and best render, and keeps
`output/walkthrough.mp4` embedded and playable throughout.

## Piece → knob map (what each builder is allowed to touch)

| Piece | Edits | Regenerate? |
|-------|-------|-------------|
| camera-motion | storyboard `motion` (preset/speed/intensity) | yes, affected clips |
| framing | storyboard `sourcePhoto`/`framing` | yes, affected clips |
| transitions | storyboard `transitionIn` | no (assemble only) |
| pacing | storyboard `durationSec`/`isHero`, `pieces.pacing` | no (assemble only) |
| color | `pieces.color` + per-shot color params passed to assemble | no (assemble only) |
| captions | `pieces.captions`, storyboard `caption` | no (assemble only) |
| assembly | storyboard shot order, `pieces.assembly`, music bed | no (assemble only) |
