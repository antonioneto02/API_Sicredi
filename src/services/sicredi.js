const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const logger = require('../logger');
const PDFS_DIR = process.env.PDF_OUTPUT_DIR ? path.resolve(process.env.PDF_OUTPUT_DIR) : path.resolve('E:\\TOTVS\\Boletos');
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

  logger.info(`[Sicredi auth] Autenticando | url=${url} | user=${SICREDI_USERNAME}`);
  try {
    const response = await axios.post(url, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-api-key':    SICREDI_X_API_KEY,
        'context':      'COBRANCA',
      },
      timeout: 15000,
    });
    logger.info(`[Sicredi auth] Token obtidos | HTTP ${response.status}`);
    return response.data.access_token;
  } catch (err) {
    const status  = err.response ? err.response.status : 'N/A';
    const detalhe = err.response ? JSON.stringify(err.response.data) : err.message;
    logger.error(`[Sicredi auth] Falha | HTTP ${status} | ${detalhe}`);
    logger.error(`[Sicredi auth] Stack: ${err.stack}`);
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

function formatSeuNumero(raw) {
  let s = String(raw || '');
  s = s.replace(/-/g, '');
  if (s.length > 10) s = s.slice(-10);
  return s;
}
async function chamarSicredi(url, payload, token) {
  logger.info(`[Sicredi POST] url=${url}`);
  try {
    const response = await axios.post(url, payload, {
      headers: headersCobranca(token),
      timeout: 30000,
    });
    logger.info(`[Sicredi POST] HTTP ${response.status} | url=${url}`);
    return response.data;
  } catch (err) {
    const status  = err.response ? err.response.status : 'N/A';
    const detalhe = err.response ? JSON.stringify(err.response.data) : err.message;
    logger.error(`[Sicredi POST] Erro | HTTP ${status} | url=${url} | ${detalhe}`);
    logger.error(`[Sicredi POST] Stack: ${err.stack}`);
    throw new Error(`HTTP ${status} — ${detalhe}`);
  }
}

async function gerarBoletoHibrido(token, dados) {
  const url = `${SICREDI_BASE_URL}/cobranca/boleto/v1/boletos`;
  const valorBoleto = Number(dados.valor);
  const percentual = Number(2.00);
  const jurosMonetarioRaw = (valorBoleto * (percentual / 100)) / 30;
  const jurosMonetario = Number((Math.round(jurosMonetarioRaw * 100) / 100).toFixed(2));
  const payload = {
    codigoBeneficiario:     SICREDI_CODIGO_BENEFICIARIO,
    dataVencimento:         dados.vencto,
    especieDocumento:       'DUPLICATA_MERCANTIL_INDICACAO',
    tipoCobranca:           'HIBRIDO',
    seuNumero:              formatSeuNumero(dados.parcela ? `${dados.nf}-${dados.parcela}` : String(dados.nf)),
    valor:                  valorBoleto,
    pagador:                buildPagador(dados),
    validadeAposVencimento: 30,
    tipoJuros:              'VALOR',
    juros:                  jurosMonetario,
    tipoMulta:              'PERCENTUAL',
    multa:                  2.00,
  };
  logger.info(`Gerando boleto HÍBRIDO | NF=${dados.nf} | Parcela=${dados.parcela || '-'} | Valor=${dados.valor}`);
  logger.info(`Payload boleto: ${JSON.stringify(payload)}`);
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
    seuNumero:          formatSeuNumero(String(dados.nf)),
    valor:              Number(dados.valor),
    pagador:            buildPagador(dados),
  };
  logger.info(`Gerando PIX SIMPLES | NF=${dados.nf} | Valor=${dados.valor}`);
  logger.info(`[gerarPixSimples] Payload enviado: ${JSON.stringify(payload)}`);
  const resultado = await chamarSicredi(url, payload, token);
  logger.info(`[gerarPixSimples] Resposta Sicredi: ${JSON.stringify(resultado)}`);
  return resultado;
}

