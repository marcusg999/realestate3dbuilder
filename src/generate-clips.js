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
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

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
  client = new sdk.HiggsfieldClient({ apiKey: c.key, apiSecret: c.secret });
  const model = dopModel(sdk, cfg);

  let ok = 0;
  for (const s of shots) {
    const img = abs(s.sourcePhoto);
    if (!fs.existsSync(img)) {
      console.error(`  ✗ ${s.id}: source photo missing: ${s.sourcePhoto}`);
      process.exitCode = 1;
      continue;
    }
    try {
      process.stdout.write(`  • ${s.id}: uploading… `);
      const publicUrl = await client.uploadImage(fs.readFileSync(img), fmtFor(img));
      process.stdout.write('generating… ');
      const jobSet = await client.generate('/v1/image2video/dop', {
        model,
        prompt: s.higgsfield.prompt,
        input_images: [sdk.InputImage.fromUrl(publicUrl)],
      }, { withPolling: true });

      if (typeof jobSet.isFailed === 'function' && jobSet.isFailed()) throw new Error('generation failed on server');
      if (typeof jobSet.isNsfw === 'function' && jobSet.isNsfw()) throw new Error('flagged NSFW by server');
      const url = resultUrl(jobSet);
      if (!url) throw new Error('no result URL in completed job');

      process.stdout.write('downloading… ');
      const bytes = await download(url, abs(s.outClip));
      console.log(`done (${Math.round(bytes / 1024)} KB)`);
      ok += 1;
    } catch (err) {
      console.log('FAILED');
      const name = err && err.constructor && err.constructor.name;
      console.error(`    ${name && name !== 'Error' ? name + ': ' : ''}${err.message}`);
      if (name === 'NotEnoughCreditsError') { console.error('    Out of Higgsfield credits — stopping.'); break; }
      process.exitCode = 1;
    }
  }

  if (typeof client.close === 'function') { try { client.close(); } catch { /* noop */ } }
  console.log(`\n${ok}/${shots.length} clip(s) generated.` + (ok ? '  Next: node src/assemble.js' : ''));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
