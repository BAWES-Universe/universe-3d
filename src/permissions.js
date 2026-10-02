// UI affordances mirror server-computed capabilities. Explicit false always wins.
// The server remains authoritative; these helpers grant no access by themselves.
const fallback={canEditScene:['owner','admin','editor'],canEditMetadata:['owner','admin','editor'],canArchive:['owner','admin','editor'],canModerate:['owner','admin','moderator'],canManageMembers:['owner','admin'],canInvite:['owner','admin']};
export function roomAllows(room,capability){if(!room)return false;const value=room.capabilities?.[capability];if(typeof value==='boolean')return value;return (fallback[capability]||[]).includes(room.role);}
