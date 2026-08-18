import { IsString, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class LogoutDto {
  @ApiPropertyOptional({
    description:
      'Optional specific refresh token to revoke. If omitted, all refresh tokens for the user are revoked.',
  })
  @IsOptional()
  @IsString()
  refresh_token?: string;
}
