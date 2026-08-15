#!/usr/bin/env node
/* ===========================================================================
 * 浏览器闸门。真起页面、真敲键、真数像素、真重载。
 * ===========================================================================
 *
 * 两个“拍的数”已经没了，处理方式故意不同：
 *
 * 1. **机器人得分不再是下限，是等号。** 之前写 score >= 5，而它等到 5 就停，
 *    于是实测值永远恰好等于下限，那个数字什么也告诉不了你。现在跑到固定帧数，
 *    然后拿**同一份纯引擎在 Node 里跑同样帧数**做尺子，断言逐字相等。
 * 2. **帧率下限反而改松了。** 它只该抓彻底卡死，不是性能基准。紧到正常波动
 *    就会撞的下限是一台假红工厂，而假红会逗人去改产品迁就尺子。
 *
 * 最高分与声音这两块的断言设计：
 *
 * - 最高分验的是**真的重载页面**之后还在。读一下内存里的变量证明不了持久化,
 *   而持久化正是这个功能的全部内容。另外先拿分再死，否则得到的是一条 0 == 0。
 * - 声音验的是“真的创建并启动了音源节点”，**不是“能听到”**,后者 CI 验不了，
 *   已经写进 README 的“测不出来的”。两个方向都要红：开着必须增加，关了必须一个不增。
 * ======================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { CONFIG, botInput, createState, step } from '../src/engine.mjs';
import { startServer } from './serve.mjs';

const FPS_FLOOR = 13;
const FPS_MEASURED_BASELINE = 38;
const BOT_FRAMES = 720;
const SHOT_SEED = 7;
const SHOT_MIN_FRAMES = 300;
const BEST_TARGET_SCORE = 3;

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

async function boot(page, url){
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__FLAPPY, null, { timeout: 15000 });
  await page.bringToFront();
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
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding',
         '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 1040 } });
const consoleErrors = [];
page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', err => consoleErrors.push(String(err)));

await boot(page, server.url);

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

await check('local-storage-is-actually-available', async () => {
  const degraded = await page.evaluate(() => window.__FLAPPY.storageDegraded());
  metrics.storageDegraded = degraded;
  assert(!degraded, 'storage already degraded to memory, every persistence assertion below would be vacuous');
});

/* ---------------------------------------------------------------------------
 * 最高分持久化
 * ------------------------------------------------------------------------ */

await check('fresh-storage-means-zero-best', async () => {
  await page.evaluate(() => window.__FLAPPY.wipeStorage());
  await boot(page, server.url);
  eq(await page.evaluate(() => window.__FLAPPY.getBest()), 0, 'best on fresh storage');
  eq(await page.evaluate(() => document.getElementById('best-value').textContent), '0', 'best pill');
});

await check('best-score-survives-a-real-page-reload', async () => {
  const scored = await page.evaluate(target => {
    window.__FLAPPY.setPaused(true);
    const snap = window.__FLAPPY.runToDeathAfterScoring(7, target);
    return { snap, best: window.__FLAPPY.getBest() };
  }, BEST_TARGET_SCORE);

  metrics.bestRunScore = scored.snap.score;
  eq(scored.snap.phase, 'dead', 'phase after the scoring run');
  assert(scored.snap.score >= BEST_TARGET_SCORE,
    'fixture only reached ' + scored.snap.score + ', a zero score would make this assertion vacuous');
  eq(scored.best, scored.snap.score, 'best right after dying');

  await boot(page, server.url);
  const afterReload = await page.evaluate(() => ({
    best: window.__FLAPPY.getBest(),
    pill: document.getElementById('best-value').textContent,
    phase: window.__FLAPPY.snapshot().phase,
    score: window.__FLAPPY.snapshot().score,
  }));
  metrics.bestAfterReload = afterReload.best;
  eq(afterReload.best, scored.snap.score, 'best after reload');
  eq(Number(afterReload.pill), scored.snap.score, 'best pill after reload');
  eq(afterReload.phase, 'ready', 'a reload should start a fresh round');
  eq(afterReload.score, 0, 'current score after reload');
});

await check('a-worse-run-does-not-lower-the-best', async () => {
  const before = await page.evaluate(() => window.__FLAPPY.getBest());
  assert(before > 0, 'nothing to protect, previous assertion did not leave a best score');
  const after = await page.evaluate(() => {
    window.__FLAPPY.setPaused(true);
    const snap = window.__FLAPPY.runToDeath(7);
    return { score: snap.score, best: window.__FLAPPY.getBest() };
  });
  assert(after.score < before, 'the fixture run scored ' + after.score + ', not worse than ' + before);
  eq(after.best, before, 'best after a worse run');
});

await check('hud-best-matches-the-stored-best', async () => {
  const data = await page.evaluate(() => ({
    best: window.__FLAPPY.getBest(),
    pill: document.getElementById('best-value').textContent,
  }));
  eq(Number(data.pill), data.best, 'best pill vs stored best');
});

/* ---------------------------------------------------------------------------
 * 声音开关
 * ------------------------------------------------------------------------ */

await check('audio-context-exists-in-this-runner', async () => {
  const audio = await page.evaluate(() => window.__FLAPPY.audio());
  metrics.audio = audio;
  assert(audio.hasContextClass,
    'no AudioContext in this browser, so both sound assertions below would be vacuous');
});

