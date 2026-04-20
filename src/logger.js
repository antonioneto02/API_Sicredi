const { createLogger, format, transports } = require('winston');
const fs = require('fs');
const path = require('path');

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

function appendPayloadLog(filename, payload) {
  try {
    const filePath = path.resolve(__dirname, '..', 'logs', filename);
    const json = JSON.stringify(payload);
    fs.appendFile(filePath, json + '\n', (err) => {
      if (err) console.error('Failed to write payload log:', err);
    });
  } catch (e) {
    console.error('Failed to append payload log:', e);
  }
}

logger.logBoletoSuccessPayload = (payload) => appendPayloadLog('boleto_success_payload.log', payload);
logger.logBoletoErrorPayload = (payload) => appendPayloadLog('boleto_error_payload.log', payload);
logger.logPixSuccessPayload = (payload) => appendPayloadLog('pix_success_payload.log', payload);
logger.logPixErrorPayload = (payload) => appendPayloadLog('pix_error_payload.log', payload);

module.exports = logger;
