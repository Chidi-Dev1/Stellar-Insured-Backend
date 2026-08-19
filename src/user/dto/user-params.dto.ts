import { IsString, IsNotEmpty, MaxLength, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';
import { sanitizeString } from '../../common/utils/sanitization.util';

export class UserParamsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(36)
  @IsUUID('4', { message: 'id must be a valid UUID v4' })
  @Transform(({ value }) =>
    typeof value === 'string' ? sanitizeString(value) : value,
  )
  id: string;
}
