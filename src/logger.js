const { createLogger, format, transports } = require('winston');

function timestampBRT() {
  const now = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return now.toISOString().replace('T', ' ').slice(0, 19);
}

const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: timestampBRT }),
    format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: 'logs/app.log' }),
  ],
});

module.exports = logger;