await check('sound-on-really-starts-an-audio-node', async () => {
  const result = await page.evaluate(() => {
    window.__FLAPPY.setPaused(true);
    window.__FLAPPY.setMuted(false);
    window.__FLAPPY.reset(7);
    const before = window.__FLAPPY.audio();
    window.__FLAPPY.feed({ flap: true });
    document.dispatchEvent(new Event('noop'));
    const mid = window.__FLAPPY.audio();
    return { before, mid };
  });
  // feed() 不发声，发声的是真正的按键路径，所以这里用真键盘事件。
  await page.keyboard.press('Space');
  const after = await page.evaluate(() => window.__FLAPPY.audio());
  metrics.audioStartsUnmuted = after.starts;
  eq(after.failures, 0, 'audio node failures while unmuted');
  assert(after.starts > result.mid.starts,
    'pressing Space with sound on started no audio node (starts stayed at ' + after.starts + ')');
});

await check('muting-starts-no-audio-node-at-all', async () => {
  await page.evaluate(() => {
    window.__FLAPPY.setPaused(true);
    window.__FLAPPY.setMuted(true);
    window.__FLAPPY.reset(7);
  });
  const before = await page.evaluate(() => window.__FLAPPY.audio());
  await page.keyboard.press('Space');
  await page.keyboard.press('Space');
  const after = await page.evaluate(() => window.__FLAPPY.audio());
  metrics.audioStartsMuted = after.starts - before.starts;
  eq(after.starts, before.starts, 'audio nodes started while muted');
  eq(after.failures, before.failures, 'muted path should not even try to build audio');
});

await check('sound-toggle-button-drives-and-reflects-the-state', async () => {
  const states = await page.evaluate(() => {
    window.__FLAPPY.setMuted(false);
    const on = { muted: window.__FLAPPY.isMuted(), label: window.__FLAPPY.soundToggleLabel() };
    const afterClick = window.__FLAPPY.clickSoundToggle();
    const off = { muted: afterClick, label: window.__FLAPPY.soundToggleLabel() };
    return { on, off };
  });
  eq(states.on.muted, false, 'muted flag with sound on');
  eq(states.off.muted, true, 'muted flag after clicking the button');
  assert(states.on.label !== states.off.label,
    'the button label did not change, so it cannot tell the two states apart');
});

await check('mute-preference-survives-a-real-page-reload', async () => {
  await page.evaluate(() => window.__FLAPPY.setMuted(true));
  await boot(page, server.url);
  const muted = await page.evaluate(() => ({
    flag: window.__FLAPPY.isMuted(),
    attr: document.getElementById('sound-toggle').dataset.muted,
  }));
  eq(muted.flag, true, 'muted flag after reload');
  eq(muted.attr, '1', 'button data attribute after reload');

  await page.evaluate(() => window.__FLAPPY.setMuted(false));
  await boot(page, server.url);
  const unmuted = await page.evaluate(() => ({
    flag: window.__FLAPPY.isMuted(),
    attr: document.getElementById('sound-toggle').dataset.muted,
  }));
  eq(unmuted.flag, false, 'unmuted flag after reload');
  eq(unmuted.attr, '0', 'button data attribute after reload');
});

/* ---------------------------------------------------------------------------
 * 画面与循环。从这里开始把存储抹干净并重载，让三张截图确定性地可重现
 * （最高分会画在弹窗上，不抹的话它会跟着上面那几条断言的结果走）。
 * ------------------------------------------------------------------------ */

await page.evaluate(() => window.__FLAPPY.wipeStorage());
await boot(page, server.url);

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
    const title = c.measureText('Game Over');
    c.font = '18px "Noto Sans CJK SC", "Noto Sans", system-ui, sans-serif';
    const body = c.measureText('\u6700\u9ad8\u5206 0');
    return {
      snap,
      titleAscent: title.actualBoundingBoxAscent,
      bodyDescent: body.actualBoundingBoxDescent,
      bodyWidth: body.width,
      strip: window.__FLAPPY.countColorsInBand([window.__FLAPPY.colors.panel], args.strip.y0, args.strip.y1),
    };
  }, { strip: CONFIG.DEAD_STRIP, seed: SHOT_SEED });

  const expected = (CONFIG.DEAD_STRIP.y1 - CONFIG.DEAD_STRIP.y0) * CONFIG.CARD_INNER_W;
  const cardBottom = CONFIG.CARD.cy + CONFIG.CARD.hDead / 2;
  const lastLine = CONFIG.DEAD_LINES[CONFIG.DEAD_LINES.length - 1];
  metrics.deadStripPixels = data.strip;
  metrics.expectedDeadStripPixels = expected;
  metrics.deadCause = data.snap.deathCause;
  metrics.titleAscent = Number(data.titleAscent.toFixed(1));
  metrics.bodyDescent = Number(data.bodyDescent.toFixed(1));

  eq(data.snap.phase, 'dead', 'phase');
  assert(data.snap.deathCause === 'pipe' || data.snap.deathCause === 'ground', 'missing death cause');
  assert(CONFIG.DEAD_STRIP.y1 <= CONFIG.DEAD_LINES[0] - data.titleAscent,
    'strip overlaps the title, measured ascent ' + data.titleAscent.toFixed(1));
  assert(lastLine + data.bodyDescent <= cardBottom,
    'the last line descends past the card bottom: ' + (lastLine + data.bodyDescent).toFixed(1) +
    ' > ' + cardBottom + ' (measured descent ' + data.bodyDescent.toFixed(1) + ')');
  assert(data.bodyWidth < CONFIG.CARD_INNER_W,
    'the best-score line is wider than the card: ' + data.bodyWidth.toFixed(1));
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
