#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = args.find(a => !a.startsWith('--')) || 'reports';
const checkOnly = args.includes('--check');
const GATES = [
  { slug: 'eng', label: '引擎闸门', file: 'verify-report.json' },
  { slug: 'web', label: '浏览器闸门', file: 'verify-web-report.json' },
];
const LOG_TAIL_LINES = 80;

function walk(d, hits = []){
  for (const ent of fs.readdirSync(d, { withFileTypes: true })){
    const p = path.join(d, ent.name);
    if (ent.isDirectory()) walk(p, hits);
    else hits.push(p);
  }
  return hits;
}

function findFile(name){
  try {
    return walk(dir).find(p => path.basename(p) === name) || null;
  } catch {
    return null;
  }
}

function readJson(file){
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function tail(text, lines = LOG_TAIL_LINES){
  return String(text || '').replace(/\s+$/, '').split('\n').slice(-lines).join('\n');
}

function fold(summary, text){
  return '<details><summary>' + summary + '</summary>\n\n```\n' + text + '\n```\n\n</details>';
}

function missingSection(gate){
  const logFile = findFile('stdout-' + gate.slug + '.log');
  const log = logFile ? tail(fs.readFileSync(logFile, 'utf8')) : '';
  return [
    '### ❌ ' + gate.label + ' - 没有产出报告',
    '',
    '闸门在写出报告之前就崩了，或者 artifact 根本没上传。这算失败。',
    '',
    log ? fold('stdout 末尾', log.slice(-8000)) : '连 stdout 也没拿到，去看 workflow，不是看闸门。',
    '',
  ].join('\n');
}

function engSection(data){
  const m = data.metrics || {};
  return [
    '### ' + (data.failures.length ? '❌' : '✅') + ' 引擎闸门 - ' + data.passed + '/' + data.total,
    '',
    '- 单元 / 结构检查: ' + m.unitPass + ' 项',
    '- 机器人种子: ' + m.seeds + '，得分中位 ' + m.medianScore + '，范围 ' + m.minScore + '-' + m.maxScore,
    '- 两管之间最大可爬升: ' + m.maxClimb + ' px，允许偏移 ' + m.maxGapDelta,
    '- 压测: ' + m.perfMs + ' ms / ' + m.perfFrames + ' steps',
    '- 规矩文件: ' + m.rulesLines + ' 行',
    '- 变异体: ' + m.mutantsKilled + '/' + m.mutantsTotal,
    '',
  ].join('\n');
}

function webSection(data){
  const m = data.metrics || {};
  return [
    '### ' + (data.failures.length ? '❌' : '✅') + ' 浏览器闸门 - ' + data.passed + '/' + data.total,
    '',
    '- 画布: ' + m.canvas,
    '- 机器人分数: ' + m.botScore + '，跳跃 ' + m.botJumps,
    '- 管体像素: 实际 ' + m.pipePixels + '，期望 ' + m.expectedPipePixels,
    '- 管口像素: 实际 ' + m.capPixels + '，期望 ' + m.expectedCapPixels,
    '- 帧率: ' + m.fps,
    '- 截图: ' + (m.shots || []).map(s => s.name + ' ' + s.bytes + 'B ' + s.sha.slice(0, 8)).join(' · '),
    '',
  ].join('\n');
}

let failed = false;
let passedCount = 0;
let totalCount = 0;
const sections = [];
const failures = [];

for (const gate of GATES){
  const file = findFile(gate.file);
  const data = file ? readJson(file) : null;
  if (!data){
    failed = true;
    sections.push(missingSection(gate));
    continue;
  }
  passedCount += data.passed;
  totalCount += data.total;
  if (data.passed !== data.total) failed = true;
  sections.push(gate.slug === 'eng' ? engSection(data) : webSection(data));
  for (const f of data.failures || []) failures.push(gate.label + ' · ' + f);
}

if (failures.length){
  sections.push(['### 失败项', '', ...failures.map(f => '- ' + f), ''].join('\n'));
}

const sha = (process.env.GITHUB_SHA || 'local').slice(0, 7);
const runLink = process.env.GITHUB_RUN_ID
  ? ' · [完整日志](' + (process.env.GITHUB_SERVER_URL || 'https://github.com') + '/' +
    (process.env.GITHUB_REPOSITORY || '') + '/actions/runs/' + process.env.GITHUB_RUN_ID + ')'
  : '';
const body = [
  (failed ? '## 验证闸门有失败' : '## 验证闸门全部通过'),
  '',
  passedCount + '/' + totalCount + ' 项通过 · 提交 `' + sha + '`' + runLink,
  '',
  ...sections,
].join('\n');

if (checkOnly){
  process.stdout.write((failed ? 'FAILED' : 'PASSED') + ': ' + passedCount + '/' + totalCount + '\n');
  process.exit(failed ? 1 : 0);
}

fs.writeFileSync('comment.md', body.slice(0, 60000));
process.stdout.write(body + '\n');
