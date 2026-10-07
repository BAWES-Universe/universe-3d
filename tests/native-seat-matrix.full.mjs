/** Keep the contextual and genuinely enlarged Sit/Stand targets in required CI. */
import {spawn} from 'node:child_process';
const variants=[['ordinary',{}],...['normal','root200','computed2x'].map(scale=>[scale,{SEAT_QUEST:'1',SEAT_TEXT_SCALE:scale==='normal'?'':scale,SEAT_VIEWPORTS:JSON.stringify([{width:320,height:568},{width:550,height:375},{width:667,height:375}])}])];
for(const [name,extra] of variants){
 console.log('\n=== Native seat '+name+' ===');
 const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['tests/native-seat-controls.full.mjs'],{stdio:'inherit',env:{...process.env,...extra,SEAT_EVIDENCE:`evidence/native-seat-${name}`}});child.once('error',reject);child.once('exit',code=>resolve(code??1));});
 if(code){process.exitCode=code;break;}
}
