/** Native whole-app regression for the four independently audited flow failures.
 * Synthetic owner and ephemeral database only; no external traffic or capture. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createGameServer} from '../server/app.mjs';
import {bootstrapOwner} from '../server/operator-accounts.mjs';
import {seedWorlds} from '../src/worlds.js';
import {validatePlacement} from '../src/editor-geometry.js';
import {launch} from '../scripts/browser.mjs';
const baseline=process.env.EDITOR_FLOW_BASELINE==='1';
const out=process.env.EDITOR_FLOW_OUTPUT||'evidence/editor-flow-journey';
await mkdir(out,{recursive:true});
const sourceIdentity=()=>({head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(),trackedChanges:execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim()});
const sourceBefore=sourceIdentity();
const browser=await launch(),reports=[];
try {
 for(const [width,height] of [[1440,900],[390,844],[320,700],[844,390],[568,320],[550,320]].filter(([w])=>!process.env.EDITOR_FLOW_WIDTH||w===Number(process.env.EDITOR_FLOW_WIDTH))){
  const app=createGameServer({database:':memory:',seeds:structuredClone(seedWorlds),dist:new URL('../dist',import.meta.url).pathname});
  const password='synthetic editor flow password';
  await bootstrapOwner(app.store,{name:'Synthetic editor owner',username:'editor_owner',password});
  const base='http://127.0.0.1:'+(await app.listen(0)).port;
  const context=await browser.newContext({viewport:{width,height},hasTouch:width<1000,isMobile:width<700,reducedMotion:'reduce'});
  await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
  await context.addInitScript(()=>{for(const key of ['getUserMedia','getDisplayMedia'])if(navigator.mediaDevices)Object.defineProperty(navigator.mediaDevices,key,{value:()=>{throw Error('Capture forbidden');}});});
  const p=await context.newPage();p.setDefaultTimeout(45000);
  const report={viewport:{width,height},checks:[],errors:[],writes:[]};reports.push(report);
  p.on('pageerror',e=>report.errors.push(e.message));
  p.on('request',r=>{if(/\/(scene(?:\/operations)?|bots(?:\/[^/]+)?)$/.test(new URL(r.url()).pathname)&&['POST','PUT','PATCH','DELETE'].includes(r.method()))report.writes.push({path:new URL(r.url()).pathname,method:r.method()});});
  const click=locator=>width<1000?locator.tap():locator.click();
  const button=name=>p.getByRole('button',{name,exact:true}),field=name=>p.locator(`[data-bot-field="${name}"]`);
  const state=()=>p.evaluate(()=>window.__universe.getState());
  const check=(name,pass,detail)=>{report.checks.push({name,pass,detail});console.log(pass?'PASS':'FAIL',width,name);};
  const shot=label=>p.screenshot({path:`${out}/${width}x${height}-${label}.png`});
  async function bots(){
   if(await p.locator('#manage-bots').isVisible())await click(p.locator('#manage-bots'));
   else{await click(p.locator('#dock-more'));await click(p.locator('#shell-more').getByRole('button',{name:'Room residents',exact:true}));}
  }
  async function floor({plant=false,avoid=[]}={}){
   await p.waitForTimeout(550);const s=await state();
   for(const [x,z] of [[-3,3],[3,3],[0,4],[-2,4],[2,4],[-4,4],[4,4],[0,6],[-3,6],[3,6],[-5,5],[5,5],[0,0],[-4,0]]){
    if(avoid.some(a=>Math.hypot(a.x-x,a.z-z)<1.5))continue;
    if(plant&&!validatePlacement(s.scene,{type:'plant',name:'Planter',x,z,width:1,depth:1},{position:s.position}).valid)continue;
    const q=await p.evaluate(({x,z})=>window.__universe.getScreenPoint(x,z,0),{x,z});
    if(!q?.visible||q.x<10||q.x>width-10||q.y<80||q.y>height-60||!await p.evaluate(q=>document.elementFromPoint(q.x,q.y)?.id==='game',q))continue;
    if(width<1000)await p.touchscreen.tap(q.x,q.y);else{await p.mouse.move(q.x,q.y);await p.mouse.click(q.x,q.y);}
    return {x,z};
   }
   throw Error('No available native ground target');
  }
  try {
   await p.goto(base);await p.waitForFunction(()=>window.__universe);
   if(await p.locator('#login-form').isHidden())await click(p.locator('#show-login'));
   await p.locator('#login-username').fill('editor_owner');await p.locator('#login-password').fill(password);await click(p.locator('#login-button'));
   await p.waitForFunction(()=>window.__universe?.getState().ready);
   if(await button('Not now').isVisible())await click(button('Not now'));
   await click(p.locator('#dock-build'));await click(p.locator('[data-tool="plant"]'));
   const count=(await state()).scene.objects.length,planted=await floor({plant:true});
   await p.waitForFunction(n=>window.__universe.getState().scene.objects.length===n+1,count);
   const placement=await p.evaluate(()=>window.__universe.getEditor());
   check('placement clears stationary duplicate ghost',placement.preview===null,placement);
   check('multi-place remains armed',placement.tool==='plant');await shot('placed');
   const repeated=await floor({plant:true,avoid:[planted]});await p.waitForFunction(n=>window.__universe.getState().scene.objects.length===n+2,count);
   check('deliberate next tap repeats placement and clears ghost',await p.evaluate(()=>window.__universe.getEditor().preview===null));
   await p.locator('#game').focus();await p.keyboard.press('Control+z');check('Undo reverses only last placement',(await state()).scene.objects.length===count+1);
   await p.keyboard.press('Control+Shift+z');check('Redo restores repeated placement',(await state()).scene.objects.length===count+2);
   await click(button('Close editor'));
   const explicit=await button('Save & play').isVisible()&&await button('Keep draft').isVisible();
   check('Build Done offers explicit save or keep draft',explicit);await shot('build-decision');
   if(explicit)await click(button('Keep draft'));
   check('Keep draft retains exact unsaved object',await p.evaluate(()=>window.__universe.getEditor().dirty)&&(await state()).scene.objects.length===count+2);
   await bots();const continuation=await button('Save room & edit residents').isVisible();
   check('dirty Bots offers save-and-continue',continuation);await shot('bots-decision');
   if(continuation)await click(button('Save room & edit residents'));
   else{await click(p.locator('#dock-build'));await click(button('Save room'));await p.waitForFunction(()=>!window.__universe.getEditor().dirty&&!window.__universe.getEditor().saving);await click(button('Close editor'));await bots();}
   await p.getByTestId('bot-create').waitFor();
   check('acknowledged save reaches resident destination',!await p.evaluate(()=>window.__universe.getEditor().dirty));
   await click(p.getByTestId('bot-create'));await field('name').fill('Flow resident '+width);
   await click(p.getByTestId('bot-route-world'));const a=await floor({avoid:[planted,repeated]});await floor({avoid:[planted,repeated,a]});
   const pointControl=await button('Select waypoint 1').isVisible()?button('Select waypoint 1'):p.getByRole('combobox',{name:'Route target',exact:true});
   const selector=await pointControl.evaluate(n=>{const r=n.getBoundingClientRect(),panel=n.closest('.resident-panel').getBoundingClientRect();return {hit:n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),inside:r.y>=panel.y&&r.bottom<=panel.bottom&&r.x>=0&&r.right<=innerWidth,scroll:n.closest('.resident-map-body')?.scrollTop||0,rect:r.toJSON()};});
   check('route selector initially reachable without inner scrolling',selector.hit&&selector.inside&&selector.scroll===0,selector);await shot('route-selector');
   const camera=await p.evaluate(()=>[...document.querySelectorAll('#view-controls button')].filter(n=>n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden').map(n=>{const r=n.getBoundingClientRect();return{id:n.id,rect:r.toJSON(),hits:[[.5,.5],[.1,.5],[.9,.5],[.5,.1],[.5,.9]].map(([x,y])=>n.contains(document.elementFromPoint(r.x+r.width*x,r.y+r.height*y)))};}));
   check('map camera targets remain unobscured',camera.length>0&&camera.every(c=>c.hits.every(Boolean)),camera);
   const follow=p.locator('#camera-follow'),following=await follow.getAttribute('aria-pressed');await click(follow);await p.waitForFunction(value=>document.querySelector('#camera-follow').getAttribute('aria-pressed')!==value,following);await click(follow);await p.waitForFunction(value=>document.querySelector('#camera-follow').getAttribute('aria-pressed')===value,following);check('native map camera follow toggles and restores',true);
   if(selector.hit){if(await button('Select waypoint 1').isVisible())await click(button('Select waypoint 1'));else await pointControl.selectOption('waypoint:0');}
   await click(p.getByTestId('bot-map-done'));
   check('map Done stays draft until explicit Create',!report.writes.some(w=>w.path.includes('/bots')));
   await click(p.getByTestId('bot-save'));await p.waitForFunction(name=>window.__universe.getState().bots.some(b=>b.name===name),'Flow resident '+width);
   await field('name').fill('Unsaved resident name');await click(button('Close residents'));
   check('resident leave has one decision group',await p.getByTestId('bot-confirm-save').isVisible()&&!await p.getByTestId('bot-save').isVisible()&&!await p.getByTestId('bot-reset').isVisible());await shot('resident-decision');
   await click(button('Keep editing'));check('Keep editing restores footer and exact draft',await p.getByTestId('bot-save').isVisible()&&await field('name').inputValue()==='Unsaved resident name');
   await click(button('Close residents'));await click(p.getByTestId('bot-confirm-discard'));await p.getByTestId('bot-editor').waitFor({state:'hidden'});
   check('Discard closes without persisting edited name',!(await state()).bots.some(b=>b.name==='Unsaved resident name'));
   check('no page errors',report.errors.length===0,report.errors);
  }catch(error){report.failure=error.stack;console.error(error);await shot('failure').catch(()=>{});}
  finally{await context.close();await app.close();}
 }
}finally{
 await browser.close();await writeFile(out+'/results.json',JSON.stringify({baseline,sourceBefore,sourceAfter:sourceIdentity(),buildSha256:createHash('sha256').update(await readFile(new URL('../dist/main.js',import.meta.url))).digest('hex'),reports},null,2));
}
if(!baseline)assert.deepEqual(reports.flatMap(r=>[...(r.failure?[r.failure]:[]),...r.checks.filter(c=>!c.pass).map(c=>`${r.viewport.width}: ${c.name}`)]),[]);
