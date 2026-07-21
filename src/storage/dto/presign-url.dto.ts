import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNumber, IsOptional, Min, Max } from 'class-validator';

export class PresignUrlDto {
  @ApiProperty({ description: 'S3 object key to generate a presigned URL for' })
  @IsString()
  key!: string;

  @ApiPropertyOptional({
    description: 'URL expiration time in seconds (default 3600, max 604800)',
    default: 3600,
    minimum: 60,
    maximum: 604800,
  })
  @IsOptional()
  @IsNumber()
  @Min(60)
  @Max(604800)
  expiresIn?: number;
}
