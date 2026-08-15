import { CONFIG, bestOf, botInput, createState, sanitizeScore, snapshot, step } from './engine.mjs';
import { COLORS } from './palette.mjs';
import { render } from './render.mjs';

/* 本地存储的键只在这一处声明。快闸门有一条扫描要求所有 localStorage 调用
 * 都走 STORAGE.xxx，不得直接传字符串字面量,白名单形式，新加一个键而忘了
 * 登记会红。带 v1 后缀是为了以后改存储格式时不会读到旧结构。 */
const STORAGE = {
  best: 'flappycat.best.v1',
  muted: 'flappycat.muted.v1',
};

const canvas = document.getElementById('game');
const scoreNode = document.getElementById('score-value');
const bestNode = document.getElementById('best-value');
const phaseNode = document.getElementById('phase-value');
const soundButton = document.getElementById('sound-toggle');
const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });

canvas.width = CONFIG.WORLD_W;
canvas.height = CONFIG.WORLD_H;

let state = createState(7);
let paused = false;
let bot = false;
let raf = null;
let lastTick = 0;

/* 读本地存储永远可能抛（隐私模式、禁用第三方存储），而一个因为存不了最高分
 * 就打不开的游戏是很蠢的。所以这里失败降级成内存，但**把降级记下来**，
 * 并且把它暴露在诊断出口上,静默降级和“存储工作正常”在界面上一模一样。 */
let storageDegraded = false;

function readStorage(key){
  try {
    return window.localStorage.getItem(key);
  } catch (error) {
    storageDegraded = true;
    return null;
  }
}

function writeStorage(key, value){
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (error) {
    storageDegraded = true;
    return false;
  }
}

let best = sanitizeScore(readStorage(STORAGE.best));
let muted = readStorage(STORAGE.muted) === '1';

/* ---------------------------------------------------------------------------
 * 声音。闸门验的是“真的创建并启动了一个音源节点”，不是“能听到”,
 * 后者 CI 验不了，已经写进“测不出来的”那一节。
 *
 * soundStarts 只在**节点真的启动成功之后**才加。要是在“决定要响”那一刻就加，
 * 它证明的只是我有意愿，而意愿不是行为。
 * ------------------------------------------------------------------------ */
let audioCtx = null;
let soundStarts = 0;
let soundFailures = 0;

function audioContextClass(){
  return window.AudioContext || window.webkitAudioContext || null;
}

function ensureAudio(){
  if (audioCtx) return audioCtx;
  const Ctor = audioContextClass();
  if (!Ctor) return null;
  try {
    audioCtx = new Ctor();
  } catch (error) {
    soundFailures += 1;
    return null;
  }
  return audioCtx;
}

function blip(freq, seconds, type){
  if (muted) return false;
  const ac = ensureAudio();
  if (!ac) return false;
  try {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type || 'square';
    osc.frequency.value = freq;
    gain.gain.value = 0.06;
    osc.connect(gain);
    gain.connect(ac.destination);
    const now = ac.currentTime;
    osc.start(now);
    osc.stop(now + seconds);
    soundStarts += 1;
    return true;
  } catch (error) {
    soundFailures += 1;
    return false;
  }
}

const sfx = {
  flap: () => blip(660, 0.07, 'square'),
  score: () => blip(990, 0.09, 'triangle'),
  die: () => blip(180, 0.28, 'sawtooth'),
};

function renderSoundButton(){
  if (!soundButton) return;
  soundButton.textContent = muted ? '\u58f0\u97f3\uff1a\u5173' : '\u58f0\u97f3\uff1a\u5f00';
  soundButton.setAttribute('aria-pressed', muted ? 'false' : 'true');
  soundButton.dataset.muted = muted ? '1' : '0';
}

function setMuted(flag){
  muted = !!flag;
  writeStorage(STORAGE.muted, muted ? '1' : '0');
  renderSoundButton();
  return muted;
}

/* ------------------------------------------------------------------------ */

function paint(){
  render(ctx, state, best);
  scoreNode.textContent = String(state.score);
  bestNode.textContent = String(best);
  phaseNode.textContent = state.phase;
}

/* 每次状态推进之后都走这里，所以“死了就结算最高分”不依赖谁记得调用它。
 * 规则走纯核心的 bestOf，这里只负责落盘。 */
function settle(previousPhase){
  if (state.phase === 'dead' && previousPhase !== 'dead'){
    const next = bestOf(best, state.score);
    if (next !== best){
      best = next;
      writeStorage(STORAGE.best, String(best));
    }
    sfx.die();
  }
}

function advance(input){
  const before = state;
  state = step(state, input);
  if (state.score > before.score) sfx.score();
  settle(before.phase);
  return state;
}

function pause(){
  paused = true;
  if (raf) cancelAnimationFrame(raf);
  raf = null;
}

function resume(){
  if (!paused) return;
  paused = false;
  lastTick = 0;
  raf = requestAnimationFrame(loop);
}

