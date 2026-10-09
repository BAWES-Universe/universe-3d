// Read-only activation inspection. This command has no code path to PATCH, POST,
// registry writes, account tools or data mutation. Never save raw API payloads.
import { writeFileSync } from 'node:fs';
import { coolify, publicSite } from './coolify.mjs';
const api = coolify({ base: process.env.COOLIFY_BASE, token: process.env.COOLIFY_TOKEN });
const coolifyVersion = await api.version();
await api.assertIdle();
const configured = await api.inspect();
const health = await publicSite().health();
const receipt = { schemaVersion: 1, coolifyVersion, inspectedAt: new Date().toISOString(), configured,
  liveHealth: { ok: health.ok, persistence: health.persistence, build: health.build || null },
  runtimeDigestVerified: false, dataBackupVerified: false,
  note: 'Configured digest and served build only. Host image/mount and backup verification remain owner activation work.' };
writeFileSync(process.env.INSPECTION_OUTPUT || 'on-dev-readonly-inspection.json', `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt));
