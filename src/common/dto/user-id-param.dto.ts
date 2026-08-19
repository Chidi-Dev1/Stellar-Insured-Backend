import { IsString, IsNotEmpty, MaxLength, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';
import { sanitizeString } from '../utils/sanitization.util';

export class UserIdParamDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(36)
  @IsUUID('4', { message: 'userId must be a valid UUID v4' })
  @Transform(({ value }) =>
    typeof value === 'string' ? sanitizeString(value) : value,
  )
  userId: string;
}
