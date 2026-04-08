require('dotenv').config();
const express = require('express');
const http    = require('http');
const { PORT, SICREDI_COOPERATIVA } = require('./config');
const logger   = require('./logger');
const { autenticar, gerarBoletoHibrido, consultarFrancesinha, consultarLiquidadosPorPeriodo, consultarBoletosCadastrados, consultarLiquidadosPorDia, registrarWebhookBoleto, consultarWebhookBoleto, alterarWebhookBoleto } = require('./services/sicredi');
const { autenticarPix, gerarBolecodePix, registrarWebhook, consultarWebhook, listarCobrancas } = require('./services/sicredi-pix');
const { verificarElegibilidadePix, salvarPix, salvarBoleto } = require('./services/database');

const app = express();
app.use(express.json());

function erro(res, mensagem, status) {
  logger.warn(`HTTP ${status} → ${mensagem}`);
  return res.status(status).json({ erro: mensagem });
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

  const nf     = String(dados.nf).trim();
  const filial = String(dados.filial || '').trim() || null;
  logger.info(`=== Requisição boleto recebida | NF=${nf} | Filial=${filial} ===`);

  res.status(200).json({ status: 'recebido' });

  (async () => {
    try {
      const token     = await autenticar();
      const resultado = await gerarBoletoHibrido(token, dados);
      logger.info(`Boleto gerado | NF=${nf} | nossoNumero=${resultado.nossoNumero}`);

      await salvarBoleto(nf, resultado.txid, resultado.qrCode, resultado.nossoNumero, resultado.codigoBarras || resultado.linhaDigitavel, resultado.cooperativa || SICREDI_COOPERATIVA);
    } catch (err) {
      logger.error(`Erro ao processar boleto | NF=${nf} | ${err.message}`);
    }
  })();
});

app.post('/pix', async (req, res) => {
  const dados = req.body || {};
  const camposObrigatorios = ['nf', 'valor'];
  for (const campo of camposObrigatorios) {
    if (dados[campo] === undefined || dados[campo] === null || dados[campo] === '') {
      return erro(res, `Campo '${campo}' é obrigatório.`, 400);
    }
  }

  const nf = String(dados.nf).trim();
  logger.info(`=== Requisição PIX recebida | NF=${nf} ===`);

  try {
    await verificarElegibilidadePix(nf);
  } catch (err) {
    logger.warn(`PIX bloqueado | NF=${nf} | ${err.message}`);
    return erro(res, err.message, 422);
  }

  res.status(200).json({ status: 'recebido' });

  (async () => {
    try {
      const token     = await autenticarPix();
      const resultado = await gerarBolecodePix(token, dados);
      logger.info(`PIX gerado | NF=${nf} | txid=${resultado.txid}`);

      await salvarPix(nf, resultado.txid, resultado.pixCopiaECola);
    } catch (err) {
      logger.error(`Erro ao processar PIX | NF=${nf} | ${err.message}`);
    }
  })();
});

app.get('/pix/webhook', async (_req, res) => {
  try {
    const token = await autenticarPix();
    const resultado = await consultarWebhook(token);
    return res.status(200).json(resultado);
  } catch (err) {
    logger.error(`Erro ao consultar webhook PIX: ${err.message}`);
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
    const token = await autenticar();
    const resultado = await consultarBoletosCadastrados(token, { seuNumero, idTituloEmpresa });
    return res.status(200).json(resultado);
  } catch (err) {
    logger.error(`Erro ao consultar boletos cadastrados: ${err.message}`);
    return erro(res, err.message, 502);
  }
});

app.get('/boleto/francesinha', async (req, res) => {
  const { data, tipoMovimento, pagina } = req.query;
  if (!data) return erro(res, 'Parâmetro data é obrigatório (formato YYYY-MM-DD).', 400);

  try {
    const token = await autenticar();
    const resultado = await consultarFrancesinha(token, {
      dataLancamento: data,
      tipoMovimento:  tipoMovimento || undefined,
      pagina:         Number(pagina ?? 0),
    });
    return res.status(200).json(resultado);
  } catch (err) {
    logger.error(`Erro ao consultar francesinha: ${err.message}`);
    return erro(res, err.message, 502);
  }
});

app.get('/boleto/liquidados/periodo', async (req, res) => {
  const { dataInicio, dataFim } = req.query;
  if (!dataInicio || !dataFim) {
    return erro(res, 'Parâmetros dataInicio e dataFim são obrigatórios (formato YYYY-MM-DD).', 400);
  }

  try {
    const token = await autenticar();
    const resultado = await consultarLiquidadosPorPeriodo(token, dataInicio, dataFim);
    return res.status(200).json(resultado);
  } catch (err) {
    logger.error(`Erro ao consultar liquidados por período: ${err.message}`);
    return erro(res, err.message, err.message.includes('máximo') || err.message.includes('anterior') ? 400 : 502);
  }
});

app.get('/boleto/liquidados', async (req, res) => {
  const { data } = req.query;
  if (!data) return erro(res, 'Parâmetro data é obrigatório (formato YYYY-MM-DD).', 400);

  try {
    const token = await autenticar();
    const resultado = await consultarLiquidadosPorDia(token, data);
    return res.status(200).json(resultado);
  } catch (err) {
    logger.error(`Erro ao consultar boletos liquidados: ${err.message}`);
    return erro(res, err.message, 502);
  }
});

app.get('/boleto/webhook', async (_req, res) => {
  try {
    const token = await autenticar();
    const resultado = await consultarWebhookBoleto(token);
    return res.status(200).json(resultado);
  } catch (err) {
    logger.error(`Erro ao consultar webhook boleto: ${err.message}`);
    return erro(res, err.message, 502);
  }
});

app.post('/boleto/webhook', async (req, res) => {
  const { webhookUrl } = req.body || {};
  if (!webhookUrl) return erro(res, 'Campo webhookUrl é obrigatório.', 400);

  try {
    const token = await autenticar();
    const resultado = await registrarWebhookBoleto(token, webhookUrl);
    logger.info(`Webhook boleto registrado | url=${webhookUrl}`);
    return res.status(201).json({ status: 'registrado', resultado });
  } catch (err) {
    logger.error(`Erro ao registrar webhook boleto: ${err.message}`);
    return erro(res, err.message, 502);
  }
});

app.put('/boleto/webhook/:idContrato', async (req, res) => {
  const { idContrato } = req.params;
  const { webhookUrl } = req.body || {};
  if (!webhookUrl) return erro(res, 'Campo webhookUrl é obrigatório.', 400);

  try {
    const token = await autenticar();
    const resultado = await alterarWebhookBoleto(token, idContrato, webhookUrl);
    logger.info(`Webhook boleto alterado | idContrato=${idContrato} | url=${webhookUrl}`);
    return res.status(200).json({ status: 'alterado', resultado });
  } catch (err) {
    logger.error(`Erro ao alterar webhook boleto: ${err.message}`);
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
    logger.error(`Erro ao listar cobranças PIX: ${err.message}`);
    return erro(res, err.message, 502);
  }
});

http.createServer(app).listen(PORT, () => {
  logger.info(`Sicredi API rodando em http://localhost:${PORT}`);
});
module.exports = app;
