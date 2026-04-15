require('dotenv').config();
const express = require('express');
const http    = require('http');
const { PORT, SICREDI_COOPERATIVA } = require('./config');
const logger   = require('./logger');
const { autenticar, gerarBoletoHibrido, gerarPdf, gerarPdfParaPasta, alterarJuros, consultarFrancesinha, consultarLiquidadosPorPeriodo, consultarBoletosCadastrados, consultarLiquidadosPorDia, registrarWebhookBoleto, consultarWebhookBoleto, alterarWebhookBoleto } = require('./services/sicredi');
const { autenticarPix, gerarBolecodePix, registrarWebhook, consultarWebhook, listarCobrancas } = require('./services/sicredi-pix');
const { verificarElegibilidadePix, salvarPix, salvarBoleto, buscarProximoDiaUtil } = require('./services/database');

const { swaggerUi, swaggerDocument } = require('./swagger');

const app = express();
app.use(express.json());
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

function erro(res, mensagem, status) {
  logger.warn(`HTTP ${status} → ${mensagem}`);
  return res.status(status).json({ erro: mensagem });
}

async function aplicarEncargosComRetry(nossoNumero, nf, tentativas = 6, intervaloMs = 60000) {
  for (let i = 1; i <= tentativas; i++) {
    await new Promise(r => setTimeout(r, intervaloMs));
    try {
      const token = await autenticar();
      await alterarJuros(token, nossoNumero, 2.00);
      logger.info(`Juros aplicado | NF=${nf} | nossoNumero=${nossoNumero}`);
      return true;
    } catch (err) {
      logger.warn(`Juros PATCH tentativa ${i}/${tentativas} | NF=${nf} | ${err.message}`);
    }
  }
  logger.error(`Juros não aplicado após ${tentativas} tentativas | NF=${nf}`);
  return false;
}

async function gerarPdfComRetry(linhaDigitavel, nf, parcela, filial, tentativas = 6, intervaloMs = 10000) {
  for (let i = 1; i <= tentativas; i++) {
    await new Promise(r => setTimeout(r, intervaloMs));
    try {
      const tokenPdf = await autenticar();
      await gerarPdf(linhaDigitavel, nf, tokenPdf, parcela, filial);
      return;
    } catch (err) {
      logger.warn(`PDF tentativa ${i}/${tentativas} | NF=${nf} | Parcela=${parcela || '-'} | ${err.message}`);
    }
  }
  logger.error(`PDF não gerado após ${tentativas} tentativas | NF=${nf} | Parcela=${parcela || '-'}`);
}

function agoraBRT() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', ' BRT').slice(0, 23);
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: agoraBRT() });
});

app.post('/bolecode', async (req, res) => {
  const dados = req.body || {};
  const camposObrigatorios = ['nf', 'valor', 'vencto', 'nome', 'documento', 'tpdoc', 'cep', 'cidade', 'uf', 'frmpag'];
  for (const campo of camposObrigatorios) {
    if (dados[campo] === undefined || dados[campo] === null || dados[campo] === '') {
      return erro(res, `Campo '${campo}' é obrigatório.`, 400);
    }
  }

  const nf      = String(dados.nf).trim();
  const parcela = dados.parcela ? String(dados.parcela).trim().toUpperCase() : null;
  const filial  = String(dados.filial || '').trim() || null;
  logger.info(`=== Requisição boleto recebida | NF=${nf} | Parcela=${parcela || '-'} | Filial=${filial} ===`);
  logger.info(`[POST /bolecode] Body recebido: ${JSON.stringify(dados)}`);

  res.status(200).json({ status: 'recebido' });

  (async () => {
    try {
      logger.info(`[boleto async] Iniciando processamento | NF=${nf} | Parcela=${parcela || '-'}`);
      const token    = await autenticar();
      const dataInicioJuros = await buscarProximoDiaUtil(dados.vencto);
      logger.info(`[boleto async] dataInicioJuros=${dataInicioJuros} | NF=${nf}`);
      const resultado = await gerarBoletoHibrido(token, { ...dados, dataInicioJuros });
      logger.info(`[boleto async] Boleto gerado | NF=${nf} | Parcela=${parcela || '-'} | nossoNumero=${resultado.nossoNumero} | txid=${resultado.txid} | linhaDigitavel=${resultado.linhaDigitavel}`);

      logger.info(`[boleto async] Salvando no banco | NF=${nf} | txid=${resultado.txid} | nossoNumero=${resultado.nossoNumero}`);
      await salvarBoleto(nf, resultado.txid, resultado.qrCode, resultado.nossoNumero, resultado.codigoBarras || resultado.linhaDigitavel, resultado.cooperativa || SICREDI_COOPERATIVA, filial);
      logger.info(`[boleto async] Banco salvo | NF=${nf}`);

      await gerarPdfComRetry(resultado.linhaDigitavel, nf, parcela, filial);
      const jurosOk = await aplicarEncargosComRetry(resultado.nossoNumero, nf);
      if (!jurosOk) {
        logger.error(`[boleto async] Juros não aplicado após todas as tentativas | NF=${nf} | nossoNumero=${resultado.nossoNumero}`);
      }
      logger.info(`[boleto async] Processamento concluído | NF=${nf}`);
    } catch (err) {
      logger.error(`[boleto async] Erro ao processar boleto | NF=${nf} | ${err.message}`);
      logger.error(`[boleto async] Stack: ${err.stack}`);
    }
  })();
});

