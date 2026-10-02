import {Mesh} from '@babylonjs/core/Meshes/mesh.js';
import {VertexData} from '@babylonjs/core/Meshes/mesh.vertexData.js';
import {TransformNode} from '@babylonjs/core/Meshes/transformNode.js';
import {CreateLines} from '@babylonjs/core/Meshes/Builders/linesBuilder.js';
import {Vector3} from '@babylonjs/core/Maths/math.vector.js';
import {Color3} from '@babylonjs/core/Maths/math.color.js';
import {StandardMaterial} from '@babylonjs/core/Materials/standardMaterial.js';
import {Material} from '@babylonjs/core/Materials/material.js';
import {Texture} from '@babylonjs/core/Materials/Textures/texture.js';
import '@babylonjs/core/Culling/ray.js';
import {imageAlphaHitTest} from './image-asset-geometry.js';
import {createImageObjectView} from './image-object-view.js';
import {createAuthenticatedImageLoader, createImageTexturePool, ImageAssetLoadError, imageAbortError} from './image-asset-loader.js';

const views = new WeakMap();
const checkAbort = signal => { if (signal?.aborted) throw imageAbortError(); };
const vector = point => new Vector3(point.x, point.y, point.z);

/** The only geometry inputs are the authoritative shared resolved plane and extent. */
export function createBabylonImagePort(scene) {
  function place(node, placement) {
    const {mesh, material} = node.imageParts, data = new VertexData();
    data.positions = placement.render.worldCorners.flatMap(point => [point.x, point.y, point.z]);
    data.uvs = placement.render.uv.flatMap(uv => [uv.u, uv.v]);
    data.indices = [0, 1, 2, 0, 2, 3]; data.normals = [];
    VertexData.ComputeNormals(data.positions, data.indices, data.normals); data.applyToMesh(mesh, true);
    node.metadata = {id: placement.instanceId, type: 'object', kind: 'image', assetRef: placement.assetRef, imageObject: true, dynamic: true};
    mesh.metadata = node.metadata; mesh.computeWorldMatrix(true); mesh.refreshBoundingInfo();
    material.alphaCutOff = placement.render.alphaCutoff;
    node.imageParts.outline?.dispose();
    const corners = placement.editBounds.corners.map(point => new Vector3(point.x, .025, point.z));
    const outline = CreateLines(`image-status-${placement.instanceId}`, {points: [...corners, corners[0]]}, scene);
    outline.parent = node; outline.isPickable = false; outline.metadata = {...node.metadata, type: 'image-status'};
    node.imageParts.outline = outline;
    if (node.imageParts.state) setState(node, node.imageParts.state);
  }
  function setState(node, state) {
    const {mesh, outline} = node.imageParts; node.imageParts.state = state;
    if (node.isDisposed()) return;
    mesh.setEnabled(state.status === 'ready'); mesh.isPickable = state.status === 'ready';
    outline.setEnabled(['loading', 'error', 'revoked'].includes(state.status));
    outline.color = state.status === 'loading' ? Color3.FromHexString('#e9bf66') : Color3.FromHexString('#ed7474');
    mesh.metadata.imageStatus = state.status; outline.metadata.imageStatus = state.status;
  }
  return {
    createNode(placement) {
      const node = new TransformNode(`image-object-${placement.instanceId}`, scene), mesh = new Mesh(`image-plane-${placement.instanceId}`, scene), material = new StandardMaterial(`image-material-${placement.instanceId}`, scene);
      mesh.parent = node; mesh.material = material; mesh.setEnabled(false); mesh.isPickable = false;
      material.diffuseColor = Color3.White(); material.emissiveColor = Color3.White(); material.specularColor = Color3.Black(); material.disableLighting = true;
      material.backFaceCulling = false; material.twoSidedLighting = true; material.transparencyMode = Material.MATERIAL_ALPHATEST; material.useAlphaFromDiffuseTexture = true;
      material.disableDepthWrite = false; material.forceDepthWrite = false; material.alpha = 1;
      // Leave renderingGroupId/depthFunction at Babylon defaults: native opaque/alpha-test depth.
      node.imageParts = {mesh, material, outline: null, state: null}; place(node, placement); return node;
    },
    updatePlacement: place, setState,
    setTexture(node, texture) { node.imageParts.material.diffuseTexture = texture; },
    clearTexture(node) { node.imageParts.material.diffuseTexture = null; node.imageParts.mesh.setEnabled(false); node.imageParts.mesh.isPickable = false; },
    dispose(node) { views.delete(node.imageParts.mesh); node.imageParts.material.diffuseTexture = null; node.imageParts.material.dispose(false, false); if (!node.isDisposed()) node.dispose(false, false); }
  };
}

