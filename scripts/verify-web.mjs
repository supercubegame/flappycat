#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { CONFIG, pipeGeometry, playFloor } from '../src/engine.mjs';
import { startServer } from './serve.mjs';

const BOT_SCORE_MIN = 5; // TODO tighten from first real CI run
const FPS_FLOOR = 20; // TODO tighten from first real CI run
const artifactsDir = path.resolve('artifacts');
fs.mkdirSync(artifactsDir, { recursive: true });

const failures = [];
let passed = 0;
const metrics = { shots: [] };

function check(name, fn){
  return Promise.resolve().then(fn).then(() => {
    passed += 1;
    console.log('ok  ', name);
  }).catch(error => {
    failures.push(name + ': ' + error.message);
    console.log('FAIL', name + ': ' + error.message);
  });
}

function assert(condition, message){
  if (!condition) throw new Error(message);
}

function eq(actual, expected, label){
  if (actual !== expected) throw new Error(label + ' expected ' + expected + ', got ' + actual);
}

function rgba(hex){
  const n = Number.parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255].join(',');
}

function expectedVisiblePipePixels(snap){
  let body = 0;
  let cap = 0;
  for (const pipe of snap.pipes){
    const x = Math.round(pipe.x);
    const left = Math.max(0, x);
    const right = Math.min(CONFIG.WORLD_W, x + CONFIG.PIPE_W);
    const bodyW = Math.max(0, right - left);
    const capLeft = Math.max(0, x - CONFIG.CAP_OVERHANG);
    const capRight = Math.min(CONFIG.WORLD_W, x + CONFIG.PIPE_W + CONFIG.CAP_OVERHANG);
    const capW = Math.max(0, capRight - capLeft);
    if (bodyW > 0){
      body += bodyW * Math.max(0, pipe.topH - CONFIG.CAP_H);
      body += bodyW * Math.max(0, pipe.bottomH - CONFIG.CAP_H);
    }
    if (capW > 0){
      cap += capW * CONFIG.CAP_H * 2;
    }
  }
  return { body, cap };
}

function saveShot(name, buffer){
  const file = path.join(artifactsDir, name);
  fs.writeFileSync(file, buffer);
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  metrics.shots.push({ name, bytes: buffer.length, sha });
}

const server = await startServer('.', 0);
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 980 } });
const consoleErrors = [];
page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', err => consoleErrors.push(String(err)));

await page.goto(server.url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__FLAPPY);

await check('page-boots-without-console-errors', async () => {
  assert(consoleErrors.length === 0, consoleErrors.join(' | '));
});

await check('canvas-is-correct-size', async () => {
  const size = await page.evaluate(() => ({ w: game.width, h: game.height }));
  eq(size.w, 480, 'width');
  eq(size.h, 640, 'height');
  metrics.canvas = size.w + 'x' + size.h;
});

await check('ready-phase-has-zero-pipe-pixels', async () => {
  const data = await page.evaluate(() => {
    window.__FLAPPY.setPaused(true);
    window.__FLAPPY.renderNow();
    return {
      snap: window.__FLAPPY.snapshot(),
      body: window.__FLAPPY.countColors([window.__FLAPPY.colors.pipeBody]),
    };
  });
  eq(data.snap.phase, 'ready', 'phase');
  eq(data.body, 0, 'ready pipe pixels');
});

await check('cjk-glyph-is-not-tofu', async () => {
  const sig = await page.evaluate(() => ({
    text: window.__FLAPPY.glyphSignature('起飞'),
    tofu: window.__FLAPPY.glyphSignature('\uE000'),
  }));
  assert(sig.text !== sig.tofu, 'CJK glyph collapsed into tofu');
});

await check('space-starts-the-game', async () => {
  await page.keyboard.press('Space');
  const snap = await page.evaluate(() => window.__FLAPPY.snapshot());
  eq(snap.phase, 'playing', 'phase');
  assert(snap.flaps >= 1, 'flaps should increment');
});

const menuShot = await page.screenshot({ type: 'png' });
saveShot('shot-ready.png', menuShot);

await check('bot-scores-on-real-loop', async () => {
  await page.evaluate(() => window.__FLAPPY.setBot(true));
  await page.waitForFunction(score => window.__FLAPPY.snapshot().score >= score, BOT_SCORE_MIN, { timeout: 25000 });
  const snap = await page.evaluate(() => window.__FLAPPY.snapshot());
  metrics.botScore = snap.score;
  metrics.botJumps = snap.flaps;
  assert(snap.score >= BOT_SCORE_MIN, 'bot score too low: ' + snap.score);
});

await check('pipe-body-pixels-equal-engine-geometry', async () => {
  const data = await page.evaluate(() => {
    window.__FLAPPY.setPaused(true);
    window.__FLAPPY.renderNow();
    return {
      snap: window.__FLAPPY.snapshot(),
      body: window.__FLAPPY.countColors([window.__FLAPPY.colors.pipeBody]),
      cap: window.__FLAPPY.countColors([window.__FLAPPY.colors.pipeCap]),
      scoreText: document.getElementById('score-value').textContent,
    };
  });
  const expected = expectedVisiblePipePixels(data.snap);
  metrics.pipePixels = data.body;
  metrics.expectedPipePixels = expected.body;
  metrics.capPixels = data.cap;
  metrics.expectedCapPixels = expected.cap;
  eq(data.body, expected.body, 'pipe body pixels');
  eq(data.cap, expected.cap, 'pipe cap pixels');
  eq(Number(data.scoreText), data.snap.score, 'HUD score');
});

const playShot = await page.screenshot({ type: 'png' });
saveShot('shot-play.png', playShot);

await check('fps-stays-above-floor', async () => {
  await page.evaluate(() => window.__FLAPPY.setPaused(false));
  const fps = await page.evaluate(async () => {
    const start = window.__FLAPPY.snapshot().frame;
    await new Promise(r => setTimeout(r, 1000));
    const end = window.__FLAPPY.snapshot().frame;
    return end - start;
  });
  metrics.fps = fps;
  assert(fps >= FPS_FLOOR, 'fps too low: ' + fps);
});

await check('death-overlay-renders-and-restart-works', async () => {
  await page.evaluate(() => window.__FLAPPY.setBot(false));
  await page.waitForFunction(() => window.__FLAPPY.snapshot().phase === 'dead', { timeout: 12000 });
  const dead = await page.evaluate(() => ({
    snap: window.__FLAPPY.snapshot(),
    white: window.__FLAPPY.countColors(['#ffffff']),
  }));
  assert(dead.white > 200, 'death overlay text missing');
  assert(dead.snap.deathCause === 'pipe' || dead.snap.deathCause === 'ground', 'missing death cause');
  await page.keyboard.press('Space');
  const reset = await page.evaluate(() => window.__FLAPPY.snapshot());
  eq(reset.phase, 'ready', 'phase after restart');
  eq(reset.score, 0, 'score after restart');
});

const deadShot = await page.screenshot({ type: 'png' });
saveShot('shot-dead.png', deadShot);

await check('screenshots-are-distinct', async () => {
  const shas = metrics.shots.map(s => s.sha);
  eq(new Set(shas).size, metrics.shots.length, 'shot sha uniqueness');
});

await browser.close();
await server.close();

const report = {
  passed,
  total: passed + failures.length,
  failures,
  metrics,
};
fs.writeFileSync(path.join(artifactsDir, 'verify-web-report.json'), JSON.stringify(report, null, 2));
process.stdout.write('\n' + JSON.stringify(report, null, 2) + '\n');
process.exit(failures.length ? 1 : 0);
