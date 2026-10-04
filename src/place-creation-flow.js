/** Resumable client sequence over the existing, per-record idempotent APIs.
 * Persist BEFORE each POST. Unknown outcomes always retry the identical payload.
 * Storage is per account and browser tab; there is no server-side workflow/rollback.
 */
export const PLACE_KINDS = ['universe', 'world', 'room'];
const uuid = () => crypto.randomUUID();
export function suggestedSlug(name, suffix = uuid().replaceAll('-', '').slice(0, 12)) {
  const stem = name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48).replace(/-$/g, '') || 'place';
  return `${stem}-${suffix}`;
}
export function newPlaceDraft(userId) {
  return { version: 1, userId, name: '', public: false, started: false, steps: [] };
}
export const creationKey = userId => `universe-place-creation-v1:${userId}`;
export function readPlaceDraft(storage, userId) {
  const raw = storage.getItem(creationKey(userId));
  if (!raw) return newPlaceDraft(userId);
  const d = JSON.parse(raw);
  if (d.version !== 1 || d.userId !== userId || typeof d.name !== 'string' || typeof d.public !== 'boolean' || typeof d.started !== 'boolean' || !Array.isArray(d.steps)
    || (d.started && (d.steps.length !== 3 || d.steps.some((s, i) => s.kind !== PLACE_KINDS[i] || !s.body?.clientOperationId || typeof s.body.name !== 'string' || typeof s.body.slug !== 'string')))) {
    throw new Error('The saved creation receipt cannot be read. No creation request was sent. Keep this tab and inspect your places before starting elsewhere.');
  }
  return d;
}
export function savePlaceDraft(storage, draft) {
  try { storage.setItem(creationKey(draft.userId), JSON.stringify(draft)); }
  catch { throw new Error('Creation progress could not be saved in this browser tab. No further creation request was sent. Enable browser storage, then retry here.'); }
}
export function preparePlaceDraft(draft) {
  if (draft.started) return;
  const name = draft.name.trim();
  if (!name || name.length > 120) throw new Error('Give your place a name of 1–120 characters.');
  draft.name = name;
  draft.steps = PLACE_KINDS.map(kind => ({ kind, id: null, body: {
    name, public: draft.public, slug: suggestedSlug(name), clientOperationId: uuid(),
  } }));
  draft.started = true;
}
export async function runPlaceCreation(draft, { api, persist, onProgress = () => {}, isCurrent = () => true }) {
  const assertCurrent = () => { if (!isCurrent()) throw new Error('Your account changed. Resume creation from the original account.'); };
  assertCurrent();
  preparePlaceDraft(draft);
  for (let i = 0; i < draft.steps.length; i++) {
    const step = draft.steps[i];
    if (step.id) continue;
    assertCurrent();
    if (i) step.body[i === 1 ? 'universeId' : 'worldId'] = draft.steps[i - 1].id;
    for (let collision = 0; ; collision++) {
      assertCurrent();
      persist(draft); // A lost response/reload can replay this exact operation.
      onProgress();
      assertCurrent(); // Callbacks may have changed the actor before this POST.
      let result;
      try { result = await api(`/api/${step.kind}s`, { method: 'POST', body: { ...step.body } }); }
      catch (error) {
        assertCurrent(); // Preserve the original receipt across an awaited account change.
        // Only this explicit transactional rejection establishes that no write occurred.
        if (error?.status === 409 && error?.data?.error === 'SLUG_TAKEN' && collision < 3) {
          step.body.slug = suggestedSlug(draft.name);
          step.body.clientOperationId = uuid();
          continue;
        }
        throw error;
      }
      assertCurrent();
      const record = result?.[step.kind];
      if (!record?.id) throw new Error('The server response was incomplete. Retry to recover the same place.');
      step.id = record.id;
      persist(draft);
      onProgress();
      break;
    }
  }
  return draft.steps[2].id;
}
