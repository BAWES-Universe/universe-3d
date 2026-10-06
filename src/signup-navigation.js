import {readTravelLocation} from './travel-location.js';

// Carry only the existing destination fields. Never accept a return URL, path,
// position, role or arbitrary query. Fragments stay out of HTTP/referrer logs
// and keep /signup.html compatible with the strict setup/navigation allowlist.
function destinationParams(value) {
  const destination=readTravelLocation(value),params=new URLSearchParams();
  if(destination.roomId!==null)params.set('room',destination.roomId);
  if(destination.entry!==undefined)params.set('entry',destination.entry);
  if(destination.invite!==null)params.set('invite',destination.invite);
  return params;
}
export function signupLink(value) {
  try { const hash=destinationParams(value).toString();return '/signup.html'+(hash?'#'+hash:''); }
  catch { return '/signup.html'; }
}
export function signupDestination(value) {
  try {
    const url=new URL(value),hash=url.hash.slice(1);
    if(!['http:','https:'].includes(url.protocol))return '/';
    const params=destinationParams(new URL('/?'+hash,url.origin).href).toString();
    return '/'+(params?'?'+params:'');
  } catch { return '/'; }
}
export function signupStartsWithSignin(value) {
  const hash=new URL(value).hash.slice(1);
  return hash==='signin'||new URLSearchParams(hash).get('view')==='signin';
}
export function signupViewLink(value,signin) {
  const url=new URL(value),destination=new URL(signupDestination(value),url.origin);
  const params=destination.searchParams;
  if(signin)params.set('view','signin');
  return '/signup.html'+(params.size?'#'+params.toString():'');
}
