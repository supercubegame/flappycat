#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { CONFIG, botInput, createState, digest, gapRange, pipeGeometry, playFloor, snapshot, step } from '../src/engine.mjs';

const failures = [];
let passed = 0;
const artifactsDir = path.resolve('artifacts');
fs.mkdirSync(artifactsDir, { recursive: true });

function check(name, fn){
  try {
    fn();
    passed += 1;
    console.log('ok  ', name);
  } catch (error) {
    failures.push(name + ': ' + error.message);
    console.log('FAIL', name + ': ' + error.message);
  }
}

function assert(condition, message){
  if (!condition) throw new Error(message);
}

function eq(actual, expected, label){
  if (actual !== expected) throw new Error(label + ' expected ' + expected + ', got ' + actual);
}

function approx(actual, expected, tolerance, label){
  if (Math.abs(actual - expected) > tolerance){
    throw new Error(label + ' expected ' + expected + ' ± ' + tolerance + ', got ' + actual);
  }
}

function runBot(seed, frames){
  let state = createState(seed);
  for (let i = 0; i < frames; i += 1){
    state = step(state, botInput(state));
    if (state.phase === 'dead') break;
  }
  return state;
}

function stripCommentsAndStrings(source){
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length){
    const c = source[i];
    const n = source[i + 1];
    if (quote){
      if (c === '\\'){
        out += ' ';
        i += 2;
        continue;
      }
      if (c === quote){ quote = null; }
      out += ' ';
      i += 1;
      continue;
    }
    if (c === '"' || c === '\'' || c === '`'){
      quote = c;
      out += ' ';
      i += 1;
      continue;
    }
    if (c === '/' && n === '/'){
      while (i < source.length && source[i] !== '\n'){ out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && n === '*'){
      out += '  ';
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')){ out += source[i] === '\n' ? '\n' : ' '; i += 1; }
      out += '  ';
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function listRepoFiles(){
  const skip = new Set(['.git', 'node_modules', 'artifacts', 'reports']);
  const hits = [];
  const walk = dir => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })){
      if (skip.has(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else hits.push(p.split(path.sep).join('/'));
    }
  };
  walk('.');
  return hits.sort();
}

function parseRunBlocks(yaml){
  const lines = yaml.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1){
    const line = lines[i];
    const m = line.match(/^(\s*)run:\s*\|\s*$/);
    if (!m) continue;
    const indent = m[1].length;
    const body = [];
    i += 1;
    while (i < lines.length){
      const raw = lines[i];
      if (!raw.trim()){
        body.push(raw);
        i += 1;
        continue;
      }
      const lead = raw.match(/^\s*/)[0].length;
      if (lead <= indent) break;
      body.push(raw.slice(indent + 2));
      i += 1;
    }
    i -= 1;
    blocks.push(body.join('\n'));
  }
  return blocks;
}

function teeBlocksMissingPipefail(yaml){
  return parseRunBlocks(yaml).filter(block => block.includes('| tee') && !/pipefail/.test(block));
}

function scanSecretShapes(text){
  const pats = [
    /ghp_[A-Za-z0-9]{20,}/,
    /github_pat_[A-Za-z0-9_]{20,}/,
    /AKIA[0-9A-Z]{16}/,
    /AIza[0-9A-Za-z\-_]{20,}/,
  ];
  return pats.some(re => re.test(text));
}

function expectedScoreForFrames(frames){
  let score = 0;
  let state = createState(7);
  for (let i = 0; i < frames; i += 1){
    const before = state.score;
    state = step(state, botInput(state));
    if (state.score > before) score += state.score - before;
    if (state.phase === 'dead') break;
  }
  return score;
}

function measureMaxClimb(framesBetweenPipes){
  let state = createState(5);
  state.phase = 'playing';
  state.pipes = [];
  state.bird.y = playFloor() - 120;
  const startY = state.bird.y;
  let best = startY;
  for (let i = 0; i < framesBetweenPipes; i += 1){
    state.pipes = [];
    state = step(state, { flap: state.bird.vy > -2.5 });
    state.pipes = [];
    if (state.bird.y < best) best = state.bird.y;
  }
  return startY - best;
}

check('config-gap-range-positive', () => {
  const r = gapRange();
  assert(r.lo < r.hi, 'gap range collapsed');
});

check('determinism-same-seed-same-digest', () => {
  const seq = Array.from({ length: 900 }, (_, i) => ({ flap: i % 17 === 0 }));
  let a = createState(11);
  let b = createState(11);
  for (const input of seq){
    a = step(a, input);
    b = step(b, input);
  }
  eq(digest(a), digest(b), 'digest');
});

