import './public-guest-entry.css';

// Public exploration starts with an action, not a mandatory-looking profile.
// Existing controls/listeners are moved intact; local and sign-in forms retain
// their original behavior, and applying policy twice cannot duplicate controls.
export function configurePublicGuestEntry(policy,root=globalThis.document?.getElementById('welcome')){
 if(!policy?.publicGuests||!root||root.classList.contains('public-guest-entry'))return false;
 const doc=root.ownerDocument,form=root.querySelector('#join-form'),button=root.querySelector('#join-button'),name=root.querySelector('#display-name'),choices=root.querySelector('.woka-picker'),error=root.querySelector('#join-error');
 if(!form||!button||!name||!choices||!error)return false;
 root.classList.add('public-guest-entry');
 name.required=false;name.placeholder='Guest';name.previousElementSibling.textContent='Your name (optional)';
 button.textContent='Explore as guest →';
 root.querySelector('#show-login').textContent='Sign in to an existing account';
 root.querySelector('.welcome-card > p:not(.session-note)').textContent='No account needed. Look around, walk, jump or take a seat.';
 root.querySelector('.session-note').textContent='Guest visits last up to 24 hours. An account lets you save and create.';
 const options=doc.createElement('details'),summary=doc.createElement('summary');options.id='guest-entry-options';options.className='guest-entry-options';summary.className='small-btn guest-entry-summary';summary.tabIndex=0;summary.textContent='Name and character (optional)';options.append(summary,name.closest('.field'),choices);
 form.prepend(button);button.after(error);error.after(options);
 return true;
}
