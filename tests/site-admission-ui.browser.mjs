/** Synthetic standalone browser checks; no deployment, real accounts, or live invites. */
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {launch} from '../scripts/browser.mjs';
import {createGameServer} from '../server/app.mjs';
import {bootstrapOwner} from '../server/operator-accounts.mjs';
import {readRuntimeConfig} from '../server/runtime-config.mjs';
import {seedWorlds} from '../src/worlds.js';
import {CLIENT_CAPABILITIES_HEADER,IMAGE_PHYSICAL_SIZE_CAPABILITY} from '../src/client-protocol.js';

const token='A'.repeat(43),password='tenletters',now=Date.now();
const ownerPolicy={enabled:true,canManage:true,inviteTtlMs:86400000,maxActiveInvites:25,maxAccounts:50};
const friendPolicy={...ownerPolicy,canManage:false};
const initialInvite=()=>({id:'invite_original',label:'',createdAt:now,expiresAt:now+86400000,status:'active',revokedAt:null,redeemedAt:null});
let scenario={},requests=[],errors=[],browser;
const checks=[];
function reset(next={}){scenario={session:null,invites:[],redeems:[],mints:[],revokes:[],logins:0,accounts:1,...next};requests=[];}
const reply=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','referrer-policy':'no-referrer'});res.end(JSON.stringify(body));};
const failure=(res,status,code)=>reply(res,status,{error:code,code,message:'Synthetic fixture error'});
const loseResponse=res=>{res.writeHead(200,{'content-type':'application/json'});res.write('{"incomplete":');setTimeout(()=>res.destroy(),20);};
const server=http.createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  let body;try{const chunks=[];for await(const chunk of req)chunks.push(chunk);if(chunks.length)body=JSON.parse(Buffer.concat(chunks));}catch{return failure(res,400,'INVALID_JSON');}
  requests.push({url:req.url,path,method:req.method,headers:req.headers,body});
  if(path==='/api/access')return reply(res,200,{mode:'public',registration:false,siteAdmission:scenario.session?.owner?ownerPolicy:friendPolicy});
  if(path==='/api/session')return scenario.session?reply(res,200,{user:{id:'synthetic_existing',name:'A familiar friend',account:true},siteAdmission:scenario.session.owner?ownerPolicy:friendPolicy}):failure(res,401,'AUTH_REQUIRED');
  if(path==='/api/logout'){if(!scenario.session)return failure(res,401,'AUTH_REQUIRED');scenario.session=null;if(scenario.dropLogout){loseResponse(res);return;}return reply(res,200,{ok:true});}
  if(path==='/api/site-admission/check'){
    if(scenario.checkFailure)return failure(res,scenario.checkFailure==='ACCOUNT_LIMIT_REACHED'?409:410,scenario.checkFailure);
    return reply(res,200,{valid:true,expiresAt:now+86400000});
  }
  if(path==='/api/site-admission/redeem'){
    scenario.redeems.push(body);
    if(scenario.retryRedeemFailure&&scenario.redeems.length===2)return failure(res,scenario.retryRedeemFailure==='INVITE_UNAVAILABLE'?410:scenario.retryRedeemFailure==='SERVER_ERROR'?503:429,scenario.retryRedeemFailure);
    if(scenario.redeemFailure)return failure(res,400,scenario.redeemFailure);
    if(scenario.dropRedeem&&scenario.redeems.length===1){scenario.accounts++;loseResponse(res);return;}
    if(scenario.redeems.length===1)scenario.accounts++;
    return reply(res,scenario.redeems.length===1?201:200,{created:true,username:body.username,duplicate:scenario.redeems.length>1,loginRequired:true});
  }
  if(path==='/api/login'){
    scenario.logins++;
    if(scenario.loginFailure)return failure(res,401,'INVALID_CREDENTIALS');
    scenario.session={owner:!!scenario.loginOwner};return reply(res,200,{user:{name:'New friend',account:true},siteAdmission:scenario.loginOwner?ownerPolicy:friendPolicy});
  }
  if(path==='/api/site-invites'&&req.method==='GET'){
    const cursor=new URL(req.url,'http://localhost').searchParams.get('cursor');
    const page=scenario.paginate?scenario.invites.slice(cursor?2:0,cursor?4:2):scenario.invites;
    return reply(res,200,{invites:page,activeInvites:scenario.invites.filter(i=>i.status==='active').length,accountCount:scenario.accounts,maxActiveInvites:25,maxAccounts:50,hasMore:scenario.paginate&&!cursor,nextCursor:scenario.paginate&&!cursor?'synthetic_cursor':null});
  }
  if(path==='/api/site-invites'&&req.method==='POST'){
    scenario.mints.push(body);
    if(scenario.retryMintFailure&&scenario.mints.length===2)return failure(res,429,scenario.retryMintFailure);
    if(scenario.mintFailure)return failure(res,409,scenario.mintFailure);
    const duplicate=scenario.mints.some((m,index)=>index<scenario.mints.length-1&&m.clientOperationId===body.clientOperationId);
    if(!duplicate)scenario.invites.unshift({...initialInvite(),label:body.label||'',id:'invite_minted_'+scenario.mints.length});
    if(scenario.dropMint&&scenario.mints.length===1){loseResponse(res);return;}
    return reply(res,duplicate?200:201,{invite:scenario.invites[0],...(duplicate?{}:{token:'B'.repeat(43)}),duplicate,linkRecoverable:!duplicate});
  }
  if(/^\/api\/site-invites\/[^/]+\/revoke$/.test(path)){
    scenario.revokes.push(body);const invite=scenario.invites.find(i=>i.id===path.split('/')[3]);invite.status='revoked';invite.revokedAt=now;
    if(scenario.dropRevoke&&scenario.revokes.length===1){loseResponse(res);return;}
    return reply(res,200,{invite,duplicate:scenario.revokes.length>1});
  }
  try{
    if(path==='/external'){res.writeHead(200,{'content-type':'text/html'});res.end(`<!doctype html><title>Synthetic external invitation</title><a href="${scenario.actualLink}">Open your Universe invitation</a>`);return;}
    if(path==='/' ){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Synthetic Universe destination</title><h1>Universe</h1>');return;}
    const allowed=path==='/join.html'||path==='/site-admission.js'||path==='/site-admission.css'||path==='/universe-tokens.css'||path.startsWith('/assets/');
    if(!allowed||path.includes('..')){res.writeHead(404);res.end();return;}
    const mime=path.endsWith('.html')?'text/html':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.ttf')?'font/ttf':path.endsWith('.svg')?'image/svg+xml':'image/png';
    res.writeHead(200,{'content-type':mime,'referrer-policy':'no-referrer'});res.end(await readFile(new URL('../public'+path,import.meta.url)));
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const out=new URL('../evidence/site-admission-ui/',import.meta.url);await mkdir(out,{recursive:true});
async function check(name,run){console.log('RUN',name);await run();checks.push({name,status:'passed'});console.log('PASS',name);}
async function pageFor(options={}){
  const context=await browser.newContext({viewport:{width:1280,height:960},reducedMotion:'reduce',...options});const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));page.on('console',msg=>{if(msg.type()==='error'&&!msg.text().includes('Failed to load resource'))errors.push(msg.text());});
  return{context,page};
}
async function ready(page,path='/join.html#invite='+token){await page.goto(base+path);await page.locator('#loading-view').waitFor({state:'hidden'});await page.evaluate(()=>document.fonts.ready);}
async function fillSignup(page){const form=page.locator('#signup-form');await form.getByLabel('What should we call you?').fill('Synthetic Friend');await form.getByLabel('Username',{exact:true}).fill('synthetic_friend');await form.getByLabel('Password',{exact:true}).fill(password);await form.getByLabel('Confirm password',{exact:true}).fill(password);}
async function noLeaks(page){
  assert.equal(new URL(page.url()).hash,'');assert.equal(new URL(page.url()).search,'');
  assert.equal(await page.evaluate(()=>location.href.includes('invite=')),false);
  assert.deepEqual(await page.evaluate(()=>({local:Object.entries(localStorage),session:Object.entries(sessionStorage)})),{local:[],session:[]});
  for(const request of requests){assert(!request.url.includes(token),'No token in HTTP URL');assert(!JSON.stringify(request.headers).includes(token),'No token in headers');assert.equal(request.headers.referer,undefined,'No referrer on same-origin requests');
    if(request.body?.token)assert(['/api/site-admission/check','/api/site-admission/redeem'].includes(request.path),'Token only in authorized POST bodies');}
  assert(!errors.some(e=>e.includes(token)||e.includes(password)),'No sensitive console output');
}
try{
  browser=await launch();
  await check('Fragment is stripped before UI initialization; no storage, URL, referrer, or token rendering; full source logo and fonts',async()=>{
    reset();const{context,page}=await pageFor();await ready(page);assert(await page.locator('#signup-view').isVisible());await noLeaks(page);
    assert.equal(await page.locator('body').textContent().then(t=>t.includes(token)),false);
    const logo=await page.locator('.brand img').boundingBox();assert.equal(logo.width/logo.height,2);
    assert.equal(await page.locator('.brand img').getAttribute('src'),'/assets/bawes-universe-logo.png');
    assert.match(await page.locator('h2').first().evaluate(el=>getComputedStyle(el).fontFamily),/^Space/);
    const fonts=await page.evaluate(()=>[...document.fonts].filter(f=>f.family==='Space').map(f=>({weight:f.weight,status:f.status})));assert.deepEqual(fonts,[{weight:'700',status:'loaded'}]);
    assert.equal(await page.locator('#signup-password').getAttribute('autocomplete'),'new-password');
    for(const id of ['signup-password','signup-confirm']){assert.equal(await page.locator('#'+id).getAttribute('minlength'),'10');assert.equal(await page.locator('#'+id).getAttribute('maxlength'),'256');}
    await page.screenshot({path:new URL('signup-desktop.png',out).pathname,fullPage:true});await context.close();
  });
  await check('Native Tab/Enter account creation leads to separate login; confirmation and validation remain accessible',async()=>{
    reset();const{context,page}=await pageFor();await ready(page);await page.getByLabel('What should we call you?').focus();await page.keyboard.type('Synthetic Friend');await page.keyboard.press('Tab');await page.keyboard.type('synthetic_friend');await page.keyboard.press('Tab');await page.keyboard.type(password);await page.getByLabel('Confirm password',{exact:true}).fill(password+' mismatch');await page.keyboard.press('Enter');await page.getByRole('alert').filter({hasText:'don’t match'}).waitFor();assert.equal(scenario.redeems.length,0);
    await page.getByLabel('Confirm password',{exact:true}).fill(password);await page.keyboard.press('Enter');await page.getByRole('heading',{name:'You’re one hello away.'}).waitFor();
    assert.equal(scenario.redeems.length,1);assert.equal(scenario.logins,0);assert.match(scenario.redeems[0].clientOperationId,/^[A-Za-z0-9_-]{43}$/);assert.equal('confirmation' in scenario.redeems[0],false);
    assert.equal(await page.locator('#signin-username').inputValue(),'synthetic_friend');assert.equal(await page.locator('#signup-password').inputValue(),'');assert.equal(await page.locator('#signup-confirm').inputValue(),'');assert.equal(await page.locator('#signin-password').inputValue(),'');
    await page.locator('#signin-password').fill(password);await page.keyboard.press('Enter');await page.getByRole('heading',{name:'You’re signed in.'}).waitFor();assert.equal(scenario.logins,1);await noLeaks(page);await context.close();
  });
  await check('Lost redemption response preserves the exact operation and form until explicit safe retry',async()=>{
    reset({dropRedeem:true});const{context,page}=await pageFor();await ready(page);await fillSignup(page);await page.getByRole('button',{name:'Create my account'}).click();await page.getByRole('button',{name:'Retry safely'}).waitFor();assert.equal(scenario.redeems.length,1);assert.equal(await page.locator('#signup-username').getAttribute('readonly'),'');assert(await page.locator('#signup-signin').isDisabled());
    await page.getByRole('button',{name:'Retry safely'}).click();await page.getByRole('heading',{name:'You’re one hello away.'}).waitFor();assert.equal(scenario.redeems.length,2);assert.deepEqual(scenario.redeems[1],scenario.redeems[0]);assert.equal(scenario.accounts,2);assert.equal(scenario.logins,0);await noLeaks(page);await context.close();
  });
  await check('Transient rate/busy responses preserve proof after a lost redemption or mint response',async()=>{
    for(const code of ['RATE_LIMITED','SIGNUP_BUSY','SERVER_ERROR']){
      reset({dropRedeem:true,retryRedeemFailure:code});const{context,page}=await pageFor();await ready(page);await fillSignup(page);await page.getByRole('button',{name:'Create my account'}).click();await page.getByRole('button',{name:'Retry safely'}).click();if(code!=='SERVER_ERROR')await page.getByText(/Your original attempt and details stay unchanged/).waitFor();else await page.waitForFunction(()=>document.querySelector('#signup-submit').textContent==='Retry safely');await page.getByRole('button',{name:'Retry safely'}).click();await page.getByRole('heading',{name:'You’re one hello away.'}).waitFor();assert.equal(scenario.redeems.length,3);assert.deepEqual(scenario.redeems[2],scenario.redeems[0]);assert.equal(scenario.accounts,2);await context.close();
    }
    reset({session:{owner:true},dropMint:true,retryMintFailure:'RATE_LIMITED'});const{context,page}=await pageFor();await ready(page,'/join.html');await page.getByRole('button',{name:'Create invite link'}).click();await page.getByRole('button',{name:'Check same attempt'}).click();await page.getByText(/There have been too many attempts/).waitFor();await page.getByRole('button',{name:'Check same attempt'}).click();await page.getByText(/its link was shown only once and can’t be recovered/).waitFor();assert.equal(scenario.mints.length,3);assert.deepEqual(scenario.mints[2],scenario.mints[0]);assert.equal(scenario.invites.length,1);await context.close();
  });
  await check('Unavailable invitation after a lost creation response offers ordinary login with chosen username and cleared secrets',async()=>{
    reset({dropRedeem:true,retryRedeemFailure:'INVITE_UNAVAILABLE'});const{context,page}=await pageFor();await ready(page);await fillSignup(page);await page.getByRole('button',{name:'Create my account'}).click();await page.getByRole('button',{name:'Retry safely'}).click();await page.getByRole('heading',{name:'Let’s check your account.'}).waitFor();assert.equal(await page.locator('#signin-username').inputValue(),'synthetic_friend');assert.equal(await page.locator('#signup-password').inputValue(),'');assert.equal(await page.locator('#signin-password').inputValue(),'');assert.equal(scenario.logins,0);assert.equal(scenario.accounts,2);await noLeaks(page);await context.close();
  });
  await check('Expired/revoked/used invitation, quota, username, and password failures have clear reachable recovery',async()=>{
    for(const code of ['INVITE_UNAVAILABLE','ACCOUNT_LIMIT_REACHED','SITE_ADMISSION_DISABLED']){reset({checkFailure:code});const{context,page}=await pageFor();await ready(page);assert(await page.locator('#guide-view').isVisible());assert((await page.locator('#guide-message').textContent()).length>40);await page.getByRole('button',{name:'I already have an account'}).click();assert(await page.locator('#signin-view').isVisible());await context.close();}
    for(const code of ['USERNAME_TAKEN','INVALID_PASSWORD','INVALID_NAME']){reset({redeemFailure:code});const{context,page}=await pageFor();await ready(page);await fillSignup(page);await page.getByRole('button',{name:'Create my account'}).click();await page.locator('#signup-error').waitFor();assert(!(await page.locator('#signup-password').getAttribute('readonly')));assert(await page.locator('#signup-view').isVisible());assert.equal(await page.locator('[aria-invalid=true]').count(),1);await context.close();}
  });
  await check('Existing signed-in identity is preserved until explicit sign-out; no invitation is consumed by landing',async()=>{
    reset({session:{owner:false}});const{context,page}=await pageFor();await ready(page);assert(await page.locator('#signedin-view').isVisible());assert.equal(scenario.redeems.length,0);assert.equal(requests.filter(r=>r.path==='/api/site-admission/check').length,0);
    await page.getByRole('button',{name:'Sign out to use this invitation'}).click();await page.locator('#signup-view').waitFor();assert.equal(requests.filter(r=>r.path==='/api/logout').length,1);assert.equal(scenario.redeems.length,0);await context.close();
  });
  await check('Lost sign-out response recovers from an already-signed-out retry without replacing identity',async()=>{
    reset({session:{owner:false},dropLogout:true});const{context,page}=await pageFor();await ready(page);await page.getByRole('button',{name:'Sign out to use this invitation'}).click();await page.getByText(/We couldn’t confirm sign-out/).waitFor();assert.equal(scenario.redeems.length,0);await page.getByRole('button',{name:'Sign out to use this invitation'}).click();await page.locator('#signup-view').waitFor();assert.equal(scenario.redeems.length,0);await context.close();
  });
  await check('No invitation, malformed fragment, query token, and reload never create accounts or preserve a bearer',async()=>{
    for(const path of ['/join.html','/join.html#invite=broken','/join.html?invite='+token]){reset();const{context,page}=await pageFor();await ready(page,path);assert(await page.locator('#guide-view').isVisible());assert.equal(requests.filter(r=>r.path==='/api/site-admission/check').length,0);assert.equal(scenario.redeems.length,0);await context.close();}
    reset();const{context,page}=await pageFor();await ready(page);await page.reload();await page.locator('#guide-view').waitFor();assert.equal(requests.filter(r=>r.path==='/api/site-admission/check').length,1);await context.close();
  });
  await check('Owner creates one-time link with explicit copy, native Escape, distinct expiry/revoke/used metadata',async()=>{
    reset({session:{owner:true},invites:[{...initialInvite(),id:'expired',status:'expired'},{...initialInvite(),id:'revoked',status:'revoked',revokedAt:now},{...initialInvite(),id:'used',status:'redeemed',redeemedAt:now}]});
    const{context,page}=await pageFor({permissions:['clipboard-read','clipboard-write']});await ready(page,'/join.html');assert(await page.locator('#owner-view').isVisible());await page.getByRole('button',{name:'Create invite link'}).click();await page.getByRole('dialog').waitFor();assert.equal(scenario.mints.length,1);assert.match(scenario.mints[0].clientOperationId,/^[A-Za-z0-9_-]{43}$/);
    assert.equal(await page.locator('#created-link').inputValue(),base+'/join.html#invite='+'B'.repeat(43));assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'');
    await page.getByRole('button',{name:'Copy invite link',exact:true}).click();await page.getByRole('button',{name:'Copied',exact:true}).waitFor();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),base+'/join.html#invite='+'B'.repeat(43));await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(await page.locator('#created-link').inputValue(),'');await page.waitForFunction(()=>document.activeElement.id==='create-invite');
    assert.deepEqual(await page.locator('.invite-state').allTextContents(),['Expired','Revoked','Used']);await page.getByRole('button',{name:/Revoke invite .* created/}).click();await page.getByText('Invite revoked. Its link can no longer create an account.').waitFor();assert.equal(scenario.revokes.length,1);assert.match(scenario.revokes[0].clientOperationId,/^[A-Za-z0-9_-]{43}$/);
    await page.screenshot({path:new URL('owner-desktop.png',out).pathname,fullPage:true});await noLeaks(page);await context.close();
  });
  await check('Lost mint and revoke responses never automatically create a replacement or silently repeat a mutation',async()=>{
    reset({session:{owner:true},dropMint:true,dropRevoke:true});const{context,page}=await pageFor();await ready(page,'/join.html');await page.getByLabel('Who’s this hello for? (optional)').fill('Synthetic Sam');await page.getByRole('button',{name:'Create invite link'}).click();await page.getByRole('button',{name:'Check same attempt'}).waitFor();assert.equal(scenario.mints.length,1);assert.equal(scenario.invites.length,1);assert.equal(await page.locator('#invite-label').getAttribute('readonly'),'');assert.equal(scenario.mints[0].label,'Synthetic Sam');
    await page.getByRole('button',{name:'Check same attempt'}).click();await page.getByText(/its link was shown only once and can’t be recovered/).waitFor();assert.equal(scenario.mints.length,2);assert.deepEqual(scenario.mints[1],scenario.mints[0]);assert.equal(scenario.invites.length,1);assert(!(await page.getByRole('dialog').isVisible()));
    await page.getByRole('button',{name:/Revoke invite .* created/}).click();await page.getByRole('button',{name:/Revoke invite .* created/}).filter({hasText:'Retry revoke'}).waitFor();assert.equal(scenario.revokes.length,1);await page.getByRole('button',{name:/Revoke invite .* created/}).click();await page.getByText('Invite revoked. Its link can no longer create an account.').waitFor();assert.deepEqual(scenario.revokes[1],scenario.revokes[0]);await context.close();
  });
  await check('Owner pagination appends safe invite metadata and refresh resets the list',async()=>{
    reset({session:{owner:true},paginate:true,invites:[0,1,2,3].map(n=>({...initialInvite(),id:'page_'+n,label:'Synthetic invite '+n}))});const{context,page}=await pageFor();await ready(page,'/join.html');assert.equal(await page.locator('.invite-row').count(),2);await page.getByRole('button',{name:'Load more invites'}).click();await page.waitForFunction(()=>document.querySelectorAll('.invite-row').length===4);assert(await page.locator('#more-invites').isHidden());await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.invite-row').length===2);await context.close();
  });
  await check('Touch at 320px, mobile landscape, and 200% text keep forms, owner controls, and dialogs within viewport',async()=>{
    for(const [size,enlarged] of [[{width:320,height:700},false],[{width:640,height:360},false],[{width:320,height:700},true]]){
      reset();const{context,page}=await pageFor({viewport:size,isMobile:true,hasTouch:true});
      if(enlarged)await page.route('**/site-admission.css',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text())+'\n:root{font-size:32px}'});});
      await ready(page);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),size.width);
      if(size.width===320&&!enlarged){const first=await page.locator('#signup-name').boundingBox();assert(first.y+first.height<=size.height,'First signup input is visible without scrolling on a320px phone');}
      for(const target of await page.locator('#signup-view button,#signup-view input').evaluateAll(es=>es.filter(e=>e.getClientRects().length).map(e=>({id:e.id,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height}))))assert(target.h>=46,`${target.id} touch height ${target.h}`);
      await page.screenshot({path:new URL(`signup-${size.width}x${size.height}${enlarged?'-text200':''}.png`,out).pathname,fullPage:true});
      reset({session:{owner:true},invites:[initialInvite()]});await ready(page,'/join.html');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),size.width);await page.getByRole('button',{name:'Create invite link'}).click();await page.getByRole('dialog').waitFor();const box=await page.getByRole('dialog').boundingBox();assert(box.x>=0&&box.x+box.width<=size.width);assert(box.y>=0&&box.y+box.height<=size.height);
      await page.keyboard.press('Escape');assert.equal(await page.locator('#created-link').inputValue(),'');await context.close();
    }
  });
  for(const imagePhysicalSizeEnabled of [false,true])await check(`Actual API (image sizes ${imagePhysicalSizeEnabled?'enabled':'disabled'}): native cross-site landing, mint, signup, login, no private grants, reload and revoke`,async()=>{
    reset();const config=readRuntimeConfig({UNIVERSE_MODE:'local',UNIVERSE_REGISTRATION_MODE:'invite-only'});
    const app=createGameServer({database:':memory:',seeds:seedWorlds,dist:new URL('../public',import.meta.url).pathname,runtimeConfig:config,imagePhysicalSizeEnabled});
    const ownerInput={name:'Synthetic UI Owner',username:'synthetic_ui_owner',password};await bootstrapOwner(app.store,ownerInput);
    const address=await app.listen(0),actualBase=`http://127.0.0.1:${address.port}`,observed=[];
    app.server.on('request',(req,res)=>{observed.push({url:req.url,headers:req.headers,method:req.method});});
    const owner=await pageFor(),friend=await pageFor();
    try{
      await owner.page.goto(actualBase+'/join.html');await owner.page.getByRole('button',{name:'I already have an account'}).click();await owner.page.locator('#signin-username').fill(ownerInput.username);await owner.page.locator('#signin-password').fill(password);await owner.page.locator('#signin-password').press('Enter');await owner.page.locator('#owner-view').waitFor();
      await owner.page.reload();await owner.page.locator('#owner-view').waitFor();
      await owner.page.getByLabel('Who’s this hello for? (optional)').fill('Synthetic friend journey');await owner.page.getByRole('button',{name:'Create invite link'}).click();await owner.page.getByRole('dialog').waitFor();const link=await owner.page.locator('#created-link').inputValue(),actualToken=new URL(link).hash.slice('#invite='.length);assert.match(actualToken,/^[A-Za-z0-9_-]{43}$/);scenario.actualLink=link;
      await friend.page.goto(`http://localhost:${server.address().port}/external`);const landingPromise=friend.page.waitForResponse(r=>r.url()===actualBase+'/join.html');await friend.page.getByRole('link',{name:'Open your Universe invitation'}).click();const landing=await landingPromise;assert.equal(landing.status(),200);assert.equal(landing.headers()['referrer-policy'],'no-referrer');assert.equal(landing.headers()['cache-control'],'no-store');assert.match(landing.headers()['content-security-policy'],/default-src 'none'/);
      await friend.page.locator('#signup-view').waitFor();assert.equal(new URL(friend.page.url()).hash,'');assert.equal(app.store.get('SELECT COUNT(*) AS n FROM accounts').n,1,'Landing consumes no account');
      const navigation=observed.find(r=>r.url==='/join.html'&&r.headers['sec-fetch-site']==='cross-site');assert(navigation,'Actual second loopback origin sent cross-site navigation');assert.equal(navigation.headers['sec-fetch-mode'],'navigate');assert.equal(navigation.headers['sec-fetch-dest'],'document');assert.equal(navigation.headers['sec-fetch-user'],'?1');
      await fillSignup(friend.page);await friend.page.locator('#signup-confirm').press('Enter');await friend.page.getByRole('heading',{name:'You’re one hello away.'}).waitFor();assert.equal((await friend.context.cookies()).length,0,'Redeem never signs the friend in');assert.equal(app.store.get('SELECT COUNT(*) AS n FROM accounts').n,2);assert.equal(await friend.page.locator('#signup-password').inputValue(),'');
      await friend.page.locator('#signin-password').fill(password);await friend.page.locator('#signin-password').press('Enter');await friend.page.locator('#signedin-view').waitFor();assert.equal((await friend.context.cookies()).filter(c=>c.name==='universe_session').length,1);const userId=app.store.get('SELECT user_id FROM accounts WHERE username=?','synthetic_friend').user_id;assert.equal(app.store.get('SELECT COUNT(*) AS n FROM world_members WHERE user_id=?',userId).n,0);assert.equal(app.store.get('SELECT COUNT(*) AS n FROM members WHERE user_id=?',userId).n,0);
      await friend.page.reload();await friend.page.locator('#signedin-view').waitFor();assert(await friend.page.locator('#signedin-manage').isHidden());
      if(imagePhysicalSizeEnabled){app.setImagePhysicalSizeEnabledForTest(false);await friend.page.reload();await friend.page.locator('#signedin-view').waitFor();assert.equal(app.store.get('SELECT value FROM metadata WHERE key=?','image_physical_size_protocol_floor').value,IMAGE_PHYSICAL_SIZE_CAPABILITY,'Disabling writes retains the reader floor');}
      const sessions=observed.filter(r=>r.url==='/api/session');assert(sessions.length>=4,'Actual owner/friend session reads observed');assert(sessions.every(r=>r.headers[CLIENT_CAPABILITIES_HEADER.toLowerCase()]===IMAGE_PHYSICAL_SIZE_CAPABILITY),'Standalone admission declares the reader capability on actual session reads');
      await owner.page.keyboard.press('Escape');await owner.page.getByRole('button',{name:'Refresh',exact:true}).click();await owner.page.getByText('Used',{exact:true}).waitFor();await owner.page.getByLabel('Who’s this hello for? (optional)').fill('Synthetic revoked friend');await owner.page.getByRole('button',{name:'Create invite link'}).click();await owner.page.getByRole('dialog').waitFor();const revokedLink=await owner.page.locator('#created-link').inputValue();await owner.page.keyboard.press('Escape');await owner.page.getByRole('button',{name:/Revoke invite .* created/}).click();await owner.page.getByText('Revoked',{exact:true}).waitFor();
      const newcomer=await pageFor();await newcomer.page.goto(revokedLink);await newcomer.page.locator('#guide-view').waitFor();assert.match(await newcomer.page.locator('#guide-message').textContent(),/expired, been revoked, or already been used/);await newcomer.context.close();
      assert(observed.every(r=>!r.url.includes(actualToken)&&!JSON.stringify(r.headers).includes(actualToken)),'No bearer in real server URLs or headers');
      assert(observed.filter(r=>r.url.startsWith('/api/')).every(r=>r.headers.referer===undefined),'Real API requests have no referrer');
      await owner.page.locator('#owner-view h2').focus();await owner.page.screenshot({path:new URL(`actual-owner-completed-${imagePhysicalSizeEnabled?'sized':'legacy'}.png`,out).pathname,fullPage:true});
    }finally{await owner.context.close();await friend.context.close();await app.close();}
  });
  assert(requests.filter(r=>r.path.startsWith('/api/')).every(r=>r.headers[CLIENT_CAPABILITIES_HEADER.toLowerCase()]===IMAGE_PHYSICAL_SIZE_CAPABILITY),'All standalone API requests declare capability without a token');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,scope:'Synthetic API fixtures and actual standalone API browser journey; no deployment or real accounts'},null,2));
}catch(error){process.exitCode=1;errors.push(error.stack);console.error(error);}
finally{await writeFile(new URL('results.json',out),JSON.stringify({checks,errors,scope:'Synthetic fixtures and actual standalone API browser journey; no deployment or real accounts'},null,2));if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
