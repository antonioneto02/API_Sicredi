const axios = require('axios');
const sql   = require('mssql');
const { PDFDocument, rgb } = require('pdf-lib');
const poppler = require('pdf-poppler');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../logger');
const {
  SICREDI_BASE_URL,
  SICREDI_X_API_KEY,
  SICREDI_USERNAME,
  SICREDI_PASSWORD,
  SICREDI_COOPERATIVA,
  SICREDI_POSTO,
  SICREDI_CODIGO_BENEFICIARIO,
  DB_HOST_SD,
  DB_USER_SD,
  DB_PASSWORD_SD,
  DB_NAME_DW,
} = require('../config');

let dwPool = null;
async function getDwPool() {
  if (!dwPool) {
    dwPool = await sql.connect({
      server:   DB_HOST_SD,
      database: DB_NAME_DW,
      user:     DB_USER_SD,
      password: DB_PASSWORD_SD,
      options:  { encrypt: false, trustServerCertificate: true },
      pool:     { max: 3, min: 0, idleTimeoutMillis: 30000 },
    });
  }
  return dwPool;
}

async function buscarFeriados(de, ate) {
  const p = await getDwPool();
  const result = await p.request()
    .input('de',  sql.Date, de)
    .input('ate', sql.Date, ate)
    .query(`SELECT DATA FROM CALENDARIO WHERE FERIADO = 1 AND DATA BETWEEN @de AND @ate`);
  return new Set(result.recordset.map(r => {
    const d = new Date(r.DATA);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }));
}

