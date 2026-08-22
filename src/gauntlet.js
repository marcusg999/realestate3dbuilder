'use strict';
// Gauntlet control logic for the builder/critic loop. This module owns the
// RULES of the loop as pure, testable functions; it does NOT call Higgsfield
// and does NOT spawn subagents. The orchestrating agent drives the loop by:
//
//   for each piece:
//     round = 0
//     until critic picks OURS blind, or shouldStop():
//       - BUILDER subagent (fresh context): tune this piece's knobs, regenerate
//         the affected clip(s) via Higgsfield MCP, re-run assemble.js.
//       - CRITIC subagent (fresh context): run compare-harness.js, open the
//         reference frames + Matterport sample, judge blind, name the single
//         biggest remaining gap, hand back to the builder.
//       - recordRound(...) with improved=true/false and the critic verdict.
//     if flagged: surface current render + remaining gap to the human, move on.
//
// See RUNBOOK.md for the exact subagent prompts.

const state = require('./lib/state');
const { loadPieces } = require('./lib/config');

const MAX_NONIMPROVING = 3;

// Decide whether to stop looping a piece.
// Returns { stop, reason }.
function shouldStop(pieceState) {
  if (pieceState.status === 'won') return { stop: true, reason: 'critic picked OURS blind' };
  if (pieceState.nonImprovingStreak >= MAX_NONIMPROVING) {
    return { stop: true, reason: `no meaningful improvement for ${MAX_NONIMPROVING} consecutive rounds` };
  }
  return { stop: false, reason: null };
}

// Record the outcome of one round for a piece and persist.
// outcome: { won:boolean, improved:boolean, bestRender:string, verdict:string, remainingGap:string }
function recordRound(pieceId, outcome) {
  const s = state.load();
  const p = s.pieces.find((x) => x.id === pieceId);
  if (!p) throw new Error(`unknown piece: ${pieceId}`);
  p.rounds += 1;
  if (outcome.won) {
    p.status = 'won';
    p.nonImprovingStreak = 0;
  } else {
    p.status = 'looping';
    p.nonImprovingStreak = outcome.improved ? 0 : p.nonImprovingStreak + 1;
  }
  if (outcome.bestRender) p.bestRender = outcome.bestRender;
  if (outcome.verdict) p.criticVerdict = outcome.verdict;
  if (outcome.remainingGap !== undefined) p.remainingGap = outcome.remainingGap;

  const stop = shouldStop(p);
  if (stop.stop && p.status !== 'won') {
    p.status = 'flagged';
    p.flagReason = stop.reason;
  }
  state.save(s);
  return { piece: p, ...stop };
}

// Dry-run: print the loop plan for each pending piece without doing anything.
function plan() {
  const pieces = loadPieces().pieces;
  const lines = ['GAUNTLET PLAN (dry run — no generation)', '======================================='];
  for (const p of pieces) {
    lines.push('');
    lines.push(`• ${p.title} [${p.id}]`);
    lines.push(`    judged on: ${p.judged}`);
    lines.push(`    knobs: ${Object.keys(p.knobs).join(', ')}`);
    lines.push(`    loop: builder tunes knobs -> regenerate -> assemble -> critic blind-compares vs bar`);
    lines.push(`    stop when: critic picks OURS blind, OR ${MAX_NONIMPROVING} non-improving rounds -> flag`);
  }
  return lines.join('\n');
}

if (require.main === module) {
  console.log(plan());
}

module.exports = { shouldStop, recordRound, plan, MAX_NONIMPROVING };
