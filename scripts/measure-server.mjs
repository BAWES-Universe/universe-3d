/** A bounded local baseline, deliberately not a user-capacity/load claim. */
import {fork,execFileSync} from 'node:child_process';
import {mkdtemp,readFile,readdir,stat,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir,cpus,platform,release} from 'node:os';
import {join,resolve} from 'node:path';
import {gzipSync,brotliCompressSync} from 'node:zlib';
const wait=ms=>new Promise(r=>setTimeout(r,ms)),dir=await mkdtemp(join(tmpdir(),'universe-baseline-')),db=join(dir,'baseline.sqlite');
const child=fork(resolve('server.mjs'),[],{env:{...process.env,PORT:'0',UNIVERSE_DB:db},stdio:['ignore','pipe','pipe','ipc']});
let stderr='';child.stderr.on('data',b=>stderr+=b);let hz=100;try{hz=Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}).trim());}catch{}
async function sample(){const raw=await readFile(`/proc/${child.pid}/stat`,'utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).split(' '),status=await readFile(`/proc/${child.pid}/status`,'utf8');return{at:performance.now(),cpuMs:(Number(fields[11])+Number(fields[12]))/hz*1000,rssBytes:Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]||0)*1024};}
const interval=(a,b)=>({wallMs:Math.round(b.at-a.at),cpuMs:Math.round(b.cpuMs-a.cpuMs),singleCoreCpuPercent:Math.round(10000*(b.cpuMs-a.cpuMs)/(b.at-a.at))/100,rssStartBytes:a.rssBytes,rssEndBytes:b.rssBytes});
try{
 const ready=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',code=>reject(Error('Server exited '+code+stderr)));setTimeout(()=>reject(Error('Server readiness timeout')),15000).unref();}),base='http://127.0.0.1:'+ready.port;
 const idleStart=await sample();await wait(5000);const idle=interval(idleStart,await sample());
 const r=await fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Local measurement'})});if(!r.ok)throw Error('Session failed');const cookie=r.headers.get('set-cookie').split(';')[0];await r.json();
 async function call(path,body){const start=performance.now();const response=await fetch(base+path,{method:body?'POST':'GET',headers:{cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});await response.arrayBuffer();if(!response.ok)throw Error(path+' '+response.status);return performance.now()-start;}
 await call('/api/rooms/commons/join',{});const activeStart=await sample(),latencies=[];
 for(let i=0;i<100;i++){const tick=performance.now();latencies.push(await call('/api/presence',{roomId:'commons',x:Math.sin(i/10),z:7,moving:true,running:false,rotation:0,velocity:{x:1,z:0}}));await wait(Math.max(0,100-(performance.now()-tick)));}
 const active=interval(activeStart,await sample());latencies.sort((a,b)=>a-b);active.scenario='One authenticated participant, 100 presence posts at target10Hz, no media and no renderer';active.latencyMs={median:latencies[50],p95:latencies[95],max:latencies.at(-1)};
 const assets=[];async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())await walk(path);else{const bytes=await readFile(path);assets.push({path,raw:bytes.length,gzip:gzipSync(bytes).length,brotli:brotliCompressSync(bytes).length});}}}await walk('dist');
 const totals=assets.reduce((a,b)=>({raw:a.raw+b.raw,gzip:a.gzip+b.gzip,brotli:a.brotli+b.brotli}),{raw:0,gzip:0,brotli:0});
 const report={measuredAt:new Date().toISOString(),node:process.version,environment:{platform:platform(),release:release(),cpuModel:cpus()[0]?.model,logicalCpus:cpus().length},idle,active,allDistributionFiles:{files:assets.length,...totals},databaseFiles:await Promise.all(['','-wal','-shm'].map(async suffix=>({name:'baseline.sqlite'+suffix,bytes:await stat(db+suffix).then(s=>s.size).catch(()=>0)}))),limits:['CPU is process CPU as a percentage of one core; host is shared cloud hardware','Single-user baseline is not a concurrency, SFU, TURN, video or production capacity benchmark','All dist files include deferred chunks, licenses and fonts; this is not a measured initial browser download','Compression sizes are estimates; the development server currently sends uncompressed assets'],assets};
 await mkdir('evidence',{recursive:true});await writeFile('evidence/server-baseline.json',JSON.stringify(report,null,2));console.log(JSON.stringify({...report,assets:undefined},null,2));
}finally{child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));await rm(dir,{recursive:true,force:true});}