async function proximoDiaUtil(vencto) {
  const [ano, mes, dia] = vencto.split('-').map(Number);
  const venc = new Date(Date.UTC(ano, mes - 1, dia));
  const de  = new Date(Date.UTC(ano, mes - 1, dia + 1));
  const ate = new Date(Date.UTC(ano, mes - 1, dia + 15));
  const feriados = await buscarFeriados(de, ate);
  const candidato = new Date(venc);
  candidato.setUTCDate(candidato.getUTCDate() + 1);

  for (let i = 0; i < 15; i++) {
    const dow = candidato.getUTCDay(); 
    const str = `${candidato.getUTCFullYear()}-${String(candidato.getUTCMonth() + 1).padStart(2,'0')}-${String(candidato.getUTCDate()).padStart(2,'0')}`;
    if (dow !== 0 && dow !== 6 && !feriados.has(str)) return str;
    candidato.setUTCDate(candidato.getUTCDate() + 1);
  }

  throw new Error('Não foi possível encontrar próximo dia útil nos próximos 15 dias');
}

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

  const dataInicioEncargos = await proximoDiaUtil(dados.vencto);
  logger.info(`Próximo dia útil após vencimento (${dados.vencto}): ${dataInicioEncargos}`);

  const payload = {
    codigoBeneficiario: SICREDI_CODIGO_BENEFICIARIO,
    dataVencimento:     dados.vencto,
    especieDocumento:   'DUPLICATA_MERCANTIL_INDICACAO',
    tipoCobranca:       'HIBRIDO',
    seuNumero:          String(dados.nf),
    valor:              Number(dados.valor),
    pagador:            buildPagador(dados),
    tipoJuros:              'PERCENTUAL',
    tipoJurosPercentual:    'MENSAL',
    juros:                  1.00,
    dataInicioJuros:        dataInicioEncargos,
    tipoMulta:              'PERCENTUAL',
    multa:                  1.00,
    dataInicioMulta:        dataInicioEncargos,
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

async function pdfParaPng(pdfBase64) {
  const tmpDir = os.tmpdir();
  const pdfPath = path.join(tmpDir, `boleto_${Date.now()}.pdf`);
  const outPrefix = path.join(tmpDir, `boleto_${Date.now()}`);

  try {
    fs.writeFileSync(pdfPath, Buffer.from(pdfBase64, 'base64'));

    await poppler.convert(pdfPath, {
      format: 'png',
      out_dir: tmpDir,
      out_prefix: path.basename(outPrefix),
      scale: 1500,
    });

    const arquivos = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith(path.basename(outPrefix)) && f.endsWith('.png'))
      .sort();

    if (arquivos.length === 0) {
      throw new Error('Nenhuma imagem PNG gerada pelo poppler');
    }

    const pngPath = path.join(tmpDir, arquivos[0]);
    const imgBase64 = fs.readFileSync(pngPath).toString('base64');
    
    try { fs.unlinkSync(pdfPath); } catch (_) {}
    for (const arq of arquivos) {
      try { fs.unlinkSync(path.join(tmpDir, arq)); } catch (_) {}
    }

    logger.info(`PDF convertido para PNG com sucesso (${arquivos.length} página(s))`);
    return imgBase64;
  } catch (err) {
    try { fs.unlinkSync(pdfPath); } catch (_) {}
    logger.error(`Erro ao converter PDF para PNG: ${err.message}`);
    throw err;
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

  try {
    const response = await axios.get(url, {
      params,
      headers: {
        ...headersCobranca(token),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 30000,
    });
    logger.info(`Francesinha consultada | data=${dataFormatada} | total=${response.data?.total ?? 0}`);
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
    logger.info(`Boletos cadastrados consultados | ${filtro} | total=${response.data?.length ?? 0}`);
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
  try {
    const response = await axios.get(url, {
      params: {
        codigoBeneficiario: SICREDI_CODIGO_BENEFICIARIO,
        dia: diaFormatado,
      },
      headers: {
        ...headersCobranca(token),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 30000,
    });
    logger.info(`Boletos liquidados consultados | data=${diaFormatado} | total=${response.data?.length ?? 0}`);
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
  try {
    const response = await axios.post(url, {
      cooperativa:     SICREDI_COOPERATIVA,
      posto:           SICREDI_POSTO,
      codBeneficiario: SICREDI_CODIGO_BENEFICIARIO,
      eventos:         ['LIQUIDACAO'],
      url:             webhookUrl,
      urlStatus:       'ATIVO',
      contratoStatus:  'ATIVO',
      enviarIdTituloEmpresa: true,
    }, {
      headers: headersCobranca(token),
      timeout: 15000,
    });
    logger.info(`Webhook boleto registrado | url=${webhookUrl} | HTTP ${response.status}`);
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
  try {
    const response = await axios.get(url, {
      params: {
        cooperativa:  SICREDI_COOPERATIVA,
        posto:        SICREDI_POSTO,
        beneficiario: SICREDI_CODIGO_BENEFICIARIO,
      },
      headers: headersCobranca(token),
      timeout: 15000,
    });
    return response.data;
  } catch (err) {
    const status  = err.response ? err.response.status : 'N/A';
    const detalhe = err.response ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`HTTP ${status} — ${detalhe}`);
  }
}

async function alterarWebhookBoleto(token, idContrato, webhookUrl) {
  const url = `${SICREDI_BASE_URL}/cobranca/boleto/v1/webhook/contrato/${idContrato}`;
  try {
    const response = await axios.put(url, {
      cooperativa:     SICREDI_COOPERATIVA,
      posto:           SICREDI_POSTO,
      codBeneficiario: SICREDI_CODIGO_BENEFICIARIO,
      eventos:         ['LIQUIDACAO'],
      url:             webhookUrl,
      urlStatus:       'ATIVO',
      contratoStatus:  'ATIVO',
      enviarIdTituloEmpresa: true,
    }, {
      headers: headersCobranca(token),
      timeout: 15000,
    });
    logger.info(`Webhook boleto alterado | idContrato=${idContrato} | url=${webhookUrl}`);
    return response.data;
  } catch (err) {
    const status  = err.response ? err.response.status : 'N/A';
    const detalhe = err.response ? JSON.stringify(err.response.data) : err.message;
    logger.error(`Falha ao alterar webhook boleto → HTTP ${status} | ${detalhe}`);
    throw new Error(`HTTP ${status} — ${detalhe}`);
  }
}

module.exports = { autenticar, gerarBoletoHibrido, gerarPixSimples, gerarPdf, cobrirFichaBoleto, pdfParaPng, consultarFrancesinha, consultarLiquidadosPorPeriodo, consultarBoletosCadastrados, consultarLiquidadosPorDia, registrarWebhookBoleto, consultarWebhookBoleto, alterarWebhookBoleto };
