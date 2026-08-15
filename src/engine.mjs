/* ===========================================================================
 * FLAPPYCAT 引擎 —— 纯核心
 * ===========================================================================
 *
 * 这个文件不碰 I/O：不读文件、不碰界面、不发请求、不取系统时间、不用未播种的
 * 随机源，也不碰本地存储与音频。闸门里有一条扫描在守这件事，而且它先剥掉
 * 注释再扫，所以这段说明本身不会把它骗过去。
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

  /* 两根相邻管道缝隙中心最大可能的高差。它必须等于 gapRange().span，有一条
   * 等号断言把两头钉在一起；另一条断言要求机器人在两管之间真的爬得上这么多。
   * 改 GAP_MARGIN 而不重算这个数会红，把它改到物理上爬不上去也会红。 */
  MAX_GAP_DELTA: 320,

  /* 弹窗与 HUD 几何。下面这一整组是耦合的，改任意一个必须重算其余：
   *
   *   - CARD.hDead 决定弹窗上下沿（cy ± h/2）。死亡弹窗现在有五行（多了
   *     一行最高分），所以 hDead 从 172 涨到 200，下沿从 284 移到 298。
   *   - SHOT_BAND 必须落在弹窗下沿之下、地面之上，否则管体像素会被遮,
   *     所以它的 y0 跟着从 300 移到 310。
   *   - DEAD_STRIP 必须在弹窗内部、避开圆角半径、且在第一行基线之上。
   *   - DEAD_LINES / READY_LINES 是文字基线，**渲染层与闸门读同一份**：
   *     两边各写一份就会各自漂，而那时几何断言验的就不是画面上真在用的数。
   *   - CARD_INNER_W = CARD.w - stroke*2：描边居中，两侧各吃 stroke 一半宽。
   *
   * 快闸门有四条断言 + 两个变异体守这一组，浏览器闸门里还有一条拿**实测
   * 字体度量**去卡的。 */
  CARD: { cy: 198, w: 306, hReady: 126, hDead: 200, radius: 16, stroke: 2 },
  CARD_INNER_W: 302,
  DEAD_STRIP: { y0: 126, y1: 142 },
  DEAD_LINES: [172, 206, 232, 258, 286],
  READY_LINES: [176, 210, 238],
  HUD_BASELINE: 66,
  SHOT_BAND: { y0: 310, y1: 560 },
};

export function playFloor(){
  return CONFIG.WORLD_H - CONFIG.GROUND_H;
}

export function gapRange(){
  const lo = CONFIG.GAP_MARGIN;
  const hi = playFloor() - CONFIG.GAP_MARGIN;
  return { lo, hi, span: hi - lo };
}

/* 最高分的**规则**在这里，**存储**在外壳里。这么分的理由很具体：
 * 规则是纯函数，能在快闸门里零依赖验；存储得真跑一个浏览器并真的重载页面。
 * 两边各自那条断言因此也是不同的东西，不是同一条写两遍。
 *
 * 非法输入（NaN、负数、字符串、null）一律归 0,从本地存储读回来的东西
 * 是用户可以随手改的，没有任何保证。 */
export function sanitizeScore(value){
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

export function bestOf(previous, current){
  return Math.max(sanitizeScore(previous), sanitizeScore(current));
}

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

/* 管道几何只有这一份。渲染层和闸门都读它，画法和期望像素数因此不会各自漂。 */
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
    if (!(CONFIG.BIRD_X + r > p.x && CONFIG.BIRD_X - r < p.x + CONFIG.PIPE_W)) continue;
    const g = pipeGeometry(p);
    if (bird.y - r < g.topH || bird.y + r > g.bottomY) return 'pipe';
  }
  return null;
}

export function nextPipe(state){
  let best = null;
  for (const p of state.pipes){
    if (p.x + CONFIG.PIPE_W < CONFIG.BIRD_X - CONFIG.BIRD_R) continue;
    if (!best || p.x < best.x) best = p;
  }
  return best;
}

/* 机器人策略。它是闸门的主力：一个能连过十几根管道的策略，同时证明关卡可通过、
 * 计分在走、碰撞在拦。浏览器闸门里跑的是同一份。 */
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

/* 只读诊断出口。字段可以增加，不能删改，闸门认这些名字。 */
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

export function digest(state){
  const json = JSON.stringify(state);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i += 1){
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
