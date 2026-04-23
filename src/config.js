require('dotenv').config();

const isBoletSandbox = process.env.SICREDI_BOLETO_ENV === 'sandbox';
const isPixSandbox   = process.env.SICREDI_PIX_ENV   === 'sandbox';

module.exports = {
  PORT: process.env.PORT,
  SICREDI_BASE_URL:            isBoletSandbox ? process.env.SICREDI_BASE_URL_SANDBOX  : process.env.SICREDI_BASE_URL,
  SICREDI_X_API_KEY:           isBoletSandbox ? process.env.SICREDI_X_API_KEY_SANDBOX : process.env.SICREDI_X_API_KEY,
  SICREDI_USERNAME:            isBoletSandbox ? process.env.SICREDI_USERNAME_SANDBOX  : process.env.SICREDI_USERNAME,
  SICREDI_PASSWORD:            isBoletSandbox ? process.env.SICREDI_PASSWORD_SANDBOX  : process.env.SICREDI_PASSWORD,
  SICREDI_COOPERATIVA:         process.env.SICREDI_COOPERATIVA,
  SICREDI_POSTO:               process.env.SICREDI_POSTO,
  SICREDI_CODIGO_BENEFICIARIO: process.env.SICREDI_CODIGO_BENEFICIARIO,
  WEBHOOK_URL:                 process.env.WEBHOOK_URL,
  WEBHOOK_COMPENSACAO_URL:     process.env.WEBHOOK_COMPENSACAO_URL,

  SICREDI_OB_CLIENT_ID:        process.env.SICREDI_OB_CLIENT_ID,
  SICREDI_OB_CLIENT_SECRET:    process.env.SICREDI_OB_CLIENT_SECRET,

  SICREDI_PIX_BASE_URL:        isPixSandbox ? process.env.SICREDI_PIX_BASE_URL_SANDBOX : process.env.SICREDI_PIX_BASE_URL,
  SICREDI_PIX_CLIENT_ID:       process.env.SICREDI_PIX_CLIENT_ID,
  SICREDI_PIX_CLIENT_SECRET:   process.env.SICREDI_PIX_CLIENT_SECRET,
  SICREDI_PIX_CHAVE:           process.env.SICREDI_PIX_CHAVE,
  SICREDI_PIX_CERT_PATH:       process.env.SICREDI_PIX_CERT_PATH,
  SICREDI_PIX_KEY_PATH:        process.env.SICREDI_PIX_KEY_PATH,
  SICREDI_PIX_KEY_PASSPHRASE:  process.env.SICREDI_PIX_KEY_PASSPHRASE,

  DB_HOST_SD:     process.env.DB_HOST_SD,
  DB_USER_SD:     process.env.DB_USER_SD,
  DB_PASSWORD_SD: process.env.DB_PASSWORD_SD,
  DB_NAME_DW:     process.env.DB_NAME_DW,
};
