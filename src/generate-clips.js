'use strict';
// Local, self-sufficient clip generation via the Higgsfield HTTP API — NO agent,
// NO MCP, NO Claude. Reads work/shot-plan.json and, for each shot: uploads its
// source photo, runs image-to-video (DoP), and downloads the result to
// spec.outClip (work/clips/<id>.mp4). Then run `node src/assemble.js`.
//
// Built against @higgsfield/client v0.2.x (verified API surface):
//   client.uploadImage(buffer, 'jpeg'|'png'|'webp') -> public_url
//   client.generate('/v1/image2video/dop', { model, prompt, input_images:[InputImage.fromUrl(url)] }, { withPolling:true })
//   jobSet.jobs[0].results.raw.url -> the finished mp4
//
// Credentials (either pair works): HF_API_KEY + HF_SECRET, or
// HIGGSFIELD_API_KEY + HIGGSFIELD_API_SECRET. Put them in a local .env (gitignored)
// or export them before running.
//
// Usage:
//   node src/generate-clips.js              # generate only the clips that don't exist yet
//   node src/generate-clips.js --force      # regenerate all (spends credits)
//   node src/generate-clips.js --only kitchen-island
//   node src/generate-clips.js --dry-run    # print exactly what would be sent; NO API calls, NO credits
//   node src/generate-clips.js --resume     # poll jobs already submitted (after a timeout) WITHOUT re-charging
//   node src/generate-clips.js --concurrency 4   # how many clips to render at once (default: config higgsfield.concurrency, else 3)
//
// Batch runner: shots are processed by a pool of workers, so several clips
// upload/render/download concurrently instead of strictly one at a time. The
// pool self-throttles to higgsfield.maxConcurrent (the provider's per-account
// cap) and, if a submission is still rate-limited, re-queues that shot with
// backoff rather than failing it — so a whole property runs from one click /
// one button press. The dashboard's "Generate clips" button runs exactly this.
//
// Renders run on Higgsfield's servers and can take several minutes. Each shot is
// submitted, its job id saved to work/jobs/, then polled up to
// higgsfield.maxPollMinutes (config). If that window is exceeded the render keeps
// going server-side and the job is kept — re-run with --resume to finish it
// without spending credits again.

const fs = require('fs');
const path = require('path');
const { ROOT, abs, loadConfig } = require('./lib/config');

const MISSING_KEY = [
  'Higgsfield credentials not set.',
  'Set HF_API_KEY and HF_SECRET (or HIGGSFIELD_API_KEY / HIGGSFIELD_API_SECRET),',
  'either exported in your shell or in a local .env file (gitignored). See docs/HIGGSFIELD_SETUP.md.',
].join('\n');

function creds() {
  const key = process.env.HF_API_KEY || process.env.HIGGSFIELD_API_KEY || null;
  const secret = process.env.HF_SECRET || process.env.HIGGSFIELD_API_SECRET || null;
  return { key, secret, ok: Boolean(key && secret) };
}

function fmtFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'png';
  if (ext === '.webp') return 'webp';
  return 'jpeg';
}
function contentTypeFor(file) { return `image/${fmtFor(file)}`; }

// Upload a local image the documented way. The @higgsfield/client 0.2.x
// uploadImage() drops the headers the presigned storage URL is signed to
// require and 403s; we honor them here and surface the real error body.
async function uploadLocalImage(baseURL, key, secret, file) {
  const ct = contentTypeFor(file);
  const r1 = await fetch(`${baseURL}/files/generate-upload-url`, {
    method: 'POST',
    headers: { 'hf-api-key': key, 'hf-secret': secret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_type: ct }),
  });
  const t1 = await r1.text();
  if (!r1.ok) throw new Error(`generate-upload-url ${r1.status}: ${t1.slice(0, 300)}`);
  let j;
  try { j = JSON.parse(t1); } catch { throw new Error(`generate-upload-url returned non-JSON: ${t1.slice(0, 200)}`); }
  if (!j.upload_url || !j.public_url) throw new Error(`generate-upload-url missing url fields: ${t1.slice(0, 200)}`);
  // The response returns the EXACT headers the presigned URL was signed for
  // (Content-Type + x-amz-tagging). Send them verbatim, or S3 rejects the
  // signature. Field is `upload_headers` (older/other shapes: `headers`).
  const signed = (j.upload_headers && typeof j.upload_headers === 'object' && Object.keys(j.upload_headers).length)
    ? j.upload_headers
    : (j.headers && typeof j.headers === 'object' && Object.keys(j.headers).length ? j.headers : null);
  const putHeaders = signed || { 'Content-Type': ct };
  const r2 = await fetch(j.upload_url, { method: 'PUT', headers: putHeaders, body: fs.readFileSync(abs(file)) });
  if (!r2.ok) { const t2 = await r2.text(); throw new Error(`storage PUT ${r2.status}: ${t2.slice(0, 400)}`); }
  return j.public_url;
}

