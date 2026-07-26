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
    next();
  }
}