app.post('/pix', async (req, res) => {
  const dados = req.body || {};
  const camposObrigatorios = ['nf', 'valor', 'filial'];
  for (const campo of camposObrigatorios) {
    if (dados[campo] === undefined || dados[campo] === null || dados[campo] === '') {
      return erro(res, `Campo '${campo}' é obrigatório.`, 400);
    }
  }

  const nf     = String(dados.nf).trim();
  const filial = String(dados.filial || '').trim() || null;
  logger.info(`=== Requisição PIX recebida | NF=${nf} | Filial=${filial || '-'} | valor=${dados.valor} ===`);
  logger.info(`[POST /pix] Body recebido: ${JSON.stringify(dados)}`);

  try {
    await verificarElegibilidadePix(nf, filial);
  } catch (err) {
    logger.warn(`PIX bloqueado | NF=${nf} | Filial=${filial || '-'} | ${err.message}`);
    return erro(res, err.message, 422);
  }

  res.status(200).json({ status: 'recebido' });

  (async () => {
    try {
      logger.info(`[pix async] Iniciando processamento | NF=${nf} | Filial=${filial || '-'}`);
      const token     = await autenticarPix();
      const resultado = await gerarBolecodePix(token, dados);
      logger.info(`[pix async] PIX gerado | NF=${nf} | Filial=${filial || '-'} | txid=${resultado.txid} | pixCopiaECola.length=${(resultado.pixCopiaECola || '').length}`);

      logger.info(`[pix async] Salvando no banco | NF=${nf} | txid=${resultado.txid}`);
      await salvarPix(nf, resultado.txid, resultado.pixCopiaECola, filial);
      logger.info(`[pix async] Processamento concluído | NF=${nf}`);
    } catch (err) {
      logger.error(`[pix async] Erro ao processar PIX | NF=${nf} | ${err.message}`);
      logger.error(`[pix async] Stack: ${err.stack}`);
    }
  })();
});

app.get('/pix/webhook', async (_req, res) => {
  try {
    logger.info(`[GET /pix/webhook] Consultando webhook PIX`);
    const token = await autenticarPix();
    const resultado = await consultarWebhook(token);
    logger.info(`[GET /pix/webhook] OK | resultado=${JSON.stringify(resultado)}`);
    return res.status(200).json(resultado);
  } catch (err) {
    logger.error(`[GET /pix/webhook] Erro: ${err.message}`);
    logger.error(`[GET /pix/webhook] Stack: ${err.stack}`);
    return erro(res, err.message, 502);
  }
});

app.post('/pix/webhook', async (req, res) => {
  const { webhookUrl } = req.body || {};
  if (!webhookUrl) {
    return erro(res, 'Campo webhookUrl é obrigatório.', 400);
  }

  try {
    const token     = await autenticarPix();
    const resultado = await registrarWebhook(token, webhookUrl);
    logger.info(`Webhook PIX registrado | url=${webhookUrl}`);
    return res.status(200).json({ status: 'registrado', resultado: resultado ?? null });
  } catch (err) {
    logger.error(`Erro ao registrar webhook PIX: ${err.message}`);
    return erro(res, err.message, 502);
  }
});

