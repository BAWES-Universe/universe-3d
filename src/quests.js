import './quests.css';

const icons={explore:'⌖',build:'◇',meet:'♡'};
const labels={explore:'Explorer',build:'Builder',meet:'Connection'};
const element=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
const textFocused=()=>/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)||document.activeElement?.isContentEditable;
const nextStep=quest=>quest.available===false?(quest.reason||'This quest is unavailable right now.'):quest.guidance?.instruction||quest.objective;
const questStatus=(quest,available=false)=>available?'Available':quest.status==='completed'?'Completed':quest.status==='archived'?'Set aside':quest.available===false?'Waiting':'In progress';

/** All progress comes from the server. This module cannot declare completion. */
export function mountQuests({root,api,getContext,onGuide=()=>{},onWalk=()=>{},onCancelWalk=()=>{},onOpenEditor=()=>{},onRegister=()=>{},onOpenChange=()=>{}}) {
  root ||= document.body.appendChild(element('div'));
  root.classList.add('quest-root');
  const invitation=element('aside','quest-invitation'),tracker=element('aside','quest-tracker'),payoff=element('div','quest-payoff'),buildHint=element('p','quest-build-hint');
  const shade=element('div','quest-shade'),sheet=element('section','quest-sheet');
  invitation.setAttribute('aria-label','Optional welcome');payoff.setAttribute('role','status');payoff.setAttribute('aria-live','polite');
  tracker.setAttribute('aria-label','Current quest');buildHint.setAttribute('role','status');buildHint.hidden=true;
  sheet.setAttribute('role','dialog');sheet.setAttribute('aria-modal','true');sheet.setAttribute('aria-label','Quests');shade.append(sheet);root.append(invitation,tracker,payoff,shade);
  let data=null,opened=false,destroyed=false,suppressed=false,previousFocus=null,error='',busy=false,walkTarget=null,walkingAttemptId=null,walkingPhase=null,guideAttemptId=null,guideSignature='',payoffTimer=null,payoffQueue=[],claiming=false,invitationKey='',trackerKey='',refreshTimer=null,requestEpoch=0,identity='',lastRefresh=0;
  const initialParams=new URLSearchParams(location.search);
  const skipArrival=['meeting','meetingId','interview','interviewId','appointment','appointmentId'].some(key=>initialParams.has(key));
  const context=()=>getContext?.()||{};
  const isQuiet=()=>{const c=context();return suppressed||c.busy||!c.ready||document.hidden||textFocused()||['dnd','busy','invisible'].includes(c.user?.status);};
  function button(label,action,key,primary=false){const b=element('button',primary?'quest-button quest-primary':'quest-button',label);b.type='button';if(key)b.dataset.questKey=key;b.disabled=busy&&!['close','cancel-walk'].includes(key);b.onclick=action;return b;}
  function cancelWalk(){walkTarget=null;walkingAttemptId=null;walkingPhase=null;guideAttemptId=null;guideSignature='';onGuide(null);onCancelWalk();renderQuiet();}
  function showGuide(quest){guideAttemptId=quest.id;guideSignature='';close();renderQuiet();}
  function startWalk(quest){
    if(!quest.available||!quest.target)return;
    close();walkTarget=quest.target;walkingAttemptId=quest.id;walkingPhase=quest.guidance?.phase;guideAttemptId=quest.id;guideSignature='';
    Promise.resolve(onWalk(quest.target)).catch(()=>{cancelWalk();error='The walk could not start. Try Show the way, or walk there yourself.';render();});renderQuiet();
  }
  function syncGuidance(){
    const quest=data?.tracked;
    if(walkTarget&&(!quest?.target||!quest.available||quest.id!==walkingAttemptId||quest.guidance?.phase!==walkingPhase)){
      // Reaching the exit is a real intermediate step, never a completion or
      // permission to start another walk. The next action is shown explicitly.
      walkTarget=null;walkingAttemptId=null;walkingPhase=null;onCancelWalk();
    }
    const target=guideAttemptId&&quest?.id===guideAttemptId&&quest.available?quest.target:null;
    const signature=JSON.stringify(target);
    if(signature!==guideSignature){guideSignature=signature;onGuide(target||null);}
    if(!target)guideAttemptId=null;
  }
  async function mutate(url,body,method='POST') {
    if(busy)return;busy=true;error='';render();
    try{const result=await api(url,{method,body});if(result.attempts)data=result;else await refresh();return result;}
    catch(e){await refresh();error=e.message||'That could not be saved. Please try again.';}
    finally{busy=false;render();}
  }
  function setPreferences(body){return mutate('/api/quests/preferences',body,'PATCH');}
  function open(){if(!context().user)return;previousFocus=document.activeElement;opened=true;error='';onOpenChange(true);window.dispatchEvent(new CustomEvent('quest-surface',{detail:{open:true}}));render();sheet.querySelector('.quest-close')?.focus();refresh();}
  function close(){if(!opened)return;opened=false;onOpenChange(false);window.dispatchEvent(new CustomEvent('quest-surface',{detail:{open:false}}));render();const returnFocus=previousFocus?.isConnected&&previousFocus.getClientRects().length?previousFocus:document.getElementById('dock-more')||document.getElementById('game');returnFocus?.focus();}
  function addQuestCard(parent,quest,available=false){
    const card=element('article','quest-card'+(quest.tracked?' is-tracked':''));
    const heading=element('div','quest-card-heading');heading.append(element('span','quest-glyph',icons[quest.kind]||'◇'),element('h3','',quest.title));card.append(heading,element('span','quest-state',questStatus(quest,available)),element('p','quest-objective',quest.objective));
    if(available)card.append(element('p','quest-reward',quest.reward));
    if(!available&&quest.status==='accepted'&&!quest.available)card.append(element('p','quest-unavailable',quest.reason||'This target is unavailable right now'));
    if(quest.status==='completed')card.append(element('div','quest-stamp','✓ '+(labels[quest.kind]||'Quest')+' · private stamp'));
    const actions=element('div','quest-card-actions');
    if(available)actions.append(button('Accept quest',()=>mutate('/api/quests/accept',{roomId:quest.roomId,definitionId:quest.id,version:quest.version}),'accept-'+quest.id,true));
    else if(quest.status==='accepted'){
      if(quest.available){card.append(element('p','quest-next-step','Next: '+nextStep(quest)));if(quest.progress)card.append(element('p','quest-progress',`${quest.progress.completed}/${quest.progress.total} waves counted · ${quest.progress.ownWave?'Your wave is counted':'Your wave is still needed'}`));}
      if(!quest.tracked)actions.append(button('Follow this quest',()=>setPreferences({trackedAttemptId:quest.id}),'track-'+quest.id,true));
      else actions.append(button('Stop following',()=>{cancelWalk();setPreferences({trackedAttemptId:null});},'untrack-'+quest.id));
      if(quest.available&&quest.target&&quest.tracked){
        actions.append(button('Show the way',()=>showGuide(quest),'guide-'+quest.id));
        actions.append(button('Walk there',()=>startWalk(quest),'walk-'+quest.id,true));
      }
      if(quest.available&&quest.kind==='build')actions.append(button('Open Build',()=>{close();onOpenEditor();},'build-'+quest.id,true));
      if(quest.kind==='meet')card.append(element('p','quest-hint','Use Express → 👋. No microphone or camera is required. Connect must be enabled by both real players.'));
      actions.append(button('Set aside',()=>{cancelWalk();mutate('/api/quests/archive',{attemptId:quest.id});},'archive-'+quest.id));
    }
    if(actions.children.length)card.append(actions);parent.append(card);
  }
  function section(title,quests,available=false){if(!quests?.length)return;const group=element('section','quest-group');group.append(element('h2','quest-section-title',title));for(const quest of quests)addQuestCard(group,quest,available);sheet.append(group);}
  function render(){
    if(destroyed)return;
    const focused=sheet.contains(document.activeElement)?document.activeElement?.dataset?.questKey:null;
    shade.hidden=!opened;
    if(opened){
      sheet.replaceChildren();
      // The visible close is the first focusable control, including on small screens.
      const closeButton=button('Close ✕',close,'close');closeButton.classList.add('quest-close');closeButton.setAttribute('aria-label','Close quests');sheet.append(closeButton);
      const head=element('header','quest-heading');head.append(element('span','quest-eyebrow','YOUR OWN PACE'),element('h1','','Quests'),element('p','','Choose one quest, accept it, and follow the next step. Stamps are awarded automatically when you finish.'));sheet.append(head);
      if(error){const message=element('p','quest-error',error);message.setAttribute('role','alert');sheet.append(message);}
      if(!data)sheet.append(element('p','quest-empty','Loading your quest log…'));
      else if(!data.enabled)sheet.append(element('p','quest-empty','Quests are currently switched off. The rest of the room is yours to explore.'));
      else {
        const attempts=data.attempts||[];
        section('Following',attempts.filter(q=>q.status==='accepted'&&q.tracked));
        section('Accepted',attempts.filter(q=>q.status==='accepted'&&!q.tracked));
        section('Available here',data.available,true);
        section('Done · '+data.stampCount+' private '+(data.stampCount===1?'stamp':'stamps'),attempts.filter(q=>q.status==='completed'));
        section('Set aside',attempts.filter(q=>q.status==='archived'));
        if(!attempts.length&&!data.available.length)sheet.append(element('p','quest-empty','Nothing to accept here right now. Explore another room or come back when a real player is nearby.'));
        if(data.stampCount&&!context().user?.account&&!data.preferences?.signInDismissed){const retain=element('aside','quest-retain');retain.append(element('strong','','Keep your progress'),element('p','','Your stamps are saved to this guest profile. Register a local account before clearing this browser’s cookie to recover them on another device.'));const actions=element('div','quest-card-actions');actions.append(button('Account settings',()=>{close();onRegister();},'register',true),button('Not now',()=>setPreferences({signInDismissed:true}),'dismiss-signin'));retain.append(actions);sheet.append(retain);}
        sheet.append(element('p','quest-scope','Your stamps are private to this profile. Signing into another existing account does not move your progress.'));
      }
      if(focused)sheet.querySelectorAll('[data-quest-key]').forEach(node=>{if(node.dataset.questKey===focused)node.focus({preventScroll:true});});
    }
    renderQuiet();
  }
  function renderQuiet(){
    if(destroyed)return;
    syncGuidance();
    const quiet=isQuiet()||opened;
    invitation.hidden=true;tracker.hidden=true;payoff.hidden=quiet||!payoff.textContent;
    const buildQuest=context().building&&data?.tracked?.kind==='build'?data.tracked:null;
    // The main shell suppresses ambient quest UI while building. This accepted
    // quest's instruction belongs inside the editor itself and remains useful.
    buildHint.hidden=!buildQuest||!context().ready||opened||document.hidden;
    if(!buildHint.hidden){
      const editor=document.querySelector('#editor');
      const activeSheet=editor?.dataset.compact==='true'?editor.querySelector(':scope > :is(.builder-tray,.builder-terrain,.builder-inspector,.builder-tools):not([hidden])'):null;
      const host=activeSheet||editor?.querySelector('.builder-heading');
      // Compact editor sheets cover the lower part of the heading. Keep the
      // instruction inside the active sheet instead of underneath its surface.
      if(host&&!host.contains(buildHint)){if(activeSheet)host.prepend(buildHint);else host.append(buildHint);}
      const copy=`Quest: ${nextStep(buildQuest)} Moving an existing object does not count.`;if(buildHint.textContent!==copy)buildHint.textContent=copy;
    }
    if(!data?.enabled||!context().user)return;
    if(!quiet&&!skipArrival&&!data.preferences?.declined&&!data.preferences?.invitationSeen&&data.available?.length&&!data.attempts?.length){
      invitation.hidden=false;if(invitationKey!==String(busy)){invitationKey=String(busy);invitation.replaceChildren(element('p','','Welcome. Want a quick look around?'));
      const actions=element('div','quest-invitation-actions');actions.append(button('Show me the options',()=>{setPreferences({invitationSeen:true});open();},'options',true),button('Not now',()=>{cancelWalk();setPreferences({declined:true});},'decline'));invitation.append(actions);}
      // A viewed invitation may remain here for this visit. Decline is separately
      // durable; opening options or accepting acknowledges it across devices.
    }
    if(!quiet&&(data.tracked||walkTarget)){
      tracker.hidden=false;const quest=data.tracked,signature=JSON.stringify([quest,!!walkTarget,!!guideAttemptId,busy,error]);
      if(signature!==trackerKey){
        const focused=tracker.contains(document.activeElement)?document.activeElement.dataset.questKey:null;
        trackerKey=signature;tracker.replaceChildren();
        if(quest){
          const head=element('div','quest-tracker-heading');head.append(element('span','quest-state',questStatus(quest)),button('Quest log',open,'tracker'));
          tracker.append(head,element('strong','quest-tracker-title',(icons[quest.kind]||'◇')+' '+quest.title));
          const instruction=element('p','quest-next-step',nextStep(quest));instruction.setAttribute('role','status');tracker.append(instruction);
          if(quest.progress)tracker.append(element('p','quest-progress',`${quest.progress.completed}/${quest.progress.total} waves · ${quest.progress.ownWave?'Your wave counted':'Your wave needed'}`));
          const actions=element('div','quest-tracker-actions');
          if(walkTarget)actions.append(button('Cancel walk',cancelWalk,'cancel-walk'));
          else if(quest.available&&quest.target){actions.append(guideAttemptId?button('Hide marker',()=>{guideAttemptId=null;renderQuiet();},'tracker-hide-guide'):button('Show the way',()=>showGuide(quest),'tracker-guide'),button(quest.guidance?.phase==='leave-area'?'Walk outside':'Walk there',()=>startWalk(quest),'tracker-walk',true));}
          else if(quest.available&&quest.kind==='build')actions.append(button('Open Build',()=>onOpenEditor(),'tracker-build',true));
          if(actions.children.length)tracker.append(actions);
        }
        if(error)tracker.append(element('p','quest-error',error));
        if(focused)tracker.querySelectorAll('[data-quest-key]').forEach(node=>{if(node.dataset.questKey===focused)node.focus({preventScroll:true});});
      }
    }
    if(!quiet&&payoffQueue.length&&!payoff.textContent){const notice=payoffQueue.shift();payoff.textContent='✓ '+notice.title+' · private stamp added';payoff.hidden=false;clearTimeout(payoffTimer);payoffTimer=setTimeout(()=>{payoff.textContent='';renderQuiet();},5500);}
    if(!quiet&&data.pendingNotices&&!claiming)claimNotices();
  }
  async function claimNotices(){
    if(claiming||isQuiet()||opened)return;claiming=true;
    const user=context().user?.id;
    try{const result=await api('/api/quests/notices/claim',{method:'POST',body:{}});if(user!==context().user?.id)return;payoffQueue.push(...result.notices);if(data)data.pendingNotices=0;renderQuiet();}catch{}finally{claiming=false;}
  }
  async function refresh(){
    const c=context(),newIdentity=(c.user?.id||'')+':'+(c.room?.id||'');
    if(identity!==newIdentity){identity=newIdentity;data=null;payoffQueue=[];payoff.textContent='';cancelWalk();error='';}
    if(!c.user||!c.ready){render();return;}
    const epoch=++requestEpoch;lastRefresh=Date.now();
    try{const result=await api('/api/quests');if(epoch!==requestEpoch||newIdentity!==((context().user?.id||'')+':'+(context().room?.id||'')))return;data=result;error='';render();}
    catch(e){if(epoch!==requestEpoch)return;if(e.status===404||e.status===503){data={enabled:false};render();}else if(opened){error=e.message||'The quest service is unavailable. Your room still works.';render();}}
  }
  function handleEvent(type,event){if(typeof type==='object'){event=type.data;type=type.type;}if(['quest','hello','scene','role','room','moderation','media-policy','presence'].includes(type)){const urgent=!['media-policy','presence'].includes(type);if(urgent)clearTimeout(refreshTimer);if(urgent||!refreshTimer)refreshTimer=setTimeout(()=>{refreshTimer=null;refresh();},urgent?60:800);}}
  function setSuppressed(value){if(suppressed===!!value)return;suppressed=!!value;renderQuiet();}
  function onFocus(){renderQuiet();}
  function onKey(event){
    if(!opened)return;
    if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close();return;}
    // Keep dialog keystrokes local. This never replaces map-level shortcuts.
    if(sheet.contains(event.target)){
      if(event.key==='Tab'){const controls=[...sheet.querySelectorAll('button:not(:disabled),a[href],input,select,textarea')].filter(n=>!n.hidden);const first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
      event.stopPropagation();
    }
  }
  shade.onclick=e=>{if(e.target===shade)close();};root.addEventListener('pointerdown',e=>e.stopPropagation());root.addEventListener('click',e=>e.stopPropagation());
  window.addEventListener('keydown',onKey,true);document.addEventListener('focusin',onFocus);document.addEventListener('focusout',onFocus);document.addEventListener('visibilitychange',onFocus);
  const timer=setInterval(()=>{if(destroyed)return;const c=context(),key=(c.user?.id||'')+':'+(c.room?.id||'');if(key!==identity||(c.ready&&Date.now()-lastRefresh>15000))refresh();else renderQuiet();},500);
  render();
  return {refresh,open,close,handleEvent,onEvent:e=>handleEvent(e.type,e.data),setSuppressed,isOpen:()=>opened,isWalking:()=>!!walkTarget,cancelWalk,getState:()=>data,destroy(){destroyed=true;clearInterval(timer);clearTimeout(refreshTimer);clearTimeout(payoffTimer);window.removeEventListener('keydown',onKey,true);document.removeEventListener('focusin',onFocus);document.removeEventListener('focusout',onFocus);document.removeEventListener('visibilitychange',onFocus);onGuide(null);onCancelWalk();buildHint.remove();root.replaceChildren();}};
}
