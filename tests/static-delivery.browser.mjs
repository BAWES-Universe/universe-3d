/** Real built app and browser cache; WebGL disabled to isolate HTTP delivery. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds} from '../src/worlds.js';
import {launch} from '../scripts/browser.mjs';

const app=createGameServer({seeds:seedWorlds,dist:new URL('../dist',import.meta.url).pathname});
const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`;
const requests=[],pageErrors=[];let phase='cold',browser;
app.server.on('request',(req,res)=>{
  if(req.url.startsWith('/api/'))return;
  const requestPhase=phase;
  res.once('finish',()=>requests.push({phase:requestPhase,path:req.url,status:res.statusCode,encoding:res.getHeader('Content-Encoding')??'identity',etag:res.getHeader('ETag'),condition:req.headers['if-none-match'],bodyBytes:res.statusCode===200?Number(res.getHeader('Content-Length')??0):0}));
});
try{
  browser=await launch();const page=await browser.newPage();
  await page.addInitScript(()=>{
    const original=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(kind,...args){return /webgl/i.test(kind)?null:original.call(this,kind,...args);};
  });
  page.on('pageerror',error=>pageErrors.push(error.message));
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:false});
  const summaries=[];
  for(const name of ['cold','reload-1','reload-2']){
    phase=name;
    if(name==='cold')await page.goto(base);else await page.reload();
    await page.waitForFunction(()=>Boolean(window.__universe));
    await page.getByPlaceholder('Your name').waitFor();
    await page.evaluate(()=>document.fonts.ready);
    const timing=await page.evaluate(()=>performance.getEntriesByType('resource').filter(entry=>entry.name.startsWith(location.origin)&&!new URL(entry.name).pathname.startsWith('/api/')).map(entry=>({path:new URL(entry.name).pathname,transferBytes:entry.transferSize,encodedBytes:entry.encodedBodySize,decodedBytes:entry.decodedBodySize})));
    const phaseRequests=requests.filter(item=>item.phase===name),main=phaseRequests.find(item=>item.path==='/main.js');
    assert(main,'main.js request visible for '+name);
    if(name==='cold'){assert.equal(main.status,200);assert.equal(main.encoding,'br');assert(main.bodyBytes>0);}
    else{assert.equal(main.status,304);assert(main.condition);assert.equal(main.bodyBytes,0);assert.equal(phaseRequests.filter(item=>item.status===200).length,0,'reload sends no static 200 bodies');}
    summaries.push({phase:name,requests:phaseRequests.length,staticBodyBytes:phaseRequests.reduce((total,item)=>total+item.bodyBytes,0),resourceTransferBytes:timing.reduce((total,item)=>total+item.transferBytes,0),timing});
  }
  assert.deepEqual(pageErrors,[]);
  await mkdir('evidence',{recursive:true});
  await writeFile('evidence/static-delivery-browser.json',JSON.stringify({status:'passed',scope:'Chromium normal cache and two ordinary reloads of built onboarding; software WebGL disabled. No network speed, playable readiness, physical-device or production capacity claim.',summaries,requests,pageErrors},null,2));
  console.log(JSON.stringify({status:'passed',summaries:summaries.map(({timing,...summary})=>summary)},null,2));
}finally{await browser?.close();await app.close();}
