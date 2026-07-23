import { isBigInt, isPrismaDecimal, isDate } from './type-guards.util';

/**
 * Custom JSON replacer function to handle special types that JSON.stringify cannot serialize by default.
 * - BigInt: converted to string
 * - Prisma.Decimal: converted to string
 * - Date: converted to ISO string
 *
 * This replacer is used in both the ResponseTransformInterceptor and Express JSON middleware
 * to ensure consistent serialization across all response paths.
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (isBigInt(value)) {
    return value.toString();
  }

  if (isPrismaDecimal(value)) {
    return (value as any).toString();
  }

  if (isDate(value)) {
    return value.toISOString();
  }

  return value;
}