/** PNG decode and bounded one-time alpha readback. Full-resolution alpha is <=4MiB
 * under the shared server pixel cap. Picking reads cached bytes and calls the shared cutoff test. */
export async function decodeBabylonImageTexture(scene, {bytes, resolved, signal}) {
  checkAbort(signal);
  const blob = new Blob([bytes], {type: 'image/png'}); let bitmap = null, texture = null, objectURL = null, alpha = null, disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; texture?.dispose(); texture = null; alpha = null; bitmap?.close(); bitmap = null; if (objectURL) URL.revokeObjectURL(objectURL); objectURL = null; };
  try {
    bitmap = await createImageBitmap(blob, {premultiplyAlpha: 'none', colorSpaceConversion: 'none'}); checkAbort(signal);
    const width = bitmap.width, height = bitmap.height;
    if (width !== resolved.version.widthPixels || height !== resolved.version.heightPixels) throw new ImageAssetLoadError('IMAGE_DIMENSION_MISMATCH', 'Decoded image dimensions do not match the pinned version');
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', {willReadFrequently: true}); if (!context) throw new ImageAssetLoadError('IMAGE_ALPHA_UNAVAILABLE', 'Image alpha could not be read');
    context.drawImage(bitmap, 0, 0); const rgba = context.getImageData(0, 0, width, height).data;
    alpha = new Uint8Array(width * height); for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
    canvas.width = canvas.height = 0; bitmap.close(); bitmap = null; checkAbort(signal);
    objectURL = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
      let settled = false;
      const complete = error => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
      const abort = () => { texture?.dispose(); complete(imageAbortError()); };
      signal?.addEventListener('abort', abort, {once: true});
      texture = new Texture(objectURL, scene, {noMipmap: true, invertY: false, samplingMode: Texture.NEAREST_SAMPLINGMODE, onLoad: () => complete(), onError: () => complete(new ImageAssetLoadError('IMAGE_GPU_UPLOAD_FAILED', 'Image texture upload failed')), mimeType: 'image/png'});
      if (signal?.aborted) abort();
    });
    checkAbort(signal); URL.revokeObjectURL(objectURL); objectURL = null;
    texture.hasAlpha = true; texture.wrapU = Texture.CLAMP_ADDRESSMODE; texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    if (!texture.isReady()) throw new ImageAssetLoadError('IMAGE_GPU_UPLOAD_FAILED', 'Image texture is not ready');
    return {texture, isReady: () => !disposed && texture?.isReady() === true,
      hitTest({u, v}) {
        if (!alpha || !Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) return false;
        const x = Math.min(width - 1, Math.floor(u * width)), y = Math.min(height - 1, Math.floor(v * height));
        return imageAlphaHitTest({width: 1, height: 1, alpha: [alpha[y * width + x]]}, {u: 0, v: 0});
      }, dispose};
  } catch (error) { dispose(); throw error; }
}

/** Construct once per scene; pass the pool to every placed instance. */
export function createBabylonImageTexturePool(scene, options = {}) {
  const {maxResidentPixels, maxResidentBytes, ...loaderOptions} = options;
  const loadTexture = createAuthenticatedImageLoader({...loaderOptions, decodeTexture: args => decodeBabylonImageTexture(scene, args)});
  const pool = createImageTexturePool({loadTexture, maxResidentPixels, maxResidentBytes});
  scene.onDisposeObservable.addOnce(() => pool.dispose());
  return pool;
}
export function createBabylonImageObjectView({scene, texturePool, loadTexture, ...options}) {
  if (!texturePool && !loadTexture) throw new TypeError('Use one shared scene texturePool or an explicit test loader');
  const view = createImageObjectView({...options, port: createBabylonImagePort(scene), loadTexture: loadTexture || texturePool.acquire});
  views.set(view.node.imageParts.mesh, view);
  view.node.onDisposeObservable.addOnce(() => view.dispose());
  return view;
}
/** Use this in place of the first-hit scene.pick for the native scene ray. Transparent
 * source pixels pass to other image objects, ordinary items, then native ground. */
export function pickWithImageAlpha(scene, ray, predicate = mesh => mesh.isPickable) {
  const hits = scene.multiPickWithRay(ray, mesh => mesh.isPickable && mesh.isEnabled() && predicate(mesh)) || [];
  hits.sort((a, b) => a.distance - b.distance);
  for (const hit of hits) {
    const view = views.get(hit.pickedMesh);
    if (!view) return hit;
    const uv = hit.getTextureCoordinates();
    if (uv && view.acceptUV({u: uv.x, v: uv.y})) return hit;
  }
  return null;
}