async function gerarPdf(linhaDigitavel, nf, token, parcela, filial) {
  const url = `${SICREDI_BASE_URL}/cobranca/boleto/v1/boletos/pdf?linhaDigitavel=${encodeURIComponent(linhaDigitavel)}`;
  logger.info(`[gerarPdf] GET ${url} | NF=${nf} | Parcela=${parcela || '-'} | Filial=${filial || '-'}`);
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

    if (!fs.existsSync(PDFS_DIR)) fs.mkdirSync(PDFS_DIR, { recursive: true });
    const prefixo  = filial ? String(filial) : '';
    const nomePdf  = parcela ? `${prefixo}${nf}${parcela.toUpperCase()}` : `${prefixo}${nf}`;
    const pdfPath  = path.join(PDFS_DIR, `${nomePdf}.pdf`);
    fs.writeFileSync(pdfPath, Buffer.from(response.data));
    logger.info(`[gerarPdf] HTTP ${response.status} | tamanho=${response.data.byteLength} bytes`);
    logger.info(`PDF salvo | NF=${nf} | Parcela=${parcela || '-'} | path=${pdfPath}`);
    return pdfPath;
  } catch (err) {
    const status = err.response ? err.response.status : 'N/A';
    let detalhe = err.message;
    if (err.response?.data) {
      try { detalhe = Buffer.from(err.response.data).toString('utf8'); }
      catch (_) { detalhe = JSON.stringify(err.response.data); }
    }
    logger.error(`Erro ao gerar PDF → HTTP ${status} | NF=${nf} | Parcela=${parcela || '-'} | ${detalhe}`);
    throw new Error(`Erro ao gerar PDF: HTTP ${status} | ${detalhe}`);
  }
}