function loop(ts){
  if (!lastTick) lastTick = ts;
  if (ts - lastTick >= 1000 / 60){
    lastTick = ts;
    advance(bot ? botInput(state) : { flap: false });
    paint();
  }
  if (!paused) raf = requestAnimationFrame(loop);
}

function reset(seed = 7){
  state = createState(seed);
  paint();
}

function feed(input){
  advance(input);
  paint();
  return snapshot(state);
}

function flap(){
  if (state.phase === 'dead'){
    reset(state.seed);
    return snapshot(state);
  }
  const snap = feed({ flap: true });
  sfx.flap();
  return snap;
}

window.addEventListener('keydown', ev => {
  if (ev.code === 'KeyM'){
    ev.preventDefault();
    setMuted(!muted);
    return;
  }
  if (ev.code !== 'Space') return;
  ev.preventDefault();
  flap();
});
canvas.addEventListener('pointerdown', ev => {
  ev.preventDefault();
  flap();
});
if (soundButton){
  soundButton.addEventListener('click', () => setMuted(!muted));
}

renderSoundButton();
paint();
raf = requestAnimationFrame(loop);

function fnv(bytes){
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i += 1){
    h ^= bytes[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function countColorsInBand(hexList, y0, y1){
  const top = Math.max(0, Math.min(canvas.height, y0));
  const bottom = Math.max(top, Math.min(canvas.height, y1));
  if (bottom === top) return 0;
  const data = ctx.getImageData(0, top, canvas.width, bottom - top).data;
  const targets = new Set(hexList.map(hex => {
    const n = Number.parseInt(hex.slice(1), 16);
    return [n >> 16, (n >> 8) & 255, n & 255].join(',');
  }));
  let count = 0;
  for (let i = 0; i < data.length; i += 4){
    if (targets.has([data[i], data[i + 1], data[i + 2]].join(','))) count += 1;
  }
  return count;
}

function canvasHash(){
  return fnv(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
}

function glyphSignature(text, font){
  const off = document.createElement('canvas');
  off.width = 96;
  off.height = 96;
  const c = off.getContext('2d', { willReadFrequently: true });
  c.fillStyle = '#000';
  c.fillRect(0, 0, off.width, off.height);
  c.fillStyle = '#fff';
  c.font = font || '42px "Noto Sans CJK SC", "Noto Sans", system-ui, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, off.width / 2, off.height / 2 + 2);
  return fnv(c.getImageData(0, 0, off.width, off.height).data);
}

function runToShotFrame(seed, minFrames){
  reset(seed);
  pause();
  advance({ flap: true });
  for (let guard = 0; guard < 1500; guard += 1){
    advance(botInput(state));
    if (state.phase !== 'playing') break;
    if (state.frame < minFrames) continue;
    const clear = state.pipes.every(p => {
      const x = Math.round(p.x);
      return x + CONFIG.PIPE_W < CONFIG.BIRD_X - CONFIG.BIRD_R - 2 ||
             x > CONFIG.BIRD_X + CONFIG.BIRD_R + 2;
    });
    if (clear) break;
  }
  paint();
  return snapshot(state);
}

function runToDeath(seed){
  reset(seed);
  pause();
  advance({ flap: true });
  for (let guard = 0; guard < 1500 && state.phase === 'playing'; guard += 1){
    advance({ flap: false });
  }
  paint();
  return snapshot(state);
}

/* 先拿分再死。最高分那条断言需要一个**非零**的分数，而 runToDeath 一下不扇
 * 直接摔地上，分数永远是 0,拿它去验“最高分存下来了”会得到一条
 * 0 == 0 的空断言。 */
function runToDeathAfterScoring(seed, minScore){
  reset(seed);
  pause();
  advance({ flap: true });
  for (let guard = 0; guard < 3000; guard += 1){
    if (state.phase !== 'playing') break;
    if (state.score >= minScore) break;
    advance(botInput(state));
  }
  for (let guard = 0; guard < 1500 && state.phase === 'playing'; guard += 1){
    advance({ flap: false });
  }
  paint();
  return snapshot(state);
}

window.__FLAPPY = {
  config: CONFIG,
  colors: COLORS,
  storageKeys: Object.assign({}, STORAGE),
  reset,
  feed,
  snapshot: () => snapshot(state),
  renderNow: () => paint(),
  setPaused(flag){ if (flag) pause(); else resume(); },
  isPaused: () => paused,
  setBot(flag){ bot = !!flag; },
  countColorsInBand,
  canvasHash,
  glyphSignature,
  runToShotFrame,
  runToDeath,
  runToDeathAfterScoring,
  getBest: () => best,
  isMuted: () => muted,
  setMuted,
  clickSoundToggle: () => { soundButton.click(); return muted; },
  soundToggleLabel: () => soundButton.textContent,
  audio: () => ({
    starts: soundStarts,
    failures: soundFailures,
    hasContextClass: !!audioContextClass(),
    contextState: audioCtx ? audioCtx.state : null,
  }),
  storageDegraded: () => storageDegraded,
  wipeStorage(){
    for (const key of Object.values(STORAGE)) window.localStorage.removeItem(key);
  },
};
