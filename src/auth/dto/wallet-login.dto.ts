import { IsString, IsNotEmpty, IsOptional, MaxLength, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class WalletLoginDto {
  @ApiProperty({
    description: 'The user ID (UUID v4) of the wallet owner to authenticate',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsString()
  @IsNotEmpty()
  @IsUUID('4', { message: 'userId must be a valid UUID v4' })
  userId: string;

  @ApiProperty({
    description: 'The one-time nonce obtained from POST /nonce/:userId',
    example: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
  })
  @IsString()
  @IsNotEmpty()
  nonce: string;

  @ApiPropertyOptional({
    description: 'Optional device/session fingerprint for abuse detection',
    example: 'device-id-or-fingerprint-hash',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  fingerprint?: string;
}
