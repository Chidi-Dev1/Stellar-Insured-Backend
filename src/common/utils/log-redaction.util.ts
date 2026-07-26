import * as winston from 'winston';

export const REDACTED = '[REDACTED]';
export const REDACTED_JWT = '[REDACTED_JWT]';
export const REDACTED_EMAIL = '[REDACTED_EMAIL]';
export const REDACTED_STELLAR = '[REDACTED_WALLET]';
export const REDACTED_UUID = '[REDACTED_UUID]';
export const REDACTED_PHONE = '[REDACTED_PHONE]';
export const REDACTED_IP = '[REDACTED_IP]';
export const REDACTED_CC = '[REDACTED_CC]';
export const REDACTED_SSN = '[REDACTED_SSN]';

const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'secret',
  'password',
  'token',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'encryptionkey',
  'encryption_keys',
  'key',
  'vapidprivatekey',
  'vapidpublickey',
  'email',
  'pushsubscription',
  'walletaddress',
  'wallet_address',
  'phone',
  'phonenumber',
  'ssn',
  'socialsecurity',
  'creditcard',
  'ipaddress',
  'address',
  'name',
  'dateofbirth',
  'dob',
  'birthdate',
]);

const JWT_RE =
  /(?:Bearer\s+)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/gi;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const STELLAR_RE = /G[A-Z2-7]{55}/g;
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PHONE_RE =
  /\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const CC_RE =
  /\b(?:\d{4}[\s-]?){3}\d{4}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;

function redactString(value: string): string {
  let result = value;
  result = result.replace(JWT_RE, REDACTED_JWT);
  result = result.replace(EMAIL_RE, REDACTED_EMAIL);
  result = result.replace(STELLAR_RE, REDACTED_STELLAR);
  result = result.replace(UUID_RE, REDACTED_UUID);
  result = result.replace(PHONE_RE, REDACTED_PHONE);
  result = result.replace(IP_RE, REDACTED_IP);
  result = result.replace(CC_RE, REDACTED_CC);
  result = result.replace(SSN_RE, REDACTED_SSN);
  return result;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 10) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === 'boolean' || typeof value === 'number') return value;

  if (typeof value === 'string') {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map(item => redactValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        result[key] = REDACTED;
      } else {
        result[key] = redactValue(val, depth + 1);
      }
    }
    return result;
  }

  return value;
}

export function redactLogInfo<T extends winston.Logform.TransformableInfo>(
  info: T,
): winston.Logform.TransformableInfo {
  const redacted = redactValue(info);
  return redacted as winston.Logform.TransformableInfo;
}

export const redactFormat = winston.format(info => redactLogInfo(info));

export { redactValue };
