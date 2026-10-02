import {validateAppearance} from '../src/avatar-spec.js';
import {safeActionUrl,validateActions} from '../src/action-schema.js';
import {validateImageInstance,canUseImageReference} from '../src/image-asset-schema.js';
import {imagePlacementInside} from '../src/image-asset-geometry.js';
export class HttpError extends Error {
  constructor(status, code, message = code, details = {}) { super(message); this.status = status; this.code = code; this.details = details; }
}
export const fail = (status, code, message, details) => { throw new HttpError(status, code, message, details); };
export function record(value, label = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'INVALID_INPUT', `${label} must be an object`);
  return value;
}
export function text(value, label, max = 80, { empty = false } = {}) {
  if (typeof value !== 'string') fail(400, 'INVALID_INPUT', `${label} must be text`);
  const result = value.trim();
  if ((!empty && !result) || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) fail(400, 'INVALID_INPUT', `${label} must be ${empty ? '0' : '1'}–${max} characters`);
  return result;
}
export function finite(value, label, min = -10000, max = 10000) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(400, 'INVALID_INPUT', `${label} must be a number between ${min} and ${max}`);
  return value;
}
export function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  finite(value, label, min, max); if (!Number.isInteger(value)) fail(400, 'INVALID_INPUT', `${label} must be an integer`); return value;
}
export function oneOf(value, values, label) { if (!values.includes(value)) fail(400, 'INVALID_INPUT', `${label} must be one of ${values.join(', ')}`); return value; }
export const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
export function id(value, label = 'id') { if (typeof value !== 'string' || !ID_RE.test(value)) fail(400, 'INVALID_INPUT', `Invalid ${label}`); return value; }
export function boolean(value, label) { if (typeof value !== 'boolean') fail(400, 'INVALID_INPUT', `${label} must be true or false`); return value; }
export function safeJson(value, { maxBytes = 512000, maxDepth = 14 } = {}) {
  let count = 0;
  function walk(v, depth) {
    if (++count > 40000 || depth > maxDepth) fail(400, 'INVALID_INPUT', 'Data structure is too complex');
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'number') { finite(v, 'number', -1e9, 1e9); return; }
    if (typeof v === 'string') {
      if (v.length > 20000 || /[\u0000\u0008]/.test(v)) fail(400, 'INVALID_INPUT', 'Invalid string');
      return;
    }
    if (typeof v !== 'object') fail(400, 'INVALID_INPUT', 'Only JSON data is accepted');
    if (Array.isArray(v)) { if (v.length > 5000) fail(400, 'INVALID_INPUT', 'Array is too long'); for (const item of v) walk(item, depth + 1); return; }
    for (const [key, item] of Object.entries(v)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail(400, 'INVALID_INPUT', 'Unsafe object key');
      if (/(?:url|href|src)$/i.test(key) && typeof item === 'string' && item && !/^(?:https?:\/\/|\/[^/])/.test(item)) fail(400, 'INVALID_URL', 'Only HTTP(S) or local asset URLs are accepted');
      walk(item, depth + 1);
    }
  }
  walk(value, 0);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > maxBytes) fail(413, 'TOO_LARGE', 'Data is too large');
  return encoded;
}
function actions(value,scope='area'){try{validateActions(value,{scope});}catch(error){fail(400,'INVALID_SCENE',error.message);}}
function interactionUrl(value){if(value!==undefined&&value!==''&&!safeActionUrl(value))fail(400,'INVALID_URL','Use a safe HTTP(S), local asset, or protected room document URL without credentials');}
export function scene(value,imageDefinitions={}) {
  record(value, 'scene');
  for(const key of ['imageDefinitions','imageAssets','assetDefinitions','imageLibrary'])if(Object.hasOwn(value,key))fail(400,'SERVER_OWNED_FIELD','Image definitions are a server-resolved room projection, not scene data');
  if (!Array.isArray(value.objects) || value.objects.length > 2000) fail(400, 'INVALID_SCENE', 'scene.objects must contain at most 2000 objects');
  record(value.bounds, 'scene.bounds');
  finite(value.bounds.width, 'bounds.width', 8, 200); finite(value.bounds.depth, 'bounds.depth', 8, 200);
  record(value.spawn, 'scene.spawn'); finite(value.spawn.x, 'spawn.x', -value.bounds.width/2, value.bounds.width/2); finite(value.spawn.z, 'spawn.z', -value.bounds.depth/2, value.bounds.depth/2);
  if (value.theme !== undefined) text(value.theme, 'theme', 40);
  const types = ['table','chair','sofa','plant','tree','wall','lamp','screen','podium','portal','rug','board','bench','rock','image'];
  const seen = new Set();
  for (const object of value.objects) {
    record(object, 'object'); id(object.id, 'object id'); oneOf(object.type, types, 'object type');
    if(object.type==='image'){
      try{
        const image=validateImageInstance(object),key=`${image.assetRef.assetId}:${image.assetRef.versionId}`;
        const definition=Object.hasOwn(imageDefinitions,key)?imageDefinitions[key]:null;
        if(!canUseImageReference(image.assetRef,definition))fail(400,'IMAGE_REFERENCE_UNAVAILABLE','Use an existing image version from this room');
        if(!imagePlacementInside({x:0,z:0,...value.bounds},definition,image))fail(400,'IMAGE_OUTSIDE_ROOM','Keep the entire image footprint inside the room');
      }catch(error){if(error.status)throw error;fail(400,error.code??'INVALID_SCENE',error.message);}
    }
    finite(object.x, 'object.x', -value.bounds.width/2, value.bounds.width/2); finite(object.z, 'object.z', -value.bounds.depth/2, value.bounds.depth/2);
    if(object.name !== undefined) text(object.name, 'object name', 120);
    if(object.color !== undefined && (typeof object.color !== 'string' || !/^#[0-9a-f]{3,8}$/i.test(object.color))) fail(400, 'INVALID_SCENE', 'Use a hex object color');
    interactionUrl(object.url);if(object.actions!==undefined)actions(object.actions,'item');
    if(object.text!==undefined)text(object.text,'object description',2000,{empty:true});
    if(object.target !== undefined && object.target !== '') id(object.target, 'portal target');
    if (seen.has(object.id)) fail(400, 'INVALID_SCENE', 'Object IDs must be unique'); seen.add(object.id);
    for (const key of ['x','y','z','rotation','rotationY']) if (object[key] !== undefined) finite(object[key], key);
    for (const key of ['width','height','depth','scale']) if (typeof object[key] === 'number') finite(object[key], key, 0.01, 500);
  }
  if (value.areas !== undefined && (!Array.isArray(value.areas) || value.areas.length > 100)) fail(400, 'INVALID_SCENE', 'scene.areas must contain at most 100 areas');
  const areaIds = new Set();
  for(const area of value.areas || []) {
    record(area, 'area'); id(area.id, 'area id'); if(areaIds.has(area.id)) fail(400, 'INVALID_SCENE', 'Area IDs must be unique'); areaIds.add(area.id);
    text(area.name, 'area name', 120); oneOf(area.action, ['welcome','silent','meeting','stage','audience','teleport','link'], 'area action');
    finite(area.x, 'area.x', -value.bounds.width/2, value.bounds.width/2); finite(area.z, 'area.z', -value.bounds.depth/2, value.bounds.depth/2);
    finite(area.width, 'area.width', 0.5, value.bounds.width); finite(area.depth, 'area.depth', 0.5, value.bounds.depth);
    if(area.target !== undefined && area.target !== '') id(area.target, 'area target');
    interactionUrl(area.url);if(area.actions!==undefined)actions(area.actions);
    if(area.message!==undefined)text(area.message,'area message',2000,{empty:true});
  }
  return safeJson(value);
}
export function woka(value) {
  if(value&&typeof value==='object'&&['version','catalog','hairStyle','topStyle'].some(key=>Object.hasOwn(value,key)))return JSON.stringify(validateAppearance(value));
  if (typeof value === 'number') return JSON.stringify(integer(value, 'woka', 0, 31));
  if (typeof value === 'string') return JSON.stringify(text(value, 'woka', 80));
  record(value, 'woka');
  return safeJson(value, { maxBytes: 4096, maxDepth: 4 });
}
