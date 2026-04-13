const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const logger = require('../logger');

const PDFS_DIR = path.join(__dirname, '..', '..', 'pdfs');
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
    codigoBeneficiario:     SICREDI_CODIGO_BENEFICIARIO,
    dataVencimento:         dados.vencto,
    especieDocumento:       'DUPLICATA_MERCANTIL_INDICACAO',
    tipoCobranca:           'HIBRIDO',
    seuNumero:              dados.parcela ? `${dados.nf}-${dados.parcela}` : String(dados.nf),
    valor:                  Number(dados.valor),
    pagador:                buildPagador(dados),
    validadeAposVencimento: 30,
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
    seuNumero:          String(dados.nf),
    valor:              Number(dados.valor),
    pagador:            buildPagador(dados),
  };
  logger.info(`Gerando PIX SIMPLES | NF=${dados.nf} | Valor=${dados.valor}`);
  const resultado = await chamarSicredi(url, payload, token);
  logger.info(`Resposta Sicredi pix: ${JSON.stringify(resultado)}`);
  return resultado;
}

async function gerarPdf(linhaDigitavel, nf, token, parcela) {
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

    // Pasta: pdfs/{nf}/   Arquivo: {nf}BOL.pdf ou {nf}{parcela}BOL.pdf
    const nfDir   = path.join(PDFS_DIR, nf);
    if (!fs.existsSync(nfDir)) fs.mkdirSync(nfDir, { recursive: true });
    const sufixo  = parcela ? `${parcela.toUpperCase()}BOL` : 'BOL';
    const pdfPath = path.join(nfDir, `${nf}${sufixo}.pdf`);
    fs.writeFileSync(pdfPath, Buffer.from(response.data));
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

// PATCH /boletos/{nossoNumero}/juros — body aceita apenas valorOuPercentual (conforme doc 7.8)
async function alterarJuros(token, nossoNumero, valorOuPercentual) {
  const url = `${SICREDI_BASE_URL}/cobranca/boleto/v1/boletos/${nossoNumero}/juros`;
  try {
    const response = await axios.patch(url, { valorOuPercentual }, {
      headers: {
        ...headersCobranca(token),
        'codigoBeneficiario': SICREDI_CODIGO_BENEFICIARIO,
      },
      timeout: 15000,
    });
    logger.info(`Juros aplicado via PATCH | nossoNumero=${nossoNumero} | valor=${valorOuPercentual}% | HTTP ${response.status}`);
    return response.data;
  } catch (err) {
    const status  = err.response ? err.response.status : 'N/A';
    const detalhe = err.response ? JSON.stringify(err.response.data) : err.message;
    logger.error(`Falha ao aplicar juros via PATCH → HTTP ${status} | nossoNumero=${nossoNumero} | ${detalhe}`);
    throw new Error(`HTTP ${status} — ${detalhe}`);
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

module.exports = { autenticar, gerarBoletoHibrido, gerarPixSimples, gerarPdf, alterarJuros, consultarFrancesinha, consultarLiquidadosPorPeriodo, consultarBoletosCadastrados, consultarLiquidadosPorDia, registrarWebhookBoleto, consultarWebhookBoleto, alterarWebhookBoleto };
