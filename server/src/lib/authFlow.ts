import { randomBytes } from 'crypto';

const DEFAULT_ACTIVATION_TOKEN_EXPIRY_HOURS = 168;
const DEFAULT_PASSWORD_RESET_EXPIRY_HOURS = 2;

export const MIN_PASSWORD_LENGTH = 8;

function resolvePositiveHours(value: string | undefined, fallback: number) {
  const hours = Number.parseInt(value || '', 10);
  return Number.isFinite(hours) && hours > 0 ? hours : fallback;
}

function getExpiryDate(hours: number) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

export function generateAuthToken() {
  return randomBytes(24).toString('hex');
}

export function getActivationExpiryDate() {
  return getExpiryDate(resolvePositiveHours(
    process.env.USER_ACTIVATION_EXPIRY_HOURS,
    DEFAULT_ACTIVATION_TOKEN_EXPIRY_HOURS
  ));
}

export function getPasswordResetExpiryDate() {
  return getExpiryDate(resolvePositiveHours(
    process.env.USER_PASSWORD_RESET_EXPIRY_HOURS,
    DEFAULT_PASSWORD_RESET_EXPIRY_HOURS
  ));
}
