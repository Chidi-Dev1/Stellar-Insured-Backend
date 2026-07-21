import { IsString, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';
import { Prisma } from '@prisma/client';

export class CreateClaimDto {
  @IsUUID()
  policyId!: string;

  @Transform(({ value }) => {
    const decimal = new Prisma.Decimal(value);
    if (decimal.lte(new Prisma.Decimal(0))) {
      throw new Error('Claim amount must be positive');
    }
    return decimal;
  })
  claimAmount!: Prisma.Decimal;
}
