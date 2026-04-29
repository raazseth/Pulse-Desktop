import log from "electron-log";

interface SimpleLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

let logger: SimpleLogger;

try {
  log.initialize();
  log.transports.file.level = "info";
  log.transports.console.level = "debug";
  const scoped = log.scope("desktop");
  logger = {
    info:  scoped.info.bind(scoped),
    warn:  scoped.warn.bind(scoped),
    error: scoped.error.bind(scoped),
    debug: scoped.debug.bind(scoped),
  };
} catch {
  logger = {
    info:  console.info.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };
}

export { logger };
