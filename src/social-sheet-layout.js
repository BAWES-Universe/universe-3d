/** Local presentation only. Never changes channel state or captures timeline gestures. */
export function mountSocialSheet(root, handle) {
  const compact = matchMedia('(max-width: 700px), (max-height: 540px)');
  const portrait = () => innerWidth <= 700 && innerHeight > 540;
  let preferred = null, gesture = null, disposed = false;
  const viewport = window.visualViewport;
  function bounds() {
    const height = Math.min(innerHeight, viewport?.height ?? innerHeight);
    const keyboard = innerHeight - height > 120;
    const bottom = keyboard || !portrait() ? 0 : 80;
    return {height, top: viewport?.offsetTop || 0, bottom, max: Math.max(0, height - bottom - (portrait() ? 8 : 0))};
  }
  function sync() {
    if (disposed) return;
    const b = bounds(), min = Math.min(340, b.max);
    handle.hidden = !portrait();
    if (!compact.matches) {
      for (const name of ['--social-sheet-height','--social-sheet-top','--social-sheet-bottom']) root.style.removeProperty(name);
      return;
    }
    const height = portrait() ? Math.max(min, Math.min(b.max, preferred ?? b.max * .88)) : b.max;
    root.style.setProperty('--social-sheet-height', `${height}px`);
    root.style.setProperty('--social-sheet-top', `${b.top + b.height - b.bottom - height}px`);
    root.style.setProperty('--social-sheet-bottom', `${innerHeight - b.top - b.height + b.bottom}px`);
    handle.setAttribute('aria-valuemin', String(Math.round(min)));
    handle.setAttribute('aria-valuemax', String(Math.round(b.max)));
    handle.setAttribute('aria-valuenow', String(Math.round(height)));
    handle.setAttribute('aria-valuetext', `${Math.round(height)} pixels tall. Up to expand, Down to reduce.`);
  }
  function finish(cancel = false) {
    if (!gesture) return;
    const old = gesture; gesture = null;
    if (cancel) preferred = old.previous;
    if (handle.hasPointerCapture(old.id)) handle.releasePointerCapture(old.id);
    delete root.dataset.sheetResizing;
    sync();
  }
  const down = event => {
    if (gesture || !portrait() || root.hidden || root.inert || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    handle.focus({preventScroll:true});
    gesture = {id:event.pointerId, y:event.clientY, height:root.getBoundingClientRect().height, previous:preferred};
    root.dataset.sheetResizing = 'true'; handle.setPointerCapture(event.pointerId);
  };
  const move = event => {
    if (!gesture || event.pointerId !== gesture.id) return;
    event.preventDefault(); event.stopPropagation();
    const max = bounds().max;
    preferred = Math.max(Math.min(340,max), Math.min(max, gesture.height + gesture.y - event.clientY)); sync();
  };
  const up = event => { if (event.pointerId === gesture?.id) {event.stopPropagation(); finish();} };
  const cancel = () => finish(true);
  const key = event => {
    if (event.key === 'Escape' && gesture) {event.preventDefault(); event.stopPropagation(); cancel(); return;}
    if (!['ArrowUp','ArrowDown','Home','End'].includes(event.key) || !portrait()) return;
    event.preventDefault(); event.stopPropagation();
    const max = bounds().max;
    preferred = event.key === 'Home' ? Math.min(340,max) : event.key === 'End' ? max : Math.max(Math.min(340,max),Math.min(max,root.getBoundingClientRect().height + (event.key === 'ArrowUp' ? 48 : -48)));
    sync();
  };
  const resized = () => { cancel(); sync(); };
  const hidden = () => { if (document.hidden || root.hidden || root.inert) cancel(); };
  const observer = new MutationObserver(hidden);
  observer.observe(root,{attributes:true,attributeFilter:['hidden','inert']});
  handle.addEventListener('pointerdown',down); handle.addEventListener('pointermove',move);
  handle.addEventListener('pointerup',up); handle.addEventListener('pointercancel',cancel);
  handle.addEventListener('lostpointercapture',cancel); handle.addEventListener('keydown',key);
  window.addEventListener('blur',cancel); window.addEventListener('resize',resized);
  document.addEventListener('visibilitychange',hidden); viewport?.addEventListener('resize',resized); viewport?.addEventListener('scroll',resized);
  sync();
  return {cancel:()=>{const active=!!gesture;cancel();return active;}, destroy(){
    cancel(); disposed=true; observer.disconnect();
    handle.removeEventListener('pointerdown',down); handle.removeEventListener('pointermove',move);
    handle.removeEventListener('pointerup',up); handle.removeEventListener('pointercancel',cancel);
    handle.removeEventListener('lostpointercapture',cancel); handle.removeEventListener('keydown',key);
    window.removeEventListener('blur',cancel); window.removeEventListener('resize',resized);
    document.removeEventListener('visibilitychange',hidden); viewport?.removeEventListener('resize',resized); viewport?.removeEventListener('scroll',resized);
    for(const name of ['--social-sheet-height','--social-sheet-top','--social-sheet-bottom']) root.style.removeProperty(name);
  }};
}
