import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { redactValue } from '../common/utils/log-redaction.util';
import { runWithTracingContext } from '../common/tracing/tracing-context';

declare global {
  namespace Express {
    interface Request {
      redactedMeta?: Record<string, unknown>;
    }
  }
}

/**
 * Establishes the correlation ID for this request and opens the
 * AsyncLocalStorage-backed tracing scope (see tracing-context.ts) so every
 * log line, DB query meta, and notification payload emitted for the rest of
 * the request automatically carries `correlationId` (and later `userId` /
 * `entityId`, filled in downstream by ResponseTransformInterceptor and
 * domain services) without any of them having to pass it explicitly.
 *
 * Registered directly via `app.use()` in main.ts — ahead of every other
 * middleware, including the expressWinston request logger — so that even
 * the very first "incoming request" log line falls inside the tracing
 * scope. NestJS module-level middleware (`consumer.apply(...)`) runs too
 * late in the stack for that first log line to be covered.
 */
export function correlationIdHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const correlationId =
    (req.headers['x-correlation-id'] as string) || uuidv4();
  req.headers['x-correlation-id'] = correlationId;
  res.setHeader('x-correlation-id', correlationId);

  req.redactedMeta = redactValue({
    correlationId,
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
  }) as Record<string, unknown>;

  runWithTracingContext({ correlationId }, () => next());
}

/**
 * NestMiddleware wrapper around {@link correlationIdHandler}, kept for
 * modules/tests that wire middleware through Nest's `MiddlewareConsumer`
 * rather than `app.use()`.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    correlationIdHandler(req, res, next);
  }
}