function dopModel(sdk, cfg) {
  const want = String(cfg.higgsfield?.dopModel || 'turbo').toUpperCase();
  return sdk.DoPModel[want] || sdk.DoPModel.TURBO;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf.length;
}

function resultUrl(jobSet) {
  const j = jobSet.jobs && jobSet.jobs[0];
  const r = j && j.results;
  return (r && ((r.raw && r.raw.url) || (r.min && r.min.url))) || null;
}

function loadPlan() {
  const p = abs('work/shot-plan.json');
  if (!fs.existsSync(p)) {
    console.error('No shot plan found. Build it first: node src/build-shot-plan.js');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function selectShots(plan, { only, force }) {
  let shots = plan.shots;
  if (only) shots = shots.filter((s) => s.id === only);
  if (!force) shots = shots.filter((s) => !fs.existsSync(abs(s.outClip)));
  return shots;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const resume = args.includes('--resume');
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
  const concIdx = args.indexOf('--concurrency');
  const concArg = concIdx >= 0 ? parseInt(args[concIdx + 1], 10) : NaN;

  const cfg = loadConfig();
  const plan = loadPlan();

  // Clearer error than "nothing to generate" when --only names a shot that
  // isn't in the current plan (e.g. after rebuilding the storyboard).
  if (only && !plan.shots.some((s) => s.id === only)) {
    console.error(`No shot with id "${only}" in the current plan.`);
    console.error(`Available ids: ${plan.shots.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }

  const shots = selectShots(plan, { only, force });
  if (!shots.length) {
    console.log(only
      ? `"${only}" already has a clip — pass --force to regenerate it.`
      : 'Nothing to generate — every clip already exists (use --force to regenerate).');
    return;
  }

  if (dryRun) {
    console.log(`DRY RUN — ${shots.length} clip(s) would be generated (no API calls, no credits):\n`);
    for (const s of shots) {
      console.log(`  ${s.id}  (${s.room || ''})`);
      console.log(`    image : ${s.sourcePhoto}`);
      console.log(`    out   : ${s.outClip}`);
      console.log(`    model : ${cfg.higgsfield?.dopModel || 'turbo'}`);
      console.log(`    prompt: ${s.higgsfield.prompt}\n`);
    }
    return;
  }

  const c = creds();
  if (!c.ok) { console.error(MISSING_KEY); process.exit(1); }

  let sdk, client;
  try {
    sdk = require('@higgsfield/client');
  } catch {
    console.error('Higgsfield SDK not installed. Run:  npm install @higgsfield/client');
    process.exit(1);
  }
  const maxPollMin = cfg.higgsfield?.maxPollMinutes ?? 25;
  client = new sdk.HiggsfieldClient({ apiKey: c.key, apiSecret: c.secret, maxPollTime: maxPollMin * 60000 });
  const baseURL = (client.config && client.config.baseURL) || 'https://platform.higgsfield.ai';
  const model = dopModel(sdk, cfg);

  // Job-tracking so a poll timeout doesn't lose (or re-charge) a running render.
  const jobsDir = abs('work/jobs');
  const jobFile = (id) => path.join(jobsDir, `${id}.json`);
  const saveJob = (shotId, jobSetId) => {
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(jobFile(shotId), JSON.stringify({ shot: shotId, jobSetId, submittedAt: new Date().toISOString() }, null, 2));
  };
  const loadJob = (shotId) => (fs.existsSync(jobFile(shotId)) ? JSON.parse(fs.readFileSync(jobFile(shotId), 'utf8')) : null);
  const clearJob = (shotId) => { try { fs.rmSync(jobFile(shotId), { force: true }); } catch { /* noop */ } };

  // Poll a submitted job to completion and download its result. Throws
  // TimeoutError (kept job file lets you --resume) on our configurable timeout.
  async function finishJob(s, jobSet) {
    await jobSet.poll(client, client.config);
    if (jobSet.isFailed) throw new Error('generation failed on server');
    if (jobSet.isNsfw) throw new Error('flagged NSFW by server');
    if (!jobSet.isCompleted) throw new Error(`job not completed (status: ${JSON.stringify((jobSet.jobs || []).map((j) => j.status))})`);
    const url = resultUrl(jobSet);
    if (!url) throw new Error('no result URL in completed job');
    const bytes = await download(url, abs(s.outClip));
    clearJob(s.id);
    return bytes;
  }

  // Generate one shot end-to-end (upload -> submit -> poll -> download).
  // Returns 'ok' | 'skip' | 'stop' (out of credits) | 'fail'.
  async function processShot(s) {
    try {
      let jobSet;
      if (resume) {
        const saved = loadJob(s.id);
        if (!saved) { console.log(`  • ${s.id}: no saved job to resume — skipping.`); return 'skip'; }
        console.log(`  • ${s.id}: resuming job ${saved.jobSetId} · polling (up to ${maxPollMin}m)…`);
        jobSet = new sdk.JobSet({ id: saved.jobSetId, jobs: [] });
      } else {
        const img = abs(s.sourcePhoto);
        if (!fs.existsSync(img)) { console.error(`  ✗ ${s.id}: source photo missing: ${s.sourcePhoto}`); return 'fail'; }
        console.log(`  • ${s.id}: uploading + submitting…`);
        const publicUrl = await uploadLocalImage(baseURL, c.key, c.secret, s.sourcePhoto);
        jobSet = await client.generate('/v1/image2video/dop', {
          model,
          prompt: s.higgsfield.prompt,
          input_images: [sdk.InputImage.fromUrl(publicUrl)],
        }, { withPolling: false });
        saveJob(s.id, jobSet.id);
        console.log(`  • ${s.id}: job ${jobSet.id} · rendering (up to ${maxPollMin}m)…`);
      }
      const bytes = await finishJob(s, jobSet);
      console.log(`  ✓ ${s.id}: done (${Math.round(bytes / 1024)} KB)`);
      return 'ok';
    } catch (err) {
      const name = err && err.constructor && err.constructor.name;
      if (name === 'NotEnoughCreditsError') {
        console.error(`  ✗ ${s.id}: FAILED — Out of Higgsfield credits — stopping.`);
        return 'stop';
      }
      // Provider caps how many renders run at once (e.g. "max 4 concurrent
      // job(s)"). That's not a real failure — the shot just needs to wait for a
      // slot. Re-queue it with backoff instead of dropping it.
      if (/rate limit|concurren|too many|429/i.test(String(err.message))) {
        console.log(`  • ${s.id}: waiting for a free render slot (provider concurrency limit)…`);
        return 'retry';
      }
      console.error(`  ✗ ${s.id}: FAILED — ${name && name !== 'Error' ? name + ': ' : ''}${err.message}`);
      if (name === 'TimeoutError') {
        console.error(`    Still rendering on Higgsfield — the job is saved. Resume WITHOUT re-charging:`);
        console.error(`      node src/generate-clips.js --resume`);
      }
      process.exitCode = 1;
      return 'fail';
    }
  }

  // Batch runner: a pool of N workers pulls from the shot queue, so several
  // clips upload/render/download at once instead of strictly one at a time.
  // Concurrency: --concurrency N > config higgsfield.concurrency > 3, clamped to
  // higgsfield.maxConcurrent (the provider's per-account cap, default 4) so the
  // pool self-throttles into groups instead of getting submissions rejected.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const maxConcurrent = Math.max(1, cfg.higgsfield?.maxConcurrent ?? 4);
  const requested = Math.max(1, Number.isFinite(concArg) ? concArg : (cfg.higgsfield?.concurrency ?? 3));
  const concurrency = Math.min(requested, maxConcurrent);
  if (requested > maxConcurrent) console.log(`Concurrency ${requested} clamped to ${maxConcurrent} (provider cap).`);

  const queue = shots.slice();
  const attempts = new Map();
  const MAX_RETRIES = 12;
  let ok = 0, stopped = false;
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length && !stopped) {
      const s = queue.shift();
      const r = await processShot(s);
      if (r === 'ok') ok += 1;
      else if (r === 'stop') { stopped = true; }
      else if (r === 'retry') {
        const n = (attempts.get(s.id) || 0) + 1;
        attempts.set(s.id, n);
        if (n > MAX_RETRIES) { console.error(`  ✗ ${s.id}: still rate-limited after ${MAX_RETRIES} tries — giving up.`); process.exitCode = 1; }
        else { queue.push(s); await sleep(Math.min(30000, 3000 * n)); } // back-of-queue + linear backoff
      }
    }
  });
  console.log(`Generating ${shots.length} clip(s), ${concurrency} at a time (auto-throttled to the provider cap)…\n`);
  await Promise.all(workers);

  if (typeof client.close === 'function') { try { client.close(); } catch { /* noop */ } }
  console.log(`\n${ok}/${shots.length} clip(s) generated.` + (ok ? '  Next: node src/assemble.js' : ''));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
