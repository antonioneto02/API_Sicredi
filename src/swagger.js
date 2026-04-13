const swaggerUi = require('swagger-ui-express');

const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'API Sicredi — Boletos e PIX',
    version: '1.0.0',
    description: 'API para geração de boletos híbridos e cobranças PIX via Sicredi. Não requer autenticação externa — autentica internamente com o Sicredi usando certificados configurados no servidor.',
  },
  servers: [{ url: 'http://localhost:3001', description: 'Servidor local' }],
  tags: [
    { name: 'Saúde', description: 'Status da API' },
    { name: 'Boleto', description: 'Emissão e consulta de boletos' },
    { name: 'PIX', description: 'Cobranças PIX' },
    { name: 'Webhook', description: 'Gestão de webhooks' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['Saúde'],
        summary: 'Verifica se a API está no ar',
        responses: {
          200: { description: 'API operacional', content: { 'application/json': { example: { status: 'ok', timestamp: '2024-01-10 14:30:00 BRT' } } } },
        },
      },
    },
    '/bolecode': {
      post: {
        tags: ['Boleto'],
        summary: 'Gera boleto híbrido (boleto + QR Code PIX)',
        description: 'Processa de forma assíncrona. Responde imediatamente com `status: recebido` e gera o boleto em background, incluindo PDF e aplicação de juros.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['nf', 'valor', 'vencto', 'nome', 'documento', 'tpdoc', 'cep', 'cidade', 'uf', 'frmpag'],
                properties: {
                  nf:        { type: 'string', description: 'Número da nota fiscal', example: '123456' },
                  parcela:   { type: 'string', description: 'Parcela (ex: A, B)', example: 'A' },
                  filial:    { type: 'string', description: 'Código da filial', example: '01' },
                  valor:     { type: 'number', description: 'Valor do boleto', example: 1500.00 },
                  vencto:    { type: 'string', description: 'Data de vencimento (YYYY-MM-DD)', example: '2024-02-10' },
                  nome:      { type: 'string', description: 'Nome do pagador', example: 'Empresa XYZ Ltda' },
                  documento: { type: 'string', description: 'CPF ou CNPJ do pagador', example: '12345678000195' },
                  tpdoc:     { type: 'string', enum: ['CPF', 'CNPJ'], description: 'Tipo do documento' },
                  cep:       { type: 'string', example: '80000000' },
                  cidade:    { type: 'string', example: 'Curitiba' },
                  uf:        { type: 'string', example: 'PR' },
                  frmpag:    { type: 'string', description: 'Forma de pagamento', example: 'DUP' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Solicitação recebida — processamento assíncrono', content: { 'application/json': { example: { status: 'recebido' } } } },
          400: { description: 'Campo obrigatório ausente' },
        },
      },
    },
    '/pix': {
      post: {
        tags: ['PIX'],
        summary: 'Gera cobrança PIX',
        description: 'Verifica elegibilidade e gera QR Code PIX assincronamente.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['nf', 'valor'],
                properties: {
                  nf:     { type: 'string', example: '123456' },
                  valor:  { type: 'number', example: 500.00 },
                  filial: { type: 'string', example: '01' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Solicitação recebida', content: { 'application/json': { example: { status: 'recebido' } } } },
          400: { description: 'Campo obrigatório ausente' },
          422: { description: 'PIX não elegível para esta NF' },
        },
      },
    },
    '/pix/cobrancas': {
      get: {
        tags: ['PIX'],
        summary: 'Lista cobranças PIX por período',
        parameters: [
          { name: 'inicio', in: 'query', required: true, schema: { type: 'string' }, description: 'Data/hora início ISO8601', example: '2024-01-01T00:00:00' },
          { name: 'fim',    in: 'query', required: true, schema: { type: 'string' }, description: 'Data/hora fim ISO8601',   example: '2024-01-31T23:59:59' },
          { name: 'status', in: 'query', schema: { type: 'string', default: 'CONCLUIDA' }, description: 'Filtro de status' },
          { name: 'paginaAtual',    in: 'query', schema: { type: 'integer', default: 0 } },
          { name: 'itensPorPagina', in: 'query', schema: { type: 'integer', default: 100 } },
        ],
        responses: {
          200: { description: 'Lista de cobranças' },
          400: { description: 'Parâmetros obrigatórios ausentes' },
          502: { description: 'Erro na comunicação com Sicredi' },
        },
      },
    },
    '/pix/webhook': {
      get: {
        tags: ['Webhook'],
        summary: 'Consulta webhook PIX cadastrado',
        responses: { 200: { description: 'Dados do webhook' }, 502: { description: 'Erro Sicredi' } },
      },
      post: {
        tags: ['Webhook'],
        summary: 'Registra URL de webhook para notificações PIX',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['webhookUrl'], properties: { webhookUrl: { type: 'string', format: 'uri', example: 'https://meusite.com.br/pix/callback' } } } } },
        },
        responses: { 200: { description: 'Webhook registrado' }, 400: { description: 'webhookUrl ausente' }, 502: { description: 'Erro Sicredi' } },
      },
    },
    '/boleto/cadastrados': {
      get: {
        tags: ['Boleto'],
        summary: 'Consulta boletos cadastrados no Sicredi',
        parameters: [
          { name: 'seuNumero',        in: 'query', schema: { type: 'string' }, description: 'Número do título' },
          { name: 'idTituloEmpresa',  in: 'query', schema: { type: 'string' }, description: 'ID interno da empresa' },
        ],
        responses: { 200: { description: 'Dados do boleto' }, 400: { description: 'Parâmetro inválido' }, 502: { description: 'Erro Sicredi' } },
      },
    },
    '/boleto/francesinha': {
      get: {
        tags: ['Boleto'],
        summary: 'Consulta francesinha (extrato de lançamentos)',
        parameters: [
          { name: 'data',          in: 'query', required: true, schema: { type: 'string' }, description: 'Data (YYYY-MM-DD)', example: '2024-01-10' },
          { name: 'tipoMovimento', in: 'query', schema: { type: 'string' }, description: 'Tipo de movimento' },
          { name: 'pagina',        in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: { 200: { description: 'Lançamentos do dia' }, 400: { description: 'Data ausente' }, 502: { description: 'Erro Sicredi' } },
      },
    },
    '/boleto/liquidados': {
      get: {
        tags: ['Boleto'],
        summary: 'Consulta boletos liquidados em um dia',
        parameters: [{ name: 'data', in: 'query', required: true, schema: { type: 'string' }, description: 'Data (YYYY-MM-DD)', example: '2024-01-10' }],
        responses: { 200: { description: 'Boletos liquidados' }, 400: { description: 'Data ausente' }, 502: { description: 'Erro Sicredi' } },
      },
    },
    '/boleto/liquidados/periodo': {
      get: {
        tags: ['Boleto'],
        summary: 'Consulta boletos liquidados em um período',
        parameters: [
          { name: 'dataInicio', in: 'query', required: true, schema: { type: 'string' }, example: '2024-01-01' },
          { name: 'dataFim',    in: 'query', required: true, schema: { type: 'string' }, example: '2024-01-31' },
        ],
        responses: { 200: { description: 'Boletos do período' }, 400: { description: 'Parâmetros ausentes' }, 502: { description: 'Erro Sicredi' } },
      },
    },
    '/boleto/webhook': {
      get: {
        tags: ['Webhook'],
        summary: 'Consulta webhook de boleto cadastrado',
        responses: { 200: { description: 'Dados do webhook' }, 502: { description: 'Erro Sicredi' } },
      },
      post: {
        tags: ['Webhook'],
        summary: 'Registra URL de webhook para notificações de boleto',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['webhookUrl'], properties: { webhookUrl: { type: 'string', format: 'uri' } } } } },
        },
        responses: { 201: { description: 'Webhook registrado' }, 400: { description: 'webhookUrl ausente' }, 502: { description: 'Erro Sicredi' } },
      },
    },
    '/boleto/webhook/{idContrato}': {
      put: {
        tags: ['Webhook'],
        summary: 'Atualiza webhook de boleto de um contrato',
        parameters: [{ name: 'idContrato', in: 'path', required: true, schema: { type: 'string' }, description: 'ID do contrato Sicredi' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['webhookUrl'], properties: { webhookUrl: { type: 'string', format: 'uri' } } } } },
        },
        responses: { 200: { description: 'Webhook atualizado' }, 400: { description: 'webhookUrl ausente' }, 502: { description: 'Erro Sicredi' } },
      },
    },
  },
};

module.exports = { swaggerUi, swaggerDocument };
