import {IMAGE_ASSET_LIMITS, imageLibraryMetadata, normalizeImageAssetSetup, validateResolvedImageAsset} from './image-asset-schema.js';

const ownerOf = ctx => JSON.stringify([ctx.accountId, ctx.roomId]);
const scopeOf = ctx => JSON.stringify([ctx.accountId, ctx.roomId, ctx.roomEpoch]);
const copy = value => structuredClone(value);
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const rejectedCodes = new Set(['IMAGE_REVISION_CONFLICT', 'IMAGE_VERSION_CONFLICT', 'IMAGE_ARCHIVED', 'IMAGE_VERSION_LIMIT', 'IMAGE_ROOM_QUOTA', 'IMAGE_SETUP_UNCHANGED']);

/** A draft belongs to one account, room and asset. A save always owns one immutable operation. */
export function mountImageSetup({root, getContext, service, onBack, onCommitted, onStatus = () => {}}) {
  const drafts = new Map();
  let ctx = getContext(), scope = scopeOf(ctx), current = null, visible = false, disposed = false;
  let serial = 0, controller = null, previewController = null, previewSerial = 0, previewUrl = null, busy = false, composing = false;
  root.className = 'uil-draft uil-setup'; root.hidden = true; root.noValidate = true;
  const heading = element('h3', null, 'Edit image setup'); heading.tabIndex = -1;
  const identity = element('p', 'uil-note'), sourceLabel = element('p', 'uil-note'), revisionLabel = element('p', 'uil-note');
  const note = element('p', 'uil-note', 'Save creates a new depth and collision version of this PNG. Existing objects and an already selected placement keep their original setup. Choose a displayed version in the library to change new placement.');
  const previewBox = element('div', 'uil-preview'), image = element('img'), previewStatus = element('p', 'uil-note');
  image.alt = 'Original PNG for setup editing'; image.hidden = true; previewBox.append(image, previewStatus);
  const fields = element('fieldset', 'uil-fields'); fields.append(element('legend', null, 'Depth and collision setup'));
  function field(labelText, input, help) {
    input.setAttribute('aria-label', labelText);
    const label = element('label', 'uil-field'); label.append(element('span', null, labelText), input);
    if (help) label.append(element('small', null, help)); fields.append(label); return input;
  }
  const depth = field('Representation and depth', element('select'));
  for (const [value, text] of [['standing', 'Upright panel · standing'], ['floor', 'Floor decal · on the floor'], ['custom', 'Upright panel · custom depth']]) {
    const option = element('option', null, text); option.value = value; depth.append(option);
  }
  const pivot = field('Custom ground pivot', element('input'), '0 is the image top; 1 is the image bottom. This positions a flat panel, not mesh thickness.');
  pivot.type = 'number'; pivot.min = '0'; pivot.max = '1'; pivot.step = '.01';
  const floating = element('p', 'uil-note'); fields.append(floating);
  const collisions = field('Paint collision cells', element('input'), 'Only selected 32 × 32 pixel cells block movement.'); collisions.type = 'checkbox';
  const gridWrap = element('div', 'uil-grid-wrap'), grid = element('div', 'uil-grid');
  grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', 'Setup collision cells');
  gridWrap.append(element('p', 'uil-note', 'Use arrow keys to move between cells and Space to toggle. The full image still counts for edit-area boundaries.'), grid); fields.append(gridWrap);
  const message = element('p', 'uil-error'); message.setAttribute('role', 'alert'); message.hidden = true;
  const button = (text, className) => { const node = element('button', className, text); node.type = 'button'; return node; };
  const recovery = element('div', 'uil-recovery'), review = button('Review latest version'), check = button('Check version save status'), retry = button('Retry same version save');
  recovery.append(review, check, retry);
  const actions = element('div', 'uil-actions'), back = button('Back to library'), discard = button('Discard setup draft'), save = button('Save new version', 'uil-primary'); save.type = 'submit'; actions.append(back, discard, save);
  root.replaceChildren(heading, identity, sourceLabel, revisionLabel, note, previewBox, fields, message, recovery, actions);

  const key = (context, assetId) => JSON.stringify([ownerOf(context), assetId]);
  const allowed = capability => !!ctx.capabilities?.[capability];
  const live = (captured, run, draft, capability = 'canManage') => !disposed && scopeOf(getContext()) === captured && scope === captured && serial === run && current === draft && !!getContext().capabilities?.[capability];
  function say(text) { if (current) current.message = text; message.textContent = text; message.hidden = !text; }
  function releasePreview() {
    previewController?.abort(); previewSerial++; if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null; image.removeAttribute('src'); image.hidden = true; previewStatus.textContent = '';
  }
  function stop() {
    serial++; controller?.abort(); controller = null; busy = false;
    if (current?.pending) { current.pending.state = 'uncertain'; current.message = 'This version save may have completed. Check its status before trying again.'; }
    releasePreview();
  }
  function sync() {
    const fresh = getContext();
    if (scopeOf(fresh) !== scope || !!fresh.capabilities?.canManage !== allowed('canManage') || !!fresh.capabilities?.canRead !== allowed('canRead')) {
      stop(); const sameOwner = ownerOf(fresh) === ownerOf(ctx); ctx = fresh; scope = scopeOf(ctx);
      if (!sameOwner || !allowed('canRead')) { current = null; visible = false; root.hidden = true; }
      else if (current) current.needsReview = true;
      render(); return false;
    }
    ctx = fresh; return true;
  }
  function values() {
    const version = current.source.version;
    const normalized = normalizeImageAssetSetup({depthPreset: depth.value, depthPivot: depth.value === 'floor' ? .5 : depth.value === 'standing' ? 1 : pivot.value.trim() ? Number(pivot.value) : NaN, collisionGrid: collisions.checked ? current.grid : null}, version);
    return {depthPreset: normalized.depthPreset, depthPivot: normalized.depthPivot, collisionGrid: normalized.collisionGrid};
  }
  function remember() {
    if (!current || busy || current.pending) return;
    current.depthPreset = depth.value; current.depthPivot = pivot.value; current.collisions = collisions.checked;
  }
  function matchesBase(setup) {
    const version = current.base.version;
    return JSON.stringify(setup) === JSON.stringify({depthPreset: version.depthPreset, depthPivot: version.depthPivot, collisionGrid: version.collisionGrid});
  }
  function unchanged() {
    // Invalid input stays submittable so the form can explain the validation error.
    try { return !!current && matchesBase(values()); } catch { return false; }
  }
  function gate() {
    const locked = !current || !allowed('canManage') || busy || !!current.pending;
    fields.disabled = locked;
    collisions.disabled = locked || !!current?.source.version.floating || !!(current?.source.version.widthPixels % 32) || !!(current?.source.version.heightPixels % 32);
    save.disabled = locked || current.needsReview || current.base.status !== 'active' || unchanged();
    save.textContent = busy && current?.pending ? 'Saving new version…' : 'Save new version';
    review.hidden = !current || !!current.pending || !current.needsReview && current.base.status === 'active'; review.disabled = busy || !allowed('canManage');
    check.hidden = !current?.pending; check.disabled = busy || !allowed('canManage');
    retry.hidden = current?.pending?.state !== 'retryable'; retry.disabled = busy || !allowed('canManage');
    discard.disabled = !current || busy || !!current.pending || !allowed('canRead');
  }
  function renderGrid() {
    gridWrap.hidden = !current?.collisions || current.source.version.floating;
    grid.replaceChildren(); if (gridWrap.hidden) return;
    const rows = current.source.version.heightPixels / 32, cols = current.source.version.widthPixels / 32;
    if (!current.grid) current.grid = Array.from({length: rows}, () => Array(cols).fill(0));
    grid.style.gridTemplateColumns = `repeat(${cols}, var(--image-cell-size, 44px))`;
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      const cell = button(current.grid[row][col] ? 'Block' : 'Clear', 'uil-cell'); cell.tabIndex = !row && !col ? 0 : -1;
      cell.setAttribute('aria-label', `Collision row ${row + 1}, column ${col + 1}`); cell.setAttribute('aria-pressed', String(!!current.grid[row][col]));
      cell.onclick = () => {
        if (!sync() || !allowed('canManage') || busy || current.pending) return;
        current.grid[row][col] = 1 - current.grid[row][col]; cell.textContent = current.grid[row][col] ? 'Block' : 'Clear'; cell.setAttribute('aria-pressed', String(!!current.grid[row][col])); gate();
      };
      cell.onkeydown = event => {
        const direction = {ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0]}[event.key]; if (!direction) return;
        event.preventDefault(); const next = grid.children[Math.max(0, Math.min(rows - 1, row + direction[0])) * cols + Math.max(0, Math.min(cols - 1, col + direction[1]))]; cell.tabIndex = -1; next.tabIndex = 0; next.focus();
      }; grid.append(cell);
    }
  }
  function render() {
    if (!current) { gate(); return; }
    const {source, base} = current, version = source.version;
    identity.textContent = imageLibraryMetadata(base).name;
    sourceLabel.textContent = `Source version ${version.sequence} (${version.versionId}) · ${version.widthPixels} × ${version.heightPixels} px · same PNG`;
    revisionLabel.textContent = `Save base: version ${base.version.sequence} · library revision ${base.revision || 1} · ${base.status}${current.needsReview ? ' · review required' : ''}`;
    depth.value = current.depthPreset; pivot.value = current.depthPivot; pivot.parentElement.hidden = depth.value !== 'custom'; collisions.checked = current.collisions;
    floating.textContent = version.floating ? 'Floating placement is fixed for this image. Collision cells are unavailable.' : 'Nonfloating placement is fixed for this image. PNG bytes and dimensions stay unchanged.';
    say(current.message || ''); renderGrid(); gate();
  }
  async function loadPreview() {
    releasePreview(); if (!visible || !current || !allowed('canRead')) return;
    const captured = scope, draft = current, run = ++previewSerial; previewController = new AbortController(); previewStatus.textContent = 'Loading original PNG…';
    try {
      const value = await service.readImage({roomId: ctx.roomId, assetId: draft.source.definition.assetId, versionId: draft.source.version.versionId, signal: previewController.signal});
      if (disposed || run !== previewSerial || scopeOf(getContext()) !== captured || current !== draft || !visible || !getContext().capabilities?.canRead) return;
      const blob = value instanceof Blob ? value : new Blob([value.bytes], {type: value.mediaType});
      if (blob.type !== 'image/png' || !blob.size || blob.size > IMAGE_ASSET_LIMITS.maxBytes) throw new Error('Preview unavailable');
      previewUrl = URL.createObjectURL(blob); image.src = previewUrl; image.hidden = false; previewStatus.textContent = '';
    } catch { if (run === previewSerial && current === draft && scopeOf(getContext()) === captured) previewStatus.textContent = 'Preview unavailable. Your setup draft is preserved.'; }
  }
  function validateCurrent(raw) {
    const entry = validateResolvedImageAsset(raw);
    if (entry.definition.roomId !== ctx.roomId || entry.definition.assetId !== current.source.definition.assetId || !['active', 'archived'].includes(entry.status)) throw new Error('This image is unavailable in this room');
    return entry;
  }
  function observe(entries) {
    if (!sync() || !current) return;
    const entry = entries.find(item => item.definition.assetId === current.source.definition.assetId);
    if (!entry || (entry.revision || 1) > (current.base.revision || 1)) {
      current.needsReview = true;
      if (!current.pending) say('This image changed. Your setup draft is preserved. Review the latest version before saving.');
    }
    revisionLabel.textContent = `Save base: version ${current.base.version.sequence} · library revision ${current.base.revision || 1} · ${current.base.status}${current.needsReview ? ' · review required' : ''}`;
    gate();
  }
  async function reviewLatest() {
    if (!sync() || !current || current.pending || busy || !allowed('canManage')) return;
    const captured = scope, draft = current, run = ++serial; busy = true; controller = new AbortController(); gate();
    try {
      const results = await Promise.all(['active', 'archived'].map(status => service.list({roomId: ctx.roomId, status, query: '', signal: controller.signal})));
      if (!live(captured, run, draft)) return;
      const entry = results.flatMap(result => result.entries).filter(item => item.definition.assetId === draft.source.definition.assetId).sort((a, b) => (b.revision || 1) - (a.revision || 1))[0];
      if (!entry) throw new Error('This image is no longer available. Your setup draft is preserved.');
      const latest = validateCurrent(entry);
      if ((latest.revision || 1) < (draft.base.revision || 1)) throw new Error('The latest revision is still loading. Your setup draft is preserved.');
      draft.base = latest; draft.needsReview = latest.status !== 'active';
      say(latest.status === 'archived' ? 'This image is archived. Your setup draft is preserved. Restore it in the library, then review the latest version.' : `Reviewed version ${latest.version.sequence}, revision ${latest.revision || 1}. Your original setup draft is preserved. Save new version will apply it to this base.`);
      render();
    } catch (error) { if (live(captured, run, draft)) say(error.message); }
    finally { if (live(captured, run, draft)) { busy = false; gate(); } }
  }
  function complete(result, draft) {
    const entry = validateCurrent(result.entry); draft.pending = null;
    const published = result.published;
    const text = `Saved version ${published.sequence}. ${entry.status === 'archived' ? 'The image is now archived.' : `The library now displays version ${entry.version.sequence}. Choose its Place button to use it.`} Existing objects and an already selected placement are unchanged.`;
    drafts.delete(key(ctx, draft.source.definition.assetId)); current = null; visible = false; root.hidden = true; releasePreview();
    onStatus(text); onCommitted(entry, published); onBack();
  }
  async function send(operation) {
    const captured = scope, draft = current, run = ++serial; busy = true; controller = new AbortController(); draft.pending = operation; operation.state = 'pending'; say(''); gate();
    try {
      const result = await service.createVersion({...operation.args, signal: controller.signal});
      if (!live(captured, run, draft) || draft.pending !== operation) return;
      complete(result, draft);
    } catch (error) {
      if (!live(captured, run, draft) || draft.pending !== operation) return;
      if (rejectedCodes.has(error.code)) {
        draft.pending = null; draft.needsReview = error.code !== 'IMAGE_SETUP_UNCHANGED';
        say(`${error.message || 'This version could not be saved.'} Your setup draft is preserved.${draft.needsReview ? ' Review the latest version before saving again.' : ''}`);
      } else { operation.state = 'uncertain'; say('The version save response was interrupted. It may have completed. Check its status before retrying; your unchanged submission is preserved.'); }
    } finally { if (scope === captured && serial === run) { busy = false; gate(); } }
  }
  async function reconcile() {
    if (!sync() || !current?.pending || busy || !allowed('canManage')) return;
    const captured = scope, draft = current, operation = draft.pending, run = ++serial; busy = true; controller = new AbortController(); gate();
    try {
      const result = await service.reconcileVersion({roomId: operation.args.roomId, assetId: operation.args.assetId, operationId: operation.args.operationId, signal: controller.signal});
      if (!live(captured, run, draft) || draft.pending !== operation) return;
      if (result.status === 'committed') { complete(result, draft); return; }
      if (result.status !== 'not-found') throw new Error('Status is still unknown');
      operation.state = 'retryable'; say('No committed receipt was found yet; the original save may still finish. Retry sends the same setup, base revision and operation ID.');
    } catch { if (live(captured, run, draft)) say('Could not confirm version save status. Your unchanged submission is preserved. Check again before retrying.'); }
    finally { if (scope === captured && serial === run) { busy = false; gate(); } }
  }
  function show(raw) {
    sync(); if (!allowed('canManage') || !allowed('canRead')) return false;
    const entry = validateResolvedImageAsset(raw); if (entry.definition.roomId !== ctx.roomId || !['active', 'archived'].includes(entry.status)) return false;
    const draftKey = key(ctx, entry.definition.assetId);
    if (current && current !== drafts.get(draftKey)) stop();
    current = drafts.get(draftKey);
    if (!current) {
      current = {source: entry, base: entry, depthPreset: entry.version.depthPreset, depthPivot: String(entry.version.depthPivot), collisions: !!entry.version.collisionGrid, grid: copy(entry.version.collisionGrid), pending: null, needsReview: entry.status !== 'active', message: ''}; drafts.set(draftKey, current);
    } else if ((entry.revision || 1) > (current.base.revision || 1)) current.needsReview = true;
    visible = true; root.hidden = false; render(); loadPreview(); heading.focus(); return true;
  }
  function hide() { remember(); stop(); visible = false; root.hidden = true; }
  function resume() { sync(); if (visible && current) { root.hidden = false; render(); loadPreview(); heading.focus(); } }
  depth.onchange = () => { if (!sync()) return; remember(); pivot.parentElement.hidden = depth.value !== 'custom'; gate(); };
  pivot.oninput = () => { remember(); gate(); };
  collisions.onchange = () => { if (!sync()) return; remember(); renderGrid(); gate(); };
  back.onclick = () => { hide(); onBack(); };
  discard.onclick = () => {
    if (!sync() || !current || busy || current.pending || !allowed('canRead')) return;
    drafts.delete(key(ctx, current.source.definition.assetId)); stop(); current = null; visible = false; root.hidden = true;
    onStatus('Setup draft discarded. Saved versions are unchanged.'); onBack({refresh: false});
  };
  review.onclick = reviewLatest; check.onclick = reconcile;
  retry.onclick = () => { if (sync() && current?.pending?.state === 'retryable' && !busy && allowed('canManage')) send(current.pending); };
  root.onsubmit = event => {
    event.preventDefault(); if (composing || !sync() || !current || !allowed('canManage') || busy || current.pending || current.needsReview || current.base.status !== 'active') return;
    try { remember(); const setup = values(); if (matchesBase(setup)) return; send({state: 'pending', args: {roomId: ctx.roomId, assetId: current.source.definition.assetId, expectedVersionId: current.base.version.versionId, expectedRevision: current.base.revision || 1, setup: copy(setup), operationId: crypto.randomUUID()}}); }
    catch (error) { say(error.message); }
  };
  root.oncompositionstart = () => { composing = true; }; root.oncompositionend = () => { composing = false; };
  return Object.freeze({show, hide, resume, observe, attachRoom: sync, pause: () => { remember(); stop(); }, isVisible: () => visible, dispose: () => { disposed = true; stop(); drafts.clear(); current = null; root.replaceChildren(); }});
}
