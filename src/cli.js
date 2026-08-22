#!/usr/bin/env node
'use strict';
// Thin dispatcher for the walkthrough pipeline steps.
const cmd = process.argv[2];
const rest = process.argv.slice(3);
process.argv = [process.argv[0], process.argv[1], ...rest];

const steps = {
  preflight: '../src/preflight.js',
  plan: '../src/build-shot-plan.js',
  assemble: '../src/assemble.js',
  compare: '../src/compare-harness.js',
  progress: '../src/progress.js',
  'gauntlet-plan': '../src/gauntlet.js',
};

function usage() {
  console.log('Usage: walkthrough <preflight|plan|assemble|compare|progress|gauntlet-plan> [args]');
}

if (!cmd || cmd === '-h' || cmd === '--help' || !steps[cmd]) {
  usage();
  process.exit(cmd && cmd !== '-h' && cmd !== '--help' ? 1 : 0);
}
require(require('path').join(__dirname, steps[cmd]));
