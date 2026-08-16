#!/usr/bin/env node
/* ===========================================================================
 * 盖戳。只有定时那次写 last_scheduled_run，手动那次写 last_manual_run。
 * ===========================================================================
 *
 * 新鲜度只读 last_scheduled_run，所以一次手动盖戳不得救活一条已经死掉的 cron。
 * 两个字段分开写，就是为了不让“我去手动点了一下”冒充成“自动化还活着”。
 *
 * 报告结果也记下来，但它不参与新鲜度判定：心跳回答的是“这条链还活着吗”，
 * 不是“产品对不对”,所以闸门红了也要盖。
 * ======================================================================== */
import fs from 'node:fs';
import { HEARTBEAT_FILE } from './heartbeat.mjs';

const event = process.env.EVENT || 'unknown';
const now = new Date().toISOString();

let hb;
try {
  hb = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf8'));
} catch (error) {
  console.error('读不到或解析不了 ' + HEARTBEAT_FILE + '：' + error.message);
  process.exit(1);
}

if (event === 'schedule') hb.last_scheduled_run = now;
else hb.last_manual_run = now;

hb.last_run = {
  event,
  at: now,
  gate: process.env.GATE_RESULT || null,
  web: process.env.WEB_RESULT || null,
  run_id: process.env.GITHUB_RUN_ID || null,
  sha: (process.env.GITHUB_SHA || '').slice(0, 7) || null,
};

fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(hb, null, 2) + '\n');
process.stdout.write('盖戳完成（' + event + '）：' + now + '\n');
