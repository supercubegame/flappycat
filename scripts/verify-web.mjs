#!/usr/bin/env node
/* ===========================================================================
 * 浏览器闸门。真起页面、真敲键、真数像素。
 * ===========================================================================
 *
 * 两个“拍的数”已经没了，处理方式故意不同：
 *
 * 1. **机器人得分不再是下限，是等号。** 之前写 `score >= 5`，而它等到 5 就停，
 *    于是实测值永远恰好等于下限，那个数字什么也没告诉你。现在跑到固定帧数，
 *    然后拿**同一份纯引擎在 Node 里跑同样帧数**做尺子，断言分数逐字相等。
 *    猜的数因此不是“收紧”了，是消失了。
 *
 * 2. **帧率下限反而改松了。** 它只该抓“彻底卡死 / 白屏 / 死循环”，不是性能基准。
 *    实测 40-42，而原来写 20,只有两倍余量，CI 上共享 CPU 拖一下就会假红，
 *    而假红会逗人去改产品迁就尺子。现在 13，三倍余量，并且另配一条断言
 *    守住“有人把它收得太紧”,两条判词不同，两侧都会红。
 *
 * 还有一个**探针**：shot-play 的 sha 连两轮完全不变，而 ready / dead 那两张在拖。
 * 根因还没定案，所以这一轮不编原因，只把能分辨它的两个数报出来：
 * canvas 自己的像素哈希（不含 CSS 合成与 PNG 编码）和三个字形签名。
 * ======================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { CONFIG, botInput, createState, step } from '../src/engine.mjs';
import { startServer } from './serve.mjs';

/* 只抓彻底卡死。实测基线是 run acc56bc 上的 40（上一轮 42）。 */
const FPS_FLOOR = 13;
const FPS_MEASURED_BASELINE = 40;
const BOT_FRAMES = 720;
const SHOT_SEED = 7;
const SHOT_MIN_FRAMES = 300;

const artifactsDir = path.resolve('artifacts');
fs.mkdirSync(artifactsDir, { recursive: true });

const failures = [];
let passed = 0;
const metrics = { shots: [] };

