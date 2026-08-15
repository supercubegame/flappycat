import { CONFIG, pipeGeometry, playFloor } from './engine.mjs';
import { COLORS } from './palette.mjs';

/* 管道故意只用**整数坐标的平色矩形**：不描边、不渐变、不反锥齿。
 * 上一版给管体描了一圈 2px 边，而描边会吃掉一部分 body 像素,
 * 那会把浏览器闸门那条像素等号断言逗成一笔算不清的账。
 * 要加装饰层的话，先把它的面积算进期望值里。 */
export function drawBackground(ctx){
  ctx.fillStyle = COLORS.sky;
  ctx.fillRect(0, 0, CONFIG.WORLD_W, CONFIG.WORLD_H);

  ctx.fillStyle = COLORS.cloud;
  ctx.globalAlpha = 0.45;
  cloud(ctx, 76, 112, 54);
  cloud(ctx, 332, 148, 44);
  cloud(ctx, 250, 82, 32);
  ctx.globalAlpha = 1;

  ctx.fillStyle = COLORS.ground;
  ctx.fillRect(0, playFloor(), CONFIG.WORLD_W, CONFIG.GROUND_H);
  ctx.fillStyle = COLORS.grass;
  ctx.fillRect(0, playFloor(), CONFIG.WORLD_W, 14);
  ctx.fillStyle = COLORS.dirt;
  ctx.fillRect(0, playFloor() + 14, CONFIG.WORLD_W, CONFIG.GROUND_H - 14);
}

function cloud(ctx, x, y, size){
  ctx.beginPath();
  ctx.arc(x, y, size * 0.45, 0, Math.PI * 2);
  ctx.arc(x + size * 0.35, y - size * 0.18, size * 0.36, 0, Math.PI * 2);
  ctx.arc(x + size * 0.65, y, size * 0.4, 0, Math.PI * 2);
  ctx.fill();
}

export function drawPipes(ctx, state){
  for (const pipe of state.pipes){
    const x = Math.round(pipe.x);
    const g = pipeGeometry(pipe);
    const capX = x - CONFIG.CAP_OVERHANG;
    const capW = CONFIG.PIPE_W + CONFIG.CAP_OVERHANG * 2;

    ctx.fillStyle = COLORS.pipeBody;
    if (g.topH > CONFIG.CAP_H) ctx.fillRect(x, 0, CONFIG.PIPE_W, g.topH - CONFIG.CAP_H);
    if (g.bottomH > CONFIG.CAP_H){
      ctx.fillRect(x, g.bottomY + CONFIG.CAP_H, CONFIG.PIPE_W, g.bottomH - CONFIG.CAP_H);
    }

    ctx.fillStyle = COLORS.pipeCap;
    ctx.fillRect(capX, g.topH - CONFIG.CAP_H, capW, CONFIG.CAP_H);
    ctx.fillRect(capX, g.bottomY, capW, CONFIG.CAP_H);
  }
}

export function drawBird(ctx, state){
  ctx.save();
  ctx.translate(CONFIG.BIRD_X, state.bird.y);
  ctx.rotate(Math.max(-0.45, Math.min(0.65, state.bird.vy / 13)));
  ctx.fillStyle = COLORS.birdBody;
  ctx.beginPath();
  ctx.arc(0, 0, CONFIG.BIRD_R, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = COLORS.birdWing;
  ctx.beginPath();
  ctx.ellipse(-3, 4, 8, 5.5, -0.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = COLORS.birdBeak;
  ctx.beginPath();
  ctx.moveTo(CONFIG.BIRD_R - 2, -1);
  ctx.lineTo(CONFIG.BIRD_R + 10, 2);
  ctx.lineTo(CONFIG.BIRD_R - 2, 5);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = COLORS.birdEye;
  ctx.beginPath();
  ctx.arc(4, -4, 3.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = COLORS.ink;
  ctx.beginPath();
  ctx.arc(5, -4, 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawHud(ctx, state){
  const text = String(state.score);
  ctx.font = 'bold 40px "Noto Sans CJK SC", "Noto Sans", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 8;
  ctx.strokeStyle = COLORS.scoreShadow;
  ctx.strokeText(text, CONFIG.WORLD_W / 2, CONFIG.HUD_BASELINE);
  ctx.fillStyle = COLORS.score;
  ctx.fillText(text, CONFIG.WORLD_W / 2, CONFIG.HUD_BASELINE);
}

export function drawReady(ctx){
  card(ctx, CONFIG.CARD.hReady);
  ctx.fillStyle = COLORS.ink;
  ctx.textAlign = 'center';
  ctx.font = 'bold 30px "Noto Sans CJK SC", "Noto Sans", system-ui, sans-serif';
  ctx.fillText('FLAPPYCAT', CONFIG.WORLD_W / 2, 176);
  ctx.font = '18px "Noto Sans CJK SC", "Noto Sans", system-ui, sans-serif';
  ctx.fillText('按 Space 起飞', CONFIG.WORLD_W / 2, 212);
  ctx.fillText('穿过管道，别摔死', CONFIG.WORLD_W / 2, 240);
}

export function drawDead(ctx, state){
  card(ctx, CONFIG.CARD.hDead);
  ctx.fillStyle = COLORS.ink;
  ctx.textAlign = 'center';
  ctx.font = 'bold 28px "Noto Sans CJK SC", "Noto Sans", system-ui, sans-serif';
  ctx.fillText('Game Over', CONFIG.WORLD_W / 2, 158);
  ctx.font = '18px "Noto Sans CJK SC", "Noto Sans", system-ui, sans-serif';
  ctx.fillText('得分 ' + state.score, CONFIG.WORLD_W / 2, 198);
  ctx.fillText(state.deathCause === 'pipe' ? '你撞管道了' : '你砸到地上了', CONFIG.WORLD_W / 2, 226);
  ctx.fillText('按 Space 再来一局', CONFIG.WORLD_W / 2, 258);
}

function card(ctx, h){
  const w = CONFIG.CARD.w;
  const x = CONFIG.WORLD_W / 2 - w / 2;
  const y = CONFIG.CARD.cy - h / 2;
  ctx.fillStyle = COLORS.panel;
  ctx.strokeStyle = COLORS.panelBorder;
  ctx.lineWidth = 4;
  roundRect(ctx, x, y, w, h, 16);
  ctx.fill();
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function render(ctx, state){
  drawBackground(ctx);
  drawPipes(ctx, state);
  drawBird(ctx, state);
  if (state.phase !== 'ready') drawHud(ctx, state);
  if (state.phase === 'ready') drawReady(ctx);
  if (state.phase === 'dead') drawDead(ctx, state);
}