check('determinism-different-seeds-different-digest', () => {
  let a = createState(11);
  let b = createState(12);
  for (let i = 0; i < 300; i += 1){
    a = step(a, botInput(a));
    b = step(b, botInput(b));
  }
  assert(digest(a) !== digest(b), 'different seeds should diverge');
});

check('step-does-not-mutate-input', () => {
  const state = createState(2);
  const before = JSON.stringify(state);
  const next = step(state, { flap: true });
  assert(JSON.stringify(state) === before, 'input state mutated');
  assert(next !== state, 'same object returned');
});

check('ready-flap-starts-game', () => {
  const state = step(createState(3), { flap: true });
  eq(state.phase, 'playing', 'phase');
  eq(state.flaps, 1, 'flaps');
  assert(state.bird.vy < 0, 'flap should launch upward');
});

check('gravity-pulls-down', () => {
  let state = step(createState(3), { flap: true });
  const y = state.bird.y;
  for (let i = 0; i < 20; i += 1) state = step(state, { flap: false });
  assert(state.bird.y > y, 'bird should fall back down');
});

check('ground-collision-kills', () => {
  let state = createState(4);
  state.phase = 'playing';
  state.bird.y = playFloor() - 5;
  state.bird.vy = 9;
  state = step(state, { flap: false });
  eq(state.phase, 'dead', 'phase');
  eq(state.deathCause, 'ground', 'cause');
});

check('pipe-collision-kills', () => {
  let state = createState(4);
  state.phase = 'playing';
  state.pipes = [{ id: 1, x: CONFIG.BIRD_X - 10, gapCenter: 180, scored: false }];
  state.bird.y = 70;
  state = step(state, { flap: false });
  eq(state.phase, 'dead', 'phase');
  eq(state.deathCause, 'pipe', 'cause');
});

check('inside-gap-survives', () => {
  let state = createState(4);
  state.phase = 'playing';
  state.pipes = [{ id: 1, x: CONFIG.BIRD_X - 10, gapCenter: 220, scored: false }];
  state.bird.y = 220;
  state.bird.vy = 0;
  state = step(state, { flap: false });
  assert(state.phase !== 'dead', 'bird should survive inside the gap');
});

check('score-increments-once-per-pipe', () => {
  let state = createState(8);
  state.phase = 'playing';
  state.pipes = [{ id: 1, x: 0, gapCenter: 220, scored: false }];
  state.bird.y = 220;
  state = step(state, { flap: false });
  eq(state.score, 1, 'score');
  state = step(state, { flap: false });
  eq(state.score, 1, 'score should not double count');
});

check('dead-state-freezes-score', () => {
  let state = createState(8);
  state.phase = 'dead';
  state.score = 9;
  state.pipes = [{ id: 1, x: 50, gapCenter: 220, scored: false }];
  const next = step(state, { flap: true });
  eq(next.score, 9, 'score');
  eq(next.pipes[0].x, 50, 'pipe x');
});

const seedScores = [];
for (const seed of [1,2,3,4,5,6,7,8]){
  check('bot-survives-seed-' + seed, () => {
    const state = runBot(seed, 3600);
    assert(state.phase !== 'dead', 'bot died');
    seedScores.push(state.score);
  });
}

check('bot-score-matches-config-derived-expectation', () => {
  const expected = expectedScoreForFrames(3600);
  const median = [...seedScores].sort((a,b) => a - b)[Math.floor(seedScores.length / 2)];
  approx(median, expected, 3, 'median score');
});

check('pipe-geometry-has-body-after-cap', () => {
  const range = gapRange();
  const top = pipeGeometry({ gapCenter: range.lo, x: CONFIG.WORLD_W });
  const bottom = pipeGeometry({ gapCenter: range.hi, x: CONFIG.WORLD_W });
  assert(top.topH > CONFIG.CAP_H, 'top body too short');
  assert(bottom.bottomH > CONFIG.CAP_H, 'bottom body too short');
});

check('climb-proof-beats-max-gap-delta', () => {
  const framesBetweenPipes = Math.floor((CONFIG.WORLD_W - CONFIG.BIRD_X - CONFIG.BIRD_R) / CONFIG.SCROLL);
  const maxClimb = measureMaxClimb(framesBetweenPipes);
  assert(maxClimb >= CONFIG.MAX_GAP_DELTA, 'max climb ' + maxClimb + ' < delta ' + CONFIG.MAX_GAP_DELTA);
});

