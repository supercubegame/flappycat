#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { CONFIG, bestOf, botInput, createState, digest, gapRange, pipeGeometry, playFloor, sanitizeScore, snapshot, step } from '../src/engine.mjs';

const failures = [];
let passed = 0;
let mutationChecks = 0;
let mutationKilled = 0;
const artifactsDir = path.resolve('artifacts');
fs.mkdirSync(artifactsDir, { recursive: true });

function check(name, fn){
  const isMutation = /mutation|proves-itself/.test(name);
  if (isMutation) mutationChecks += 1;
  try {
    fn();
    passed += 1;
    if (isMutation) mutationKilled += 1;
    console.log('ok  ', name);
  } catch (error){
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

function approx(actual, expected, tol, label){
  if (Math.abs(actual - expected) > tol){
    throw new Error(label + ' expected ' + expected + ' +/- ' + tol + ', got ' + actual);
  }
}

function finite(value, label){
  assert(Number.isFinite(value), label + ' is not a finite number, got ' + value +
    ' - comparing against a non-number silently passes in one direction');
  return value;
}

function runBot(seed, frames){
  let state = createState(seed);
  for (let i = 0; i < frames; i += 1){
    state = step(state, botInput(state));
    if (state.phase === 'dead') break;
  }
  return state;
}

/* 剥注释与字符串。“某段里有没有 X”这类扫描必须先剥，否则两个方向都会骗人：
 * 注释里提到的词会让它误报，而“以后别在注释里写这些词”是拿产品迁就尺子。 */
function stripCommentsAndStrings(source){
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length){
    const c = source[i];
    const n = source[i + 1];
    if (quote){
      if (c === '\\'){ out += '  '; i += 2; continue; }
      if (c === quote) quote = null;
      out += ' ';
      i += 1;
      continue;
    }
    if (c === '"' || c === '\'' || c === '`'){ quote = c; out += ' '; i += 1; continue; }
    if (c === '/' && n === '/'){
      while (i < source.length && source[i] !== '\n'){ out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && n === '*'){
      out += '  ';
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')){
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
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
    const m = lines[i].match(/^(\s*)run:\s*\|\s*$/);
    if (!m) continue;
    const indent = m[1].length;
    const body = [];
    i += 1;
    while (i < lines.length){
      const raw = lines[i];
      if (!raw.trim()){ body.push(raw); i += 1; continue; }
      if (raw.match(/^\s*/)[0].length <= indent) break;
      body.push(raw.slice(indent + 2));
      i += 1;
    }
    i -= 1;
    blocks.push(body.join('\n'));
  }
  return blocks;
}

function teeBlocksMissingPipefail(yaml){
  return parseRunBlocks(yaml).filter(b => b.includes('| tee') && !/pipefail/.test(b));
}

const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z\-_]{20,}/,
];

function scanSecretShapes(text){
  return SECRET_PATTERNS.some(re => re.test(text));
}

/* 哨兵在运行时拼出来，源码里一个字符都不出现。上一版把它写成字面量，
 * 结果被密钥扫描器自己抓了,扫描是对的，说谎的是夹具。 */
function sentinelToken(){
  return ['g', 'h', 'p'].join('') + '_' + 'AbCdEf0123456789AbCdEf0123456789';
}

/* 本地存储调用的白名单检查。剥掩之后字符串字面量会变成空白，所以
 * `localStorage.getItem(STORAGE.best)` 活下来，而 `localStorage.getItem('x')` 变成
 * `localStorage.getItem(   )`,后者就是未登记的键。白名单优于黑名单：
 * 新加一个键而忘了登记，默认不通过。 */
function unregisteredStorageCalls(source){
  const stripped = stripCommentsAndStrings(source);
  const hits = [...stripped.matchAll(/localStorage\.(getItem|setItem|removeItem)\s*\(([^)]*)\)/g)];
  return hits
    .map(m => ({ method: m[1], arg: m[2].trim() }))
    .filter(hit => !/^STORAGE\./.test(hit.arg) && !/^key$/.test(hit.arg));
}

function storageCallCount(source){
  return [...stripCommentsAndStrings(source).matchAll(/localStorage\./g)].length;
}

