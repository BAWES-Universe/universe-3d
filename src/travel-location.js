import {ENTRY_KEY_RE} from './arrivals.js';

const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function locationUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP(S) room link.');
  return url;
}
export function validateDestination(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.roomId !== 'string' || !ROOM_ID_RE.test(value.roomId)) throw new Error('Choose a valid destination room.');
  if (own(value, 'entry') && value.entry !== undefined &&
      (typeof value.entry !== 'string' || !ENTRY_KEY_RE.test(value.entry))) throw new Error('Choose a valid named arrival.');
  return {roomId: value.roomId, ...(value.entry !== undefined ? {entry: value.entry} : {})};
}
/** URL data selects a destination only. It cannot supply position or membership. */
export function readTravelLocation(value) {
  const url = locationUrl(value), params = url.searchParams;
  for (const name of ['room', 'entry', 'invite']) if (params.getAll(name).length > 1) throw new Error('This room link repeats a destination field.');
  const roomId = params.get('room'), entry = params.has('entry') ? params.get('entry') : undefined, invite = params.get('invite');
  if (roomId !== null && !ROOM_ID_RE.test(roomId)) throw new Error('This room link has an invalid room.');
  if (entry !== undefined && !ENTRY_KEY_RE.test(entry)) throw new Error('This room link has an invalid named arrival.');
  if (invite !== null && !ROOM_ID_RE.test(invite)) throw new Error('This invitation link is invalid.');
  return {roomId, entry, invite};
}
export function writeTravelLocation(value, destination) {
  const {roomId, entry} = validateDestination(destination), url = locationUrl(value);
  url.searchParams.set('room', roomId); url.searchParams.delete('invite');
  if (entry === undefined) url.searchParams.delete('entry'); else url.searchParams.set('entry', entry);
  return url.href;
}
/** Shared links omit unrelated queries, fragments and invitation capabilities. */
export function shareDestinationUrl(value, destination) {
  const url = locationUrl(value);
  return writeTravelLocation(new URL(url.pathname, url.origin).href, destination);
}
export function destinationKey(destination) {
  const value = validateDestination(destination);
  return JSON.stringify([value.roomId, value.entry ?? null]);
}
