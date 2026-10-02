export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const FILE_ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.md,.csv,.json';

async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.message || 'Document request failed'), { status: response.status, code: data.code });
  return data;
}

function base(roomId) {
  if (typeof roomId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(roomId)) throw new Error('Choose a room before uploading');
  return `/api/rooms/${roomId}/files`;
}

// Returns metadata with a protected same-origin `url` suitable for object.url.
// Keep the original room/object IDs across the await; navigation must not attach
// the completed upload to whichever item happens to be selected later.
export async function attachRoomFile({ roomId, file, signal }) {
  if (!file || typeof file.name !== 'string' || !Number.isFinite(file.size) || !file.size) throw new Error('Choose a non-empty document');
  if (file.size > MAX_FILE_BYTES) throw new Error('Files must be at most 5 MiB');
  const { file: saved } = await request(base(roomId), {
    method: 'POST', signal, body: file,
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-File-Type': file.type || 'application/octet-stream' },
  });
  return saved;
}

export async function listRoomFiles(roomId, { includeDeleted = false, signal } = {}) {
  return request(base(roomId) + (includeDeleted ? '?includeDeleted=1' : ''), { signal });
}

export async function deleteRoomFile(roomId, fileId) {
  return request(base(roomId) + '/' + encodeURIComponent(fileId), { method: 'DELETE' });
}

export async function restoreRoomFile(roomId, fileId) {
  return request(base(roomId) + '/' + encodeURIComponent(fileId) + '/restore', { method: 'POST' });
}

export function roomDocumentLink(file) {
  const link = document.createElement('a');
  link.href = file.url; link.download = file.name; link.textContent = `Download ${file.name}`;
  link.setAttribute('aria-label', `Download ${file.name} (${Math.ceil(file.size / 1024)} KB)`);
  return link;
}
