import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CorrelationIdMiddleware.name);

  async use(req: Request, res: Response, next: NextFunction) {
    const headerId = req.headers['x-correlation-id'];
    const { v4: uuidv4, validate: isUuid } = await import('uuid');
    const correlationId =
      typeof headerId === 'string' && isUuid(headerId.trim())
        ? headerId.trim()
        : uuidv4();

    req.headers['x-correlation-id'] = correlationId;
    res.setHeader('x-correlation-id', correlationId);
    this.logger.debug(`Assigned correlation id ${correlationId}`);
import { v4 as uuidv4 } from 'uuid';
import { redactValue } from '../common/utils/log-redaction.util';

declare global {
  namespace Express {
    interface Request {
      redactedMeta?: Record<string, unknown>;
    }
  }
}

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
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

    next();
  }
}
