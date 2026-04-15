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
  SICREDI_PIX_CHAVE,
} = require('../config');

const ROOT = path.resolve(__dirname, '..', '..');

let _pixToken = null;
let _pixTokenExpiraEm = 0;

function criarAgenteMtls() {
  const certPath = SICREDI_PIX_CERT_PATH || path.join(ROOT, '76490572000168.cer');
  const keyPath  = SICREDI_PIX_KEY_PATH  || path.join(ROOT, 'api-pix-cini.key');

  logger.info(`[PIX mTLS] certPath=${certPath} | existe=${fs.existsSync(certPath)}`);
  logger.info(`[PIX mTLS] keyPath=${keyPath}  | existe=${fs.existsSync(keyPath)}`);
  logger.info(`[PIX mTLS] passphrase configurada=${!!SICREDI_PIX_KEY_PASSPHRASE}`);

  let certBuf, keyBuf;
  try {
    certBuf = fs.readFileSync(certPath);
    logger.info(`[PIX mTLS] Certificado lido | tamanho=${certBuf.length} bytes`);
  } catch (err) {
    logger.error(`[PIX mTLS] Falha ao ler certificado | ${err.message}`);
    throw err;
  }
  try {
    keyBuf = fs.readFileSync(keyPath);
    logger.info(`[PIX mTLS] Chave privada lida | tamanho=${keyBuf.length} bytes`);
  } catch (err) {
    logger.error(`[PIX mTLS] Falha ao ler chave privada | ${err.message}`);
    throw err;
  }

  const opts = {
    cert: certBuf,
    key:  keyBuf,
    rejectUnauthorized: true,
  };
  if (SICREDI_PIX_KEY_PASSPHRASE) {
    opts.passphrase = SICREDI_PIX_KEY_PASSPHRASE;
  }
  return new https.Agent(opts);
}

async function autenticarPix() {
  if (_pixToken && Date.now() < _pixTokenExpiraEm) {
    logger.info(`[PIX auth] Token em cache válido | expira em ${new Date(_pixTokenExpiraEm).toISOString()}`);
    return _pixToken;
  }
  logger.info(`[PIX auth] Obtendo novo token | url_base=${SICREDI_PIX_BASE_URL} | client_id=${SICREDI_PIX_CLIENT_ID}`);

  const url        = `${SICREDI_PIX_BASE_URL}/oauth/token`;
  const agenteMtls = criarAgenteMtls();
  const credenciais = Buffer
    .from(`${SICREDI_PIX_CLIENT_ID}:${SICREDI_PIX_CLIENT_SECRET}`)
    .toString('base64');

  try {
    const response = await axios.post(url, null, {
      params: {
        grant_type: 'client_credentials',
        scope:      'cob.write cob.read cobv.write cobv.read webhook.read webhook.write',
      },
      headers: {
        'Authorization': `Basic ${credenciais}`,
        'Content-Type':  'application/json',
      },
      httpsAgent: agenteMtls,
      timeout:    15000,
    });
    _pixToken = response.data.access_token;
    _pixTokenExpiraEm = Date.now() + (response.data.expires_in - 60) * 1000;
    logger.info(`[PIX auth] Token obtido | expires_in=${response.data.expires_in}s | expira=${new Date(_pixTokenExpiraEm).toISOString()}`);
    return _pixToken;
  } catch (err) {
    const status  = err.response ? err.response.status : 'N/A';
    const detalhe = err.response ? JSON.stringify(err.response.data) : err.message;
    logger.error(`[PIX auth] Falha ao autenticar | HTTP ${status} | ${detalhe}`);
    logger.error(`[PIX auth] Stack: ${err.stack}`);
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
    logger.error(`[PIX cob] Erro | HTTP ${status} | NF=${dados.nf} | ${detalhe}`);
    logger.error(`[PIX cob] Stack: ${err.stack}`);
    throw new Error(`HTTP ${status} — ${detalhe}`);
  }
}

async function registrarWebhook(token, webhookUrl) {
  const chave      = SICREDI_PIX_CHAVE;
  const url        = `${SICREDI_PIX_BASE_URL}/api/v2/webhook/${encodeURIComponent(chave)}`;
  const agenteMtls = criarAgenteMtls();

  logger.info(`[registrarWebhook PIX] PUT ${url} | payload: ${JSON.stringify({ webhookUrl })}`);

  try {
    const response = await axios.put(url, { webhookUrl }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      httpsAgent: agenteMtls,
      timeout:    15000,
    });
    logger.info(`[registrarWebhook PIX] HTTP ${response.status} | Resposta: ${JSON.stringify(response.data)}`);
    return response.data;
  } catch (err) {
    const status  = err.response ? err.response.status : 'N/A';
    const detalhe = err.response ? JSON.stringify(err.response.data) : err.message;
    logger.error(`[registrarWebhook PIX] Erro | HTTP ${status} | ${detalhe}`);
    logger.error(`[registrarWebhook PIX] Stack: ${err.stack}`);
    throw new Error(`HTTP ${status} — ${detalhe}`);
  }
}

async function consultarWebhook(token) {
  const chave      = SICREDI_PIX_CHAVE;
  const url        = `${SICREDI_PIX_BASE_URL}/api/v2/webhook/${encodeURIComponent(chave)}`;
  const agenteMtls = criarAgenteMtls();
  logger.info(`[consultarWebhook PIX] GET ${url} | chave=${chave}`);

  try {
    const response = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      httpsAgent: agenteMtls,
      timeout: 15000,
    });
    logger.info(`[consultarWebhook PIX] HTTP ${response.status} | Resposta: ${JSON.stringify(response.data)}`);
    return response.data;
  } catch (err) {
    const status  = err.response ? err.response.status : 'N/A';
    const detalhe = err.response ? JSON.stringify(err.response.data) : err.message;
    logger.error(`[consultarWebhook PIX] Erro | HTTP ${status} | ${detalhe}`);
    logger.error(`[consultarWebhook PIX] Stack: ${err.stack}`);
    throw new Error(`HTTP ${status} — ${detalhe}`);
  }
}
async function listarCobrancas(token, { inicio, fim, status, paginaAtual = 0, itensPorPagina = 100 }) {
  const url        = `${SICREDI_PIX_BASE_URL}/api/v2/cob`;
  const agenteMtls = criarAgenteMtls();

  const params = {
    inicio,
    fim,
    'paginacao.paginaAtual':    paginaAtual,
    'paginacao.itensPorPagina': itensPorPagina,
  };
  if (status) params.status = status;

  logger.info(`[listarCobrancas PIX] GET ${url} | params: ${JSON.stringify(params)}`);

  try {
    const response = await axios.get(url, {
      params,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      httpsAgent: agenteMtls,
      timeout:    30000,
    });
    logger.info(`[listarCobrancas PIX] HTTP ${response.status} | total=${response.data?.cobs?.length ?? 0}`);
    return response.data;
  } catch (err) {
    const status  = err.response ? err.response.status : 'N/A';
    const detalhe = err.response ? JSON.stringify(err.response.data) : err.message;
    logger.error(`Falha ao listar cobranças PIX → HTTP ${status} | ${detalhe}`);
    throw new Error(`HTTP ${status} — ${detalhe}`);
  }
}

module.exports = { autenticarPix, gerarBolecodePix, registrarWebhook, consultarWebhook, listarCobrancas };
