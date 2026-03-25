const axios = require('axios');
const { PDFDocument, rgb } = require('pdf-lib');
const logger = require('../logger');
const {
  SICREDI_BASE_URL,
  SICREDI_X_API_KEY,
  SICREDI_USERNAME,
  SICREDI_PASSWORD,
  SICREDI_COOPERATIVA,
  SICREDI_POSTO,
  SICREDI_CODIGO_BENEFICIARIO,
} = require('../config');

async function autenticar() {
  const url = `${SICREDI_BASE_URL}/auth/openapi/token`;
  const params = new URLSearchParams({
    username:   SICREDI_USERNAME,
    password:   SICREDI_PASSWORD,
    scope:      'cobranca',
    grant_type: 'password',
  });

  try {
    const response = await axios.post(url, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-api-key':    SICREDI_X_API_KEY,
        'context':      'COBRANCA',
      },
      timeout: 15000,
    });
    logger.info('Token Sicredi obtido com sucesso.');
    return response.data.access_token;
  } catch (err) {
    const detalhe = err.response ? JSON.stringify(err.response.data) : err.message;
    logger.error(`Falha ao autenticar no Sicredi: ${detalhe}`);
    throw new Error(`Autenticação Sicredi falhou: ${detalhe}`);
  }
}

function headersCobranca(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
    'x-api-key':     SICREDI_X_API_KEY,
    'cooperativa':   SICREDI_COOPERATIVA,
    'posto':         SICREDI_POSTO,
  };
}

function buildPagador(dados) {
  const tipoPessoa = dados.tpdoc === 'cnpj' ? 'PESSOA_JURIDICA' : 'PESSOA_FISICA';
  return {
    cep:       String(dados.cep       || '').replace(/\D/g, ''),
    cidade:    dados.cidade    || '',
    documento: String(dados.documento || '').replace(/\D/g, ''),
    nome:      dados.nome      || '',
    tipoPessoa,
    endereco:  dados.endereco  || '',
    uf:        dados.uf        || '',
  };
}

async function chamarSicredi(url, payload, token) {
  try {
    const response = await axios.post(url, payload, {
      headers: headersCobranca(token),
      timeout: 30000,
    });
    logger.info(`Sicredi → HTTP ${response.status}`);
    return response.data;
  } catch (err) {
    const status  = err.response ? err.response.status : 'N/A';
    const detalhe = err.response ? JSON.stringify(err.response.data) : err.message;
    logger.error(`Sicredi → HTTP ${status} | ${detalhe}`);
    throw new Error(`HTTP ${status} — ${detalhe}`);
  }
}

async function gerarBoletoHibrido(token, dados) {
  const url = `${SICREDI_BASE_URL}/cobranca/boleto/v1/boletos`;
  const payload = {
    codigoBeneficiario: SICREDI_CODIGO_BENEFICIARIO,
    dataVencimento:     dados.vencto,
    especieDocumento:   'DUPLICATA_MERCANTIL_INDICACAO',
    tipoCobranca:       'HIBRIDO',
    seuNumero:          String(dados.nf),
    valor:              Number(dados.valor),
    pagador:            buildPagador(dados),
  };
  logger.info(`Gerando boleto HÍBRIDO | NF=${dados.nf} | Valor=${dados.valor}`);
  const resultado = await chamarSicredi(url, payload, token);
  logger.info(`Resposta Sicredi boleto: ${JSON.stringify(resultado)}`);
  return resultado;
}

async function gerarPixSimples(token, dados) {
  const url = `${SICREDI_BASE_URL}/cobranca/boleto/v1/boletos`;
  const payload = {
    codigoBeneficiario: SICREDI_CODIGO_BENEFICIARIO,
    dataVencimento:     dados.vencto,
    especieDocumento:   'DUPLICATA_MERCANTIL_INDICACAO',
    tipoCobranca:       'HIBRIDO',
    seuNumero:          String(dados.nf),
    valor:              Number(dados.valor),
    pagador:            buildPagador(dados),
  };
  logger.info(`Gerando PIX SIMPLES | NF=${dados.nf} | Valor=${dados.valor}`);
  const resultado = await chamarSicredi(url, payload, token);
  logger.info(`Resposta Sicredi pix: ${JSON.stringify(resultado)}`);
  return resultado;
}

async function gerarPdf(linhaDigitavel, token) {
  const url = `${SICREDI_BASE_URL}/cobranca/boleto/v1/boletos/pdf?linhaDigitavel=${encodeURIComponent(linhaDigitavel)}`;
  try {
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-api-key':     SICREDI_X_API_KEY,
        'cooperativa':   SICREDI_COOPERATIVA,
        'posto':         SICREDI_POSTO,
      },
      responseType: 'arraybuffer',
      timeout: 30000,
    });
    logger.info('PDF do boleto gerado com sucesso.');
    return Buffer.from(response.data).toString('base64');
  } catch (err) {
    const status = err.response ? err.response.status : 'N/A';
    let detalhe = err.message;
    if (err.response?.data) {
      try {
        detalhe = Buffer.from(err.response.data).toString('utf8');
      } catch (_) {
        detalhe = JSON.stringify(err.response.data);
      }
    }
    logger.error(`Erro ao gerar PDF → HTTP ${status} | URL: ${url} | ${detalhe}`);
    throw new Error(`Erro ao gerar PDF: HTTP ${status} | ${detalhe}`);
  }
}

// Para R$: cobre a FICHA DE COMPENSAÇÃO (barcode + linha digitável) com branco
async function cobrirFichaBoleto(pdfBase64) {
  try {
    const pdfBytes = Buffer.from(pdfBase64, 'base64');
    const pdfDoc   = await PDFDocument.load(pdfBytes);
    const white    = rgb(1, 1, 1);

    for (const page of pdfDoc.getPages()) {
      const { width, height } = page.getSize();
      page.drawRectangle({ x: 0, y: 0, width, height: height * 0.58, color: white });
    }

    const modifiedBytes = await pdfDoc.save();
    logger.info('FICHA DE COMPENSAÇÃO coberta no PDF PIX.');
    return Buffer.from(modifiedBytes).toString('base64');
  } catch (err) {
    logger.error(`Erro ao modificar PDF PIX: ${err.message}`);
    throw err;
  }
}

module.exports = { autenticar, gerarBoletoHibrido, gerarPixSimples, gerarPdf, cobrirFichaBoleto };
