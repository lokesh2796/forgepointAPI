const winston = require('winston');

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Define a custom format for how log messages will be structured.
const logFormat = printf(({ level, message, timestamp, stack }) => {
  // If there's a stack trace (from an error), include it.
  if (stack) {
    return `${timestamp} ${level}: ${message} - ${stack}`;
  }
  return `${timestamp} ${level}: ${message}`;
});

// Create the main logger instance.
const logger = winston.createLogger({
  level: 'info', // This means it will log messages of level 'info', 'warn', and 'error'.
  format: combine(
    errors({ stack: true }), // Automatically handle error stack traces.
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports: [
    // - All logs of level 'error' will be saved in error.log
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    // - All logs of level 'info' and above will be saved in app.log
    new winston.transports.File({ filename: 'app.log' }),
  ],
});

// For development, we also want to see nicely colored logs in our terminal.
// This will not be active in the final packaged .exe.
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: combine(
      colorize(), // Add colors to the output
      timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      logFormat
    ),
  }));
}

module.exports = logger;
