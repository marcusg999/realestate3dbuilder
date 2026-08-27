# Generate clips via the Higgsfield MCP (agent-driven)

This is the **second** of the two clip-generation paths. It does not need a
Higgsfield API key in `.env` — it uses the Higgsfield **MCP** connection that is
attached to a Claude Code session. Use it when you'd rather have the agent drive
generation than run the local key-based script.

> The **first** path — fully local, no agent — is `src/generate-clips.js` with
> your own key in `.env`. See `docs/HIGGSFIELD_SETUP.md`. That one is the
> everyday, self-sufficient path. This MCP path is the agent-driven alternative.

## The one thing to understand first

**An MCP tool belongs to the agent session it is connected to — it is not a
server a local script can call.** So there is no standalone
`node src/…-mcp.js` that can "use the MCP." If a Higgsfield MCP shows up in your
Claude Code session, it's *Claude* that can call `generate_video`, not a Node
process on your machine. Anything shaped like "spawn a local MCP server and JSON‑RPC
to it" will not reach the session's Higgsfield connection.

Two consequences:

- To generate this way, you ask the **agent** (in the session that has the
  Higgsfield MCP) to run the plan. The steps below are what the agent does.
- The **credits are spent on whatever Higgsfield account the MCP is signed into**,
  which may be different from your personal API-key balance. Check with the
  `balance` MCP tool before spending.

## What the agent needs from you

The MCP generates from an image. In a **remote** Claude Code session the MCP
**cannot read images you attach in chat** — it can only take:

- a **file** it can upload with `media_upload` (a photo present on the session's
  filesystem, e.g. committed under `inputs/listing-photos/`), or
- a **public URL** it can pull with `media_import_url` (a direct image link, or a
  listing page).

So: commit your listing photos into `inputs/listing-photos/` (and build the
storyboard from them), **or** hand the agent public URLs for each room photo.

## The flow the agent runs

1. **Plan.** `node src/build-storyboard.js` then `node src/build-shot-plan.js`.
   This writes `work/shot-plan.json` — one spec per shot, each with a
   `higgsfield` block (start image + prompt + motion) and an `outClip` path.
2. **Confirm cost.** `balance` to see credits; pick the model (below). Surface the
   expected spend **before** generating.
3. **Per shot**, in order:
   - Get a media id for the shot's photo: `media_upload` (local file) or
     `media_import_url` (public URL).
   - `generate_video` with `medias:[{ role:'start_image', media_id }]`,
     `prompt: spec.higgsfield.prompt`, the chosen `model`, `aspect_ratio:'16:9'`,
     `duration` from the spec, `sound:'off'` (we add the music bed in assembly).
   - Wait for it (`jobs_wait`), then download the result to `spec.outClip`
     (`work/clips/<id>.mp4`).
   - Batch independent shots with `generate_video_batch` + `jobs_wait`.
4. **Assemble.** `node src/assemble.js` → `output/walkthrough.mp4`.

`assemble.js` already trims each clip to its storyboard `durationSec` and stitches
transitions/captions/music, so the MCP path and the local-key path converge on the
exact same assembly step.

## Model pick

For real-estate interiors the failure mode is warping — bent straight lines,
melting cabinetry. Prefer a model tuned for controlled cinematic camera over one
tuned for dramatic motion:

- **`cinematic_studio_video_v2`** (Higgsfield — "Cinema Studio Video", refined
  cinematic camera + color). Good default. `mode:'std'`, `sound:'off'`.
- **`kling3_0`** (Kling v3.0) — cinematic, multi-shot; capable but more prone to
  motion drift on static interiors. Use `sound:'off'` to lower credits.

Confirm the current shortlist at run time with
`models_explore(action:'recommend', input:'image', type:'video', query:'…')` — model
availability changes.

## Why there is no `generate-clips-mcp.js` here

An earlier attempt at a standalone `src/generate-clips-mcp.js` tried to JSON‑RPC to
a local MCP server URL. That can't work for the reason at the top — the session's
Higgsfield MCP is not a local server. The supported paths are exactly two: the
**local key-based** `src/generate-clips.js`, and this **agent-driven MCP** flow.