async function gerarPdfParaPasta(linhaDigitavel, token, outputDir, nomeArquivo) {
  const url = `${SICREDI_BASE_URL}/cobranca/boleto/v1/boletos/pdf?linhaDigitavel=${encodeURIComponent(linhaDigitavel)}`;
  logger.info(`[gerarPdfParaPasta] GET ${url} | outputDir=${outputDir} | nomeArquivo=${nomeArquivo}`);
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

    if (!outputDir) throw new Error('outputDir é obrigatório');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const safeName = nomeArquivo ? String(nomeArquivo) : `${linhaDigitavel}.pdf`;
    const pdfPath = path.join(outputDir, safeName);
    fs.writeFileSync(pdfPath, Buffer.from(response.data));
    logger.info(`[gerarPdfParaPasta] HTTP ${response.status} | tamanho=${response.data.byteLength} bytes`);
    logger.info(`PDF salvo para teste | linha=${linhaDigitavel} | path=${pdfPath}`);
    return pdfPath;
  } catch (err) {
    const status = err.response ? err.response.status : 'N/A';
    let detalhe = err.message;
    if (err.response?.data) {
      try { detalhe = Buffer.from(err.response.data).toString('utf8'); }
      catch (_) { detalhe = JSON.stringify(err.response.data); }
    }
    logger.error(`Erro ao gerar PDF para pasta → HTTP ${status} | linha=${linhaDigitavel} | ${detalhe}`);
    throw new Error(`Erro ao gerar PDF para pasta: HTTP ${status} | ${detalhe}`);
  }
}
async function consultarFrancesinha(token, { dataLancamento, tipoMovimento, pagina = 0 }) {
  const [ano, mes, dia] = dataLancamento.split('-');
  const dataFormatada = `${dia}/${mes}/${ano}`;
  const url = `${SICREDI_BASE_URL}/cobranca/v1/cobranca-financeiro/movimentacoes/`;
  const params = {
    codigoBeneficiario: SICREDI_CODIGO_BENEFICIARIO,
    cooperativa:        SICREDI_COOPERATIVA,
    posto:              SICREDI_POSTO,
    dataLancamento:     dataFormatada,
    pagina,
  };
  if (tipoMovimento) params.tipoMovimento = tipoMovimento;
  logger.info(`[consultarFrancesinha] GET ${url} | params: ${JSON.stringify(params)}`);

  try {
    const response = await axios.get(url, {
      params,
      headers: {
        ...headersCobranca(token),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 30000,
    });
    logger.info(`[consultarFrancesinha] HTTP ${response.status} | data=${dataFormatada} | total=${response.data?.total ?? 0}`);
    return response.data;
  } catch (err) {
    const status  = err.response ? err.response.status : 'N/A';
    const detalhe = err.response ? JSON.stringify(err.response.data) : err.message;
    logger.error(`Falha ao consultar francesinha → HTTP ${status} | ${detalhe}`);
    throw new Error(`HTTP ${status} — ${detalhe}`);
  }
}

async function consultarLiquidadosPorPeriodo(token, dataInicio, dataFim) {
  const inicio = new Date(dataInicio + 'T00:00:00Z');
  const fim    = new Date(dataFim    + 'T00:00:00Z');
  const diffDias = Math.round((fim - inicio) / 86400000);

  if (diffDias < 0)   throw new Error('dataInicio deve ser anterior ou igual a dataFim.');
  if (diffDias > 31)  throw new Error('O período máximo permitido é de 31 dias.');

  const resultados = [];
  for (let i = 0; i <= diffDias; i++) {
    const d = new Date(inicio);
    d.setUTCDate(d.getUTCDate() + i);
    const dataStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    try {
      const boletos = await consultarLiquidadosPorDia(token, dataStr);
      if (Array.isArray(boletos) && boletos.length > 0) {
        resultados.push(...boletos.map(b => ({ ...b, _data: dataStr })));
      }
    } catch (err) {
      logger.warn(`Sem resultado para ${dataStr}: ${err.message}`);
    }
  }
  logger.info(`Liquidados por período ${dataInicio} → ${dataFim} | total=${resultados.length}`);
  return resultados;
}

async function consultarBoletosCadastrados(token, { seuNumero, idTituloEmpresa }) {
  const url = `${SICREDI_BASE_URL}/cobranca/boleto/v1/boletos/cadastrados`;
  const params = { codigoBeneficiario: SICREDI_CODIGO_BENEFICIARIO };
  if (seuNumero)      params.seuNumero      = seuNumero;
  if (idTituloEmpresa) params.idTituloEmpresa = idTituloEmpresa;
  logger.info(`[consultarBoletosCadastrados] GET ${url} | params: ${JSON.stringify(params)}`);

  try {
    const response = await axios.get(url, {
      params,
      headers: {
        ...headersCobranca(token),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 30000,
    });
    const filtro = seuNumero ? `seuNumero=${seuNumero}` : `idTituloEmpresa=${idTituloEmpresa}`;
    logger.info(`[consultarBoletosCadastrados] HTTP ${response.status} | ${filtro} | total=${response.data?.length ?? 0}`);
    return response.data;
  } catch (err) {
    const status  = err.response ? err.response.status : 'N/A';
    const detalhe = err.response ? JSON.stringify(err.response.data) : err.message;
    logger.error(`Falha ao consultar boletos cadastrados → HTTP ${status} | ${detalhe}`);
    throw new Error(`HTTP ${status} — ${detalhe}`);
  }
}

async function consultarLiquidadosPorDia(token, data) {
  const [ano, mes, dia] = data.split('-');
  const diaFormatado = `${dia}/${mes}/${ano}`;
  const url = `${SICREDI_BASE_URL}/cobranca/boleto/v1/boletos/liquidados/dia`;
  const queryParams = { codigoBeneficiario: SICREDI_CODIGO_BENEFICIARIO, dia: diaFormatado };
  logger.info(`[consultarLiquidadosPorDia] GET ${url} | params: ${JSON.stringify(queryParams)}`);
  try {
    const response = await axios.get(url, {
      params: queryParams,
      headers: {
        ...headersCobranca(token),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 30000,
    });
    logger.info(`[consultarLiquidadosPorDia] HTTP ${response.status} | data=${diaFormatado} | total=${response.data?.length ?? 0}`);
    return response.data;
  } catch (err) {
    const status  = err.response ? err.response.status : 'N/A';
    const detalhe = err.response ? JSON.stringify(err.response.data) : err.message;
    logger.error(`Falha ao consultar liquidados → HTTP ${status} | ${detalhe}`);
    throw new Error(`HTTP ${status} — ${detalhe}`);
  }
}

async function registrarWebhookBoleto(token, webhookUrl) {
  const url = `${SICREDI_BASE_URL}/cobranca/boleto/v1/webhook/contrato/`;
  const webhookPayload = {
    cooperativa:     SICREDI_COOPERATIVA,
    posto:           SICREDI_POSTO,
    codBeneficiario: SICREDI_CODIGO_BENEFICIARIO,
    eventos:         ['LIQUIDACAO'],
    url:             webhookUrl,
    urlStatus:       'ATIVO',
    contratoStatus:  'ATIVO',
    enviarIdTituloEmpresa: true,
  };
  logger.info(`[registrarWebhookBoleto] POST ${url} | payload: ${JSON.stringify(webhookPayload)}`);
  try {
    const response = await axios.post(url, webhookPayload, {
      headers: headersCobranca(token),
      timeout: 15000,
    });
    logger.info(`[registrarWebhookBoleto] HTTP ${response.status} | url=${webhookUrl}`);
    logger.info(`[registrarWebhookBoleto] Resposta: ${JSON.stringify(response.data)}`);
    return response.data;
  } catch (err) {
    const status  = err.response ? err.response.status : 'N/A';
    const detalhe = err.response ? JSON.stringify(err.response.data) : err.message;
    logger.error(`Falha ao registrar webhook boleto → HTTP ${status} | ${detalhe}`);
    throw new Error(`HTTP ${status} — ${detalhe}`);
  }
}

async function consultarWebhookBoleto(token) {
  const url = `${SICREDI_BASE_URL}/cobranca/boleto/v1/webhook/contratos/`;
  const webhookParams = { cooperativa: SICREDI_COOPERATIVA, posto: SICREDI_POSTO, beneficiario: SICREDI_CODIGO_BENEFICIARIO };
  logger.info(`[consultarWebhookBoleto] GET ${url} | params: ${JSON.stringify(webhookParams)}`);
  try {
    const response = await axios.get(url, {
      params: webhookParams,
      headers: headersCobranca(token),
      timeout: 15000,
    });
    logger.info(`[consultarWebhookBoleto] HTTP ${response.status} | Resposta: ${JSON.stringify(response.data)}`);
    return response.data;
  } catch (err) {
    const status  = err.response ? err.response.status : 'N/A';
    const detalhe = err.response ? JSON.stringify(err.response.data) : err.message;
    logger.error(`[consultarWebhookBoleto] Erro | HTTP ${status} | ${detalhe}`);
    logger.error(`[consultarWebhookBoleto] Stack: ${err.stack}`);
    throw new Error(`HTTP ${status} — ${detalhe}`);
  }
}

async function alterarWebhookBoleto(token, idContrato, webhookUrl) {
  const url = `${SICREDI_BASE_URL}/cobranca/boleto/v1/webhook/contrato/${idContrato}`;
  const alterarPayload = {
    cooperativa:     SICREDI_COOPERATIVA,
    posto:           SICREDI_POSTO,
    codBeneficiario: SICREDI_CODIGO_BENEFICIARIO,
    eventos:         ['LIQUIDACAO'],
    url:             webhookUrl,
    urlStatus:       'ATIVO',
    contratoStatus:  'ATIVO',
    enviarIdTituloEmpresa: true,
  };
  logger.info(`[alterarWebhookBoleto] PUT ${url} | payload: ${JSON.stringify(alterarPayload)}`);
  try {
    const response = await axios.put(url, alterarPayload, {
      headers: headersCobranca(token),
      timeout: 15000,
    });
    logger.info(`[alterarWebhookBoleto] HTTP ${response.status} | idContrato=${idContrato}`);
    logger.info(`[alterarWebhookBoleto] Resposta: ${JSON.stringify(response.data)}`);
    return response.data;
  } catch (err) {
    const status  = err.response ? err.response.status : 'N/A';
    const detalhe = err.response ? JSON.stringify(err.response.data) : err.message;
    logger.error(`Falha ao alterar webhook boleto → HTTP ${status} | ${detalhe}`);
    throw new Error(`HTTP ${status} — ${detalhe}`);
  }
}

module.exports = { autenticar, gerarBoletoHibrido, gerarPixSimples, gerarPdf, gerarPdfParaPasta, consultarFrancesinha, consultarLiquidadosPorPeriodo, consultarBoletosCadastrados, consultarLiquidadosPorDia, registrarWebhookBoleto, consultarWebhookBoleto, alterarWebhookBoleto };
