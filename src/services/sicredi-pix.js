const axios = require('axios');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const logger = require('../logger');
const {
  SICREDI_PIX_BASE_URL,
  SICREDI_PIX_CLIENT_ID,
  SICREDI_PIX_CLIENT_SECRET,
  SICREDI_PIX_CERT_PATH,
  SICREDI_PIX_KEY_PATH,
  SICREDI_PIX_KEY_PASSPHRASE,
} = require('../config');

// Raiz do projeto (dois níveis acima de src/services)
const ROOT = path.resolve(__dirname, '..', '..');

function criarAgenteMtls() {
  const certPath = SICREDI_PIX_CERT_PATH || path.join(ROOT, '76490572000168.cer');
  const keyPath  = SICREDI_PIX_KEY_PATH  || path.join(ROOT, 'api-pix-cini.key');

  const opts = {
    cert: fs.readFileSync(certPath),
    key:  fs.readFileSync(keyPath),
    rejectUnauthorized: true,
  };
  if (SICREDI_PIX_KEY_PASSPHRASE) {
    opts.passphrase = SICREDI_PIX_KEY_PASSPHRASE;
  }
  return new https.Agent(opts);
}

async function autenticarPix() {
  const url        = `${SICREDI_PIX_BASE_URL}/oauth/token`;
  const agenteMtls = criarAgenteMtls();
  const credenciais = Buffer
    .from(`${SICREDI_PIX_CLIENT_ID}:${SICREDI_PIX_CLIENT_SECRET}`)
    .toString('base64');

  try {
    const response = await axios.post(url, null, {
      params: {
        grant_type: 'client_credentials',
        scope:      'cob.write cob.read cobv.write',
      },
      headers: {
        'Authorization': `Basic ${credenciais}`,
        'Content-Type':  'application/json',
      },
      httpsAgent: agenteMtls,
      timeout:    15000,
    });
    logger.info('Token PIX Sicredi (cob) obtido com sucesso.');
    return response.data.access_token;
  } catch (err) {
    const detalhe = err.response ? JSON.stringify(err.response.data) : err.message;
    logger.error(`Falha ao autenticar PIX Sicredi: ${detalhe}`);
    throw new Error(`Autenticação PIX Sicredi falhou: ${detalhe}`);
  }
}

async function gerarBolecodePix(token, dados) {
  const url        = `${SICREDI_PIX_BASE_URL}/api/v3/cob`;
  const agenteMtls = criarAgenteMtls();

  const payload = {
    calendario: {
      expiracao: 15000000,
    },
    valor: {
      original:            Number(dados.valor).toFixed(2),
      modalidadeAlteracao: 0,
    },
    chave:              'financeiro@cini.com.br',
    solicitacaoPagador: `NF ${dados.nf}`,
  };

  logger.info(`Gerando PIX (cob) | NF=${dados.nf} | Valor=${dados.valor}`);
  logger.info(`Payload cob: ${JSON.stringify(payload)}`);

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      httpsAgent: agenteMtls,
      timeout:    30000,
    });
    logger.info(`PIX cob criado | txid=${response.data.txid} | HTTP ${response.status}`);
    logger.info(`Resposta cob: ${JSON.stringify(response.data)}`);
    return response.data;
  } catch (err) {
    const status  = err.response ? err.response.status : 'N/A';
    const detalhe = err.response ? JSON.stringify(err.response.data) : err.message;
    logger.error(`PIX cob → HTTP ${status} | ${detalhe}`);
    throw new Error(`HTTP ${status} — ${detalhe}`);
  }
}

module.exports = { autenticarPix, gerarBolecodePix };
