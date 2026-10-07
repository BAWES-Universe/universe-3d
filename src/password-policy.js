/** Shared creation policy. Sign-in intentionally does not re-apply a new floor. */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;
export const PASSWORD_HELP = `Use a unique ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} character password without outer whitespace or control characters`;
export function validAccountPassword(value) {
  return typeof value === 'string' && value.length >= PASSWORD_MIN_LENGTH && value.length <= PASSWORD_MAX_LENGTH && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}
