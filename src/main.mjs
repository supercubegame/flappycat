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

function reset(seed = 7){
  state = createState(seed);
  paint();
}

function feed(input){
  state = step(state, input);
  paint();
  return snapshot(state);
}

function loop(ts){
  if (!lastTick) lastTick = ts;
  const dt = ts - lastTick;
  if (dt >= 1000 / 60){
    lastTick = ts;
    const input = bot ? botInput(state) : { flap: false };
    state = step(state, input);
    paint();
  }
  if (!paused) raf = requestAnimationFrame(loop);
}

function resume(){
  if (!paused) return;
  paused = false;
  lastTick = 0;
  raf = requestAnimationFrame(loop);
}

function pause(){
  paused = true;
  if (raf) cancelAnimationFrame(raf);
  raf = null;
}

function flap(){
  if (state.phase === 'dead'){
    reset(7);
    return feed({ flap: false });
  }
  return feed({ flap: true });
}

window.addEventListener('keydown', ev => {
  if (ev.code !== 'Space') return;
  ev.preventDefault();
  flap();
});

paint();
raf = requestAnimationFrame(loop);

function countColors(hexList){
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
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
  for (let i = 0; i < d.length; i += 4){
    h ^= d[i]; h = Math.imul(h, 16777619) >>> 0;
    h ^= d[i + 1]; h = Math.imul(h, 16777619) >>> 0;
    h ^= d[i + 2]; h = Math.imul(h, 16777619) >>> 0;
    h ^= d[i + 3]; h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

window.__FLAPPY = {
  config: CONFIG,
  colors: COLORS,
  reset,
  feed,
  getState: () => structuredClone(state),
  snapshot: () => snapshot(state),
  renderNow: () => paint(),
  setPaused(flag){ if (flag) pause(); else resume(); },
  setBot(flag){ bot = !!flag; },
  countColors,
  glyphSignature,
};
