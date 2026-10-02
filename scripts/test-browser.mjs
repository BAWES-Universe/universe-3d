/** Serial browser runs: concurrent software-WebGL suites can exhaust CI GPUs. */
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
const groups={
 core:['fallback.browser.mjs','camera-walkthrough.browser.mjs','editor-direct.browser.mjs','avatar-live.browser.mjs','avatar-layout-final.browser.mjs','express.full.mjs'],
 modules:['avatar.browser.mjs','camera-renderer.browser.mjs','editor-transactions.browser.mjs','express.browser.mjs','express.live.mjs','places.live.mjs','social.browser.mjs','social.live.mjs','media-browser.mjs','media-server-browser.mjs']
};
const group=process.argv[2]||'core';if(!groups[group])throw Error('Choose core or modules');
await mkdir('evidence',{recursive:true});const results=[];
for(const file of groups[group]){
 console.log('\n=== '+file+' ===');const start=Date.now();
 const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['tests/'+file],{stdio:'inherit'});child.once('error',reject);child.once('exit',code=>resolve(code??1));});
 results.push({file,exitCode:code,durationMs:Date.now()-start});
 await writeFile(`evidence/browser-${group}-summary.json`,JSON.stringify({scope:group,results},null,2));
 if(code){process.exitCode=code;break;}
}
