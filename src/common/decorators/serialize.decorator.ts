import { SetMetadata } from '@nestjs/common';
import { SerializationTransformer } from '../utils/serialization.util';

/**
 * Decorator to mark a class or method for automatic serialization
 * This metadata can be used by interceptors to apply serialization
 */
export const SERIALIZABLE_KEY = 'serializable';

export const Serializable = () => SetMetadata(SERIALIZABLE_KEY, true);

/**
 * Decorator to mark specific fields for serialization
 * Can be used on DTO properties to indicate they need special handling
 */
export function SerializeField() {
  return function (target: any, propertyKey: string) {
    // This decorator can be extended to add field-level metadata
    // For now, it serves as a marker for documentation
  };
}

/**
 * Helper function to serialize an object using the SerializationTransformer
 * Can be used in services or controllers when manual serialization is needed
 */
export function serialize<T>(value: T): T {
  return SerializationTransformer.transform(value) as T;
}

/**
 * Helper function to serialize an array of objects
 */
export function serializeArray<T>(values: T[]): T[] {
  return SerializationTransformer.transformArray(values) as T[];
}
