import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {CONFIG} from '../src/engine.mjs';

export function obligationProblems(items,read,now=Date.now()) {
  if(!Array.isArray(items))return ['obligation ledger must be an array'];
  const out=[],seen=new Set();
  for(const [i,item] of items.entries()) {
    if(!item||typeof item!=='object'){out.push('invalid obligation '+i);continue;}
    const id=item.id;
    if(typeof id!=='string'||!id.trim()){out.push('missing obligation id '+i);continue;}
    if(seen.has(id))out.push(id+': duplicate id');seen.add(id);
    if(item.status!=='pending')out.push(id+': completed item still pending in ledger');
    const day=typeof item.due==='string'?Date.parse(item.due+'T00:00:00Z'):NaN;
    if(!Number.isFinite(day)||new Date(day).toISOString().slice(0,10)!==item.due)out.push(id+': invalid due date');
    else if(day+16*3600000-1<now)out.push(id+': overdue; fulfill or document a genuine measurement limit');
    if(!item.criteria||typeof item.criteria.path!=='string'||typeof item.criteria.mustInclude!=='string'||!item.criteria.mustInclude){out.push(id+': invalid criteria');continue;}
    try {if(!read(item.criteria.path).includes(item.criteria.mustInclude))out.push(id+': completion evidence changed; resolve the ledger');}
    catch(e){out.push(id+': evidence unreadable: '+e.message);}
  }
  return out;
}
export function closureChecks() {
  const problems=obligationProblems(JSON.parse(fs.readFileSync('docs/OBLIGATIONS.json')),p=>fs.readFileSync(p,'utf8'));
  const m=JSON.parse(fs.readFileSync('docs/shots/provenance.json','utf8'));
  assert.equal(m.kind,'browser-ci-screenshots');assert.equal(m.shots.length,3);
  assert(/^[0-9a-f]{40}$/.test(m.source_sha));assert(/^\d+$/.test(m.run_id));
  assert.equal(new Set(m.shots.map(s=>s.sha256)).size,3);
  const names=['ready','play','dead'];
  for(const name of names){
    const entries=m.shots.filter(x=>x.name===name);assert.equal(entries.length,1);
    const svg=fs.readFileSync('docs/shots/'+name+'.svg','utf8');
    assert(svg.includes('data-kind="ci-screenshot"'));assert(!svg.includes('data-kind="illustration"'));
    const matches=[...svg.matchAll(/href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/g)];assert.equal(matches.length,1);
    const b=Buffer.from(matches[0][1],'base64');assert(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
    assert.equal(b.readUInt32BE(16),CONFIG.WORLD_W);assert.equal(b.readUInt32BE(20),CONFIG.WORLD_H);
    assert.equal(crypto.createHash('sha256').update(b).digest('hex'),entries[0].sha256);assert.equal(b.length,entries[0].bytes);
  }
  const audio=m.audio_buffer;assert.deepEqual(audio.map(x=>x.mode),['on','muted','disconnected']);
  assert(audio[0].nonzero>0&&audio[0].peak>0&&audio[0].samples>0);
  assert(audio[1].nonzero===0&&audio[1].contexts===0&&audio[2].nonzero===0&&audio[2].starts>0);
  assert(audio.every(x=>x.finite===true&&x.failures===0));
  const record=JSON.parse(fs.readFileSync('docs/COMPLETED-OBLIGATIONS.json','utf8'));
  const ids=['replace-illustration-shots-with-real-ci-shots','assert-sound-is-actually-audible','confirm-first-scheduled-run-really-happened'];
  assert.deepEqual(record.map(x=>x.id).sort(),[...ids].sort());
  assert(record.every(x=>x.status==='resolved'&&x.original_due&&x.evidence));
  assert(record.some(x=>x.id===ids[1]&&x.disposition==='buffer-verified-speaker-unmeasurable'));
  const historic=record.find(x=>x.id===ids[2]).evidence;
  assert(Number.isFinite(Date.parse(historic.at))&&/^\d+$/.test(historic.run_id));
  const hasScheduled=hb=>typeof hb.last_scheduled_run==='string'&&Number.isFinite(Date.parse(hb.last_scheduled_run));
  const hb=JSON.parse(fs.readFileSync('heartbeat.json'));assert(hasScheduled(hb));
  assert(hasScheduled({...hb,last_run:{event:'workflow_dispatch'}}),'later manual heartbeat does not erase scheduled history');
  assert(!hasScheduled({last_scheduled_run:null,last_manual_run:new Date().toISOString()}),'manual stamp cannot stand in for scheduled history');
  const now=Date.parse('2026-09-07T00:00:00Z');
  const fixture=['a','b','c'].map(id=>({id,status:'pending',due:'2020-01-01',criteria:{path:id,mustInclude:'present'}}));
  const bad=obligationProblems(fixture,()=>'',now);
  assert.equal(bad.length,6,'all overdue and completed-marker problems must be reported, not only first');
  assert.deepEqual(obligationProblems([],()=>'',now),[],'fulfilled empty pending ledger is valid');
  assert(obligationProblems({},()=>'',now).length);
  assert(obligationProblems([{...fixture[0],due:'2026-02-30'}],()=> 'present',now).some(x=>x.includes('invalid due')));
  assert(obligationProblems([fixture[0],fixture[0]],()=> 'present',now).some(x=>x.includes('duplicate')));
  assert(obligationProblems(fixture,()=>{throw Error('missing');},now).filter(x=>x.includes('unreadable')).length===3);
  if(problems.length)throw Error(problems.join('\n'));
  return '3 screenshot PNG payloads/hash/dimensions checked; all obligation problems aggregated; audio speaker boundary recorded';
}
