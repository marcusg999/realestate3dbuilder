'use strict';
// Local intake + control dashboard. Dependency-free (Node built-in http).
// Run: `npm run dashboard` (or `node src/dashboard.js`), open http://localhost:4300.
//
// Lets you drag-drop the input assets into the right inputs/ folders, set the
// Matterport URL, edit/save the storyboard, watch preflight go green, run the
// deterministic steps (plan/assemble/progress), and play the latest render.
// Clip generation itself runs through the Higgsfield MCP (the agent), not here —
// the dashboard shows that step and its status but does not call Higgsfield.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ROOT, abs, loadConfig, loadPieces } = require('./lib/config');
const preflight = require('./preflight');
const stateLib = require('./lib/state');

const PORT = Number(process.env.PORT) || 4300;
const cfg = loadConfig();

const TARGETS = {
  'reference-frames': { dir: cfg.paths.referenceFrames, exts: ['.png', '.jpg', '.jpeg', '.webp'] },
  'listing-photos': { dir: cfg.paths.listingPhotos, exts: ['.png', '.jpg', '.jpeg', '.webp'] },
  'floorplan': { dir: cfg.paths.floorplan, exts: ['.png', '.jpg', '.jpeg', '.webp', '.pdf'] },
};
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

function safeName(name) {
  return path.basename(String(name || '')).replace(/[^\w.\- ]+/g, '_').slice(0, 200);
}
function send(res, code, body, headers = {}) {
  res.writeHead(code, Object.assign({ 'Cache-Control': 'no-store' }, headers));
  res.end(body);
}
function json(res, code, obj) { send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json' }); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 200 * 1024 * 1024) { reject(new Error('file too large (>200MB)')); req.destroy(); } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function listImages(dir) {
  const d = abs(dir);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => !f.startsWith('.'));
}

// ---- API ----
function apiState() {
  const report = preflight.check();
  const state = stateLib.load();
  const cfgPaths = cfg.paths;
  const matterport = fs.existsSync(abs(cfgPaths.matterportUrlFile))
    ? fs.readFileSync(abs(cfgPaths.matterportUrlFile), 'utf8').trim() : '';
  const storyboardPath = abs(cfgPaths.storyboard);
  const hasStoryboard = fs.existsSync(storyboardPath);
  const renderExists = fs.existsSync(abs(cfgPaths.assembledVideo));

  // Clip status from the shot plan (if built): which shots have a rendered clip.
  let clips = null;
  const planPath = abs('work/shot-plan.json');
  if (fs.existsSync(planPath)) {
    try {
      const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
      const shots = (plan.shots || []).map((s) => ({
        id: s.id, room: s.room, has: fs.existsSync(abs(s.outClip)),
      }));
      clips = { total: shots.length, ready: shots.filter((s) => s.has).length, shots };
    } catch { /* ignore malformed plan */ }
  }

  return {
    preflight: report,
    pieces: state.pieces,
    stage: state.stage,
    assets: {
      'reference-frames': listImages(TARGETS['reference-frames'].dir),
      'listing-photos': listImages(TARGETS['listing-photos'].dir),
      'floorplan': listImages(TARGETS['floorplan'].dir),
    },
    matterport,
    hasStoryboard,
    renderExists,
    clips,
  };
}

function runStep(step) {
  const map = {
    preflight: 'src/preflight.js',
    plan: 'src/build-shot-plan.js',
    assemble: 'src/assemble.js',
    progress: 'src/progress.js',
    devclips: 'src/dev/make-placeholder-clips.js',
  };
  const rel = map[step];
  return new Promise((resolve) => {
    if (!rel) return resolve({ ok: false, code: 1, stdout: '', stderr: `unknown step: ${step}` });
    const child = spawn(process.execPath, [rel], { cwd: ROOT, env: process.env });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout: out, stderr: err }));
  });
}

function serveFile(res, file, req) {
  const p = abs(file);
  if (!fs.existsSync(p)) return send(res, 404, 'not found');
  const ext = path.extname(p).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const stat = fs.statSync(p);
  const range = req.headers.range;
  if (range && /^bytes=/.test(range)) {
    const [s, e] = range.replace('bytes=', '').split('-');
    const start = parseInt(s, 10) || 0;
    const end = e ? parseInt(e, 10) : stat.size - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': type,
    });
    return fs.createReadStream(p, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': type, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(p).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;

    if (p === '/' || p === '/index.html') return serveFile(res, 'public/dashboard.html', req);
    if (p === '/api/state') return json(res, 200, apiState());
    if (p === '/api/storyboard/example') return serveFile(res, 'inputs/storyboard.example.json', req);
    if (p === '/api/storyboard' && req.method === 'GET') {
      const sp = abs(cfg.paths.storyboard);
      return fs.existsSync(sp) ? serveFile(res, cfg.paths.storyboard, req) : json(res, 404, { error: 'no storyboard yet' });
    }
    if (p === '/api/render') return serveFile(res, cfg.paths.assembledVideo, req);
    if (p === '/api/asset-file') {
      const t = url.searchParams.get('target'); const n = safeName(url.searchParams.get('name'));
      if (!TARGETS[t]) return json(res, 400, { error: 'bad target' });
      return serveFile(res, path.join(TARGETS[t].dir, n), req);
    }

    if (req.method === 'POST' && p === '/api/upload') {
      const t = url.searchParams.get('target'); const n = safeName(url.searchParams.get('name'));
      const target = TARGETS[t];
      if (!target) return json(res, 400, { error: 'bad target' });
      if (!target.exts.includes(path.extname(n).toLowerCase())) return json(res, 400, { error: `bad extension for ${t}` });
      const buf = await readBody(req);
      const dir = abs(target.dir); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, n), buf);
      return json(res, 200, { ok: true, saved: `${target.dir}/${n}` });
    }
    if (req.method === 'POST' && p === '/api/matterport') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      fs.writeFileSync(abs(cfg.paths.matterportUrlFile), String(body.url || '').trim() + '\n');
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/storyboard') {
      const raw = (await readBody(req)).toString('utf8');
      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) { return json(res, 400, { error: 'invalid JSON: ' + e.message }); }
      if (!parsed || !Array.isArray(parsed.shots) || !parsed.shots.length) return json(res, 400, { error: 'storyboard needs a non-empty shots[] array' });
      fs.writeFileSync(abs(cfg.paths.storyboard), JSON.stringify(parsed, null, 2));
      return json(res, 200, { ok: true, shots: parsed.shots.length });
    }
    if (req.method === 'POST' && p === '/api/delete') {
      const t = url.searchParams.get('target'); const n = safeName(url.searchParams.get('name'));
      if (!TARGETS[t]) return json(res, 400, { error: 'bad target' });
      const fp = path.join(abs(TARGETS[t].dir), n);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/run') {
      const step = url.searchParams.get('step');
      const result = await runStep(step);
      return json(res, 200, result);
    }

    return send(res, 404, 'not found');
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Listing Walkthrough Studio — dashboard`);
  console.log(`  → http://localhost:${PORT}\n`);
  console.log(`  Drop in reference frames, listing photos, floor plan, Matterport URL, and storyboard.`);
  console.log(`  Preflight goes green when inputs are ready; then run plan → (generate via agent) → assemble.\n`);
});