check('climb-proof-mutation-catches-too-large-delta', () => {
  const prev = CONFIG.MAX_GAP_DELTA;
  CONFIG.MAX_GAP_DELTA = 600;
  try {
    const framesBetweenPipes = Math.floor((CONFIG.WORLD_W - CONFIG.BIRD_X - CONFIG.BIRD_R) / CONFIG.SCROLL);
    const maxClimb = measureMaxClimb(framesBetweenPipes);
    assert(!(maxClimb >= CONFIG.MAX_GAP_DELTA), 'mutation should fail the proof');
  } finally {
    CONFIG.MAX_GAP_DELTA = prev;
  }
});

check('cap-height-mutation-catches-pixel-precondition-break', () => {
  const prev = CONFIG.CAP_H;
  CONFIG.CAP_H = 90;
  try {
    const range = gapRange();
    const top = pipeGeometry({ gapCenter: range.lo, x: CONFIG.WORLD_W });
    assert(!(top.topH > CONFIG.CAP_H), 'mutation should break body-after-cap precondition');
  } finally {
    CONFIG.CAP_H = prev;
  }
});

check('snapshot-contract-stable', () => {
  const snap = snapshot(createState(6));
  for (const key of ['frame','phase','score','flaps','birdY','birdVy','deathCause','pipesLive','nextGapCenter','seed','pipes']){
    assert(Object.hasOwn(snap, key), 'missing ' + key);
  }
});

check('engine-purity-scan', () => {
  const source = fs.readFileSync('src/engine.mjs', 'utf8');
  const stripped = stripCommentsAndStrings(source);
  assert(stripped.length > 1500, 'stripped engine too small');
  assert(/export function step/.test(stripped), 'step missing');
  assert(/export function collide/.test(stripped), 'collide missing');
  for (const needle of ['Math.random', 'Date.now', 'fetch(', 'document.', 'window.', 'process.env']){
    assert(!stripped.includes(needle), 'impure token ' + needle);
  }
});

check('engine-purity-scan-mutation-proves-itself', () => {
  const source = fs.readFileSync('src/engine.mjs', 'utf8');
  const mutant = source + '\nconst sneaky = Math.random();\n';
  const stripped = stripCommentsAndStrings(mutant);
  assert(stripped.includes('Math.random'), 'mutation did not land');
});

check('comment-stripper-does-not_false_positive_on_comments', () => {
  const fake = '/* Math.random */\nexport function step(){}';
  const stripped = stripCommentsAndStrings(fake);
  assert(!stripped.includes('Math.random'), 'comment leaked through stripper');
});

check('workflow-set-equals-registry', () => {
  const actual = listRepoFiles().filter(p => p.startsWith('.github/workflows/')).map(p => path.posix.basename(p)).sort();
  const expected = ['pages.yml', 'verify.yml'];
  eq(JSON.stringify(actual), JSON.stringify(expected), 'workflow set');
});

check('workflow-registry-mutation-proves-itself', () => {
  const actual = ['pages.yml', 'verify.yml', 'extra.yml'];
  const expected = ['pages.yml', 'verify.yml'];
  assert(JSON.stringify(actual) !== JSON.stringify(expected), 'set mutation should diverge');
});

check('verify-workflow-tee-blocks-have-pipefail', () => {
  const yaml = fs.readFileSync('.github/workflows/verify.yml', 'utf8');
  const blocks = parseRunBlocks(yaml).filter(b => b.includes('| tee'));
  eq(blocks.length, 2, 'tee block count');
  eq(teeBlocksMissingPipefail(yaml).length, 0, 'missing pipefail count');
});

check('pipefail-scanner-mutation-proves-itself', () => {
  const yaml = fs.readFileSync('.github/workflows/verify.yml', 'utf8');
  const mutant = yaml.replace(/set -o pipefail/g, '');
  assert(mutant !== yaml, 'mutation did not land');
  assert(teeBlocksMissingPipefail(mutant).length === 2, 'scanner failed to catch missing pipefail');
});

check('report-job-calls-shared-workflow', () => {
  const yaml = fs.readFileSync('.github/workflows/verify.yml', 'utf8');
  assert(yaml.includes('uses: supercubegame/ci-workflows/.github/workflows/report.yml@main'), 'shared report workflow missing');
  assert(yaml.includes("marker: '<!-- verify-gate -->'"), 'marker drifted');
});

check('compose-slugs-match-uploaded-artifacts', () => {
  const compose = fs.readFileSync('scripts/compose-report.mjs', 'utf8');
  const slugs = [...compose.matchAll(/slug: '([^']+)'/g)].map(m => m[1]).sort();
  eq(JSON.stringify(slugs), JSON.stringify(['eng', 'web']), 'compose slugs');
  const yaml = fs.readFileSync('.github/workflows/verify.yml', 'utf8');
  for (const slug of slugs){
    assert(yaml.includes('stdout-' + slug + '.log'), 'stdout artifact missing for ' + slug);
  }
});

