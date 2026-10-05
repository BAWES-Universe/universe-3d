import { fail } from './validation.mjs';

/** Product rule: trim and lowercase the whole ASCII address, preserving + tags. */
export function normalizeEmail(value) {
  if (typeof value !== 'string') fail(400, 'INVALID_EMAIL', 'Use a valid email address');
  const trimmed = value.trim();
  if (/[^\x00-\x7f]/.test(trimmed)) fail(400, 'INVALID_EMAIL', 'Use an ASCII email address');
  const email = trimmed.toLowerCase();
  const parts = email.split('@');
  const [local, domain] = parts;
  // Practical ASCII dot-atom subset: no quoted addresses, IDNs, or literals.
  if (email.length > 254 || parts.length !== 2 || !local || local.length > 64 ||
      !/^[a-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[a-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/.test(local) ||
      !domain || domain.length > 253 || !domain.includes('.') ||
      !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    fail(400, 'INVALID_EMAIL', 'Use an ASCII email address up to 254 characters, with a local part up to 64 characters');
  }
  return email;
}

export function validateAccountPassword(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 256 || password !== password.trim() || /[\u0000-\u001f\u007f]/.test(password)) {
    fail(400, 'INVALID_PASSWORD', 'Use a unique 10–256 character password without outer whitespace or control characters');
  }
  return password;
}
