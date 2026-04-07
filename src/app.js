require('dotenv').config();
const express = require('express');
const { PORT, SICREDI_COOPERATIVA } = require('./config');
const logger   = require('./logger');
const { autenticar, gerarBoletoHibrido } = require('./services/sicredi');
const { autenticarPix, gerarBolecodePix } = require('./services/sicredi-pix');
const { notificarCompensacao }            = require('./services/webhook');
const { salvarPix, salvarBoleto }         = require('./services/database');

const app = express();
app.use(express.json());

function erro(res, mensagem, status) {
  logger.warn(`HTTP ${status} → ${mensagem}`);
  return res.status(status).json({ erro: mensagem });
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── BOLETO ──────────────────────────────────────────────────────────────────
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

      const txid        = resultado.txid        || '';
      const emvPix      = resultado.qrCode      || '';
      const nossoNumero = resultado.nossoNumero  || '';
      const codigoBarras = resultado.codigoBarras || resultado.linhaDigitavel || '';
      const agedep      = resultado.cooperativa  || SICREDI_COOPERATIVA || '';

      await salvarBoleto(nf, txid, emvPix, nossoNumero, codigoBarras, agedep);
    } catch (err) {
      logger.error(`Erro ao processar boleto | NF=${nf} | ${err.message}`);
    }
  })();
});

// ─── PIX ─────────────────────────────────────────────────────────────────────
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

// ─── WEBHOOK SICREDI ─────────────────────────────────────────────────────────
app.post('/webhook/sicredi', (req, res) => {
  const payload       = req.body || {};
  const nossoNumero   = payload.nossoNumero   || payload.nosso_numero   || '?';
  const seuNumero     = payload.seuNumero     || payload.seu_numero     || '?';
  const situacao      = payload.situacao      || '?';
  const valorPago     = payload.valorPago     || payload.valor_pago     || '?';
  const dataPagamento = payload.dataPagamento || payload.data_pagamento || '?';

  logger.info(`Webhook Sicredi recebido | nossoNumero=${nossoNumero} | seuNumero=${seuNumero} | situacao=${situacao} | valorPago=${valorPago} | dataPagamento=${dataPagamento}`);
  logger.info(`Payload completo: ${JSON.stringify(payload)}`);
  res.sendStatus(200);
  notificarCompensacao(payload).catch((err) =>
    logger.error(`Encaminhamento de compensação falhou: ${err.message}`)
  );
});

app.listen(PORT, () => {
  logger.info(`Sicredi API rodando em http://localhost:${PORT}`);
});
module.exports = app;
