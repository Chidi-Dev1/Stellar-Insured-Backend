import * as winston from 'winston';
import 'winston-daily-rotate-file';
import { redactFormat } from '../common/utils/log-redaction.util';

const isProduction = process.env.NODE_ENV === 'production';
const logDir = process.env.LOG_DIR || 'logs';
const logLevel = process.env.LOG_LEVEL || 'info';

const consoleFormat = isProduction
  ? winston.format.json()
  : winston.format.combine(winston.format.colorize(), winston.format.simple());

export const winstonConfig: winston.LoggerOptions = {
  level: logLevel,
  exitOnError: false,
  defaultMeta: { service: process.env.SERVICE_NAME || 'stellar-insured-backend' },
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    isProduction ? winston.format.json() : winston.format.combine(winston.format.colorize(), winston.format.simple()),
  ),
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    redactFormat(),
    process.env.NODE_ENV === 'production'
      ? winston.format.json()
      : winston.format.combine(
          winston.format.colorize(),
          winston.format.simple(),
        ),
  ),
  transports: [
    new winston.transports.Console({
      format:
        process.env.NODE_ENV === 'production'
          ? winston.format.json()
          : winston.format.combine(
              winston.format.colorize(),
              winston.format.simple(),
            ),
    }),
    new winston.transports.DailyRotateFile({
      dirname: logDir,
      filename: 'app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '30d',
      level: logLevel,
    }),
    new winston.transports.DailyRotateFile({
      dirname: logDir,
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '90d',
      level: 'error',
    }),
  ],
};

export const logger = winston.createLogger(winstonConfig);