async function check(name, fn){
  try {
    await fn();
    passed += 1;
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

function expectedBandPixels(snap){
  const { y0, y1 } = CONFIG.SHOT_BAND;
  let body = 0;
  let cap = 0;
  const overlap = (a0, a1) => Math.max(0, Math.min(a1, y1) - Math.max(a0, y0));
  for (const pipe of snap.pipes){
    const x = Math.round(pipe.x);
    const bodyW = Math.max(0, Math.min(CONFIG.WORLD_W, x + CONFIG.PIPE_W) - Math.max(0, x));
    const capW = Math.max(0, Math.min(CONFIG.WORLD_W, x + CONFIG.PIPE_W + CONFIG.CAP_OVERHANG) -
                             Math.max(0, x - CONFIG.CAP_OVERHANG));
    body += overlap(0, Math.max(0, pipe.topH - CONFIG.CAP_H)) * bodyW;
    body += overlap(pipe.bottomY + CONFIG.CAP_H,
                    pipe.bottomY + CONFIG.CAP_H + Math.max(0, pipe.bottomH - CONFIG.CAP_H)) * bodyW;
    cap += overlap(pipe.topH - CONFIG.CAP_H, pipe.topH) * capW;
    cap += overlap(pipe.bottomY, pipe.bottomY + CONFIG.CAP_H) * capW;
  }
  return { body, cap };
}

async function shoot(page, name){
  const canvasSha = await page.evaluate(() => window.__FLAPPY.canvasHash());
  const buffer = await page.locator('#game').screenshot({ type: 'png' });
  fs.writeFileSync(path.join(artifactsDir, name), buffer);
  metrics.shots.push({
    name,
    bytes: buffer.length,
    sha: crypto.createHash('sha256').update(buffer).digest('hex'),
    canvasSha,
  });
}

const server = await startServer('.', 0);
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
const consoleErrors = [];
page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', err => consoleErrors.push(String(err)));

await page.goto(server.url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__FLAPPY, null, { timeout: 15000 });
await page.bringToFront();

await check('page-boots-without-console-errors', async () => {
  eq(consoleErrors.join(' | '), '', 'console errors');
});

await check('canvas-matches-engine-world-size', async () => {
  const size = await page.evaluate(() => ({ w: game.width, h: game.height }));
  eq(size.w, CONFIG.WORLD_W, 'canvas width');
  eq(size.h, CONFIG.WORLD_H, 'canvas height');
  metrics.canvas = size.w + 'x' + size.h;
});

await check('cjk-renders-differently-from-guaranteed-tofu', async () => {
  const sig = await page.evaluate(() => ({
    cjk: window.__FLAPPY.glyphSignature('\u8d77\u98de'),
    latin: window.__FLAPPY.glyphSignature('7'),
    tofu: window.__FLAPPY.glyphSignature('\uE000'),
  }));
  metrics.glyph = sig;
  assert(sig.cjk !== sig.tofu, 'CJK collapsed into tofu, runner is missing CJK fonts');
  assert(sig.latin !== sig.tofu, 'latin digit collapsed into tofu');
});

/* 同一个状态重画两次必须逐像素相等。这条把“渲染本身不确定”从候选名单里划掉，
 * 让漂动的嘲疑范围缩到“跑与跑之间的环境差异”。 */
await check('render-is-idempotent-for-the-same-state', async () => {
  const pair = await page.evaluate(() => {
    window.__FLAPPY.setPaused(true);
    window.__FLAPPY.reset(7);
    const a = window.__FLAPPY.canvasHash();
    window.__FLAPPY.renderNow();
    return { a, b: window.__FLAPPY.canvasHash() };
  });
  eq(pair.b, pair.a, 'repeated paint of the same state');
});

await check('ready-phase-has-zero-pipe-pixels', async () => {
  const data = await page.evaluate(band => {
    window.__FLAPPY.setPaused(true);
    window.__FLAPPY.reset(7);
    return {
      phase: window.__FLAPPY.snapshot().phase,
      body: window.__FLAPPY.countColorsInBand([window.__FLAPPY.colors.pipeBody], band.y0, band.y1),
      panel: window.__FLAPPY.countColorsInBand([window.__FLAPPY.colors.panel], 0, window.__FLAPPY.config.WORLD_H),
    };
  }, CONFIG.SHOT_BAND);
  eq(data.phase, 'ready', 'phase');
  eq(data.body, 0, 'ready pipe body pixels');
  assert(data.panel > 0, 'ready card should be visible');
});

await shoot(page, 'shot-ready.png');

await check('space-starts-the-game-on-the-real-page', async () => {
  await page.evaluate(() => window.__FLAPPY.setPaused(false));
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__FLAPPY.snapshot().phase !== 'ready', null, { timeout: 8000 });
  const snap = await page.evaluate(() => window.__FLAPPY.snapshot());
  assert(snap.flaps >= 1, 'flaps did not increment');
});

await check('fps-floor-keeps-three-times-margin', async () => {
  assert(FPS_FLOOR * 3 <= FPS_MEASURED_BASELINE,
    'floor ' + FPS_FLOOR + ' is too tight against measured ' + FPS_MEASURED_BASELINE +
    ' - a floor that normal jitter can hit is a false-red factory');
  assert(FPS_FLOOR > 0, 'floor of zero would be an empty assertion');
});

await check('real-loop-advances-above-fps-floor', async () => {
  const fps = await page.evaluate(async () => {
    const start = window.__FLAPPY.snapshot().frame;
    await new Promise(r => setTimeout(r, 1000));
    return window.__FLAPPY.snapshot().frame - start;
  });
  metrics.fps = fps;
  metrics.fpsFloor = FPS_FLOOR;
  metrics.fpsBaseline = FPS_MEASURED_BASELINE;
  assert(fps >= FPS_FLOOR, 'loop advanced only ' + fps + ' frames in 1s, page is effectively frozen');
});

/* 承重的那一条：浏览器里跑出来的分数必须逐字等于同一份纯引擎在 Node 里
 * 跑同样帧数的分数。尺子是独立的（另一个进程、另一个堆），而且它不只守分数：
 * 鸟的高度、存活管道数、相位都要对得上。 */
await check('browser-run-equals-pure-engine-at-the-same-frame-count', async () => {
  await page.evaluate(() => {
    window.__FLAPPY.reset(7);
    window.__FLAPPY.setBot(true);
    window.__FLAPPY.setPaused(false);
  });
  await page.waitForFunction(
    target => window.__FLAPPY.snapshot().frame >= target,
    BOT_FRAMES,
    { timeout: 45000 },
  );
  const snap = await page.evaluate(() => {
    window.__FLAPPY.setPaused(true);
    return window.__FLAPPY.snapshot();
  });

  let sim = createState(7);
  for (let i = 0; i < snap.frame; i += 1) sim = step(sim, botInput(sim));

  metrics.botFrames = snap.frame;
  metrics.botScore = snap.score;
  metrics.botJumps = snap.flaps;
  metrics.engineScoreSameFrames = sim.score;

  assert(sim.score > 0, 'the expectation itself is zero, frame budget is too small to reach any pipe');
  eq(snap.phase, sim.phase, 'phase');
  eq(snap.score, sim.score, 'browser score vs pure engine score at frame ' + snap.frame);
  eq(snap.flaps, sim.flaps, 'flap count');
  eq(snap.pipesLive, sim.pipes.length, 'live pipe count');
  eq(Math.round(snap.birdY), Math.round(sim.bird.y), 'bird y');
});

await check('pipe-pixels-equal-engine-geometry', async () => {
  const data = await page.evaluate(args => {
    window.__FLAPPY.setBot(false);
    const snap = window.__FLAPPY.runToShotFrame(args.seed, args.minFrames);
    return {
      snap,
      body: window.__FLAPPY.countColorsInBand([window.__FLAPPY.colors.pipeBody], args.band.y0, args.band.y1),
      cap: window.__FLAPPY.countColorsInBand([window.__FLAPPY.colors.pipeCap], args.band.y0, args.band.y1),
      panel: window.__FLAPPY.countColorsInBand([window.__FLAPPY.colors.panel], 0, args.worldH),
      hud: document.getElementById('score-value').textContent,
    };
  }, { seed: SHOT_SEED, minFrames: SHOT_MIN_FRAMES, band: CONFIG.SHOT_BAND, worldH: CONFIG.WORLD_H });

  const expected = expectedBandPixels(data.snap);
  metrics.shotFrame = data.snap.frame;
  metrics.shotScore = data.snap.score;
  metrics.pipePixels = data.body;
  metrics.expectedPipePixels = expected.body;
  metrics.capPixels = data.cap;
  metrics.expectedCapPixels = expected.cap;

  eq(data.snap.phase, 'playing', 'phase at shot frame');
  assert(expected.body > 0, 'expectation itself is empty, fixture never reached a pipe');
  eq(data.body, expected.body, 'pipe body pixels in band');
  eq(data.cap, expected.cap, 'pipe cap pixels in band');
  eq(data.panel, 0, 'playing phase must have no card panel pixels');
  eq(Number(data.hud), data.snap.score, 'HUD score vs engine score');
});

await shoot(page, 'shot-play.png');

await check('death-card-geometry-is-exact', async () => {
  const data = await page.evaluate(args => {
    const snap = window.__FLAPPY.runToDeath(args.seed);
    const c = document.createElement('canvas').getContext('2d');
    c.font = 'bold 28px "Noto Sans CJK SC", "Noto Sans", system-ui, sans-serif';
    return {
      snap,
      ascent: c.measureText('Game Over').actualBoundingBoxAscent,
      strip: window.__FLAPPY.countColorsInBand([window.__FLAPPY.colors.panel], args.strip.y0, args.strip.y1),
    };
  }, { strip: CONFIG.DEAD_STRIP, seed: SHOT_SEED });

  const expected = (CONFIG.DEAD_STRIP.y1 - CONFIG.DEAD_STRIP.y0) * CONFIG.CARD_INNER_W;
  metrics.deadStripPixels = data.strip;
  metrics.expectedDeadStripPixels = expected;
  metrics.deadCause = data.snap.deathCause;

  eq(data.snap.phase, 'dead', 'phase');
  assert(data.snap.deathCause === 'pipe' || data.snap.deathCause === 'ground', 'missing death cause');
  assert(CONFIG.DEAD_STRIP.y1 <= CONFIG.DEAD_TITLE_BASELINE - data.ascent,
    'strip overlaps the title, measured ascent ' + data.ascent.toFixed(1));
  eq(data.strip, expected, 'death card panel strip pixels');
});

await shoot(page, 'shot-dead.png');

await check('space-restarts-after-death', async () => {
  await page.keyboard.press('Space');
  const snap = await page.evaluate(() => window.__FLAPPY.snapshot());
  eq(snap.phase, 'ready', 'phase after restart');
  eq(snap.score, 0, 'score after restart');
});

await check('three-shots-are-distinct', async () => {
  eq(metrics.shots.length, 3, 'shot count');
  eq(new Set(metrics.shots.map(s => s.sha)).size, 3, 'distinct png hashes');
  eq(new Set(metrics.shots.map(s => s.canvasSha)).size, 3, 'distinct canvas pixel hashes');
  for (const shot of metrics.shots) assert(shot.bytes > 1000, shot.name + ' is only ' + shot.bytes + ' bytes');
});

await browser.close();
await server.close();

const report = { passed, total: passed + failures.length, failures, metrics };
fs.writeFileSync(path.join(artifactsDir, 'verify-web-report.json'), JSON.stringify(report, null, 2));
process.stdout.write('\n' + JSON.stringify(report, null, 2) + '\n');
process.exit(failures.length ? 1 : 0);
