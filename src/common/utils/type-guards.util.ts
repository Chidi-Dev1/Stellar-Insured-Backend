/**
 * Type guard utilities for detecting special types that need serialization
 */

/**
 * Check if a value is a BigInt
 */
export function isBigInt(value: unknown): value is bigint {
  return typeof value === 'bigint';
}

/**
 * Check if a value is likely a Prisma.Decimal instance
 * Prisma.Decimal has specific internal properties (d, s, e) and a toString method
 */
export function isPrismaDecimal(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const obj = value as Record<string, unknown>;

  // Check for Decimal-specific properties
  const hasDecimalStructure = 'd' in obj || 's' in obj || 'e' in obj;
  const hasToString = typeof obj.toString === 'function';

  if (!hasDecimalStructure || !hasToString) {
    return false;
  }

  // Verify toString returns a valid number string
  try {
    const str = obj.toString();
    return typeof str === 'string' && !isNaN(Number(str));
  } catch {
    return false;
  }
}

/**
 * Check if a value is a Date
 */
export function isDate(value: unknown): value is Date {
  return value instanceof Date;
}

/**
 * Check if a value needs special serialization (BigInt, Decimal, or Date)
 */
export function needsSerialization(value: unknown): boolean {
  return isBigInt(value) || isPrismaDecimal(value) || isDate(value);
}
