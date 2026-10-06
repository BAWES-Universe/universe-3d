import {signupDestination,signupStartsWithSignin,signupViewLink} from '../src/signup-navigation.js';

(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let policy = {enabled:false,setupOnly:false}, busy = false, generation = 0, action = null, interruptedSignup = false;
  const requests = new Set(), views = ['loading','unavailable','signup','signin','account','entering'];
  function show(name) {
    for (const view of views) $(view+'-view').hidden = view !== name;
    $(name+'-view').querySelector('h2')?.focus();
  }
  function notice(id,text='') { $(id).textContent=text; $(id).hidden=!text; }
  function setBusy(value) {
    busy=value;
    for(const control of document.querySelectorAll('form input,form button,#signup-signin,#signin-create,#change-account,#retry-access,#check-status'))control.disabled=value;
    $('signup-form').setAttribute('aria-busy',String(value));$('signin-form').setAttribute('aria-busy',String(value));
  }
  async function request(path,body) {
    const controller=new AbortController();requests.add(controller);
    const timer=setTimeout(()=>controller.abort(),20000);
    try {
      const response = await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,headers:{'X-Universe-Client-Capabilities':'image-physical-size-v1',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      let data;try{data=await response.json();}catch{data=null;}
      if (!response.ok) throw Object.assign(new Error(response.status===429?'Too many attempts. Wait a minute, then try again.':data?.message||'That request could not finish. Please try again.'),{status:response.status,code:data?.code||data?.error});
      if(!data||typeof data!=='object'||Array.isArray(data)||!Object.keys(data).length)throw new Error('The server returned an unreadable response.');
      return data;
    } finally {clearTimeout(timer);requests.delete(controller);}
  }
  function signin(note='Sign in with your email or existing username.',current=null) {
    history.replaceState(null,'',signupViewLink(location.href,true));
    $('signin-note').textContent=note; $('signin-create').hidden=!policy.enabled;
    $('signin-continue').hidden=!current;$('signin-continue').href=signupDestination(location.href);
    $('signin-password').value=''; notice('signin-error'); show('signin');
  }
  function validateIdentity(identity) {
    if(typeof identity.setupOnly!=='boolean'||typeof identity.accountId!=='string'||!(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/).test(identity.accountId)||identity.user?.id!==identity.accountId)throw new Error('We couldn’t confirm your sign-in. Please try again.');
  }
  function account(identity) {
    validateIdentity(identity);
    // The authenticated response is authoritative if setup changed while this
    // form was open. An ordinary visitor never needs an operator/account ID.
    if(!identity.setupOnly){
      const destination=signupDestination(location.href);
      $('continue-universe').href=destination;show('entering');location.replace(destination);return;
    }
    $('account-id').value=identity.accountId;
    $('account-heading').textContent='Your account is ready.';
    $('account-note').textContent='Site setup is still in progress. This is the ID of the account you’re signed in to.';
    $('setup-note').hidden=false; $('check-status').hidden=false;
    $('enter-universe').hidden=true; $('copy-status').textContent=''; show('account');
  }
  async function refresh() {
    if(busy)return;const operation=++generation;show('loading');setBusy(true);
    try {
      const next=await request('/api/signup');if(operation!==generation)return;
      if(typeof next.enabled!=='boolean'||typeof next.setupOnly!=='boolean')throw new Error('We couldn’t check account access. Please try again.');
      policy=next;$('signup-submit').textContent=policy.setupOnly?'Create my account':'Create account & enter';
      try {const identity=await request('/api/setup/me');if(operation!==generation)return;
        validateIdentity(identity);
        if(identity.setupOnly===false&&signupStartsWithSignin(location.href))signin('You’re already signed in. Continue, or sign in to another account.',identity);else account(identity);
      }
      catch(error) {
        if(operation!==generation)return;if(error.status!==401)throw error;
        if(interruptedSignup){interruptedSignup=false;signin('Account creation was interrupted. Try signing in with the details you chose.');}
        else if(policy.enabled&&!signupStartsWithSignin(location.href))show('signup');
        else signin(policy.enabled?undefined:'Account creation is closed. You can still sign in to an existing account.');
      }
    } catch(error) {if(operation===generation){notice('unavailable-message',error.name==='AbortError'?'Checking access took too long. Please try again.':error.message);show('unavailable');}}
    finally {if(operation===generation)setBusy(false);}
  }
  for(const button of document.querySelectorAll('[data-password]'))button.addEventListener('click',()=>{
    const input=$(button.dataset.password),shown=input.type==='password';input.type=shown?'text':'password';button.textContent=shown?'Hide':'Show';button.setAttribute('aria-pressed',String(shown));button.setAttribute('aria-label',(shown?'Hide ':'Show ')+(input.id==='signup-confirm'?'confirmation password':input.id==='signin-password'?'sign-in password':'password'));
  });
  document.querySelector('.skip-link').addEventListener('click',event=>{event.preventDefault();$('content').focus();$('content').scrollIntoView({block:'start'});});
  $('signup-signin').onclick=()=>{if(busy)return;$('signin-identifier').value=$('signup-email').value;signin();};
  $('signin-create').onclick=()=>{if(busy)return;history.replaceState(null,'',signupViewLink(location.href,false));notice('signup-error');show('signup');};
  $('change-account').onclick=()=>{if(busy)return;$('signin-identifier').value='';signin();};
  $('retry-access').onclick=refresh; $('check-status').onclick=refresh;
  $('signup-form').onsubmit=async event=>{
    event.preventDefault(); if(busy)return;notice('signup-error');
    const password=$('signup-password').value,email=$('signup-email').value,name=$('signup-name').value;
    if(password!==$('signup-confirm').value){notice('signup-error','Your passwords don’t match. Try them again.');$('signup-confirm').focus();return;}
    if(password!==password.trim()||/[\u0000-\u001f\u007f]/.test(password)){notice('signup-error','Use a password without spaces at either end or control characters.');$('signup-password').focus();return;}
    const operation=++generation;action='signup';setBusy(true);$('signin-identifier').value=email;
    // If creation commits but its acknowledgement is lost, reload must offer
    // sign-in instead of encouraging a second account. Never store credentials.
    history.replaceState(null,'',signupViewLink(location.href,true));
    try {
      const created=await request('/api/signup',{name,email,password});if(operation!==generation)return;
      if(created.created!==true||created.loginRequired!==true)throw new Error('Account creation could not be confirmed.');
      $('signup-password').value='';$('signup-confirm').value='';
      history.replaceState(null,'',signupViewLink(location.href,true));
      if(policy.setupOnly){signin('Your account was created. Sign in with the password you just chose.');return;}
      // Signup still creates no session. The explicitly labeled combined action
      // uses the existing login endpoint, credentials, limits and cookie policy.
      try {const identity=await request('/api/login',{identifier:email,password});if(operation===generation)account(identity);}
      catch(error){if(operation===generation){signin('Your account was created. Sign in to finish entering Universe.');notice('signin-error',error.name==='AbortError'?'Sign-in took too long. Please try again.':error.message);}}
    }catch(error){if(operation===generation)notice('signup-error',error.status?error.message:'We couldn’t confirm account creation. Try signing in before creating another account.');}
    finally{if(operation===generation){action=null;setBusy(false);}}
  };
  $('signin-form').onsubmit=async event=>{
    event.preventDefault();if(busy)return;notice('signin-error');const operation=++generation;action='signin';setBusy(true);
    try {
      const identity=await request('/api/login',{identifier:$('signin-identifier').value,password:$('signin-password').value});
      if(operation!==generation)return;$('signin-password').value='';account(identity);
    }catch(error){if(operation===generation)notice('signin-error',error.name==='AbortError'?'Sign-in took too long. Please try again.':error.message);}
    finally{if(operation===generation){action=null;setBusy(false);}}
  };
  $('copy-account-id').onclick=async()=>{
    try {await navigator.clipboard.writeText($('account-id').value);$('copy-status').textContent='Account ID copied.';}
    catch { $('account-id').focus();$('account-id').select();$('copy-status').textContent='Account ID selected. Copy it from this field.'; }
  };
  window.addEventListener('pagehide',()=>{
    interruptedSignup=action==='signup';generation++;for(const controller of requests)controller.abort();
    $('signup-password').value='';$('signup-confirm').value='';$('signin-password').value='';action=null;setBusy(false);
  });
  window.addEventListener('pageshow',event=>{if(event.persisted)refresh();});
  refresh();
})();