app.get('/boleto/cadastrados', async (req, res) => {
  const { seuNumero, idTituloEmpresa } = req.query;
  if (!seuNumero && !idTituloEmpresa) {
    return erro(res, 'Informe seuNumero ou idTituloEmpresa.', 400);
  }
  if (seuNumero && idTituloEmpresa) {
    return erro(res, 'Informe apenas seuNumero ou idTituloEmpresa, não ambos.', 400);
  }

  try {
    logger.info(`[GET /boleto/cadastrados] seuNumero=${seuNumero || '-'} | idTituloEmpresa=${idTituloEmpresa || '-'}`);
    const token = await autenticar();
    const resultado = await consultarBoletosCadastrados(token, { seuNumero, idTituloEmpresa });
    return res.status(200).json(resultado);
  } catch (err) {
    logger.error(`[GET /boleto/cadastrados] Erro: ${err.message}`);
    logger.error(`[GET /boleto/cadastrados] Stack: ${err.stack}`);
    return erro(res, err.message, 502);
  }
});

app.get('/boleto/teste-gerar', async (req, res) => {
  const linha = String(req.query.linha || '74891160090001460730351462011076214120000001060').trim();
  const outputDir = 'E:\\TOTVS\\Boletos';
  const nomeArquivo = `boleto-teste-${Date.now()}.pdf`;

  try {
    const token = await autenticar();
    const caminho = await gerarPdfParaPasta(linha, token, outputDir, nomeArquivo);
    return res.status(200).json({ status: 'salvo', path: caminho });
  } catch (err) {
    logger.error(`Erro gerar boleto teste: ${err.message}`);
    return erro(res, err.message, 502);
  }
});

app.get('/boleto/francesinha', async (req, res) => {
  const { data, tipoMovimento, pagina } = req.query;
  if (!data) return erro(res, 'Parâmetro data é obrigatório (formato YYYY-MM-DD).', 400);

  try {
    logger.info(`[GET /boleto/francesinha] data=${data} | tipoMovimento=${tipoMovimento || '-'} | pagina=${pagina ?? 0}`);
    const token = await autenticar();
    const resultado = await consultarFrancesinha(token, {
      dataLancamento: data,
      tipoMovimento:  tipoMovimento || undefined,
      pagina:         Number(pagina ?? 0),
    });
    return res.status(200).json(resultado);
  } catch (err) {
    logger.error(`[GET /boleto/francesinha] Erro: ${err.message}`);
    logger.error(`[GET /boleto/francesinha] Stack: ${err.stack}`);
    return erro(res, err.message, 502);
  }
});

app.get('/boleto/liquidados/periodo', async (req, res) => {
  const { dataInicio, dataFim } = req.query;
  if (!dataInicio || !dataFim) {
    return erro(res, 'Parâmetros dataInicio e dataFim são obrigatórios (formato YYYY-MM-DD).', 400);
  }

  try {
    logger.info(`[GET /boleto/liquidados/periodo] dataInicio=${dataInicio} | dataFim=${dataFim}`);
    const token = await autenticar();
    const resultado = await consultarLiquidadosPorPeriodo(token, dataInicio, dataFim);
    return res.status(200).json(resultado);
  } catch (err) {
    logger.error(`[GET /boleto/liquidados/periodo] Erro: ${err.message}`);
    logger.error(`[GET /boleto/liquidados/periodo] Stack: ${err.stack}`);
    return erro(res, err.message, err.message.includes('máximo') || err.message.includes('anterior') ? 400 : 502);
  }
});

app.get('/boleto/liquidados', async (req, res) => {
  const { data } = req.query;
  if (!data) return erro(res, 'Parâmetro data é obrigatório (formato YYYY-MM-DD).', 400);

  try {
    logger.info(`[GET /boleto/liquidados] data=${data}`);
    const token = await autenticar();
    const resultado = await consultarLiquidadosPorDia(token, data);
    return res.status(200).json(resultado);
  } catch (err) {
    logger.error(`[GET /boleto/liquidados] Erro: ${err.message}`);
    logger.error(`[GET /boleto/liquidados] Stack: ${err.stack}`);
    return erro(res, err.message, 502);
  }
});

