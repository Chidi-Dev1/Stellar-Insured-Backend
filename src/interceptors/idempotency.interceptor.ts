import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { idempotencyCircuitBreaker } from './utils/circuit-breaker';

interface StoredResponse {
  data: any;
  statusCode: number;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);
  
  constructor(private readonly prisma: PrismaService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const idempotencyKey = this.normalizeIdempotencyKey(
      request.headers['idempotency-key'] || request.headers['Idempotency-Key'],
    );
    const requestBody = request.body || {};

    if (!idempotencyKey) {
      return next.handle();
    }

    const method = request.method;
    const endpoint = request.url;

    try {
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24);

      const existingKey = await this.prisma.idempotencyKey.findUnique({
        where: { key: idempotencyKey },
      });

      if (existingKey) {
        const isExpired = new Date() > existingKey.expiresAt;

        if (!isExpired) {
          const currentRequestBody = JSON.stringify(requestBody);
          const storedRequestBody = JSON.stringify(existingKey.requestBody || {});
          
          if (currentRequestBody !== storedRequestBody) {
            this.logger.warn(`Idempotency key ${idempotencyKey} reused with different request body`);
            throw new HttpException(
              'Idempotency key already used with a different request body',
              HttpStatus.BAD_REQUEST,
            );
          }

          if (existingKey.status === 'COMPLETED' && existingKey.response) {
            this.logger.log(`Replaying cached response for idempotency key ${idempotencyKey}`);
            const storedResponse = existingKey.response as unknown as StoredResponse;
            response.status(storedResponse.statusCode);
            response.set('X-Idempotency-Key', idempotencyKey);
            response.set('X-Idempotency-Replayed', 'true');
            return of(storedResponse.data);
          }

          if (existingKey.status === 'PENDING') {
            this.logger.debug(`Concurrent request for pending idempotency key ${idempotencyKey}`);
            throw new HttpException(
              'Request is still being processed. Please wait and retry.',
              HttpStatus.CONFLICT,
            );
          }
        }

        await this.prisma.idempotencyKey.update({
          where: { key: idempotencyKey },
          data: {
            method,
            endpoint,
            requestBody: request.body || {},
            response: Prisma.DbNull,
            status: 'PENDING',
            expiresAt,
            deletedAt: null,
          },
        });
      } else {
        this.logger.debug(`Created new idempotency key ${idempotencyKey} for ${method} ${endpoint}`);
        await this.prisma.idempotencyKey.create({
          data: {
            key: idempotencyKey,
            method,
            endpoint,
            requestBody,
            status: 'PENDING',
            expiresAt,
          },
        });
      }

      const originalStatusCode = response.statusCode;

      return next.handle().pipe(
        tap(async (result) => {
          try {
            await idempotencyCircuitBreaker.execute(() => 
              this.prisma.idempotencyKey.update({
                where: { key: idempotencyKey },
                data: {
                  status: 'COMPLETED',
                  response: {
                    data: result,
                    statusCode: response.statusCode || originalStatusCode,
                  } as unknown as Prisma.InputJsonValue,
                },
              })
            );
          } catch (cbError) {
            const errorMessage = cbError instanceof Error ? cbError.message : 'Unknown error';
            this.logger.error(`Failed to store idempotency key ${idempotencyKey}: ${errorMessage}`);
          }
          response.set('X-Idempotency-Key', idempotencyKey);
        }),
        catchError(async (error: unknown) => {
          if (idempotencyKey) {
            try {
              const errorMessage = error instanceof Error ? error.message : 'Internal server error';
              const statusCode = error instanceof HttpException ? error.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
              
              await this.prisma.idempotencyKey.update({
                where: { key: idempotencyKey },
                data: {
                  status: 'FAILED',
                  response: { 
                    error: errorMessage,
                    statusCode: statusCode
                  } as unknown as Prisma.InputJsonValue,
                  },
              });
            } catch (dbError) {
              // Ignore database errors during error handling
            }
          }
          throw error;
        }),
      );
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      if (idempotencyKey) {
        await this.updateFailedStatus(idempotencyKey, error, HttpStatus.INTERNAL_SERVER_ERROR);
      }
      throw error;
    }
  }

  private normalizeIdempotencyKey(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private async updateFailedStatus(key: string, error: unknown, statusCode: number): Promise<void> {
    try {
      const errorMessage = error instanceof Error ? error.message : 'Internal server error';
      await this.prisma.idempotencyKey.update({
        where: { key },
        data: {
          status: 'FAILED',
          response: {
            error: errorMessage,
            statusCode,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (dbError) {
      this.logger.warn(`Failed to update failed idempotency status for ${key}`, dbError);
    }
  }
}