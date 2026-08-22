'use strict';
const fs = require('fs');
const path = require('path');
const { ROOT, loadPieces } = require('./config');

const STATE_PATH = path.join(ROOT, 'state.json');

// state.json is the single source of truth for the progress page and the
// gauntlet orchestrator. It is initialized from config/pieces.json and then
// mutated round by round.
function init() {
  const pieces = loadPieces();
  return {
    generatedAt: new Date().toISOString(),
    stage: 'scaffold',
    inputsReady: false,
    preflight: null,
    latestAssembledVideo: null,
    pieces: pieces.pieces.map((p) => ({
      id: p.id,
      title: p.title,
      status: p.state.status,
      rounds: p.state.rounds,
      nonImprovingStreak: p.state.nonImprovingStreak,
      bestRender: p.state.bestRender,
      criticVerdict: p.state.criticVerdict,
      remainingGap: p.state.remainingGap,
    })),
  };
}

function load() {
  if (!fs.existsSync(STATE_PATH)) return init();
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return init();
  }
}

function save(state) {
  state.generatedAt = new Date().toISOString();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  return state;
}

function updatePiece(state, id, patch) {
  const p = state.pieces.find((x) => x.id === id);
  if (p) Object.assign(p, patch);
  return state;
}

module.exports = { STATE_PATH, init, load, save, updatePiece };
