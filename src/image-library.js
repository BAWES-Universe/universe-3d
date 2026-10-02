import {ImageAssetValidationError, freezeImageRecord, validateResolvedImageAsset} from './image-asset-schema.js';

/** Custom-only library: stable input ordering, AND-token matching, no deduplication by display name. */
export function searchImageLibrary(entries, {query = '', category = 'custom'} = {}) {
  if (!Array.isArray(entries) || entries.length > 10000) throw new ImageAssetValidationError('entries', 'Library entries must be a bounded array');
  if (typeof query !== 'string' || query.length > 1024) throw new ImageAssetValidationError('query', 'Search query must be text of at most 1024 characters');
  if (!['custom', 'all'].includes(category)) return Object.freeze([]);
  const tokens = query.normalize('NFC').toLowerCase().trim().split(/\s+/u).filter(Boolean);
  const result = [];
  for (const entry of entries) {
    const normalized = validateResolvedImageAsset(entry);
    if (normalized.status !== 'active') continue;
    const fields = [normalized.version.name, ...normalized.version.tags].map(value => value.toLowerCase());
    if (tokens.every(token => fields.some(field => field.includes(token)))) result.push(normalized);
  }
  return freezeImageRecord(result);
}
