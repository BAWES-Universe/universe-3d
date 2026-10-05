/* The blocking head script captures the fragment before UI initialization.
   Referrer policy and fragment semantics protect resource requests independently.
   Bearer links and operation proofs never enter storage. */
(() => {
  'use strict';
  let inviteToken = null;
  let hadFragment = false;
  let fragmentRemoved = false;
  try {
    const fragment = location.hash;
    hadFragment = Boolean(fragment);
    const match = /^#invite=([A-Za-z0-9_-]{43})$/.exec(fragment);
    inviteToken = match ? match[1] : null;
    history.replaceState(null, '', location.pathname);
    fragmentRemoved = true;
  } catch {
    inviteToken = null;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const $ = id => document.getElementById(id);
    const signup = $('signup-form'), signin = $('signin-form');
    const views = [...document.querySelectorAll('.view')];
    let policy = null, currentSession = null, signupOperation = null, createOperation = null;
    let signupBusy = false, signupNeedsReconciliation = false, createBusy = false, copied = false, initialLoad = true;
    const revokeOperations = new Map();
    const ownerInvites = new Map();
    let nextCursor = null, ownerListEpoch = 0;
    const signupFields = [...signup.querySelectorAll('input')];
    const signedName = () => currentSession?.user?.name || currentSession?.user?.username || 'your existing profile';
    const canManage = () => currentSession?.siteAdmission?.canManage === true || policy?.siteAdmission?.canManage === true;
    const date = value => {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? 'Time unavailable' : d.toLocaleString(undefined, {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'});
    };
    const operationId = () => {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    };
    const notice = (id, message = '') => { $(id).textContent = message; $(id).hidden = !message; };
    function show(view, focus = true) {
      for (const el of views) el.hidden = el.id !== `${view}-view`;
      $('content').classList.toggle('owner-mode', view === 'owner');
      document.title = view === 'owner' ? 'Site invites · Universe' : 'Join Universe · BAWES';
      if (focus && !initialLoad) $(`${view}-view`).querySelector('h2')?.focus();
      if (view !== 'loading') initialLoad = false;
    }
    function clearPasswords() {
      for (const input of document.querySelectorAll('input[name="password"], input[name="confirmation"]')) { input.value = ''; input.type = 'password'; }
      for (const button of document.querySelectorAll('[data-password]')) { button.textContent = 'Show'; button.setAttribute('aria-pressed', 'false'); button.setAttribute('aria-label', button.dataset.originalLabel); }
    }
    function forgetInvite() {
      inviteToken = null; signupOperation = null; signupNeedsReconciliation = false; signup.reset(); clearPasswords();
    }
    async function api(path, body) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(path, {
          method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
          redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
          headers: body === undefined ? {Accept:'application/json', 'X-Universe-Client-Capabilities':'image-physical-size-v1'} : {Accept:'application/json', 'Content-Type':'application/json', 'X-Universe-Client-Capabilities':'image-physical-size-v1'},
          ...(body === undefined ? {} : {body:JSON.stringify(body)}),
        });
        let data;
        try { data = await response.json(); } catch { throw Object.assign(new Error('UNCONFIRMED_RESPONSE'), {uncertain:true}); }
        if (!response.ok) throw Object.assign(new Error(data.code || 'REQUEST_FAILED'), {code:data.code, status:response.status, uncertain:response.status >= 500});
        return data;
      } catch (error) {
        if (!error.status) error.uncertain = true;
        throw error;
      } finally { clearTimeout(timeout); }
    }
    function messageFor(error) {
      const messages = {
        INVITE_UNAVAILABLE:'This invite can’t be used. It may have expired, been revoked, or already been used. Ask the site owner for a new link.',
        SITE_ADMISSION_DISABLED:'New accounts by invitation aren’t available on this site right now. You can still sign in to an existing account.',
        ACCOUNT_LIMIT_REACHED:'This site has reached its account limit. Ask the site owner for help, or sign in if you already have an account.',
        INVITE_LIMIT_REACHED:'There are too many active invites. Revoke an unused invite before creating another.',
        ACTIVE_INVITE_LIMIT_REACHED:'There are too many active invites. Revoke an unused invite before creating another.',
        INVITE_HISTORY_LIMIT_REACHED:'This site’s saved invitation history is full. Ask the site operator to review its configured limit.',
        INVALID_USERNAME:'Choose a username with 3–32 lowercase letters, numbers, or underscores.',
        USERNAME_TAKEN:'That username is already taken. Try another one.',
        USERNAME_EXISTS:'That username is already taken. Try another one.',
        INVALID_PASSWORD:'Use a password with 10–256 characters, no control characters, and no spaces at the beginning or end.',
        INVALID_NAME:'Use a name with 1–40 characters and no control characters.',
        INVALID_CREDENTIALS:'That username and password don’t match. Check them and try again.',
        SIGNUP_SIGN_OUT_REQUIRED:'You’re already signed in. Sign out before using an invite for a different account.',
        SIGNUP_SESSION_CHANGED:'Your sign-in changed while creating this account. Check your current sign-in before trying again.',
        SIGNUP_BUSY:'Another signup attempt is still in progress. Wait a moment, then try again.',
        ALREADY_REGISTERED:'You already have an account. Sign in with that account to continue.',
        AUTH_REQUIRED:'Your sign-in has expired. Sign in again to continue.',
        SITE_INVITES_FORBIDDEN:'Only the site owner can manage these invitations.',
        SITE_OWNER_REQUIRED:'Only the site owner can manage these invitations. Owning a world or room doesn’t grant access here.',
        FORBIDDEN:'Only the site owner can manage these invitations.',
        RATE_LIMITED:'There have been a few too many attempts. Wait a little, then try again.',
        OPERATION_CONFLICT:'This attempt no longer matches the original request. Reopen your original invitation to try again.',
        CLIENT_OPERATION_CONFLICT:'This attempt no longer matches the original request. Refresh your invites to check what was created.',
      };
      return messages[error.code] || 'We couldn’t complete that request. Please try again.';
    }
    function showGuide(message, retry = false) {
      $('guide-message').textContent = message || 'New here? Ask the site owner for a personal invite link, then open it to create your account.';
      $('guide-retry').hidden = !retry; show('guide');
    }
    function showSignin(username, created = false) {
      clearPasswords(); notice('signin-error');
      if (username !== undefined) $('signin-username').value = username;
      $('signin-eyebrow').textContent = created ? 'YOUR ACCOUNT IS READY' : 'WELCOME BACK';
      $('signin-heading').textContent = created ? 'You’re one hello away.' : 'Your people await.';
      $('signin-intro').textContent = created ? 'Account created. Sign in with your new password to enter Universe. Private places still need their own invitation.' : 'Sign in with your Universe account.';
      $('signin-back').hidden = created;
      show('signin');
      if (created) $('signin-password').focus();
    }
    function showSignedIn() {
      $('signedin-name').textContent = `Welcome, ${signedName()}.`;
      $('signedin-invite-note').hidden = !inviteToken;
      $('signedin-signout').hidden = !inviteToken;
      $('signedin-manage').hidden = !canManage();
      show('signedin');
    }
    async function checkInvite() {
      show('loading', false);
      try {
        const result = await api('/api/site-admission/check', {token:inviteToken});
        if (result.valid !== true) throw Object.assign(new Error('INVITE_UNAVAILABLE'), {code:'INVITE_UNAVAILABLE'});
        $('invite-expiry').textContent = `Use this invitation by ${date(result.expiresAt)}.`;
        show('signup');
      } catch (error) {
        showGuide(error.uncertain ? 'We couldn’t check your invitation. It’s still here in this tab; try again when your connection is back.' : messageFor(error), error.uncertain || error.code === 'RATE_LIMITED');
      }
    }
    async function start() {
      if (!fragmentRemoved) return showGuide('We couldn’t safely open this invitation. Reopen the original link in a new browser tab.');
      show('loading', false);
      try {
        const [access, session] = await Promise.all([
          api('/api/access'), api('/api/session').catch(error => { if (error.status === 401) return null; throw error; }),
        ]);
        policy = access; currentSession = session;
        if (currentSession?.user) return inviteToken || !canManage() ? showSignedIn() : loadOwner();
        if (inviteToken) return await checkInvite();
        showGuide(hadFragment ? 'This invitation link is incomplete. Ask the site owner to send the full link again.' : undefined);
      } catch {
        showGuide('We couldn’t reach Universe. Check your connection, then try again. Your invitation stays in this tab.', true);
      }
    }
    function lockSignup(lock) {
      for (const field of signupFields) field.readOnly = lock;
      $('signup-signin').disabled = lock;
      signup.setAttribute('aria-busy', String(signupBusy));
    }
    signup.addEventListener('submit', async event => {
      event.preventDefault(); if (signupBusy) return;
      notice('signup-error');
      if (!signupOperation) {
        const username = $('signup-username'), password = $('signup-password'), confirmation = $('signup-confirm'), name = $('signup-name');
        for (const field of signupFields) field.removeAttribute('aria-invalid');
        if (password.value !== confirmation.value) {
          confirmation.setAttribute('aria-invalid', 'true'); notice('signup-error', 'Your passwords don’t match. Enter the same password in both fields.'); confirmation.focus(); return;
        }
        if (password.value.trim() !== password.value || /[\u0000-\u001f\u007f]/.test(password.value)) {
          password.setAttribute('aria-invalid', 'true'); notice('signup-error', messageFor({code:'INVALID_PASSWORD'})); password.focus(); return;
        }
        if (!inviteToken) return showGuide('Reopen your original invitation to create your account.');
        signupOperation = {token:inviteToken,clientOperationId:operationId(),username:username.value,password:password.value,name:name.value};
      }
      const submittedUsername = signupOperation.username;
      signupBusy = true; lockSignup(true); $('signup-submit').disabled = true; $('signup-submit').textContent = 'Creating your account…';
      let uncertain = false;
      try {
        const result = await api('/api/site-admission/redeem', signupOperation);
        if (result.created !== true || result.loginRequired !== true) throw Object.assign(new Error('UNCONFIRMED_RESPONSE'), {uncertain:true});
        const username = result.username || signupOperation.username;
        forgetInvite(); hadFragment = false; showSignin(username, true);
      } catch (error) {
        uncertain = Boolean(error.uncertain || ['RATE_LIMITED','SIGNUP_BUSY'].includes(error.code));
        if (uncertain) {
          signupNeedsReconciliation ||= Boolean(error.uncertain);
          notice('signup-error', error.code === 'RATE_LIMITED' || error.code === 'SIGNUP_BUSY' ? `${messageFor(error)} Keep this tab open and choose “Retry safely” after waiting. Your original attempt and details stay unchanged.` : 'We couldn’t confirm the result. Your account may already be created. Keep this tab open and choose “Retry safely” to check the same attempt. Your details will stay unchanged.');
        } else {
          signupOperation = null;
          notice('signup-error', messageFor(error));
          const field = error.code?.includes('USERNAME') ? $('signup-username') : error.code === 'INVALID_PASSWORD' ? $('signup-password') : error.code === 'INVALID_NAME' ? $('signup-name') : null;
          if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
          if (error.code === 'SIGNUP_SIGN_OUT_REQUIRED') { await start(); }
          if (['INVITE_UNAVAILABLE','SITE_ADMISSION_DISABLED','ACCOUNT_LIMIT_REACHED'].includes(error.code)) {
            const recoverByLogin = signupNeedsReconciliation;
            forgetInvite();
            if (recoverByLogin) {
              showSignin(submittedUsername);
              $('signin-heading').textContent = 'Let’s check your account.';
              $('signin-intro').textContent = 'The invitation can’t be used now, but your earlier attempt may have created your account. Try signing in with the username and password you chose. If that doesn’t work, ask the site owner for help.';
              $('signin-password').focus();
            } else showGuide(messageFor(error));
          }
        }
      } finally {
        signupBusy = false; lockSignup(uncertain); $('signup-submit').disabled = false; $('signup-submit').textContent = uncertain ? 'Retry safely' : 'Create my account →';
      }
    });
    signin.addEventListener('submit', async event => {
      event.preventDefault(); if ($('signin-submit').disabled) return;
      notice('signin-error'); $('signin-submit').disabled = true; signin.setAttribute('aria-busy', 'true');
      try {
        currentSession = await api('/api/login', {username:$('signin-username').value,password:$('signin-password').value});
        clearPasswords(); forgetInvite(); policy = await api('/api/access');
        if (canManage()) await loadOwner(); else showSignedIn();
      } catch (error) {
        clearPasswords(); notice('signin-error', error.uncertain ? 'We couldn’t confirm sign-in. Check your connection, enter your password, and try again.' : messageFor(error)); $('signin-password').focus();
      } finally { $('signin-submit').disabled = false; signin.setAttribute('aria-busy', 'false'); }
    });
    $('signedin-signout').addEventListener('click', async () => {
      const button = $('signedin-signout'); button.disabled = true; notice('signedin-error');
      try { await api('/api/logout', {}); currentSession = null; if (policy?.siteAdmission) policy.siteAdmission.canManage = false; await checkInvite(); }
      catch (error) {
        if (error.status === 401) { currentSession = null; if (policy?.siteAdmission) policy.siteAdmission.canManage = false; await checkInvite(); }
        else notice('signedin-error', error.uncertain ? 'We couldn’t confirm sign-out. Try again before using this invitation.' : messageFor(error));
      }
      finally { button.disabled = false; }
    });
    $('guide-signin').addEventListener('click', () => showSignin());
    $('signup-signin').addEventListener('click', () => showSignin());
    $('signin-back').addEventListener('click', () => { clearPasswords(); if (inviteToken) checkInvite(); else showGuide(); });
    $('guide-retry').addEventListener('click', start);
    $('signedin-manage').addEventListener('click', () => loadOwner());
    for (const button of document.querySelectorAll('[data-password]')) {
      button.dataset.originalLabel = button.getAttribute('aria-label');
      button.addEventListener('click', () => {
        const input = $(button.dataset.password), visible = input.type === 'password';
        input.type = visible ? 'text' : 'password'; button.textContent = visible ? 'Hide' : 'Show';
        button.setAttribute('aria-pressed', String(visible)); button.setAttribute('aria-label', button.dataset.originalLabel.replace('Show', visible ? 'Hide' : 'Show'));
      });
    }
    function renderInvites(result, append = false) {
      if (!append) { ownerInvites.clear(); ownerListEpoch++; }
      for (const invite of result.invites) ownerInvites.set(invite.id, invite);
      nextCursor = result.hasMore && typeof result.nextCursor === 'string' ? result.nextCursor : null;
      $('more-invites').hidden = !nextCursor;
      $('active-count').textContent = `${result.activeInvites} / ${result.maxActiveInvites}`;
      $('account-count').textContent = `${result.accountCount} / ${result.maxAccounts}`;
      const ttl = currentSession?.siteAdmission?.inviteTtlMs || policy?.siteAdmission?.inviteTtlMs;
      $('owner-limits').textContent = ttl ? `New links expire after ${ttl / 3600000} hours. Limits shown are this site’s current settings.` : 'Limits shown are this site’s current settings.';
      $('invite-list').replaceChildren();
      $('invite-empty').hidden = ownerInvites.size !== 0;
      for (const invite of ownerInvites.values()) {
        const row = document.createElement('li'); row.className = 'invite-row';
        const detail = document.createElement('div'); detail.className = 'invite-detail';
        const title = document.createElement('strong'); title.textContent = invite.label || `Invite · ${invite.id.slice(-8)}`;
        const time = document.createElement('p');
        const status = invite.status;
        time.textContent = status === 'redeemed' ? `Used ${date(invite.redeemedAt)}` : status === 'revoked' ? `Revoked ${date(invite.revokedAt)}${invite.redeemedAt ? ' · Existing account stays active' : ''}` : `${status === 'expired' ? 'Expired' : 'Expires'} ${date(invite.expiresAt)}`;
        detail.append(title, time); row.append(detail);
        if (status === 'active') {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'button secondary'; button.textContent = revokeOperations.has(invite.id) ? 'Retry revoke' : 'Revoke';
          button.setAttribute('aria-label', `Revoke invite ${invite.id.slice(-8)} created ${date(invite.createdAt)}`);
          button.addEventListener('click', () => revokeInvite(invite.id, button)); row.append(button);
        } else {
          const badge = document.createElement('span'); badge.className = 'invite-state'; badge.textContent = status === 'redeemed' ? 'Used' : status === 'revoked' ? 'Revoked' : status === 'expired' ? 'Expired' : 'Unavailable'; row.append(badge);
          revokeOperations.delete(invite.id);
        }
        $('invite-list').append(row);
      }
      $('create-invite').disabled = createBusy || (!createOperation && (result.activeInvites >= result.maxActiveInvites || result.accountCount >= result.maxAccounts));
      if (!createOperation && result.accountCount >= result.maxAccounts) notice('owner-notice', 'This site has reached its account limit. New invite links can’t be created right now.');
      else if (!createOperation && result.activeInvites >= result.maxActiveInvites) notice('owner-notice', 'All invite slots are in use. Revoke an unused link to make room.');
    }
    async function loadOwner() {
      show('owner'); $('refresh-invites').disabled = true; notice('owner-error');
      try { renderInvites(await api('/api/site-invites')); }
      catch (error) {
        $('create-invite').disabled = true; notice('owner-error', error.uncertain ? 'We couldn’t load your invites. Refresh when your connection is back.' : messageFor(error));
        if (error.status === 401) showSignin();
      } finally { $('refresh-invites').disabled = false; }
    }
    $('refresh-invites').addEventListener('click', () => { notice('owner-notice'); loadOwner(); });
    $('more-invites').addEventListener('click', async () => {
      if (!nextCursor || $('more-invites').disabled) return;
      const epoch = ownerListEpoch;
      $('more-invites').disabled = true; notice('owner-error');
      try {
        const result = await api(`/api/site-invites?cursor=${encodeURIComponent(nextCursor)}`);
        if (epoch === ownerListEpoch) renderInvites(result, true);
      } catch (error) { notice('owner-error', error.uncertain ? 'We couldn’t load more invites. Try again when your connection is back.' : messageFor(error)); }
      finally { $('more-invites').disabled = false; }
    });
    $('create-invite').addEventListener('click', async () => {
      if (createBusy) return;
      createOperation ||= {clientOperationId:operationId(),label:$('invite-label').value}; createBusy = true; $('invite-label').readOnly = true; $('create-invite').disabled = true; notice('owner-error'); notice('owner-notice');
      try {
        const result = await api('/api/site-invites', createOperation);
        if (!result.invite?.id) throw Object.assign(new Error('UNCONFIRMED_RESPONSE'), {uncertain:true});
        createOperation = null;
        $('invite-label').value = '';
        if (/^[A-Za-z0-9_-]{43}$/.test(result.token || '') && result.linkRecoverable !== false) {
          $('created-link').value = `${location.origin}/join.html#invite=${result.token}`;
          $('created-expiry').textContent = `Expires ${date(result.invite.expiresAt)}. Share privately with one person.`;
          copied = false; notice('copy-status'); $('close-invite').textContent = 'Close without copying'; $('copy-invite').textContent = 'Copy invite link';
          $('invite-dialog').showModal(); $('copy-invite').focus();
        } else {
          notice('owner-notice', 'That invite was created, but its link was shown only once and can’t be recovered. Revoke the unused invite below, then create a new one.');
        }
      } catch (error) {
        if (error.uncertain || error.code === 'RATE_LIMITED') notice('owner-error', error.code === 'RATE_LIMITED' ? 'There have been too many attempts. Wait a little, then choose “Check same attempt” to check the original request safely.' : 'We couldn’t confirm creation. The invite may already exist. “Check same attempt” safely checks that request; it won’t create another link.');
        else { createOperation = null; notice('owner-error', messageFor(error)); }
      } finally {
        createBusy = false; $('invite-label').readOnly = Boolean(createOperation); $('create-invite').textContent = createOperation ? 'Check same attempt' : 'Create invite link +';
        try { renderInvites(await api('/api/site-invites')); } catch { $('create-invite').disabled = false; }
      }
    });
    async function revokeInvite(id, button) {
      if (button.disabled) return;
      const operation = revokeOperations.get(id) || {clientOperationId:operationId()}; revokeOperations.set(id, operation);
      button.disabled = true; notice('owner-error'); notice('owner-notice');
      try { await api(`/api/site-invites/${encodeURIComponent(id)}/revoke`, operation); revokeOperations.delete(id); notice('owner-notice', 'Invite revoked. Its link can no longer create an account.'); await loadOwner(); }
      catch (error) {
        if (!error.uncertain) revokeOperations.delete(id);
        notice('owner-error', error.uncertain ? 'We couldn’t confirm revocation. Refresh to check its status, or retry the same revoke request.' : messageFor(error)); button.disabled = false; button.textContent = error.uncertain ? 'Retry revoke' : 'Revoke';
      }
    }
    $('copy-invite').addEventListener('click', async () => {
      if (!$('created-link').value) return;
      try {
        await navigator.clipboard.writeText($('created-link').value); copied = true;
        $('copy-invite').textContent = 'Copied'; $('close-invite').textContent = 'Done'; notice('copy-status', 'Copied. Send this link privately to your friend.');
      } catch {
        $('created-link').focus(); $('created-link').select(); notice('copy-status', 'Copy the selected link using your browser’s Copy command before closing.');
      }
    });
    const clearDisplayedLink = () => { $('created-link').value = ''; $('created-expiry').textContent = ''; notice('copy-status'); };
    $('close-invite').addEventListener('click', () => { clearDisplayedLink(); $('invite-dialog').close(); });
    $('invite-dialog').addEventListener('cancel', clearDisplayedLink);
    document.querySelector('.dialog-close-form').addEventListener('submit', clearDisplayedLink);
    $('invite-dialog').addEventListener('close', () => {
      clearDisplayedLink();
      if (!copied) notice('owner-notice', 'Link closed. If you didn’t save it, revoke that invite and create a new one.');
      copied = false; $('create-invite').focus();
    });
    window.addEventListener('pagehide', () => {
      forgetInvite(); createOperation = null; revokeOperations.clear(); $('created-link').value = ''; if ($('invite-dialog').open) $('invite-dialog').close();
    });
    window.addEventListener('pageshow', event => {
      if (event.persisted) { hadFragment = false; showGuide('For your privacy, the invitation was cleared when you left. Reopen the original invite link to continue, or sign in to your account.'); }
    });
    start();
  }, {once:true});
})();
