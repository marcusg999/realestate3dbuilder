# Run the walkthrough pipeline fully locally (no Claude / no agent)

The whole pipeline runs on your machine. The only step that used to go through
the agent — **clip generation** — now calls the Higgsfield HTTP API directly with
your own key, via `src/generate-clips.js`. Once your key is set, the dashboard's
**Generate clips (Higgsfield)** button does everything locally.

## One-time setup

1. **Install dependencies** (includes the Higgsfield SDK):
   ```
   npm install
   ```

2. **Install ffmpeg** with the `drawtext` + `xfade` filters:
   ```
   brew install ffmpeg            # macOS — includes both
   ffmpeg -filters | grep -E 'drawtext|xfade'   # verify
   ```

3. **Get a Higgsfield API key pair** at <https://cloud.higgsfield.ai> (developer /
   API keys). You'll get a **key id** and a **key secret**.

4. **Create your `.env`** (gitignored) from the template:
   ```
   cp .env.example .env
   # then edit .env:
   #   HF_API_KEY=<your key id>
   #   HF_SECRET=<your key secret>
   ```

## Everyday flow (100% local)

```
npm run dashboard         # http://localhost:4300
```

In the dashboard:
1. Drop in **listing photos** (and floor plan), set the **Matterport URL** if you want.
2. Load/edit and **Save** the **storyboard** (Load example to start).
3. **Build shot plan.**
4. **Generate clips (Higgsfield)** — uploads each photo, runs image-to-video, and
   saves clips to `work/clips/`. Spends credits; a few rooms take a few minutes.
5. **Assemble** → the finished `output/walkthrough.mp4` appears in the player.

Or from the terminal:
```
npm run preflight     # checks inputs + ffmpeg + that your HF key is set
npm run plan          # storyboard -> work/shot-plan.json
npm run generate      # -> work/clips/<id>.mp4   (Higgsfield; spends credits)
npm run assemble      # -> output/walkthrough.mp4
```

## `generate` options

```
node src/generate-clips.js              # only the clips that don't exist yet (safe to re-run)
node src/generate-clips.js --dry-run    # print exactly what would be sent — NO API calls, NO credits
node src/generate-clips.js --only kitchen-island
node src/generate-clips.js --force      # regenerate everything (spends credits)
```

- **Always `--dry-run` first** to confirm the shots, photos, and prompts before spending credits.
- Re-running is safe: existing clips are skipped unless you pass `--force`.
- Which model runs is set by `config/pipeline.config.json → higgsfield.dopModel`
  (`turbo` | `lite` | `standard`).

## Notes / limits

- Node **18+** required (uses built-in `fetch`).
- Clip length is set by the DoP model; `assemble` trims each clip to its storyboard
  `durationSec`. If a generated clip is shorter than the storyboard asks, the segment
  is just that clip's length.
- Credentials are read from `.env` (or real environment variables) — either
  `HF_API_KEY`/`HF_SECRET` or `HIGGSFIELD_API_KEY`/`HIGGSFIELD_API_SECRET`.
- No key yet? Use **Generate placeholder clips (test)** to exercise the full
  pipeline with local ffmpeg footage — no key, no credits.
- API shapes are built against `@higgsfield/client@0.2.x`. If Higgsfield changes the
  DoP endpoint or model names, adjust `src/generate-clips.js` and
  `config/pipeline.config.json`.
