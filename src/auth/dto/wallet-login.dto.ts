import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class WalletLoginDto {
  @ApiProperty({
    description: 'The user ID (wallet owner) to authenticate',
    example: 'clxyz1234567890abcdef',
  })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiProperty({
    description: 'The one-time nonce obtained from POST /nonce',
    example: 'a1b2c3d4e5f6...',
  })
  @IsString()
  @IsNotEmpty()
  nonce: string;

  @ApiPropertyOptional({
    description:
      'Optional device/session fingerprint for abuse detection',
    example: 'device-id-or-fingerprint-hash',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  fingerprint?: string;
}
