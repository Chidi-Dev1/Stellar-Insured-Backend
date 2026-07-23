import { Serializable, serialize, serializeArray } from './serialize.decorator';
import { SetMetadata } from '@nestjs/common';

jest.mock('@nestjs/common', () => ({
  ...jest.requireActual('@nestjs/common'),
  SetMetadata: jest.fn(),
}));

describe('serialize.decorator', () => {
  describe('Serializable', () => {
    it('should call SetMetadata with correct key', () => {
      Serializable();
      expect(SetMetadata).toHaveBeenCalledWith('serializable', true);
    });
  });

  describe('serialize', () => {
    it('should serialize BigInt to string', () => {
      const input = { value: BigInt(123) };
      const result = serialize(input);
      expect(result).toEqual({ value: '123' });
    });

    it('should serialize nested objects', () => {
      const input = {
        nested: {
          bigInt: BigInt(456),
        },
      };
      const result = serialize(input);
      expect(result).toEqual({
        nested: {
          bigInt: '456',
        },
      });
    });

    it('should handle arrays', () => {
      const input = [BigInt(1), BigInt(2), BigInt(3)];
      const result = serialize(input);
      expect(result).toEqual(['1', '2', '3']);
    });
  });

  describe('serializeArray', () => {
    it('should serialize array of objects with BigInt', () => {
      const input = [
        { id: BigInt(1), name: 'test1' },
        { id: BigInt(2), name: 'test2' },
      ];
      const result = serializeArray(input);
      expect(result).toEqual([
        { id: '1', name: 'test1' },
        { id: '2', name: 'test2' },
      ]);
    });

    it('should handle empty arrays', () => {
      const result = serializeArray([]);
      expect(result).toEqual([]);
    });

    it('should handle array of primitives', () => {
      const result = serializeArray([1, 2, 3]);
      expect(result).toEqual([1, 2, 3]);
    });
  });
});
