/** Run every registered browser file once, serially, retaining failures. */
import {readFile,mkdir,writeFile,open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const runner=await readFile('scripts/test-browser.mjs','utf8');
const registered=[...new Set([...runner.matchAll(/'([a-z0-9.-]+\.mjs)'/g)].map(m=>m[1]))];
const requested=process.argv.slice(2);
if(requested.some(file=>!registered.includes(file)))throw Error('Only registered browser suites may be selected');
const files=requested.length?requested:registered;
const out=process.env.POLISH_SUITE_EVIDENCE||'evidence/integration';await mkdir(out,{recursive:true});
const bundleSha256=createHash('sha256').update(await readFile('dist/main.js')).digest('hex');
const buildHashes=Object.fromEntries(await Promise.all(['dist/main.js','dist/main.css','dist/style.css'].map(async file=>[file,createHash('sha256').update(await readFile(file)).digest('hex')])));
const results=[];
for(const file of files){
 const log=await open(`${out}/${file}.log`,'w'),start=Date.now();
 const result=await new Promise(resolve=>{const child=spawn(process.execPath,['tests/'+file],{stdio:['ignore',log.fd,log.fd],env:{...process.env,...(file==='content-history.full.mjs'?{CONTENT_HISTORY_POINTER_CLOSE:'1'}:{})}});let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},900000);child.once('error',e=>{clearTimeout(timer);resolve({exitCode:1,error:e.message});});child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({exitCode:code,signal,timedOut});});});await log.close();
 results.push({file,...result,durationMs:Date.now()-start});await writeFile(out+'/browser-all.json',JSON.stringify({bundleSha256,buildHashes,files:files.length,results},null,2));console.log(file,JSON.stringify(results.at(-1)));
}
if(results.some(r=>r.exitCode!==0))process.exitCode=1;
