import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RefreshTokenDto {
  @ApiProperty({
    description: 'The refresh token received during login or previous refresh',
  })
  @IsString()
  @IsNotEmpty()
  refresh_token: string;

  @ApiPropertyOptional({
    description:
      'Optional device/session fingerprint — must match the one used during login',
    example: 'device-id-or-fingerprint-hash',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  fingerprint?: string;
}
