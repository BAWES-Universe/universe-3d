import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const hashId = (prefix, identity) => prefix + createHash('sha256').update(identity).digest('hex').slice(0, 20);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const safePath = value => typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.split('/').some(p => p === '..' || p === '.');
function registry(rows, label) {
  assert(Array.isArray(rows), `${label} must be an array`);
  const result = new Map();
  for (const row of rows) {
    assert(row && typeof row.id === 'string' && row.id.length > 0, `${label} missing id`);
    assert(!result.has(row.id), `${label} duplicate id: ${row.id}`);
    result.set(row.id, row);
  }
  return result;
}
export function validateParity(data) {
  assert(data.schema_version === '2.0.0', 'unsupported schema version');
  assert(Number.isSafeInteger(data.inventory_revision) && data.inventory_revision > 0, 'invalid inventory revision');
  const statuses = new Set(['partial', 'missing', 'blocked', 'needs-review']);
  assert(Object.keys(data.status_definitions).length === statuses.size && Object.keys(data.status_definitions).every(x => statuses.has(x)), 'status enum mismatch');
  assert(data.certification.whole_contracts_certified === 0, 'whole-contract certification must remain zero');
  assert(data.certification.legacy_counts_reused === false, 'legacy counts must not be reused');
  const pins = registry(data.source_pins, 'source pins');
  for (const pin of pins.values()) assert(sha(pin.ref), `source pin must be exact: ${pin.id}`);
  const sources = registry(data.sources, 'sources');
  for (const source of sources.values()) {
    if (source.kind === 'git-file') {
      const pin = pins.get(source.source_pin);
      assert(pin && source.repository === pin.repository && source.ref === pin.ref, `source pin mismatch: ${source.id}`);
      assert(safePath(source.path) && sha(source.git_blob_sha), `invalid source path/blob: ${source.id}`);
      assert(source.id === hashId('src_', `${source.repository}@${source.ref}:${source.path}`), `source identity mismatch: ${source.id}`);
      assert(source.url === `https://github.com/${source.repository}/blob/${source.ref}/${source.path}`, `source URL mismatch: ${source.id}`);
    } else if (source.kind === 'issue-snapshot') {
      assert(Number.isSafeInteger(source.number) && source.number > 0 && Number.isFinite(Date.parse(source.updated_at)), `invalid issue snapshot: ${source.id}`);
      assert(/^[a-f0-9]{64}$/.test(source.body_sha256), `missing issue body digest: ${source.id}`);
      assert(source.id === hashId('src_', `${source.repository}#${source.number}@${source.updated_at}:${source.body_sha256}`), `issue identity mismatch: ${source.id}`);
      assert(source.url === `https://github.com/${source.repository}/issues/${source.number}`, `issue URL mismatch: ${source.id}`);
      assert(source.classification === 'proposal-snapshot-not-default-runtime', `issue classification mismatch: ${source.id}`);
    } else throw new Error(`unsupported source kind: ${source.kind}`);
  }
  const evidence = registry(data.candidate_evidence, 'candidate evidence');
  for (const e of evidence.values()) {
    assert(sha(e.candidate_ref) && safePath(e.path), `invalid evidence ref/path: ${e.id}`);
    assert(e.id === hashId('ev_', `${e.repository}@${e.candidate_ref}:${e.path}`), `evidence identity mismatch: ${e.id}`);
    assert(e.url === `https://github.com/${e.repository}/blob/${e.candidate_ref}/${e.path}`, `evidence URL mismatch: ${e.id}`);
  }
  function sourceRef(ref) {
    assert(sources.has(ref.source_id), `dangling source: ${ref.source_id}`);
    if (ref.lines) assert(ref.lines.length === 2 && ref.lines.every(Number.isSafeInteger) && ref.lines[0] > 0 && ref.lines[1] >= ref.lines[0], `invalid line range: ${ref.source_id}`);
  }
  function evidenceRef(ref) { assert(evidence.has(ref.evidence_id), `dangling evidence: ${ref.evidence_id}`); }
  const requirements = registry(data.requirements, 'requirements');
  for (const row of requirements.values()) {
    assert(/^U3D-PAR-[A-Z0-9-]+$/.test(row.id), `invalid requirement id: ${row.id}`);
    assert(statuses.has(row.status), `invalid requirement status: ${row.id}`);
    assert(row.certified_whole_contract === false, `nonzero certification: ${row.id}`);
    assert(Array.isArray(row.acceptance_clauses) && row.acceptance_clauses.length && row.acceptance_clauses.every(s => typeof s === 'string' && s.trim()), `missing clauses: ${row.id}`);
    row.source_refs.forEach(sourceRef);
    row.candidate.code.forEach(evidenceRef);
    row.candidate.tests.forEach(evidenceRef);
    row.legacy_aliases.forEach(alias => evidenceRef(alias.basis));
    assert(Array.isArray(row.candidate.remaining) && row.candidate.remaining.length > 0, `missing remaining boundary: ${row.id}`);
  }
  for (const conflict of data.unresolved_contradictions) (conflict.source_refs || []).forEach(sourceRef);
  return { requirements: requirements.size, sources: sources.size, candidateEvidence: evidence.size, wholeContractsCertified: 0 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2] || fileURLToPath(new URL('../PARITY-INVENTORY.json', import.meta.url));
  const result = validateParity(JSON.parse(readFileSync(path, 'utf8')));
  process.stdout.write(`Parity inventory valid: ${JSON.stringify(result)}\n`);
}
