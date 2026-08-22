'use strict';
// Generates progress.html from state.json — the live status board for the
// gauntlet. Shows each piece's status, rounds, critic verdict, remaining gap,
// and current best render, plus the latest assembled video (playable). Regenerate
// after every round: `node src/progress.js`.

const fs = require('fs');
const path = require('path');
const { ROOT, abs, loadConfig } = require('./lib/config');
const stateLib = require('./lib/state');

const STATUS = {
  pending: { label: 'Pending', color: '#6b7280' },
  looping: { label: 'Looping', color: '#d97706' },
  won: { label: 'Won (blind)', color: '#059669' },
  flagged: { label: 'Flagged', color: '#dc2626' },
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function chip(status) {
  const st = STATUS[status] || STATUS.pending;
  return `<span class="chip" style="--c:${st.color}">${esc(st.label)}</span>`;
}

function render(state) {
  const cfg = loadConfig();
  const video = state.latestAssembledVideo;
  const videoRel = video ? path.relative(ROOT, abs(video)) : null;
  const videoExists = videoRel && fs.existsSync(abs(video));

  const rows = state.pieces.map((p) => `
    <tr>
      <td class="pc"><strong>${esc(p.title)}</strong><div class="id">${esc(p.id)}</div></td>
      <td>${chip(p.status)}</td>
      <td class="num">${p.rounds}${p.nonImprovingStreak ? ` <span class="warn">(${p.nonImprovingStreak} flat)</span>` : ''}</td>
      <td class="gap">${esc(p.remainingGap || (p.status === 'won' ? '—' : 'not yet judged'))}</td>
      <td>${p.bestRender ? `<a href="${esc(path.relative(ROOT, abs(p.bestRender)))}">render</a>` : '<span class="muted">—</span>'}</td>
    </tr>`).join('');

  const preflight = state.preflight;
  const preflightHtml = preflight ? `
    <div class="pf ${preflight.inputsReady ? 'ok' : 'block'}">
      <strong>${preflight.inputsReady ? '✅ Inputs ready — gauntlet can run' : '⛔ Blocked — missing inputs'}</strong>
      <ul>${preflight.results.map((r) => `<li>${r.ok ? '✅' : (r.blocker ? '❌' : '⚠️')} ${esc(r.name)}: ${esc(r.detail)}</li>`).join('')}</ul>
    </div>` : '<div class="pf"><em>Preflight not run yet — <code>node src/preflight.js</code></em></div>';

  const won = state.pieces.filter((p) => p.status === 'won').length;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Listing Walkthrough Studio — Progress</title>
<style>
  :root{color-scheme:light dark;--bg:#0e1116;--card:#171b22;--fg:#e6e8eb;--mut:#8b93a1;--line:#232833;--acc:#3b82f6}
  *{box-sizing:border-box}
  body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--fg)}
  .wrap{max-width:960px;margin:0 auto;padding:28px 20px 64px}
  h1{font-size:22px;margin:0 0 4px}
  .sub{color:var(--mut);margin:0 0 20px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin:16px 0}
  video{width:100%;border-radius:8px;background:#000;aspect-ratio:16/9}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--mut);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  .pc .id{color:var(--mut);font-size:12px;font-family:ui-monospace,monospace}
  .num{font-variant-numeric:tabular-nums}
  .warn{color:#d97706}.muted{color:var(--mut)}
  .gap{max-width:320px;color:var(--fg)}
  .chip{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;color:var(--c);border:1px solid color-mix(in srgb,var(--c) 45%,transparent);background:color-mix(in srgb,var(--c) 14%,transparent)}
  .pf ul{margin:8px 0 0;padding-left:18px}.pf li{margin:2px 0;font-size:13px}
  .pf.block{border-left:3px solid #dc2626;padding-left:12px}.pf.ok{border-left:3px solid #059669;padding-left:12px}
  a{color:var(--acc)}
  .meta{color:var(--mut);font-size:12px;font-family:ui-monospace,monospace}
  .empty{color:var(--mut);text-align:center;padding:40px 0}
</style></head>
<body><div class="wrap">
  <h1>Listing Walkthrough Studio — Generation Progress</h1>
  <p class="sub">Stage: <strong>${esc(state.stage)}</strong> · Pieces won blind: <strong>${won}/${state.pieces.length}</strong> · Updated ${esc(state.generatedAt)}</p>

  <div class="card">
    <h3 style="margin-top:0">Latest assembled walkthrough</h3>
    ${videoExists
      ? `<video controls preload="metadata" src="${esc(videoRel)}"></video><p class="meta">${esc(videoRel)}</p>`
      : '<div class="empty">No render yet. It appears here and stays playable once the first assembly runs.</div>'}
  </div>

  <div class="card">${preflightHtml}</div>

  <div class="card">
    <h3 style="margin-top:0">Pieces</h3>
    <table>
      <thead><tr><th>Piece</th><th>Status</th><th>Rounds</th><th>Biggest remaining gap</th><th>Best</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  <p class="meta">Bar: reference frames in inputs/reference-frames + Matterport sample. A piece is "Won" only when the critic picks OUR frames over the bar blind. "Flagged" = 3 non-improving rounds; surfaced for a human call.</p>
</div></body></html>`;
}

function generate() {
  const cfg = loadConfig();
  const state = stateLib.load();
  const html = render(state);
  const out = abs(cfg.paths.progressPage);
  fs.writeFileSync(out, html);
  return out;
}

if (require.main === module) {
  const out = generate();
  console.log(`Wrote ${path.relative(ROOT, out)}`);
}

module.exports = { generate, render };
