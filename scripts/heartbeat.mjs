/* ===========================================================================
 * 心跳的参数与判定。纯函数，所以零依赖快闸门里能直接验。
 * ===========================================================================
 *
 * 为什么验痕迹而不是验配置：平台会因为仓库长期不活跃**静默停用定时工作流**，
 * 而那时工作流文件一个字都不会变。所以“读配置确认 cron 还在”这条检查，会在
 * 它本该抓住的那次失效上保持绿色。“没有坏消息”和“已经死了”长得一模一样，
 * 带时间戳的正向痕迹不会。
 *
 * 三个状态要分得很清，因为它们在面板上容易混：
 *   - awaiting-first-run：还在嬽限期内，第一次定时还没到。正常。
 *   - never-ran：嬽限期过了而从未跑过。**这就是 cron 根本没生效。**
 *   - stale：跑过，但太旧了。**这就是 cron 被停用了。**
 * 把后两个归成同一句“心跳不新鲜”会丢掉信息，而这两种情况的后续动作不同。
 *
 * 新鲜度上限不是拍的，是从 cron 频率推导的：频率周期 + 余量。改 cron 而不重算
 * 这个数，那条等号断言当场红,写在注释里的“改一个必须重算另一个”自己会腐化。
 * ======================================================================== */

export const HEARTBEAT_FILE = 'heartbeat.json';

/* 每天一次，所以周期 1 天；再留 2 天余量。漏一两次不红，连漏三天就红。
 * 频率取每天而不是每周，是有意的：写得越勤，“读到的痕迹有多旧”就越不依赖
 * 两个定时之间的先后顺序，而那个顺序是个假设。 */
export const HEARTBEAT_MARGIN_DAYS = 2;
export const MAX_HEARTBEAT_AGE_DAYS = 3;

/* 第一次定时还没到之前的嬽限期。它只买时间，不免除义务。 */
export const HEARTBEAT_GRACE_DAYS = 3;

const DAY_MS = 86400000;

export function cronsFromWorkflow(yaml){
  return [...yaml.matchAll(/^\s*-\s*cron:\s*'([^']+)'\s*$/gm)].map(m => m[1]);
}

/* 把 cron 翻成“多少天一次”。认不出来就返回 null,而断言要求它不能是 null，
 * 否则新鲜度上限就变回一个拍的数。 */
export function cadenceDays(cron){
  const f = String(cron).trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [minute, hour, dom, month, dow] = f;
  if (minute === '*' || hour === '*') return null;
  if (month !== '*') return null;
  if (dom === '*' && dow === '*') return 1;
  if (dom === '*' && /^[0-6]$/.test(dow)) return 7;
  return null;
}

export function cronMinute(cron){
  return Number(String(cron).trim().split(/\s+/)[0]);
}

export function expectedMaxAgeDays(crons){
  if (!crons.length) return null;
  const cadences = crons.map(cadenceDays);
  if (cadences.some(c => c === null)) return null;
  return Math.max(...cadences) + HEARTBEAT_MARGIN_DAYS;
}

/* 写心跳那一步的守卫必须靠**事件身份**，不得靠提交信息里的字符串。
 * 字符串守卫改一次模板就哑，而哑掉的表现不是红，是一个自己触发自己的循环。 */
export function heartbeatWriteGuard(yaml){
  const line = yaml.split('\n').find(l => /^\s*if:.*github\.event_name == 'schedule'/.test(l));
  if (!line) return { ok: false, reason: '没有任何一行把心跳挂在 schedule 事件上' };
  if (!line.includes('workflow_dispatch')){
    return { ok: false, reason: '手动那条路没有单独的门，任何一次 dispatch 都会盖戳' };
  }
  if (/event\.head_commit|commits\[0\]|\bmessage\b/.test(line)){
    return { ok: false, reason: '守卫读了提交信息，改一次模板就哑，而哑掉不会变红' };
  }
  return { ok: true, reason: '' };
}

export function heartbeatStatus(hb, nowMs, maxAgeDays = MAX_HEARTBEAT_AGE_DAYS, graceDays = HEARTBEAT_GRACE_DAYS){
  if (!hb || typeof hb !== 'object') return { state: 'missing', ageDays: null };

  const last = hb.last_scheduled_run;
  if (last === null || last === undefined){
    const seeded = Date.parse(String(hb.seeded_at) + 'T00:00:00Z');
    if (!Number.isFinite(seeded)) return { state: 'missing', ageDays: null };
    const waited = (nowMs - seeded) / DAY_MS;
    return {
      state: waited <= graceDays ? 'awaiting-first-run' : 'never-ran',
      ageDays: Number(waited.toFixed(2)),
    };
  }

  const at = Date.parse(last);
  if (!Number.isFinite(at)) return { state: 'missing', ageDays: null };
  const age = (nowMs - at) / DAY_MS;
  return { state: age <= maxAgeDays ? 'fresh' : 'stale', ageDays: Number(age.toFixed(2)) };
}

export const HEALTHY_HEARTBEAT_STATES = ['fresh', 'awaiting-first-run'];

export function heartbeatIsHealthy(status){
  return HEALTHY_HEARTBEAT_STATES.includes(status.state);
}
