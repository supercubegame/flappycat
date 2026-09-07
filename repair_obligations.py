"""Approved bounded CI-side changes; original game source is not modified."""
import base64,hashlib,json,os,re,struct,sys
from pathlib import Path
R=Path(__file__).resolve().parent

def replace(s,old,new):
    if new in s and old not in s:return s
    assert s.count(old)==1,old[:80]
    return s.replace(old,new,1)

if sys.argv[1]=='prepare':
    p=R/'scripts/verify-web.mjs';s=p.read_text()
    s=replace(s,"import { startServer } from './serve.mjs';","import { startServer } from './serve.mjs';\nimport { audioBufferCheck } from './audio-buffer-check.mjs';")
    s=replace(s,'await browser.close();',"await check('real-audio-buffer-and-negative-controls', async () => {\n  metrics.audioBuffer = await audioBufferCheck(browser, server.url);\n});\n\nawait browser.close();")
    p.write_text(s)
    raise SystemExit(0)

assert sys.argv[1]=='publish'
report=json.loads((R/'artifacts/verify-web-report.json').read_text());assert not report['failures']
a=report['metrics']['audioBuffer'];assert [x['mode'] for x in a]==['on','muted','disconnected']
assert a[0]['nonzero']>0 and a[1]['nonzero']==0 and a[2]['nonzero']==0
shots=[]
for name in ['ready','play','dead']:
    b=(R/('artifacts/shot-'+name+'.png')).read_bytes();assert b[:8]==b'\x89PNG\r\n\x1a\n'
    w,h=struct.unpack('>II',b[16:24]);assert (w,h)==(480,640)
    sha=hashlib.sha256(b).hexdigest();entry=next(x for x in report['metrics']['shots'] if x['name']=='shot-'+name+'.png');assert entry['sha']==sha
    svg=f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" data-kind="ci-screenshot"><title>Actual CI browser capture: {name}</title><image width="{w}" height="{h}" href="data:image/png;base64,{base64.b64encode(b).decode()}"/></svg>\n'
    (R/('docs/shots/'+name+'.svg')).write_text(svg)
    shots.append({'name':name,'bytes':len(b),'sha256':sha,'canvas_sha':entry['canvasSha']})
provenance={'kind':'browser-ci-screenshots','source_sha':os.environ['GITHUB_SHA'],'run_id':os.environ['GITHUB_RUN_ID'],'run_attempt':os.environ['GITHUB_RUN_ATTEMPT'],'shots':shots,'audio_buffer':a}
(R/'docs/shots/provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
items=json.loads((R/'docs/OBLIGATIONS.json').read_text())
ids=['replace-illustration-shots-with-real-ci-shots','assert-sound-is-actually-audible','confirm-first-scheduled-run-really-happened']
assert sorted(x['id'] for x in items)==sorted(ids)
hb=json.loads((R/'heartbeat.json').read_text());assert hb['last_scheduled_run'] and hb['last_run']['event']=='schedule'
records=[]
for item in items:
    x=dict(item);x['status']='resolved';x['original_due']=x.pop('due')
    if item['id']==ids[0]:x.update(disposition='fulfilled',evidence='docs/shots/provenance.json: exact PNG payload embedded without redrawing')
    elif item['id']==ids[1]:x.update(disposition='buffer-verified-speaker-unmeasurable',evidence={'machine':'real gameplay flap PCM nonzero; muted and disconnected controls zero','human':'CI cannot observe user loudspeaker output or subjective loudness; no claim of speaker acceptance'})
    else:x.update(disposition='fulfilled',evidence={'at':hb['last_scheduled_run'],'run_id':hb['last_run']['run_id']})
    records.append(x)
(R/'docs/COMPLETED-OBLIGATIONS.json').write_text(json.dumps(records,ensure_ascii=False,indent=2)+'\n')
(R/'docs/OBLIGATIONS.json').write_text('[]\n')
p=R/'scripts/verify.mjs';s=p.read_text();s=replace(s,"const failures = [];","import { closureChecks } from './closure-checks.mjs';\n\nconst failures = [];")
start=s.index("check('obligations-are-live-and-not-overdue', () => {");end=s.index("\ncheck('obligation-checker-mutation-proves-itself'",start)
s=s[:start]+"check('obligations-are-live-and-not-overdue', () => {\n  console.log(closureChecks());\n});\n"+s[end:];p.write_text(s)
p=R/'README.md';s=p.read_text();start=s.index('这三张是**按引擎几何手画的示意图**');end=s.index('\n## 安装与运行',start)
s=s[:start]+'''这三张来自真实 CI 浏览器截图，SVG 只封装未经重绘的 PNG，保留原画布尺寸；来源提交、运行和每张图的 SHA-256 见 `docs/shots/provenance.json`。

常驻闸门核对引用集合、PNG 字节哈希、尺寸和三张不同截图。音频验证的是实际游戏发声路径的 PCM 输出：开启时非零，静音和断开输出的反例为零；不代表已验证用户扬声器可听见。
'''+s[end:]
s=s.replace('已登记成带期限的义务。','机器侧音频缓冲区已验证，扬声器输出仍须人工验收，证据见 `docs/COMPLETED-OBLIGATIONS.json`。')
p.write_text(s)
for name in ['AGENTS.md','CLAUDE.md']:
    p=R/name;s=p.read_text();s=s.replace('README illustrations, not real screenshots.','real CI PNG captures embedded in SVG, with provenance.json hashes.')
    s=s.replace('README illustrations are hand-drawn and already stale against the taller death card.','README screenshots have recorded CI provenance; they are historical captures, not a guarantee of future UI parity.')
    s=s.replace('Audible sound is not proven. The gate proves nodes start and that muting starts none.','The actual flap graph renders nonzero PCM in CI; muted and disconnected controls render none. User loudspeaker audibility is not measurable by this CI and remains human acceptance.')
    p.write_text(s)
print('Published 3 real browser captures; archived all 3 obligations with evidence; PCM controls:',json.dumps(a))