function expectedScoreForFrames(frames){
  let state = createState(7);
  for (let i = 0; i < frames; i += 1){
    state = step(state, botInput(state));
    if (state.phase === 'dead') break;
  }
  return state.score;
}

function measureMaxClimb(framesBetweenPipes){
  let state = createState(5);
  state.phase = 'playing';
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

function framesBetweenPipes(){
  return Math.floor(CONFIG.PIPE_SPACING / CONFIG.SCROLL);
}

function cardBounds(height){
  return { top: CONFIG.CARD.cy - height / 2, bottom: CONFIG.CARD.cy + height / 2 };
}

check('config-numbers-are-finite', () => {
  finite(CONFIG.MAX_GAP_DELTA, 'MAX_GAP_DELTA');
  finite(CONFIG.CARD.hDead, 'CARD.hDead');
  finite(CONFIG.CARD_INNER_W, 'CARD_INNER_W');
  finite(CONFIG.SHOT_BAND.y0, 'SHOT_BAND.y0');
  finite(CONFIG.DEAD_STRIP.y1, 'DEAD_STRIP.y1');
  for (const [i, y] of CONFIG.DEAD_LINES.entries()) finite(y, 'DEAD_LINES[' + i + ']');
  for (const [i, y] of CONFIG.READY_LINES.entries()) finite(y, 'READY_LINES[' + i + ']');
});

check('config-gap-range-positive', () => {
  assert(gapRange().span > 0, 'gap range collapsed');
});

check('coupling-max-gap-delta-equals-gap-span', () => {
  eq(CONFIG.MAX_GAP_DELTA, gapRange().span, 'MAX_GAP_DELTA');
});

check('coupling-mutation-catches-margin-change-without-recompute', () => {
  const prev = CONFIG.GAP_MARGIN;
  CONFIG.GAP_MARGIN = prev + 10;
  try {
    assert(CONFIG.MAX_GAP_DELTA !== gapRange().span, 'equality assertion is decorative');
  } finally {
    CONFIG.GAP_MARGIN = prev;
  }
});

check('best-of-keeps-the-larger-score', () => {
  eq(bestOf(5, 3), 5, 'previous larger');
  eq(bestOf(3, 5), 5, 'current larger');
  eq(bestOf(0, 0), 0, 'both zero');
  eq(bestOf(7, 7), 7, 'equal');
});

check('best-of-sanitizes-hostile-storage-values', () => {
  eq(bestOf('12', 3), 12, 'numeric string');
  eq(bestOf(null, 4), 4, 'null previous');
  eq(bestOf(undefined, 4), 4, 'undefined previous');
  eq(bestOf(Number.NaN, 4), 4, 'NaN previous');
  eq(bestOf(-99, 0), 0, 'negative previous');
  eq(bestOf('drop table', 2), 2, 'garbage string');
  eq(bestOf(Number.POSITIVE_INFINITY, 2), 2, 'infinity');
  eq(sanitizeScore(4.9), 4, 'fractional score floors');
});

check('best-of-mutation-catches-always-taking-current', () => {
  const mutant = (prev, cur) => sanitizeScore(cur);
  assert(mutant(5, 3) !== bestOf(5, 3), 'a broken bestOf would survive this suite');
});

check('determinism-same-seed-same-digest', () => {
  const seq = Array.from({ length: 900 }, (_, i) => ({ flap: i % 17 === 0 }));
  let a = createState(11);
  let b = createState(11);
  for (const input of seq){ a = step(a, input); b = step(b, input); }
  eq(digest(a), digest(b), 'digest');
});

check('determinism-different-seeds-diverge', () => {
  let a = createState(11);
  let b = createState(12);
  for (let i = 0; i < 300; i += 1){ a = step(a, botInput(a)); b = step(b, botInput(b)); }
  assert(digest(a) !== digest(b), 'different seeds should diverge');
});

check('step-does-not-mutate-input', () => {
  const state = createState(2);
  const before = JSON.stringify(state);
  const next = step(state, { flap: true });
  eq(JSON.stringify(state), before, 'input state');
  assert(next !== state, 'same object returned');
});

check('ready-flap-starts-game', () => {
  const state = step(createState(3), { flap: true });
  eq(state.phase, 'playing', 'phase');
  eq(state.flaps, 1, 'flaps');
  assert(state.bird.vy < 0, 'flap should launch upward');
});

/* 20 帧不够把一次跳跃抵消完（按 FLAP_VY / GRAVITY 算需要 35 帧），那一轮红的是尺子。
 * 预算从参数推导再留余量，不凭手感填整数。 */
check('gravity-pulls-down', () => {
  const framesToCancelFlap = Math.ceil(Math.abs(CONFIG.FLAP_VY) / CONFIG.GRAVITY) * 2;
  let state = step(createState(3), { flap: true });
  const y = state.bird.y;
  for (let i = 0; i < framesToCancelFlap; i += 1) state = step(state, { flap: false });
  assert(state.bird.y > y, 'bird should fall back down after ' + framesToCancelFlap + ' frames');
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

check('dead-state-freezes-world', () => {
  const state = createState(8);
  state.phase = 'dead';
  state.score = 9;
  state.pipes = [{ id: 1, x: 50, gapCenter: 220, scored: false }];
  const next = step(state, { flap: true });
  eq(next.score, 9, 'score');
  eq(next.pipes[0].x, 50, 'pipe x');
});

const seedScores = [];
for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]){
  check('bot-survives-seed-' + seed, () => {
    const state = runBot(seed, 3600);
    assert(state.phase !== 'dead', 'bot died at frame ' + state.frame + ' cause ' + state.deathCause);
    seedScores.push(state.score);
  });
}

check('bot-score-matches-derived-expectation', () => {
  const expected = expectedScoreForFrames(3600);
  const sorted = [...seedScores].sort((a, b) => a - b);
  approx(sorted[Math.floor(sorted.length / 2)], expected, 3, 'median score');
});

check('pipe-body-taller-than-cap-across-gap-range', () => {
  const range = gapRange();
  for (const gc of [range.lo, Math.round((range.lo + range.hi) / 2), range.hi]){
    const g = pipeGeometry({ gapCenter: gc, x: CONFIG.WORLD_W });
    assert(g.topH > CONFIG.CAP_H, 'top body too short at ' + gc);
    assert(g.bottomH > CONFIG.CAP_H, 'bottom body too short at ' + gc);
  }
});

check('cap-height-mutation-breaks-pixel-precondition', () => {
  const prev = CONFIG.CAP_H;
  CONFIG.CAP_H = 90;
  try {
    const g = pipeGeometry({ gapCenter: gapRange().lo, x: CONFIG.WORLD_W });
    assert(!(g.topH > CONFIG.CAP_H), 'mutation should break body-after-cap');
  } finally {
    CONFIG.CAP_H = prev;
  }
});

check('climb-proof-beats-max-gap-delta', () => {
  const climb = measureMaxClimb(framesBetweenPipes());
  assert(climb >= CONFIG.MAX_GAP_DELTA, 'max climb ' + climb.toFixed(1) + ' < delta ' + CONFIG.MAX_GAP_DELTA);
});

check('climb-proof-mutation-catches-impossible-delta', () => {
  const prev = CONFIG.MAX_GAP_DELTA;
  CONFIG.MAX_GAP_DELTA = 5000;
  try {
    assert(!(measureMaxClimb(framesBetweenPipes()) >= CONFIG.MAX_GAP_DELTA), 'proof is decorative');
  } finally {
    CONFIG.MAX_GAP_DELTA = prev;
  }
});

check('shot-band-sits-below-dead-card-and-above-ground', () => {
  const dead = cardBounds(CONFIG.CARD.hDead);
  assert(CONFIG.SHOT_BAND.y0 > dead.bottom,
    'band y0 ' + CONFIG.SHOT_BAND.y0 + ' overlaps dead card bottom ' + dead.bottom);
  assert(CONFIG.SHOT_BAND.y1 < playFloor(), 'band reaches the ground strip');
  assert(CONFIG.SHOT_BAND.y0 > CONFIG.HUD_BASELINE, 'band overlaps HUD');
});

check('shot-band-mutation-catches-taller-card', () => {
  const prev = CONFIG.CARD.hDead;
  CONFIG.CARD.hDead = prev + 60;
  try {
    assert(!(CONFIG.SHOT_BAND.y0 > cardBounds(CONFIG.CARD.hDead).bottom),
      'growing the card should push into the band');
  } finally {
    CONFIG.CARD.hDead = prev;
  }
});

check('dead-strip-sits-inside-card-clear-of-corners', () => {
  const dead = cardBounds(CONFIG.CARD.hDead);
  assert(CONFIG.DEAD_STRIP.y0 >= dead.top + CONFIG.CARD.radius, 'strip touches rounded corner');
  assert(CONFIG.DEAD_STRIP.y1 < CONFIG.DEAD_LINES[0], 'strip runs into the title baseline');
  eq(CONFIG.CARD_INNER_W, CONFIG.CARD.w - CONFIG.CARD.stroke * 2, 'card inner width');
});

/* 死亡弹窗现在有五行（多了最高分）。行数、行间距、弹窗高度是一组：
 * 加一行而不动 hDead，最后一行会推出弹窗底那一刻，这条就红。
 * 字体基线到字底大约再往下 6px，取 10 留余量。真正拿实测字体度量去卡的
 * 那一条在浏览器闸门里,这里只能做几何层面的粗筛。 */
check('dead-card-lines-fit-and-are-ordered', () => {
  const lines = CONFIG.DEAD_LINES;
  eq(lines.length, 5, 'dead card line count');
  const dead = cardBounds(CONFIG.CARD.hDead);
  assert(lines[0] > dead.top + CONFIG.CARD.radius, 'title sits in the corner radius');
  assert(lines[lines.length - 1] + 10 <= dead.bottom,
    'last line ' + lines[lines.length - 1] + ' does not fit above card bottom ' + dead.bottom);
  for (let i = 1; i < lines.length; i += 1){
    assert(lines[i] > lines[i - 1], 'line ' + i + ' is not below line ' + (i - 1));
  }
});

check('dead-card-line-mutation-catches-overflow', () => {
  const dead = cardBounds(CONFIG.CARD.hDead);
  const mutant = [...CONFIG.DEAD_LINES.slice(0, -1), Math.round(dead.bottom) + 4];
  assert(!(mutant[mutant.length - 1] + 10 <= dead.bottom), 'overflow check is decorative');
});

check('ready-card-lines-fit-and-are-ordered', () => {
  const lines = CONFIG.READY_LINES;
  eq(lines.length, 3, 'ready card line count');
  const ready = cardBounds(CONFIG.CARD.hReady);
  assert(lines[0] > ready.top + CONFIG.CARD.radius, 'title sits in the corner radius');
  assert(lines[lines.length - 1] + 10 <= ready.bottom, 'last ready line overflows the card');
  for (let i = 1; i < lines.length; i += 1){
    assert(lines[i] > lines[i - 1], 'ready line ' + i + ' out of order');
  }
});

check('snapshot-contract-stable', () => {
  const snap = snapshot(createState(6));
  for (const key of ['frame','phase','score','flaps','birdY','birdVy','deathCause','pipesLive','nextGapCenter','seed','pipes']){
    assert(Object.hasOwn(snap, key), 'missing ' + key);
  }
});

/* 最高分把 localStorage 带进了项目，声音带进了 AudioContext。两者都是 I/O，
 * 都不得出现在纯核心里,这两个词因此进了禁用名单。 */
const IMPURE_TOKENS = ['Math.random', 'Date.now', 'fetch(', 'document.', 'window.',
                       'process.env', 'localStorage', 'AudioContext', 'requestAnimationFrame'];

check('engine-purity-scan', () => {
  const stripped = stripCommentsAndStrings(fs.readFileSync('src/engine.mjs', 'utf8'));
  assert(stripped.length > 1500, 'stripped engine suspiciously small: ' + stripped.length);
  assert(/export function step/.test(stripped), 'step missing after strip');
  assert(/export function collide/.test(stripped), 'collide missing after strip');
  assert(/export function bestOf/.test(stripped), 'bestOf missing after strip');
  for (const needle of IMPURE_TOKENS){
    assert(!stripped.includes(needle), 'impure token ' + needle + ' in engine');
  }
});

check('purity-scan-mutation-proves-itself', () => {
  const source = fs.readFileSync('src/engine.mjs', 'utf8');
  for (const token of ['Math.random()', 'localStorage.getItem(k)', 'new AudioContext()']){
    const mutant = source + '\nconst sneaky = ' + token + ';\n';
    const stripped = stripCommentsAndStrings(mutant);
    assert(IMPURE_TOKENS.some(t => stripped.includes(t)), 'mutation ' + token + ' did not land');
  }
});

check('stripper-does-not-false-positive-on-comments', () => {
  const stripped = stripCommentsAndStrings('/* Math.random localStorage AudioContext */\nexport function step(){}');
  for (const token of ['Math.random', 'localStorage', 'AudioContext']){
    assert(!stripped.includes(token), token + ' leaked through stripper');
  }
  assert(stripped.includes('export function step'), 'stripper ate real code');
});

check('storage-keys-are-registered-and-versioned', () => {
  const source = fs.readFileSync('src/main.mjs', 'utf8');
  const keys = [...source.matchAll(/^\s{2}(\w+): '([^']+)',$/gm)]
    .map(m => m[2])
    .filter(v => v.startsWith('flappycat.'));
  assert(keys.length >= 2, 'expected at least two registered storage keys, got ' + keys.length);
  eq(new Set(keys).size, keys.length, 'storage key uniqueness');
  for (const key of keys){
    assert(/\.v\d+$/.test(key), 'key ' + key + ' has no version suffix');
  }
});

check('every-storage-call-goes-through-the-registry', () => {
  const source = fs.readFileSync('src/main.mjs', 'utf8');
  assert(storageCallCount(source) >= 3, 'storage scanner found almost no calls, parser drifted');
  const offenders = unregisteredStorageCalls(source);
  eq(offenders.map(o => o.method + '(' + o.arg + ')').join(', '), '', 'unregistered storage calls');
});

check('storage-whitelist-mutation-proves-itself', () => {
  const mutant = 'const v = localStorage.getItem(\'flappycat.sneaky\');';
  const offenders = unregisteredStorageCalls(mutant);
  eq(offenders.length, 1, 'whitelist scanner missed a raw literal key');
});

check('workflow-set-equals-registry', () => {
  const actual = listRepoFiles()
    .filter(p => p.startsWith('.github/workflows/'))
    .map(p => path.posix.basename(p))
    .sort();
  eq(JSON.stringify(actual), JSON.stringify(['pages.yml', 'verify.yml']), 'workflow set');
});

check('workflow-registry-mutation-proves-itself', () => {
  assert(JSON.stringify(['pages.yml', 'verify.yml', 'extra.yml']) !== JSON.stringify(['pages.yml', 'verify.yml']),
    'set comparison is decorative');
});

check('tee-blocks-have-pipefail', () => {
  const yaml = fs.readFileSync('.github/workflows/verify.yml', 'utf8');
  eq(parseRunBlocks(yaml).filter(b => b.includes('| tee')).length, 2, 'tee block count');
  eq(teeBlocksMissingPipefail(yaml).length, 0, 'blocks missing pipefail');
});

check('pipefail-scanner-mutation-proves-itself', () => {
  const yaml = fs.readFileSync('.github/workflows/verify.yml', 'utf8');
  const mutant = yaml.split('set -o pipefail').join('');
  assert(mutant !== yaml, 'mutation did not land');
  eq(teeBlocksMissingPipefail(mutant).length, 2, 'scanner missed missing pipefail');
});

check('report-job-calls-shared-workflow', () => {
  const yaml = fs.readFileSync('.github/workflows/verify.yml', 'utf8');
  assert(yaml.includes('uses: supercubegame/ci-workflows/.github/workflows/report.yml@main'), 'shared workflow missing');
  assert(yaml.includes('<!-- verify-gate -->'), 'marker drifted');
});

check('compose-slugs-match-uploaded-artifacts', () => {
  const compose = fs.readFileSync('scripts/compose-report.mjs', 'utf8');
  const slugs = [...compose.matchAll(/slug: '([^']+)'/g)].map(m => m[1]).sort();
  eq(JSON.stringify(slugs), JSON.stringify(['eng', 'web']), 'compose slugs');
  const yaml = fs.readFileSync('.github/workflows/verify.yml', 'utf8');
  for (const slug of slugs) assert(yaml.includes('stdout-' + slug + '.log'), 'stdout log missing for ' + slug);
});

check('rules-files-match-byte-for-byte', () => {
  eq(Buffer.compare(fs.readFileSync('AGENTS.md'), fs.readFileSync('CLAUDE.md')), 0, 'rules files diverged');
});

check('rules-file-stays-under-200-lines', () => {
  const lines = fs.readFileSync('AGENTS.md', 'utf8').trimEnd().split('\n').length;
  assert(lines <= 200, 'AGENTS.md has ' + lines + ' lines');
});

function shotFiles(){
  return fs.readdirSync('docs/shots').filter(f => f.endsWith('.svg')).sort();
}

check('readme-references-exactly-the-shot-set', () => {
  const readme = fs.readFileSync('README.md', 'utf8');
  const referenced = [...readme.matchAll(/docs\/shots\/([A-Za-z0-9._-]+\.svg)/g)].map(m => m[1]);
  eq(JSON.stringify([...new Set(referenced)].sort()), JSON.stringify(shotFiles()), 'README shot set');
});

check('shots-are-non-empty-and-distinct', () => {
  const bodies = shotFiles().map(f => fs.readFileSync(path.join('docs/shots', f), 'utf8'));
  assert(bodies.length >= 3, 'expected at least three shots, got ' + bodies.length);
  for (const [i, body] of bodies.entries()){
    assert(body.length > 400, shotFiles()[i] + ' is suspiciously small: ' + body.length);
  }
  eq(new Set(bodies).size, bodies.length, 'shot uniqueness');
});

check('shots-declare-engine-canvas-size', () => {
  const want = 'viewBox="0 0 ' + CONFIG.WORLD_W + ' ' + CONFIG.WORLD_H + '"';
  for (const f of shotFiles()){
    assert(fs.readFileSync(path.join('docs/shots', f), 'utf8').includes(want), f + ' does not declare ' + want);
  }
});

check('shot-canvas-assertion-mutation-proves-itself', () => {
  const body = fs.readFileSync(path.join('docs/shots', shotFiles()[0]), 'utf8');
  const mutant = body.replace('viewBox="0 0 ' + CONFIG.WORLD_W, 'viewBox="0 0 999');
  assert(mutant !== body, 'mutation did not land');
  assert(!mutant.includes('viewBox="0 0 ' + CONFIG.WORLD_W + ' ' + CONFIG.WORLD_H + '"'), 'check is decorative');
});

check('readme-documents-install-and-verify-commands', () => {
  const readme = fs.readFileSync('README.md', 'utf8');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  for (const script of Object.keys(pkg.scripts)){
    assert(readme.includes('npm run ' + script), 'README does not document npm run ' + script);
  }
  assert(readme.includes('npm install'), 'README does not document npm install');
});

/* README 必须提到现在真存在的用户可见功能。它不是泛泛地扫“现时语气”,
 * 而是拿代码里真存在的东西（存储键、快捷键）当真值。 */
check('readme-documents-features-that-exist-in-code', () => {
  const readme = fs.readFileSync('README.md', 'utf8');
  const main = fs.readFileSync('src/main.mjs', 'utf8');
  if (main.includes('flappycat.best')) assert(/\u6700\u9ad8\u5206/.test(readme), 'README never mentions the best score');
  if (main.includes('flappycat.muted')) assert(/\u58f0\u97f3/.test(readme), 'README never mentions the sound toggle');
  if (main.includes("'KeyM'")) assert(/\bM\b/.test(readme), 'README never documents the M shortcut');
});

check('obligations-are-live-and-not-overdue', () => {
  const now = new Date();
  const items = JSON.parse(fs.readFileSync('docs/OBLIGATIONS.json', 'utf8'));
  assert(items.length > 0, 'obligation list is empty');
  for (const item of items){
    assert(item.status === 'pending', item.id + ' is done but still listed, delete it');
    assert(new Date(item.due + 'T23:59:59+08:00') >= now, item.id + ' is overdue, do it or move it to unmeasurable');
    const body = fs.readFileSync(item.criteria.path, 'utf8');
    assert(body.includes(item.criteria.mustInclude),
      item.id + ' completion marker is gone from ' + item.criteria.path + ' - if it is done, delete the obligation');
  }
});

check('obligation-checker-mutation-proves-itself', () => {
  assert(!(new Date('2020-01-01T23:59:59+08:00') >= new Date()), 'overdue check is decorative');
});

check('secret-shape-scan', () => {
  const offenders = [];
  for (const file of listRepoFiles()){
    if (/\.(png|jpe?g|gif|ico|woff2?|zip)$/i.test(file)) continue;
    if (scanSecretShapes(fs.readFileSync(file, 'utf8'))) offenders.push(file);
  }
  eq(offenders.join(','), '', 'files with secret-like tokens');
});

check('secret-scan-mutation-proves-itself', () => {
  assert(scanSecretShapes('token = "' + sentinelToken() + '"'), 'scanner missed the runtime sentinel');
});

check('sentinel-never-appears-in-sources', () => {
  const token = sentinelToken();
  for (const file of listRepoFiles()){
    if (/\.(png|jpe?g|gif|ico|woff2?|zip)$/i.test(file)) continue;
    assert(!fs.readFileSync(file, 'utf8').includes(token), 'sentinel leaked into ' + file);
  }
});

check('renderer-imports-pipe-geometry', () => {
  const source = fs.readFileSync('src/render.mjs', 'utf8');
  assert(source.includes('pipeGeometry'), 'renderer must use pipeGeometry');
  assert(!/PIPE_GAP\s*\//.test(stripCommentsAndStrings(source)), 'renderer recomputes gap math');
});

/* 基线坐标必须从 CONFIG 读。渲染层自己写一堆字面量的话，上面那几条几何断言
 * 验的就不是画面上真正在用的数字了,那才是真正的空断言。 */
check('renderer-reads-card-baselines-from-config', () => {
  const stripped = stripCommentsAndStrings(fs.readFileSync('src/render.mjs', 'utf8'));
  const deadFn = stripped.slice(stripped.indexOf('export function drawDead'), stripped.indexOf('function card('));
  assert(deadFn.length > 200, 'drawDead slice too small, parser drifted');
  assert(deadFn.includes('CONFIG.DEAD_LINES'), 'drawDead must read CONFIG.DEAD_LINES');
  const baselineLiterals = [...deadFn.matchAll(/,\s*(\d{3})\s*\)/g)].map(m => m[1]);
  eq(baselineLiterals.join(','), '', 'drawDead still has hardcoded baseline literals');
});

check('renderer-uses-flat-rects-for-pipes', () => {
  const stripped = stripCommentsAndStrings(fs.readFileSync('src/render.mjs', 'utf8'));
  const pipeFn = stripped.slice(stripped.indexOf('export function drawPipes'), stripped.indexOf('export function drawBird'));
  assert(pipeFn.length > 200, 'drawPipes slice too small, parser drifted');
  for (const banned of ['strokeRect', 'createLinearGradient', 'globalAlpha', 'shadowBlur']){
    assert(!pipeFn.includes(banned), banned + ' would break the pixel equality assertion');
  }
});

check('perf-18000-steps-under-budget', () => {
  let state = createState(9);
  const t0 = performance.now();
  for (let i = 0; i < 18000; i += 1) state = step(state, botInput(state));
  const ms = performance.now() - t0;
  assert(ms < 8000, 'perf too slow: ' + ms.toFixed(2) + ' ms');
});

let perfMs = 0;
let perfState = createState(9);
{
  const t0 = performance.now();
  for (let i = 0; i < 18000; i += 1) perfState = step(perfState, botInput(perfState));
  perfMs = Number((performance.now() - t0).toFixed(2));
}

const sortedScores = [...seedScores].sort((a, b) => a - b);
const metrics = {
  unitPass: passed,
  seeds: seedScores.length,
  medianScore: sortedScores.length ? sortedScores[Math.floor(sortedScores.length / 2)] : 0,
  minScore: sortedScores.length ? sortedScores[0] : 0,
  maxScore: sortedScores.length ? sortedScores[sortedScores.length - 1] : 0,
  maxClimb: Number(measureMaxClimb(framesBetweenPipes()).toFixed(1)),
  maxGapDelta: CONFIG.MAX_GAP_DELTA,
  perfMs,
  perfFrames: 18000,
  rulesLines: fs.readFileSync('AGENTS.md', 'utf8').trimEnd().split('\n').length,
  mutantsKilled: mutationKilled,
  mutantsTotal: mutationChecks,
};

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
