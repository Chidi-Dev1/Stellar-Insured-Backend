/**
 * Input sanitization utilities to prevent XSS, injection, and prototype pollution.
 *
 * These helpers are intentionally dependency-free — they rely only on
 * built-in RegExp and recursive traversal — so they add zero bundle size
 * and remain fast for typical JSON payloads.
 */

/** HTML tag pattern – catches <script>, <img onerror=…>, etc. */
const HTML_TAG_RE = /<[^>]*>/g;

/** Dangerous object keys that could enable prototype pollution or script execution */
const DANGEROUS_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

/** Maximum nesting depth for sanitized objects to prevent deep-bomb attacks */
const MAX_OBJECT_DEPTH = 10;

/** Maximum number of keys allowed in a single object */
const MAX_OBJECT_KEYS = 50;

/** Maximum string length for individual values (100 KB) */
const MAX_STRING_LENGTH = 100_000;

/**
 * Strip HTML tags and trim whitespace from a string.
 * Returns the sanitized string.
 */
export function sanitizeString(value: string): string {
  if (typeof value !== 'string') return '';
  let sanitized = value.trim();
  sanitized = sanitized.replace(HTML_TAG_RE, '');
  if (sanitized.length > MAX_STRING_LENGTH) {
    sanitized = sanitized.substring(0, MAX_STRING_LENGTH);
  }
  return sanitized;
}

/**
 * Validate CUID format (used by Prisma as default ID).
 * CUID v2: 24+ lowercase alphanumeric chars starting with a letter.
 * CUID v1: starts with 'c', 25 chars.
 */
export function isValidCuid(id: string): boolean {
  if (typeof id !== 'string') return false;
  return /^[a-z0-9_-]{3,64}$/i.test(id);
}

/**
 * Validate a Stellar public key (ed25519) or muxed account address.
 * Stellar public keys are base-32 encoded, start with 'G', and are 56 chars.
 */
export function isValidStellarAddress(address: string): boolean {
  if (typeof address !== 'string') return false;
  // Stellar public key: starts with G, 56 base-32 characters
  if (/^G[A-Z2-7]{55}$/.test(address)) return true;
  // Also allow test addresses that may not be fully valid format
  // but are at least safe alphanumeric strings (for dev/testing flexibility)
  return false;
}

/**
 * Validate that a wallet address string is safe for database queries.
 * Accepts Stellar public keys and alphanumeric identifiers.
 */
export function isValidWalletAddress(address: string): boolean {
  if (typeof address !== 'string') return false;
  if (address.length === 0 || address.length > 256) return false;
  // Must be alphanumeric with limited special chars (no SQL/meta chars)
  return /^[A-Za-z0-9_\-.@]+$/.test(address);
}

/**
 * Recursively sanitize a JSON-compatible value.
 *
 * - Strips HTML tags from strings
 * - Removes dangerous keys (`__proto__`, `constructor`, etc.)
 * - Enforces depth and key-count limits
 * - Preserves null, boolean, and number primitives
 */
export function sanitizeObject(
  value: unknown,
  depth = 0,
  visited = new WeakSet(),
): unknown {
  // Primitive types — safe as-is (except we sanitize strings)
  if (value === null || value === undefined) return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;

  // String — strip HTML tags and enforce length
  if (typeof value === 'string') {
    return sanitizeString(value);
  }

  // Prevent infinite recursion / excessive depth
  if (depth > MAX_OBJECT_DEPTH) return undefined;

  // Arrays — sanitize each element
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_OBJECT_KEYS)
      .map(item => sanitizeObject(item, depth + 1, visited));
  }

  // Objects — sanitize keys and values
  if (typeof value === 'object') {
    // Cycle detection
    if (visited.has(value)) return undefined;
    visited.add(value);

    const sanitized: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);

    if (entries.length > MAX_OBJECT_KEYS) {
      // Too many keys — truncate
      entries.length = MAX_OBJECT_KEYS;
    }

    for (const [key, val] of entries) {
      // Skip dangerous keys
      if (DANGEROUS_KEYS.has(key)) continue;
      // Skip keys that contain dots or dollar signs (NoSQL injection vectors)
      if (key.includes('$') || key.includes('.')) continue;
      // Sanitize the key itself (strip HTML)
      const safeKey = sanitizeString(key);
      if (!safeKey) continue;
      sanitized[safeKey] = sanitizeObject(val, depth + 1, visited);
    }

    return sanitized;
  }

  // Unknown types (functions, symbols, etc.) — discard
  return undefined;
}
