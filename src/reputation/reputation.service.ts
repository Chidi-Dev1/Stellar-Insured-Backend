import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { calculateTrustScore } from './calculators/trust-score.calculator';
import { ReputationRepository } from '../common/repositories/reputation.repository';
import { TransactionClient } from '../common/repositories/repository.interface';

@Injectable()
export class ReputationService {
  private readonly logger = new Logger(ReputationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reputationRepository: ReputationRepository,
  ) {}

  async updateTrustScore(userId: string): Promise<number> {
    const score = await calculateTrustScore(this.prisma, userId);
    await this.reputationRepository.updateTrustScore(userId, score);
    return score;
  }

  async adjustReputation(
    userId: string,
    delta: number,
    reason: string,
    tx?: TransactionClient,
  ): Promise<number> {
    const execute = async (client: TransactionClient) => {
      const user = await this.reputationRepository.findUserScore(
        userId,
        client,
      );
      const current = user?.reputationScore ?? 0;
      const clamped = Math.max(0, Math.min(1000, current + delta));

      await this.reputationRepository.updateUserScore(userId, clamped, client);
      await this.reputationRepository.createHistory(
        { userId, scoreChange: delta, reason, timestamp: new Date() },
        client,
      );

      return clamped;
    };

    const newScore = tx
      ? await execute(tx)
      : await this.prisma.$transaction(execute);

    this.logger.log(
      `Reputation adjusted for user ${userId}: delta=${delta}, reason="${reason}", newScore=${newScore}`,
    );

    return newScore;
  }
}
