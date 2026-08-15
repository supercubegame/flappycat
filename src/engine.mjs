/* ===========================================================================
 * FLAPPYCAT 引擎 —— 纯核心
 * ===========================================================================
 *
 * 这个文件不碰 I/O：不读文件、不碰界面、不发请求、不取系统时间、不用未播种的
 * 随机源。闸门里有一条扫描在守这件事，而且它先剥掉注释再扫,所以这段说明本身
 * 不会把它骗过去。
 *
 * 三个回报：同种子同输入必然同输出（闸门 eng-determinism）；一万八千步压测在
 * 毫秒级（eng 那条 perf）；同一份逻辑可以换任何外壳,canvas、终端、服务端重放。
 *
 * 契约：step(state, input) 返回**新**状态，绝不改入参。
 * ======================================================================== */

export const CONFIG = {
  WORLD_W: 480,
  WORLD_H: 640,
  GROUND_H: 72,
  BIRD_X: 132,
  BIRD_R: 14,
  GRAVITY: 0.42,
  FLAP_VY: -7.2,
  MAX_VY: 11,
  PIPE_W: 62,
  PIPE_GAP: 158,
  PIPE_SPACING: 208,
  SCROLL: 2.35,
  GAP_MARGIN: 124,
  CAP_H: 26,
  CAP_OVERHANG: 5,
};

/* 地面那条线。管体的下半段正好画到它，所以渲染层画地面不会盖住管体像素,
 * 浏览器闸门的像素等号断言依赖这一点。 */
export function playFloor(){
  return CONFIG.WORLD_H - CONFIG.GROUND_H;
}

/* 缝隙中心的取值区间。上下都留 GAP_MARGIN，保证管体两段都比管口那一段高,
 * 这是像素等号断言成立的前提，闸门 coupling-cap-inside-body 在守。 */
export function gapRange(){
  const lo = CONFIG.GAP_MARGIN;
  const hi = playFloor() - CONFIG.GAP_MARGIN;
  return { lo, hi, span: hi - lo };
}

/* 确定性随机源：种子进，序列出。 */
function nextRand(seedState){
  let t = (seedState + 0x6D2B79F5) | 0;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { state: t | 0, value };
}

export function createState(seed = 1){
  return {
    seed: seed | 0,
    rng: (seed | 0) ^ 0x9e3779b9,
    frame: 0,
    phase: 'ready',
    bird: { y: playFloor() / 2, vy: 0 },
    pipes: [],
    nextPipeId: 1,
    spawnAcc: 0,
    score: 0,
    flaps: 0,
    deathCause: null,
  };
}

/* 管道几何只有这一份。渲染层和闸门都读它,画法和期望像素数因此不会各自漂。 */
export function pipeGeometry(pipe){
  const half = CONFIG.PIPE_GAP / 2;
  const topH = Math.round(pipe.gapCenter - half);
  const bottomY = Math.round(pipe.gapCenter + half);
  return { topH, bottomY, bottomH: playFloor() - bottomY };
}

export function collide(bird, pipes){
  const r = CONFIG.BIRD_R;
  if (bird.y + r >= playFloor()) return 'ground';
  for (const p of pipes){
    const overlapX = CONFIG.BIRD_X + r > p.x && CONFIG.BIRD_X - r < p.x + CONFIG.PIPE_W;
    if (!overlapX) continue;
    const g = pipeGeometry(p);
    if (bird.y - r < g.topH || bird.y + r > g.bottomY) return 'pipe';
  }
  return null;
}

/* 还没被越过的最近那根管道。机器人和 HUD 都用它。 */
export function nextPipe(state){
  let best = null;
  for (const p of state.pipes){
    if (p.x + CONFIG.PIPE_W < CONFIG.BIRD_X - CONFIG.BIRD_R) continue;
    if (!best || p.x < best.x) best = p;
  }
  return best;
}

/* 机器人策略。它是闸门的主力：一个能连过十几根管道的策略，证明的是关卡真的
 * 可通过、计分真的在走、碰撞真的在拦。浏览器闸门里跑的是同一份。 */
export function botInput(state){
  if (state.phase === 'ready') return { flap: true };
  if (state.phase === 'dead') return { flap: false };
  const p = nextPipe(state);
  const target = p ? p.gapCenter : playFloor() / 2;
  return { flap: state.bird.y > target + 14 && state.bird.vy > -2.5 };
}

export function step(state, input){
  const s = structuredClone(state);
  const flap = !!(input && input.flap);

  if (s.phase === 'ready'){
    if (flap){
      s.phase = 'playing';
      s.bird.vy = CONFIG.FLAP_VY;
      s.flaps += 1;
    } else {
      s.bird.y = playFloor() / 2 + Math.sin(s.frame / 16) * 8;
    }
    s.frame += 1;
    return s;
  }

  if (s.phase === 'dead'){
    s.frame += 1;
    return s;
  }

  if (flap){
    s.bird.vy = CONFIG.FLAP_VY;
    s.flaps += 1;
  }
  s.bird.vy = Math.min(s.bird.vy + CONFIG.GRAVITY, CONFIG.MAX_VY);
  s.bird.y += s.bird.vy;
  if (s.bird.y < CONFIG.BIRD_R){
    s.bird.y = CONFIG.BIRD_R;
    if (s.bird.vy < 0) s.bird.vy = 0;
  }

  for (const p of s.pipes) p.x -= CONFIG.SCROLL;
  s.spawnAcc += CONFIG.SCROLL;
  if (s.pipes.length === 0 || s.spawnAcc >= CONFIG.PIPE_SPACING){
    if (s.pipes.length === 0) s.spawnAcc = 0;
    else s.spawnAcc -= CONFIG.PIPE_SPACING;
    const r = nextRand(s.rng);
    s.rng = r.state;
    const range = gapRange();
    s.pipes.push({
      id: s.nextPipeId,
      x: CONFIG.WORLD_W,
      gapCenter: Math.round(range.lo + r.value * range.span),
      scored: false,
    });
    s.nextPipeId += 1;
  }

  for (const p of s.pipes){
    if (!p.scored && p.x + CONFIG.PIPE_W < CONFIG.BIRD_X - CONFIG.BIRD_R){
      p.scored = true;
      s.score += 1;
    }
  }
  s.pipes = s.pipes.filter(p => p.x + CONFIG.PIPE_W > -CONFIG.PIPE_W);

  const cause = collide(s.bird, s.pipes);
  if (cause){
    s.phase = 'dead';
    s.deathCause = cause;
  }
  s.frame += 1;
  return s;
}

/* 只读诊断出口。字段可以增加，不能删改,闸门认这些名字。 */
export function snapshot(state){
  const p = nextPipe(state);
  return {
    frame: state.frame,
    phase: state.phase,
    score: state.score,
    flaps: state.flaps,
    birdY: state.bird.y,
    birdVy: state.bird.vy,
    deathCause: state.deathCause,
    pipesLive: state.pipes.length,
    nextGapCenter: p ? p.gapCenter : null,
    seed: state.seed,
    pipes: state.pipes.map(q => Object.assign({
      id: q.id,
      x: q.x,
      gapCenter: q.gapCenter,
      scored: q.scored,
    }, pipeGeometry(q))),
  };
}

/* 状态摘要。确定性断言比的是它,不是逐字段人工对比。 */
export function digest(state){
  const json = JSON.stringify(state);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i += 1){
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
