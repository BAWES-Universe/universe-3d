/** Portable, local-only proof helpers. The legacy source is supplied explicitly;
 * it is verified and read, never edited or given an in-tree build output. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp,mkdir,mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const root=fileURLToPath(new URL('../../',import.meta.url));
export const capability='image-physical-size-v1';
export const headers={'X-Universe-Client-Capabilities':capability};
export const baselineCommit='bc715ff6ccc0c3d2537e4c003cb4a7bb82745a34';
export const baselineTree='59799410195058ff90a5b0e11ebd1d9103a489df';
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const timeout=60000;
export function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});promise.catch(()=>{});return{promise,resolve,reject};}
export async function bounded(promise,label,ms=timeout){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out waiting for '+label)),ms);})]);}finally{clearTimeout(timer);}}
export function assertBaseline(source){
 const git=(...args)=>execFileSync('git',['-C',source,...args],{encoding:'utf8'}).trim();
 assert.equal(git('rev-parse','HEAD'),baselineCommit,'Use the exact authorized old application baseline');
 assert.equal(git('rev-parse','HEAD^{tree}'),baselineTree);
 assert.equal(git('status','--porcelain','--untracked-files=no'),'','The pinned legacy source must be immutable and clean');
}
export async function buildClients(){
 assert(process.env.UNIVERSE_LEGACY_SOURCE,'Set UNIVERSE_LEGACY_SOURCE to the immutable authorized bc715 checkout');
 const source=resolve(process.env.UNIVERSE_LEGACY_SOURCE);assertBaseline(source);
 const temporary=await mkdtemp(join(tmpdir(),'universe-image-protocol-'));
 async function bundle(directory,name){
  const output=join(temporary,name);await mkdir(output,{recursive:true});await cp(join(directory,'public'),output,{recursive:true});
  await build({absWorkingDir:directory,entryPoints:['src/main.js'],outdir:output,entryNames:'[name]',chunkNames:'chunks/[name]-[hash]',bundle:true,format:'esm',splitting:true,minify:true,target:'es2022',nodePaths:[join(root,'node_modules')]});
  return {directory:output,mainSha256:sha(await readFile(join(output,'main.js')))};
 }
 const legacy=await bundle(source,'legacy'),current=await bundle(root,'current');assertBaseline(source);
 return{temporary,legacy,current,source,baseline:{commit:baselineCommit,tree:baselineTree}};
}
export async function instrument(context,page,base){
 const events=[],requests=[],errors=[],consoleErrors=[];const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');
 cdp.on('Network.eventSourceMessageReceived',event=>{try{events.push({type:event.eventName,data:JSON.parse(event.data)});}catch{}});
 page.on('pageerror',error=>{errors.push(error.message);console.error('PAGE_ERROR',error.message);});page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
 page.on('request',request=>{const url=new URL(request.url());if(url.origin===base&&url.pathname.startsWith('/api/'))requests.push({path:url.pathname,query:url.search,method:request.method(),capability:request.headers()['x-universe-client-capabilities']??null});});
 page.setDefaultTimeout(timeout);page.setDefaultNavigationTimeout(timeout);
 return{events,requests,errors,consoleErrors};
}
export async function request(context,base,path,method='GET',data,capable=true){
 const response=await context.request.fetch(base+path,{method,timeout,headers:capable?headers:{},...(data===undefined?{}:{data})});
 const body=await response.json();return{response,status:response.status(),body};
}
export async function ok(context,base,path,method='GET',data,capable=true){const value=await request(context,base,path,method,data,capable);assert(value.response.ok(),JSON.stringify({path,status:value.status,body:value.body}));return value.body;}
export async function assertFenced(context,base,paths){
 const observations=[];
 for(const [path,method='GET',data]of paths){const value=await request(context,base,path,method,data,false);assert.equal(value.status,426,path);assert.equal(value.body.code??value.body.error?.code,'CLIENT_RELOAD_REQUIRED',path);assert(!JSON.stringify(value.body).includes('widthMetres'),'426 must contain no geometry');observations.push({path,method,status:value.status,code:value.body.code??value.body.error?.code});}
 return observations;
}
export async function makeDirty(page,name,id='a'){
 await page.locator('#dock-build').click();await page.locator('#game').focus();await page.keyboard.press(']');await page.waitForFunction(id=>__universe.getEditor().selected===id,id);
 const field=page.getByRole('textbox',{name:'Name',exact:true});await field.fill(name);await field.press('Tab');await page.waitForFunction(()=>__universe.getEditor().dirty);
}
export async function exportRetiredDraft(page){
 await page.waitForFunction(()=>window.__universe?.getState().room===null&&!__universe.getState().ready);
 const button=page.getByRole('button',{name:'Export my unsaved draft',exact:true});await button.waitFor({state:'visible'});
 const download=page.waitForEvent('download');await button.click();const file=await download;
 return JSON.parse(await readFile(await file.path(),'utf8'));
}
export function assertLegacyRetirement(events,from=0,{requireGlobal=true}={}){
 const tail=events.slice(from),first=tail.findIndex(event=>event.type==='access-revoked');assert(first>=0,'Actual EventSource must receive its existing retirement event type');
 const after=tail.slice(first);
 for(const event of after){
  assert.equal(event.type,'access-revoked','Retired stream may only receive its baseline-readable retirement event');
  assert(['room',null].includes(event.data.roomId));assert.equal(event.data.code,'CLIENT_RELOAD_REQUIRED');assert.equal(event.data.recoverDraft,true);assert.match(event.data.reason,/reload/i);
  assert(!JSON.stringify(event).includes('widthMetres'),'Never strip or leak incompatible geometry to an old reader');
 }
 assert.equal(after[0].data.roomId,'room','Targeted denial must reach the active old arrival buffer first');
 if(requireGlobal)assert(after.some(event=>event.data.roomId===null),'A global retirement still covers unrepresented client room state');
 return{events:after,count:after.length};
}
