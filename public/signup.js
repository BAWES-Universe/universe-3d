(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let policy = {enabled:false,setupOnly:false}, busy = false;
  const views = ['loading','unavailable','signup','signin','account'];
  function show(name) {
    for (const view of views) $(view+'-view').hidden = view !== name;
    $(name+'-view').querySelector('h2')?.focus({preventScroll:true});
  }
  function notice(id,text='') { $(id).textContent=text; $(id).hidden=!text; }
  async function request(path,body) {
    const response = await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer',headers:{'X-Universe-Client-Capabilities':'image-physical-size-v1',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.message||'That request could not finish. Please try again.'),{status:response.status,code:data.error});
    return data;
  }
  function signin(note='Sign in with your email or existing username.') {
    $('signin-note').textContent=note; $('signin-create').hidden=!policy.enabled;
    $('signin-password').value=''; notice('signin-error'); show('signin');
  }
  function account(identity) {
    $('account-id').value=identity.accountId||identity.user?.id||'';
    $('account-heading').textContent=policy.setupOnly?'Your account is ready.':'Good to see you.';
    $('account-note').textContent=policy.setupOnly?'Site setup is still in progress. This is the ID of the account you’re signed in to.':'Your account is ready. Private places still need their own permission.';
    $('setup-note').hidden=!policy.setupOnly; $('check-status').hidden=!policy.setupOnly;
    $('enter-universe').hidden=policy.setupOnly; $('copy-status').textContent=''; show('account');
  }
  async function refresh() {
    show('loading');
    try {
      policy=await request('/api/signup');
      try { account(await request('/api/setup/me')); }
      catch(error) {
        if(error.status!==401)throw error;
        if(policy.enabled&&location.hash!=='#signin')show('signup');
        else signin(policy.enabled?undefined:'Account creation is closed. You can still sign in to an existing account.');
      }
    } catch(error) { notice('unavailable-message',error.message); show('unavailable'); }
  }
  for(const button of document.querySelectorAll('[data-password]'))button.addEventListener('click',()=>{
    const input=$(button.dataset.password),shown=input.type==='password';input.type=shown?'text':'password';button.textContent=shown?'Hide':'Show';button.setAttribute('aria-pressed',String(shown));button.setAttribute('aria-label',(shown?'Hide ':'Show ')+(input.id==='signup-confirm'?'confirmation password':input.id==='signin-password'?'sign-in password':'password'));
  });
  $('signup-signin').onclick=()=>signin();
  $('signin-create').onclick=()=>{notice('signup-error');show('signup');};
  $('change-account').onclick=()=>{ $('signin-identifier').value=''; signin(); };
  $('retry-access').onclick=refresh; $('check-status').onclick=refresh;
  $('signup-form').onsubmit=async event=>{
    event.preventDefault(); if(busy)return;notice('signup-error');
    const password=$('signup-password').value;
    if(password!==$('signup-confirm').value){notice('signup-error','Your passwords don’t match. Try them again.');$('signup-confirm').focus();return;}
    if(password!==password.trim()||/[\u0000-\u001f\u007f]/.test(password)){notice('signup-error','Use a password without spaces at either end or control characters.');$('signup-password').focus();return;}
    busy=true;$('signup-submit').disabled=true;$('signup-signin').disabled=true;
    try {
      await request('/api/signup',{name:$('signup-name').value,email:$('signup-email').value,password});
      $('signin-identifier').value=$('signup-email').value;$('signup-password').value='';$('signup-confirm').value='';
      signin('Your account was created. Sign in with the password you just chose.');
    }catch(error){notice('signup-error',error.status?error.message:'We couldn’t confirm account creation. Try signing in before creating another account.');}
    finally{busy=false;$('signup-submit').disabled=false;$('signup-signin').disabled=false;}
  };
  $('signin-form').onsubmit=async event=>{
    event.preventDefault();if(busy)return;notice('signin-error');busy=true;$('signin-submit').disabled=true;$('signin-create').disabled=true;
    try {
      const identifier=$('signin-identifier').value;
      const identity=await request('/api/login',{[policy.registrationMode==='open'&&identifier.includes('@')?'email':'username']:identifier,password:$('signin-password').value});
      $('signin-password').value='';account(identity);
    }catch(error){notice('signin-error',error.message);}
    finally{busy=false;$('signin-submit').disabled=false;$('signin-create').disabled=false;}
  };
  $('copy-account-id').onclick=async()=>{
    try {await navigator.clipboard.writeText($('account-id').value);$('copy-status').textContent='Account ID copied.';}
    catch { $('account-id').focus();$('account-id').select();$('copy-status').textContent='Account ID selected. Copy it from this field.'; }
  };
  refresh();
})();
