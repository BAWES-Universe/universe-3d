import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateParity } from '../scripts/validate-parity.mjs';
const read = () => JSON.parse(readFileSync(new URL('../PARITY-INVENTORY.json', import.meta.url), 'utf8'));
test('normalized parity inventory has exact identities and zero certification', () => {
  const data = read(), report = validateParity(data);
  assert.equal(report.requirements, data.requirements.length);
  assert.equal(report.wholeContractsCertified, 0);
});
for (const [label, mutate] of [
  ['duplicate requirement ID', d => d.requirements.push(structuredClone(d.requirements[0]))],
  ['duplicate source ID', d => d.sources.push(structuredClone(d.sources[0]))],
  ['duplicate evidence ID', d => d.candidate_evidence.push(structuredClone(d.candidate_evidence[0]))],
  ['dangling source', d => d.requirements[0].source_refs.push({source_id:'missing'})],
  ['dangling evidence', d => d.requirements[0].candidate.code.push({evidence_id:'missing'})],
  ['unknown status', d => {d.requirements[0].status='complete';}],
  ['row certification', d => {d.requirements[0].certified_whole_contract=true;}],
  ['aggregate certification', d => {d.certification.whole_contracts_certified=1;}],
  ['retargeted source pin', d => {d.sources.find(s => s.kind==='git-file').ref='a'.repeat(40);}],
  ['retargeted evidence pin', d => {d.candidate_evidence[0].candidate_ref='a'.repeat(40);}],
  ['unsafe source path', d => {d.sources.find(s => s.kind==='git-file').path='../secret';}],
  ['invalid source line range', d => {d.requirements[0].source_refs[0].lines=[4,2];}],
]) test(`rejects ${label}`, () => { const d=read(); mutate(d); assert.throws(() => validateParity(d)); });
