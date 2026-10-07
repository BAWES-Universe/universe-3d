import {validateResolvedImageAsset} from './image-asset-schema.js';
import {resolveImagePlacement, imageAlphaHitTest} from './image-asset-geometry.js';

const abortError = () => Object.assign(new Error('Image load cancelled'), {name: 'AbortError'});
const sourceKey = asset => `${asset.definition.roomId}/${asset.definition.assetId}/${asset.version.versionId}/${asset.version.sha256}`;
const sameContext = (a, b) => a?.roomId === b?.roomId && Object.is(a?.roomEpoch, b?.roomEpoch) && Object.is(a?.authorityEpoch, b?.authorityEpoch) && a?.canRead === b?.canRead;
function contextCopy(value) {
  if (!value || ![value.roomEpoch, value.authorityEpoch].every(epoch => typeof epoch === 'string' || typeof epoch === 'number' && Number.isFinite(epoch)) || typeof value.roomId !== 'string' || value.roomEpoch === undefined || value.authorityEpoch === undefined || typeof value.canRead !== 'boolean') throw new TypeError('Image context requires roomId, roomEpoch, authorityEpoch and canRead');
  return Object.freeze({roomId: value.roomId, roomEpoch: value.roomEpoch, authorityEpoch: value.authorityEpoch, canRead: value.canRead});
}

/** Engine-independent lifecycle. Resolved definitions must come from the authorized server resolver.
 * Epochs are revocation fences, never credentials or authorization. The caller must update them
 * on room/source/session/authority change, even when the identity and room happen to match. */
export function createImageObjectView({resolved, instance, context, port, loadTexture, onState = () => {}}) {
  if (!port || typeof loadTexture !== 'function') throw new TypeError('A node port and texture loader are required');
  let asset, placement, ctx, source, node, resource = null, request = null, generation = 0, disposed = false, configurationError = null;
  let state = Object.freeze({status: 'initializing'}), ready = Promise.resolve(state);
  const emit = (status, error) => {
    state = Object.freeze({status, instanceId: placement.instanceId, assetRef: placement.assetRef, representation: placement.render.representation,
      label: status === 'ready' ? 'Image object' : status === 'loading' ? 'Loading image object' : status === 'revoked' ? 'Image access unavailable' : status === 'disposed' ? 'Image object removed' : 'Image unavailable; retry or select it from the object list',
      error: error ? Object.freeze({code: typeof error.code === 'string' ? error.code : 'IMAGE_LOAD_FAILED', message: String(error.message || 'Image could not be loaded')}) : null});
    port.setState(node, state); onState(state);
    return state;
  };
  const release = () => {
    generation++; request?.abort(); request = null;
    if (resource) { port.clearTexture(node); resource.dispose(); resource = null; }
  };
  const start = () => {
    release();
    if (!ctx.canRead || ctx.roomId !== asset.definition.roomId) { ready = Promise.resolve(emit('revoked')); return ready; }
    const epoch = generation, controller = new AbortController(), startedAsset = asset, startedContext = ctx;
    request = controller; emit('loading');
    // Acquire shared ownership before a replaced preview can release its lease.
    // The pool still defers network/decode work; ready/error delivery stays async.
    ready = (async () => {
      if (controller.signal.aborted) throw abortError();
      return loadTexture({resolved: startedAsset, placement, context: startedContext, signal: controller.signal});
    })().then(loaded => {
      if (disposed || epoch !== generation || controller.signal.aborted) { loaded?.dispose?.(); return state; }
      if (!loaded || typeof loaded.dispose !== 'function' || !loaded.texture || typeof loaded.isReady !== 'function' || !loaded.isReady() || (typeof loaded.hitTest !== 'function' && !loaded.alphaMask)) {
        loaded?.dispose?.(); throw Object.assign(new Error('Texture loader did not return a ready image with alpha picking'), {code: 'INVALID_IMAGE_RESOURCE'});
      }
      resource = loaded;
      try { port.setTexture(node, loaded.texture); } catch (error) { port.clearTexture(node); resource.dispose(); resource = null; throw error; }
      request = null; return emit('ready');
    }).catch(error => {
      if (disposed || epoch !== generation || controller.signal.aborted) return state;
      request = null; return emit('error', error);
    });
    return ready;
  };
  function update(next) {
    if (disposed) throw new Error('Image view is disposed');
    let nextAsset, nextPlacement, nextContext;
    try { nextContext = contextCopy(next.context); nextAsset = validateResolvedImageAsset(next.resolved); nextPlacement = resolveImagePlacement(nextAsset, next.instance); }
    catch (error) {
      if (!node) throw error;
      release(); configurationError = error; ready = Promise.resolve(emit('error', error)); return ready;
    }
    const changed = configurationError !== null || source !== sourceKey(nextAsset) || !sameContext(ctx, nextContext);
    configurationError = null;
    asset = nextAsset; placement = nextPlacement; ctx = nextContext; source = sourceKey(asset);
    if (!node) node = port.createNode(placement);
    else port.updatePlacement(node, placement);
    if (changed) return start();
    return ready;
  }
  const api = {
    get node() { return node; }, get ready() { return ready; }, get placement() { return placement; },
    getState: () => state,
    // This always survives fully transparent artwork, loading and load failures.
    getSelectionRecord: () => Object.freeze({id: placement.instanceId, type: 'image', assetRef: placement.assetRef, editBounds: placement.editBounds, renderBounds: placement.renderBounds, status: state.status, routes: placement.pickDescriptor.fallbackSelection}),
    acceptUV(uv) {
      if (disposed || state.status !== 'ready' || !resource || !uv || !Number.isFinite(uv.u) || !Number.isFinite(uv.v) || uv.u < 0 || uv.u > 1 || uv.v < 0 || uv.v > 1) return false;
      return (typeof resource.hitTest === 'function' ? resource.hitTest(uv) : imageAlphaHitTest(resource.alphaMask, uv)) === true;
    },
    update,
    retry() { if (disposed || configurationError) return Promise.resolve(state); return start(); },
    dispose() { if (disposed) return; disposed = true; release(); emit('disposed'); port.dispose(node); }
  };
  update({resolved, instance, context});
  return api;
}
