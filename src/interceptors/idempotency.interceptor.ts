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
import { IdempotencyService } from './idempotency.service';

interface StoredResponse {
  data: any;
  statusCode: number;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(private readonly idempotencyService: IdempotencyService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
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

      const existingKey =
        await this.idempotencyService.findExisting(idempotencyKey);

      if (existingKey) {
        const isExpired = new Date() > existingKey.expiresAt;

        if (!isExpired) {
          const currentRequestBody = JSON.stringify(requestBody);
          const storedRequestBody = JSON.stringify(
            existingKey.requestBody || {},
          );

          if (currentRequestBody !== storedRequestBody) {
            this.logger.warn(
              `Idempotency key ${idempotencyKey} reused with different request body`,
            );
            throw new HttpException(
              'Idempotency key already used with a different request body',
              HttpStatus.BAD_REQUEST,
            );
          }

          if (existingKey.status === 'COMPLETED' && existingKey.response) {
            this.logger.log(
              `Replaying cached response for idempotency key ${idempotencyKey}`,
            );
            const storedResponse =
              existingKey.response as unknown as StoredResponse;
            response.status(storedResponse.statusCode);
            response.set('X-Idempotency-Key', idempotencyKey);
            response.set('X-Idempotency-Replayed', 'true');
            return of(storedResponse.data);
          }

          if (existingKey.status === 'PENDING') {
            this.logger.debug(
              `Concurrent request for pending idempotency key ${idempotencyKey}`,
            );
            throw new HttpException(
              'Request is still being processed. Please wait and retry.',
              HttpStatus.CONFLICT,
            );
          }

          // FAILED (non-expired) keys fall through: re-arm and allow a retry.
        }

        await this.idempotencyService.resetToPending(idempotencyKey, {
          method,
          endpoint,
          requestBody,
          expiresAt,
        });
      } else {
        const claimed = await this.idempotencyService.claim({
          key: idempotencyKey,
          method,
          endpoint,
          requestBody,
          expiresAt,
        });

        if (claimed === 'conflict') {
          // A concurrent request inserted the key between our read and write.
          // If it has already finished, replay its cached response instead of
          // failing the retry.
          const winner =
            await this.idempotencyService.findExisting(idempotencyKey);
          if (
            winner &&
            winner.status === 'COMPLETED' &&
            winner.response &&
            new Date() <= winner.expiresAt
          ) {
            const storedResponse = winner.response as unknown as StoredResponse;
            this.logger.log(
              `Replaying cached response for idempotency key ${idempotencyKey}`,
            );
            response.status(storedResponse.statusCode);
            response.set('X-Idempotency-Key', idempotencyKey);
            response.set('X-Idempotency-Replayed', 'true');
            return of(storedResponse.data);
          }

          this.logger.debug(
            `Concurrent create for idempotency key ${idempotencyKey}`,
          );
          throw new HttpException(
            'Request is still being processed. Please wait and retry.',
            HttpStatus.CONFLICT,
          );
        }

        this.logger.debug(
          `Created new idempotency key ${idempotencyKey} for ${method} ${endpoint}`,
        );
      }

      const originalStatusCode = response.statusCode;

      return next.handle().pipe(
        tap(async result => {
          try {
            await this.idempotencyService.markCompleted(
              idempotencyKey,
              result,
              response.statusCode || originalStatusCode,
            );
          } catch (cbError) {
            const errorMessage =
              cbError instanceof Error ? cbError.message : 'Unknown error';
            this.logger.error(
              `Failed to store idempotency key ${idempotencyKey}: ${errorMessage}`,
            );
          }
          response.set('X-Idempotency-Key', idempotencyKey);
        }),
        catchError(async (error: unknown) => {
          try {
            const statusCode =
              error instanceof HttpException
                ? error.getStatus()
                : HttpStatus.INTERNAL_SERVER_ERROR;
            await this.idempotencyService.markFailed(
              idempotencyKey,
              error,
              statusCode,
            );
          } catch (dbError) {
            // Ignore database errors during error handling
          }
          throw error;
        }),
      );
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      if (idempotencyKey) {
        try {
          await this.idempotencyService.markFailed(
            idempotencyKey,
            error,
            HttpStatus.INTERNAL_SERVER_ERROR,
          );
        } catch (dbError) {
          this.logger.warn(
            `Failed to update failed idempotency status for ${idempotencyKey}`,
            dbError,
          );
        }
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
}
