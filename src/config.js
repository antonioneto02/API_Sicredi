require('dotenv').config();

const isSandbox = process.env.SICREDI_ENV === 'sandbox';

module.exports = {
  PORT: process.env.PORT,
  SICREDI_BASE_URL:            isSandbox ? process.env.SICREDI_BASE_URL_SANDBOX  : process.env.SICREDI_BASE_URL,
  SICREDI_X_API_KEY:           isSandbox ? process.env.SICREDI_X_API_KEY_SANDBOX : process.env.SICREDI_X_API_KEY,
  SICREDI_USERNAME:            isSandbox ? process.env.SICREDI_USERNAME_SANDBOX  : process.env.SICREDI_USERNAME,
  SICREDI_PASSWORD:            isSandbox ? process.env.SICREDI_PASSWORD_SANDBOX  : process.env.SICREDI_PASSWORD,
  SICREDI_COOPERATIVA:         process.env.SICREDI_COOPERATIVA,
  SICREDI_POSTO:               process.env.SICREDI_POSTO,
  SICREDI_CODIGO_BENEFICIARIO: process.env.SICREDI_CODIGO_BENEFICIARIO,
  WEBHOOK_URL:                 process.env.WEBHOOK_URL,
  WEBHOOK_COMPENSACAO_URL:     process.env.WEBHOOK_COMPENSACAO_URL,
};
