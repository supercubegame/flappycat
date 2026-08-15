import { CONFIG, botInput, createState, snapshot, step } from './engine.mjs';
import { COLORS } from './palette.mjs';
import { render } from './render.mjs';

const canvas = document.getElementById('game');
const scoreNode = document.getElementById('score-value');
const phaseNode = document.getElementById('phase-value');
const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });

canvas.width = CONFIG.WORLD_W;
canvas.height = CONFIG.WORLD_H;

let state = createState(7);
let paused = false;
let bot = false;
let raf = null;
let lastTick = 0;

function paint(){
  render(ctx, state);
  scoreNode.textContent = String(state.score);
  phaseNode.textContent = state.phase;
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
    state = step(state, bot ? botInput(state) : { flap: false });
    paint();
  }
  if (!paused) raf = requestAnimationFrame(loop);
}

function reset(seed = 7){
  state = createState(seed);
  paint();
}

function feed(input){
  state = step(state, input);
  paint();
  return snapshot(state);
}

function flap(){
  if (state.phase === 'dead'){
    reset(state.seed);
    return snapshot(state);
  }
  return feed({ flap: true });
}

window.addEventListener('keydown', ev => {
  if (ev.code !== 'Space') return;
  ev.preventDefault();
  flap();
});
canvas.addEventListener('pointerdown', ev => {
  ev.preventDefault();
  flap();
});

paint();
raf = requestAnimationFrame(loop);

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

/* 缺字体的时候汉字会全退化成同一个方块。判断方法不是去猜方块长什么样，
 * 而是拿私用区的一个码位做基准,任何字体都没有它，它必然是方块。 */
function glyphSignature(text){
  const off = document.createElement('canvas');
  off.width = 96;
  off.height = 96;
  const c = off.getContext('2d');
  c.fillStyle = '#000';
  c.fillRect(0, 0, off.width, off.height);
  c.fillStyle = '#fff';
  c.font = '42px "Noto Sans CJK SC", "Noto Sans", system-ui, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, off.width / 2, off.height / 2 + 2);
  const d = c.getImageData(0, 0, off.width, off.height).data;
  let h = 2166136261;
  for (let i = 0; i < d.length; i += 1){
    h ^= d[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/* 确定性截图用的推进器。不靠 rAF，所以同一个种子每次跑出来的画面一模一样。
 * 停在「管道水平方向不碰到鸟」的那一帧，不是硕死一个帧数,否则鸟会遮住管体
 * 像素，而那一笔算不进期望值里。 */
function runToShotFrame(seed, minFrames){
  reset(seed);
  pause();
  state = step(state, { flap: true });
  for (let guard = 0; guard < 1500; guard += 1){
    state = step(state, botInput(state));
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
  state = step(state, { flap: true });
  for (let guard = 0; guard < 1500 && state.phase === 'playing'; guard += 1){
    state = step(state, { flap: false });
  }
  paint();
  return snapshot(state);
}

window.__FLAPPY = {
  config: CONFIG,
  colors: COLORS,
  reset,
  feed,
  snapshot: () => snapshot(state),
  renderNow: () => paint(),
  setPaused(flag){ if (flag) pause(); else resume(); },
  isPaused: () => paused,
  setBot(flag){ bot = !!flag; },
  countColorsInBand,
  glyphSignature,
  runToShotFrame,
  runToDeath,
  toPng: () => canvas.toDataURL('image/png'),
};