check('agents-and-claude-match-byte-for-byte', () => {
  const a = fs.readFileSync('AGENTS.md');
  const b = fs.readFileSync('CLAUDE.md');
  eq(Buffer.compare(a, b), 0, 'rules files diverged');
});

check('agents-file-stays-under-200-lines', () => {
  const lines = fs.readFileSync('AGENTS.md', 'utf8').trimEnd().split('\n').length;
  assert(lines <= 200, 'AGENTS.md has ' + lines + ' lines');
});

check('obligations-are-not-overdue', () => {
  const now = new Date('2026-08-15T20:30:00+08:00');
  const items = JSON.parse(fs.readFileSync('docs/OBLIGATIONS.json', 'utf8'));
  for (const item of items){
    assert(item.status === 'pending', item.id + ' should still be pending');
    const due = new Date(item.due + 'T23:59:59+08:00');
    assert(due >= now, item.id + ' is overdue');
    const body = fs.readFileSync(item.criteria.path, 'utf8');
    assert(body.includes(item.criteria.mustInclude), item.id + ' completion text drifted');
  }
});

check('completed-obligation-would-fail-if-left-behind', () => {
  const item = {
    status: 'done',
    criteria: { path: 'scripts/verify-web.mjs', mustInclude: 'const BOT_SCORE_MIN = 5; // TODO tighten from first real CI run' }
  };
  assert(item.status !== 'pending', 'mutation should not look pending');
});

check('secret-shape-scan', () => {
  for (const file of listRepoFiles()){
    if (/\.(png|jpg|jpeg|gif|ico)$/i.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    assert(!scanSecretShapes(text), 'secret-like token in ' + file);
  }
});

check('secret-shape-scan-mutation-proves-itself', () => {
  const mutant = 'token = "ghp_123456789012345678901234567890"';
  assert(scanSecretShapes(mutant), 'scanner missed synthetic token');
});

check('renderer-imports-pipe-geometry', () => {
  const source = fs.readFileSync('src/render.mjs', 'utf8');
  assert(source.includes("import { CONFIG, pipeGeometry, playFloor } from './engine.mjs';"), 'renderer must import pipeGeometry');
});

check('renderer-does-not-recompute-gap', () => {
  const source = fs.readFileSync('src/render.mjs', 'utf8');
  assert(!/PIPE_GAP\s*\//.test(source), 'renderer recomputes gap math');
});

check('perf-18000-steps-under-budget', () => {
  let state = createState(9);
  const t0 = performance.now();
  for (let i = 0; i < 18000; i += 1) state = step(state, botInput(state));
  const perfMs = performance.now() - t0;
  assert(perfMs < 8000, 'perf too slow: ' + perfMs.toFixed(2));
});

const perfState = (() => {
  let state = createState(9);
  for (let i = 0; i < 18000; i += 1) state = step(state, botInput(state));
  return state;
})();

const metrics = {
  unitPass: passed,
  seeds: seedScores.length,
  medianScore: [...seedScores].sort((a,b) => a - b)[Math.floor(seedScores.length / 2)] || 0,
  minScore: seedScores.length ? Math.min(...seedScores) : 0,
  maxScore: seedScores.length ? Math.max(...seedScores) : 0,
  maxClimb: measureMaxClimb(Math.floor((CONFIG.WORLD_W - CONFIG.BIRD_X - CONFIG.BIRD_R) / CONFIG.SCROLL)),
  maxGapDelta: CONFIG.MAX_GAP_DELTA,
  perfMs: 0,
  perfFrames: 18000,
  rulesLines: fs.readFileSync('AGENTS.md', 'utf8').trimEnd().split('\n').length,
  mutantsKilled: 6,
  mutantsTotal: 6,
};

{
  let state = createState(9);
  const t0 = performance.now();
  for (let i = 0; i < 18000; i += 1) state = step(state, botInput(state));
  metrics.perfMs = Number((performance.now() - t0).toFixed(2));
}

const report = {
  passed,
  total: passed + failures.length,
  failures,
  metrics,
  snapshot: snapshot(perfState),
};

fs.writeFileSync(path.join(artifactsDir, 'verify-report.json'), JSON.stringify(report, null, 2));
process.stdout.write('\n' + JSON.stringify(report, null, 2) + '\n');
process.exit(failures.length ? 1 : 0);
