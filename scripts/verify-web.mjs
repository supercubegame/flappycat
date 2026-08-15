#!/usr/bin/env node
/* ===========================================================================
 * 浏览器闸门。真起页面、真敲键、真数像素。
 * ===========================================================================
 *
 * 上一轮这里红了两条，根因都在夹具：
 *
 * 1. 前面一条断言把循环 setPaused(true) 之后没恢复，于是机器人那条等了 25 秒
 *    看着一个永远不动的分数。现在每条断言自己声明需要动还是需要静。
 * 2. 三张截图里有两张 sha 一模一样,因为它们在同一个被暂停的帧上拍的。
 *    现在截图前先用引擎确定性地推到指定帧，三张图互不相同是构造保证的。
 *
 * 注意区分两件事：“三张图不同”只能证明画面变了，它不能证明画对了。
 * 承重的是横带像素等号那三条。
 * ======================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { CONFIG } from '../src/engine.mjs';
import { startServer } from './serve.mjs';

const BOT_SCORE_MIN = 5; // TODO tighten from first real CI run
const FPS_FLOOR = 20; // TODO tighten from first real CI run
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

/* 期望像素完全从引擎快照推导，不看画面。这才是“画面跟上了状态”那一半的意义。 */
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
    const topBodyH = Math.max(0, pipe.topH - CONFIG.CAP_H);
    const bottomBodyH = Math.max(0, pipe.bottomH - CONFIG.CAP_H);
    body += overlap(0, topBodyH) * bodyW;
    body += overlap(pipe.bottomY + CONFIG.CAP_H, pipe.bottomY + CONFIG.CAP_H + bottomBodyH) * bodyW;
    cap += overlap(pipe.topH - CONFIG.CAP_H, pipe.topH) * capW;
    cap += overlap(pipe.bottomY, pipe.bottomY + CONFIG.CAP_H) * capW;
  }
  return { body, cap };
}

async function shoot(page, name){
  const buffer = await page.locator('#game').screenshot({ type: 'png' });
  fs.writeFileSync(path.join(artifactsDir, name), buffer);
  metrics.shots.push({
    name,
    bytes: buffer.length,
    sha: crypto.createHash('sha256').update(buffer).digest('hex'),
  });
  return buffer;
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
    real: window.__FLAPPY.glyphSignature('\u8d77\u98de'),
    tofu: window.__FLAPPY.glyphSignature('\uE000'),
  }));
  assert(sig.real !== sig.tofu, 'CJK collapsed into tofu, runner is missing CJK fonts');
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
  await page.locator('#game').click({ position: { x: 5, y: 5 }, force: true }).catch(() => {});
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__FLAPPY.snapshot().phase !== 'ready', null, { timeout: 8000 });
  const snap = await page.evaluate(() => window.__FLAPPY.snapshot());
  assert(snap.flaps >= 1, 'flaps did not increment');
});

await check('bot-scores-on-the-real-animation-loop', async () => {
  await page.evaluate(() => {
    window.__FLAPPY.reset(7);
    window.__FLAPPY.setBot(true);
    window.__FLAPPY.setPaused(false);
  });
  await page.waitForFunction(
    min => window.__FLAPPY.snapshot().score >= min,
    BOT_SCORE_MIN,
    { timeout: 40000 },
  );
  const snap = await page.evaluate(() => window.__FLAPPY.snapshot());
  metrics.botScore = snap.score;
  metrics.botJumps = snap.flaps;
  assert(snap.score >= BOT_SCORE_MIN, 'bot score ' + snap.score + ' < floor ' + BOT_SCORE_MIN);
});

await check('real-loop-advances-at-least-fps-floor', async () => {
  const fps = await page.evaluate(async () => {
    const start = window.__FLAPPY.snapshot().frame;
    await new Promise(r => setTimeout(r, 1000));
    return window.__FLAPPY.snapshot().frame - start;
  });
  metrics.fps = fps;
  assert(fps >= FPS_FLOOR, 'loop advanced only ' + fps + ' frames in 1s');
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
  assert(expected.body > 0, 'expectation itself is empty, fixture did not reach pipes');
  eq(data.body, expected.body, 'pipe body pixels in band');
  eq(data.cap, expected.cap, 'pipe cap pixels in band');
  eq(data.panel, 0, 'playing phase must have no card panel pixels');
  eq(Number(data.hud), data.snap.score, 'HUD score vs engine score');
});

await shoot(page, 'shot-play.png');

await check('death-card-geometry-is-exact', async () => {
  const data = await page.evaluate(args => {
    const snap = window.__FLAPPY.runToDeath(args.seed);
    const ascent = (() => {
      const c = document.createElement('canvas').getContext('2d');
      c.font = 'bold 28px "Noto Sans CJK SC", "Noto Sans", system-ui, sans-serif';
      return c.measureText('Game Over').actualBoundingBoxAscent;
    })();
    return {
      snap,
      ascent,
      strip: window.__FLAPPY.countColorsInBand([window.__FLAPPY.colors.panel], args.strip.y0, args.strip.y1),
      pipeBody: window.__FLAPPY.countColorsInBand([window.__FLAPPY.colors.pipeBody], args.strip.y0, args.strip.y1),
    };
  }, { seed: SHOT_SEED, strip: CONFIG.DEAD_STRIP });

  const stripH = CONFIG.DEAD_STRIP.y1 - CONFIG.DEAD_STRIP.y0;
  const expected = stripH * CONFIG.CARD_INNER_W;
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
  eq(new Set(metrics.shots.map(s => s.sha)).size, 3, 'distinct shot hashes');
  for (const shot of metrics.shots) assert(shot.bytes > 1000, shot.name + ' is only ' + shot.bytes + ' bytes');
});

await browser.close();
await server.close();

const report = { passed, total: passed + failures.length, failures, metrics };
fs.writeFileSync(path.join(artifactsDir, 'verify-web-report.json'), JSON.stringify(report, null, 2));
process.stdout.write('\n' + JSON.stringify(report, null, 2) + '\n');
process.exit(failures.length ? 1 : 0);
