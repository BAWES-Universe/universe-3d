export const BOOTSTRAP_KEY = 'operator-bootstrap-v1';

function denied(code, message, status = 403) {
  const error = new Error(message); error.status = status; error.code = code; throw error;
}

/** Offline owner bootstrap remains mandatory; link admission is a separate capability. */
export function createAccessGate({ store, config }) {
  const disabled = config.registrationMode !== 'local-open' || config.mode === 'public';
  return Object.freeze({
    assertReady() {
      if (config.mode !== 'public') return;
      const ownerId = store.get('SELECT value FROM metadata WHERE key=?', BOOTSTRAP_KEY)?.value;
      if (!ownerId || !store.get('SELECT 1 FROM accounts WHERE user_id=?', ownerId)) denied('OPERATOR_BOOTSTRAP_REQUIRED', 'Public mode requires an offline operator-owned account before startup', 503);
      for (const table of ['universes', 'worlds', 'rooms']) {
        if (store.get(`SELECT 1 FROM ${table} WHERE owner_id IS NULL`)) denied('UNCLAIMED_SEEDS', 'Public mode refuses unowned places; inspect the dedicated database offline', 503);
      }
      // The original operator must still own at least one universe. Do not infer
      // authority from an arbitrary existing local guest or its first account.
      if (!store.get('SELECT 1 FROM universes WHERE owner_id=?', ownerId)) denied('OPERATOR_OWNER_MISSING', 'The bootstrapped operator owner no longer owns a universe', 503);
      if (store.get('SELECT 1 FROM users u LEFT JOIN accounts a ON a.user_id=u.id WHERE a.user_id IS NULL')) denied('UNPROVISIONED_PROFILES', 'Public mode refuses databases containing unprovisioned guest profiles', 503);
    },
    assertGuestCreationAllowed() {
      if (disabled) denied('GUEST_CREATION_DISABLED', 'This private preview requires an operator-provisioned account');
    },
    assertRegistrationAllowed() {
      if (disabled) denied('REGISTRATION_DISABLED', 'Web registration is disabled for this private preview');
    },
    publicPolicy() {
      return { mode: config.mode, guestCreation: !disabled, registration: !disabled, login: true, provisioning: disabled ? 'operator' : 'local' };
    },
  });
}
