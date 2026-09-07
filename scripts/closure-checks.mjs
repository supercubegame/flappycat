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
  const record=JSON.parse(fs.readFileSync('docs/COMPLETED-OBLIGATIONS.json','utf8'));
  assert.equal(new Set(record.map(x=>x.id)).size,3);
  assert(record.some(x=>x.id==='assert-sound-is-actually-audible'&&x.disposition==='buffer-verified-speaker-unmeasurable'));
  const hb=JSON.parse(fs.readFileSync('heartbeat.json'));assert(hb.last_scheduled_run&&hb.last_run.event==='schedule');
  const now=Date.parse('2026-09-07T00:00:00Z');
  const fixture=['a','b','c'].map(id=>({id,status:'pending',due:'2020-01-01',criteria:{path:id,mustInclude:'present'}}));
  const bad=obligationProblems(fixture,()=>'',now);
  assert.equal(bad.length,6,'all overdue and completed-marker problems must be reported, not only first');
  assert.deepEqual(obligationProblems([],()=>'',now),[],'fulfilled empty pending ledger is valid');
  assert(obligationProblems({},()=>'',now).length);
  assert(obligationProblems([{...fixture[0],due:'2026-02-30'}],()=> 'present',now).some(x=>x.includes('invalid due')));
  if(problems.length)throw Error(problems.join('\n'));
  return '3 screenshot PNG payloads/hash/dimensions checked; all obligation problems aggregated; audio speaker boundary recorded';
}
