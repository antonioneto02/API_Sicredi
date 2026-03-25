require('dotenv').config();
const express = require('express');
const { PORT } = require('./config');
const logger   = require('./logger');
const { autenticar, gerarBoletoHibrido, gerarPixSimples, gerarPdf, cobrirFichaBoleto } = require('./services/sicredi');
const { notificar, notificarCompensacao } = require('./services/webhook');
const app = express();
app.use(express.json());

function erro(res, mensagem, status) {
  logger.warn(`HTTP ${status} → ${mensagem}`);
  return res.status(status).json({ erro: mensagem });
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
  const frmpag = String(dados.frmpag || '').trim().toUpperCase();
  logger.info(`=== Iniciando geração de cobrança | NF=${nf} | Filial=${filial} | frmpag=${frmpag} ===`);

  let token;
  try {
    token = await autenticar();
  } catch (err) {
    return erro(res, err.message, 502);
  }

  let resultado;
  let tipoGerado;
  try {
    if (frmpag === 'BOL') {
      resultado  = await gerarBoletoHibrido(token, dados);
      tipoGerado = 'HIBRIDO';
    } else {
      resultado  = await gerarPixSimples(token, dados);
      tipoGerado = 'PIX_SIMPLES';
    }
  } catch (err) {
    return erro(res, `Sicredi retornou erro: ${err.message}`, 502);
  }

  const ehBoleto = frmpag === 'BOL';
  let pdfBase64 = null;
  if (resultado.linhaDigitavel) {
    const tentativas = 5;
    const intervalo  = 3000;
    for (let i = 1; i <= tentativas; i++) {
      await new Promise(resolve => setTimeout(resolve, intervalo));
      try {
        pdfBase64 = await gerarPdf(resultado.linhaDigitavel, token);
        if (!ehBoleto) pdfBase64 = await cobrirFichaBoleto(pdfBase64);
        break;
      } catch (err) {
        logger.warn(`Tentativa ${i}/${tentativas} de gerar PDF falhou: ${err.message}`);
        if (i === tentativas) logger.error('PDF não gerado após todas as tentativas.');
      }
    }
  }

  const resposta = {
    nf,
    nosso_numero:    resultado.nossoNumero                         || null,
    linha_digitavel: ehBoleto ? (resultado.linhaDigitavel || null) : undefined,
    qr_code_url:     resultado.qrCode                             || null,
    pdf_base64:      pdfBase64,
  };

  notificar(resposta).catch((err) => logger.error(`Webhook falhou: ${err.message}`));
  logger.info(`=== Cobrança gerada | NF=${nf} | Tipo=${tipoGerado} | nossoNumero=${resposta.nosso_numero} ===`);
  return res.json(resposta);
});

// Webhook receptor — Sicredi notifica aqui quando um boleto é compensado
app.post('/webhook/sicredi', (req, res) => {
  const payload = req.body || {};
  const nossoNumero  = payload.nossoNumero  || payload.nosso_numero  || '?';
  const seuNumero    = payload.seuNumero    || payload.seu_numero    || '?';
  const situacao     = payload.situacao     || '?';
  const valorPago    = payload.valorPago    || payload.valor_pago    || '?';
  const dataPagamento = payload.dataPagamento || payload.data_pagamento || '?';

  logger.info(`Webhook Sicredi recebido | nossoNumero=${nossoNumero} | seuNumero=${seuNumero} | situacao=${situacao} | valorPago=${valorPago} | dataPagamento=${dataPagamento}`);
  logger.info(`Payload completo: ${JSON.stringify(payload)}`);

  // Responde 200 imediatamente para o Sicredi não retentar
  res.sendStatus(200);

  // Encaminha assincronamente para o sistema interno (ERP)
  notificarCompensacao(payload).catch((err) =>
    logger.error(`Encaminhamento de compensação falhou: ${err.message}`)
  );
});

app.listen(PORT, () => {
  logger.info(`Sicredi API rodando em http://localhost:${PORT}`);
});
module.exports = app;
