// Exercise the actual page's Space -> flap -> blip path with a real OfflineAudioContext.
// Rendering PCM proves graph output, not the user's loudspeaker or subjective audibility.
export async function audioBufferCheck(browser,url) {
  const results=[];
  for(const mode of ['on','muted','disconnected']){
    const page=await browser.newPage();
    try{
      await page.addInitScript(({mode})=>{
        const Native=window.OfflineAudioContext||window.webkitOfflineAudioContext;
        if(!Native)throw Error('OfflineAudioContext unavailable');
        window.__AUDIO_BUFFERS=[];
        window.AudioContext=class extends Native {
          constructor(){super(1,22050,44100);window.__AUDIO_BUFFERS.push(this);}
          createGain(){const gain=super.createGain();if(mode==='disconnected')gain.connect=()=>{};return gain;}
        };
        window.webkitAudioContext=window.AudioContext;
      },{mode});
      await page.goto(url,{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>!!window.__FLAPPY);
      await page.evaluate(mode=>{window.__FLAPPY.setPaused(true);window.__FLAPPY.reset(7);window.__FLAPPY.setMuted(mode==='muted');},mode);
      await page.keyboard.press('Space');
      const r=await page.evaluate(async()=>{
        const contexts=window.__AUDIO_BUFFERS;let peak=0,nonzero=0,finite=true,samples=0;
        for(const ac of contexts){const buffer=await ac.startRendering();for(const x of buffer.getChannelData(0)){samples++;finite=finite&&Number.isFinite(x);peak=Math.max(peak,Math.abs(x));if(x!==0)nonzero++;}}
        return {contexts:contexts.length,peak,nonzero,finite,samples,starts:window.__FLAPPY.audio().starts,failures:window.__FLAPPY.audio().failures};
      });
      if(r.failures!==0||!r.finite)throw Error(mode+': invalid audio evidence '+JSON.stringify(r));
      if(mode==='on'&&!(r.contexts===1&&r.starts>0&&r.nonzero>0&&r.peak>0))throw Error('real sound graph produced no signal: '+JSON.stringify(r));
      if(mode==='muted'&&!(r.contexts===0&&r.starts===0&&r.nonzero===0))throw Error('muted graph produced signal');
      if(mode==='disconnected'&&!(r.contexts===1&&r.starts>0&&r.nonzero===0))throw Error('disconnected negative control failed');
      results.push({mode,...r});
    } finally {await page.close();}
  }
  return results;
}