app.get('/boleto/webhook', async (_req, res) => {
  try {
    logger.info(`[GET /boleto/webhook] Consultando webhook boleto`);
    const token = await autenticar();
    const resultado = await consultarWebhookBoleto(token);
    logger.info(`[GET /boleto/webhook] OK`);
    return res.status(200).json(resultado);
  } catch (err) {
    logger.error(`[GET /boleto/webhook] Erro: ${err.message}`);
    logger.error(`[GET /boleto/webhook] Stack: ${err.stack}`);
    return erro(res, err.message, 502);
  }
});

app.post('/boleto/webhook', async (req, res) => {
  const { webhookUrl } = req.body || {};
  if (!webhookUrl) return erro(res, 'Campo webhookUrl é obrigatório.', 400);

  try {
    logger.info(`[POST /boleto/webhook] Registrando webhook | url=${webhookUrl}`);
    const token = await autenticar();
    const resultado = await registrarWebhookBoleto(token, webhookUrl);
    logger.info(`[POST /boleto/webhook] Webhook boleto registrado | url=${webhookUrl}`);
    return res.status(201).json({ status: 'registrado', resultado });
  } catch (err) {
    logger.error(`[POST /boleto/webhook] Erro: ${err.message}`);
    logger.error(`[POST /boleto/webhook] Stack: ${err.stack}`);
    return erro(res, err.message, 502);
  }
});

app.put('/boleto/webhook/:idContrato', async (req, res) => {
  const { idContrato } = req.params;
  const { webhookUrl } = req.body || {};
  if (!webhookUrl) return erro(res, 'Campo webhookUrl é obrigatório.', 400);

  try {
    logger.info(`[PUT /boleto/webhook/:id] Alterando webhook | idContrato=${idContrato} | url=${webhookUrl}`);
    const token = await autenticar();
    const resultado = await alterarWebhookBoleto(token, idContrato, webhookUrl);
    logger.info(`[PUT /boleto/webhook/:id] Webhook boleto alterado | idContrato=${idContrato}`);
    return res.status(200).json({ status: 'alterado', resultado });
  } catch (err) {
    logger.error(`[PUT /boleto/webhook/:id] Erro: ${err.message}`);
    logger.error(`[PUT /boleto/webhook/:id] Stack: ${err.stack}`);
    return erro(res, err.message, 502);
  }
});

function toBrasiliaUTC(dateStr) {
  const date = new Date(dateStr + (dateStr.includes('Z') || dateStr.includes('+') ? '' : '-03:00'));
  return date.toISOString();
}

app.get('/pix/cobrancas', async (req, res) => {
  const { inicio, fim, status, paginaAtual, itensPorPagina } = req.query;

  if (!inicio || !fim) {
    return erro(res, 'Parâmetros inicio e fim são obrigatórios (formato ISO8601).', 400);
  }

  try {
    logger.info(`[GET /pix/cobrancas] inicio=${inicio} | fim=${fim} | status=${status || 'CONCLUIDA'} | pagina=${paginaAtual ?? 0}`);
    const token     = await autenticarPix();
    const resultado = await listarCobrancas(token, {
      inicio: toBrasiliaUTC(inicio),
      fim:    toBrasiliaUTC(fim),
      status:          status          || 'CONCLUIDA',
      paginaAtual:     Number(paginaAtual     ?? 0),
      itensPorPagina:  Number(itensPorPagina  ?? 100),
    });
    return res.status(200).json(resultado);
  } catch (err) {
    logger.error(`[GET /pix/cobrancas] Erro: ${err.message}`);
    logger.error(`[GET /pix/cobrancas] Stack: ${err.stack}`);
    return erro(res, err.message, 502);
  }
});

http.createServer(app).listen(PORT, () => {
  logger.info(`Sicredi API rodando em http://localhost:${PORT}`);
});
module.exports = app;
