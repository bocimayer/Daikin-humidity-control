import pino from 'pino';
import { DEFAULT_LOG_LEVEL, DEFAULT_NODE_ENV, isProductionNodeEnv } from './env-defaults';

const nodeEnv = process.env.NODE_ENV ?? DEFAULT_NODE_ENV;
const isProduction = isProductionNodeEnv(nodeEnv);
const logLevel = process.env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL;

const logger = pino(
  {
    level: logLevel,
    base: { service: 'daikin-humidity-control' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  },
  isProduction
    ? undefined
    : pino.transport({
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' },
      }),
);

export default logger;
