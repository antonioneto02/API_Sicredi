const axios  = require('axios');
const logger = require('../logger');
const { WEBHOOK_URL, WEBHOOK_COMPENSACAO_URL } = require('../config');

async function notificar(payload) {
  if (!WEBHOOK_URL) {
    logger.warn('WEBHOOK_URL não configurado — notificação ignorada.');
    return false;
  }

  try {
    const response = await axios.post(WEBHOOK_URL, payload, { timeout: 10000 });
    logger.info(`Webhook notificado com sucesso. Status: ${response.status}`);
    return true;
  } catch (err) {
    logger.error(`Falha ao notificar webhook: ${err.message}`);
    return false;
  }
}

async function notificarCompensacao(payload) {
  if (!WEBHOOK_COMPENSACAO_URL) {
    logger.warn('WEBHOOK_COMPENSACAO_URL não configurado — notificação de compensação ignorada.');
    return false;
  }

  try {
    const response = await axios.post(WEBHOOK_COMPENSACAO_URL, payload, { timeout: 10000 });
    logger.info(`Compensação notificada com sucesso. Status: ${response.status}`);
    return true;
  } catch (err) {
    logger.error(`Falha ao notificar compensação: ${err.message}`);
    return false;
  }
}

module.exports = { notificar, notificarCompensacao };
