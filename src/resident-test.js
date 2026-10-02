// Private manager test UI. GET polling never creates/retries a provider operation.
const TERMINAL = new Set(['completed','truncated','filtered','limited','uncertain','timeout','cancelled','revoked','error']);
const LABELS = {completed:'Complete',truncated:'Output limit reached',filtered:'Output withheld',limited:'Test limit reached',uncertain:'Outcome unknown',timeout:'Timed out',cancelled:'Cancelled',revoked:'Permission ended',error:'Test failed'};
const TOOLS = {pause:'Pause movement',resume:'Resume movement',return:'Return home & pause'};
const copy = value => structuredClone(value);
const element = (tag, className, text) => {const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
export function createResidentTestPanel({request,getContext,uuid=()=>crypto.randomUUID(),pollMs=1000,pollLimitMs=30000,requestTimeoutMs=10000}={}) {
 if(typeof request!=='function'||typeof getContext!=='function')throw Error('Resident test requires private request and context adapters');
 const root=element('section','resident-section resident-test');root.dataset.residentTest='';
 const title=element('h3',null,'Private resident test');
 const note=element('p','resident-hint','Uses the saved resident revision. Replies stay private; permitted tools change this resident in the room.');
 const label=element('label','resident-field'),input=element('textarea');input.rows=3;input.maxLength=2000;input.placeholder='Try a short message';input.setAttribute('aria-label','Private test message');label.append(element('span',null,'Message'),input);
 const actions=element('div','resident-row'),status=element('p','resident-hint');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 const reply=element('p','resident-test-reply');reply.style.whiteSpace='pre-wrap';reply.setAttribute('aria-label','Private test reply');
 const toolList=element('ul','resident-test-tools'),error=element('p','resident-error');error.setAttribute('role','alert');
 const makeButton=(text,handler)=>{const b=element('button','resident-secondary',text);b.type='button';b.addEventListener('click',handler);actions.append(b);return b;};
 const start=makeButton('Test saved resident',()=>void begin()),check=makeButton('Check receipt',()=>void inspect(true)),retry=makeButton('Retry same test',()=>void submit()),cancel=makeButton('Cancel test',()=>void cancelRun()),clear=makeButton('New test',()=>reset({forget:unknown||receipt?.status==='uncertain'}));
 root.append(title,note,label,actions,status,reply,toolList,error);
 let context=null,key=null,epoch=0,operation=null,receipt=null,unknown=false,busy=false,destroyed=false,timer=null,pollUntil=0,controller=null,message='';
 const identity=c=>c?.actorId&&c?.roomId&&c?.botId&&Number.isSafeInteger(c?.revision)?JSON.stringify([c.actorId,c.roomId,c.botId,c.revision]):null;
 const endpoint=()=>`/api/rooms/${encodeURIComponent(context.roomId)}/bots/${encodeURIComponent(context.botId)}/turns`;
 function stopTimer(){if(timer!==null)clearTimeout(timer);timer=null;}
 function retire(){epoch++;stopTimer();controller?.abort();controller=null;busy=false;}
 function reset({forget=false}={}){retire();operation=null;receipt=null;unknown=false;message=forget?'The previous request was not cancelled. A new test is a separate operation.':'';reply.textContent='';toolList.replaceChildren();render();if(root.isConnected&&!input.disabled)input.focus({preventScroll:true});}
 function allowed(){return !!context?.canManage&&!!context?.available&&!!context?.saved&&!!context?.enabled&&context?.respondToPlayers!==false&&!context?.dirty&&!context?.busy;}
 function unavailable(){if(!context?.canManage)return 'Resident management permission is required.';if(!context?.saved)return 'Create the resident before testing it.';if(context.dirty)return 'Save your resident changes before running a test.';if(!context.enabled)return 'Enable and save this resident before testing it.';if(context.respondToPlayers===false)return 'Enable Respond to players and save before testing it.';if(!context.available)return 'No provider is attached on this server. Instructions are saved but are not executed.';if(context.busy)return 'Wait for the resident operation to finish.';return '';}
 function render(){
  if(destroyed)return;
  const pending=receipt?.status==='pending',terminal=TERMINAL.has(receipt?.status);
  const inputLimit=context?.limits?.maxInputChars;
  start.disabled=!allowed()||busy||!!operation;input.disabled=busy||!!operation||!context?.canManage;input.maxLength=Number.isInteger(inputLimit)&&inputLimit>0?Math.min(2000,inputLimit):2000;
  check.hidden=!operation;check.disabled=!context?.canManage||busy;
  retry.hidden=!operation||!unknown;retry.disabled=!allowed()||busy;
  cancel.hidden=!operation||terminal;cancel.disabled=!context?.canManage||busy||!!receipt?.cancelRequested;
  clear.hidden=!operation||(!terminal&&!unknown);clear.disabled=busy;
  clear.textContent=unknown||receipt?.status==='uncertain'?'Forget local receipt':'New test';clear.title='Clearing this panel does not cancel an operation on the server';
  error.hidden=!message;error.textContent=message;
  if(unknown)status.textContent='The request outcome is unknown. Check its receipt, or retry the exact same test.';
  else if(pending)status.textContent=receipt.cancelRequested?'Cancellation requested. Waiting for the saved outcome.':Date.now()>=pollUntil?`Saved revision ${operation.revision} is still pending. Use Check receipt for an update.`:`Testing saved revision ${operation.revision}…`;
  else if(terminal)status.textContent=`${LABELS[receipt.status]} · saved revision ${operation.revision}`;
  else status.textContent=unavailable()||(busy?'Submitting test…':`Ready to test saved revision ${context?.revision ?? '—'}`);
 }
 function update(next=getContext()){
  const nextKey=identity(next);
  if(nextKey!==key||!next?.canManage){retire();operation=null;receipt=null;unknown=false;message='';input.value='';reply.textContent='';toolList.replaceChildren();key=nextKey;}
  context=next?{...next}:null;root.hidden=!context?.saved;render();return root;
 }
 function still(token){const current=getContext();if(identity(current)!==key||!current?.canManage){update(current);return false;}return !destroyed&&token===epoch;}
 function accept(value){
  if(!value||value.operationId!==operation.clientOperationId||value.roomId!==context.roomId||value.botId!==context.botId||value.revision!==operation.revision||!(value.status==='pending'||TERMINAL.has(value.status)))throw Error('The server returned a receipt for a different test.');
  receipt=copy(value);unknown=false;message='';reply.textContent='';toolList.replaceChildren();
  if(value.status==='completed'&&typeof value.result?.text==='string')reply.textContent=value.result.text.slice(0,8192);
  for(const result of (Array.isArray(value.result?.toolResults)?value.result.toolResults:[]).slice(0,3)){
   const name=TOOLS[result.name||result.tool||result.command]||'Tool';const state=result.status||result.result?.status||'result received';
   toolList.append(element('li',null,`${name}: ${String(state).slice(0,80)}${state==='accepted'?' (accepted, not an arrival guarantee)':''}`));
  }
  if(value.result?.code&&value.status!=='completed')message=String(value.result.code).slice(0,160);
 }
 function schedule(){stopTimer();if(!destroyed&&receipt?.status==='pending'&&Date.now()<pollUntil&&root.isConnected&&!root.closest('[hidden]'))timer=setTimeout(()=>void inspect(false),pollMs);else render();}
 async function call(path,options,success){
  const token=epoch;busy=true;message='';const ownedController=new AbortController();controller=ownedController;render();let deadline;
  try{const value=await Promise.race([request(path,{...options,signal:ownedController.signal}),new Promise((_,reject)=>{deadline=setTimeout(()=>{ownedController.abort();reject(Error('The request timed out. Its saved outcome is not yet known.'));},requestTimeoutMs);})]);if(still(token)){accept(value);success?.();}}
  catch(problem){if(still(token)){unknown=true;message=String(problem?.message||'The request could not be confirmed.').slice(0,240);stopTimer();}}
  finally{clearTimeout(deadline);if(still(token)){busy=false;controller=null;render();if(!unknown)schedule();}}
 }
 async function begin(){update();if(!allowed()||operation||busy)return;const text=input.value.trim();if(!text){message='Enter a message for this test.';render();input.focus();return;}if(text.length>input.maxLength){message=`Use at most ${input.maxLength} characters.`;render();return;}
  operation=Object.freeze({clientOperationId:uuid(),revision:context.revision,message:text});receipt=null;unknown=false;pollUntil=Date.now()+pollLimitMs;await submit();
 }
 async function submit(){update();if(!operation||!allowed()||busy)return;pollUntil=Date.now()+pollLimitMs;await call(endpoint(),{method:'POST',body:copy(operation)});}
 async function inspect(explicit){update();if(!operation||!context?.canManage||busy)return;if(explicit)pollUntil=Date.now()+pollLimitMs;await call(`${endpoint()}/${encodeURIComponent(operation.clientOperationId)}`,{method:'GET'});}
 async function cancelRun(){update();if(!operation||!context?.canManage||busy||TERMINAL.has(receipt?.status))return;pollUntil=Date.now()+pollLimitMs;await call(`${endpoint()}/${encodeURIComponent(operation.clientOperationId)}/cancel`,{method:'POST',body:{}});}
 function destroy(){if(destroyed)return;retire();destroyed=true;input.value='';reply.textContent='';toolList.replaceChildren();operation=null;receipt=null;root.remove();}
 update();return Object.freeze({element:root,update,reset,destroy});
}
