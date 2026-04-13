# 🏦 API Sicredi

> API intermediária para integração bancária com o banco Sicredi — geração de boletos híbridos (boleto + QR PIX), PIX avulso, PDFs e gerenciamento de webhooks.

## 📋 Sobre o Projeto

A **API Sicredi** é uma camada intermediária que recebe requisições do ERP Protheus e se comunica com a API oficial do banco Sicredi para gerar cobranças. O principal objetivo é simplificar o processo de geração de **bolecodes** (boletos híbridos com QR Code PIX embutido), permitindo que o cliente pague via boleto tradicional ou PIX pelo mesmo documento.

Além da geração de cobranças, o sistema:
- Gera PDFs dos boletos com QR Code
- Aplica encargos (multa/juros) automaticamente após a geração
- Gerencia webhooks para receber notificações de liquidação
- Consulta movimentações (francesinha) e boletos liquidados
- Salva todos os dados no SQL Server para rastreabilidade

## 🛠️ Tecnologias

| Tecnologia | Descrição |
|---|---|
| **Node.js** | Runtime JavaScript |
| **Express** | Framework web |
| **axios** | Cliente HTTP para chamar API Sicredi |
| **mssql** | Driver SQL Server |
| **pdfkit / pdf-lib** | Geração de PDFs de boletos |
| **qrcode** | Geração de QR Codes PIX |
| **winston** | Logs estruturados |
| **Swagger UI** | Documentação interativa |
| **PM2** | Gerenciador de processos (`api-sicredi`) |
| **Porta** | `3012` |

## 🔧 Como Funciona

1. O **Protheus** envia uma requisição `POST /bolecode` com os dados da cobrança (NF, valor, vencimento, dados do sacado)
2. A API autentica na API do Sicredi (OAuth2 — `grant_type=password`)
3. Gera o **boleto híbrido** (boleto + QR PIX) na API do Sicredi
4. Salva os dados do boleto/PIX no **SQL Server**
5. Em background (após responder `200 recebido`):
   - **Gera o PDF** do boleto com QR Code (com retry de até 6 tentativas)
   - **Aplica juros/multa** via PATCH na API Sicredi (com retry de até 6 tentativas)
6. Para **PIX avulso**, o fluxo é similar mas sem geração de PDF
7. Webhooks do Sicredi notificam sobre liquidações de boletos e PIX

## 📡 Endpoints

### Geração de Cobranças

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/bolecode` | Gera boleto híbrido (boleto + QR PIX). Retorna `200 recebido` e processa em background |
| `POST` | `/pix` | Gera cobrança PIX avulsa. Verifica elegibilidade antes de gerar |

### Consultas de Boletos

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/boleto/cadastrados` | Consulta boletos por `seuNumero` ou `idTituloEmpresa` |
| `GET` | `/boleto/francesinha` | Consulta movimentações (francesinha) por data |
| `GET` | `/boleto/liquidados` | Consulta boletos liquidados em uma data específica |
| `GET` | `/boleto/liquidados/periodo` | Consulta boletos liquidados em um período (dataInicio/dataFim) |

### Consultas de PIX

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/pix/cobrancas` | Lista cobranças PIX por período, com paginação |

### Webhooks

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/boleto/webhook` | Consulta webhook de boleto registrado |
| `POST` | `/boleto/webhook` | Registra novo webhook de boleto |
| `PUT` | `/boleto/webhook/:idContrato` | Altera webhook de boleto existente |
| `GET` | `/pix/webhook` | Consulta webhook de PIX registrado |
| `POST` | `/pix/webhook` | Registra novo webhook de PIX |

### Outros

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/health` | Health check da API |
| `GET` | `/docs` | Documentação Swagger |

## 🗄️ Banco de Dados

| Banco | Tipo | Uso |
|---|---|---|
| SQL Server (Protheus) | mssql | Salva dados de boletos e PIX gerados (NF, TXID, QR Code, nossoNumero, código de barras, cooperativa, filial) |

## 🔗 Integrações

| Sistema | Tipo | Descrição |
|---|---|---|
| **API Sicredi (Boleto)** | REST API | Geração de boletos, consulta de francesinha, liquidações, webhooks |
| **API Sicredi (PIX)** | REST API | Geração de cobranças PIX, webhooks, listagem de cobranças |
| **Protheus ERP** | Origem dos dados | Envia requisições de geração de boleto/PIX |

## ⚙️ Variáveis de Ambiente

```env
PORT=3012                          # Porta do servidor

# API Sicredi - Produção
SICREDI_BASE_URL=                  # URL base da API Sicredi
SICREDI_X_API_KEY=                 # Chave de API
SICREDI_USERNAME=                  # Usuário de autenticação
SICREDI_PASSWORD=                  # Senha de autenticação

# API Sicredi - Sandbox
SICREDI_BASE_URL_SANDBOX=          # URL base sandbox
SICREDI_X_API_KEY_SANDBOX=         # Chave de API sandbox
SICREDI_USERNAME_SANDBOX=          # Usuário sandbox
SICREDI_PASSWORD_SANDBOX=          # Senha sandbox

# Configuração do beneficiário
SICREDI_COOPERATIVA=               # Código da cooperativa
SICREDI_POSTO=                     # Código do posto
SICREDI_CODIGO_BENEFICIARIO=       # Código do beneficiário

# Ambiente (producao / sandbox)
SICREDI_BOLETO_ENV=producao        # Ambiente de boleto
SICREDI_PIX_ENV=producao           # Ambiente de PIX

# Webhooks
WEBHOOK_URL=                       # URL do webhook de boleto
WEBHOOK_COMPENSACAO_URL=           # URL do webhook de compensação

# Banco de dados SQL Server
DB_USER=                           # Usuário do banco
DB_PASSWORD=                       # Senha do banco
DB_SERVER=                         # Host do SQL Server
DB_DATABASE=                       # Nome do banco
```

## 🚀 Como Rodar

```bash
# 1. Instalar dependências
npm install

# 2. Configurar variáveis de ambiente
# Copiar e preencher o arquivo .env

# 3. Certificados
# O projeto requer certificados SSL para autenticação com a API Sicredi:
# - 76490572000168.cer (certificado do beneficiário)
# - api-pix-cini.key (chave privada)

# 4. Rodar em desenvolvimento
npm run dev

# 5. Rodar em produção com PM2
pm2 start src/app.js --name api-sicredi

# 6. Acessar
# http://localhost:3012
# Documentação: http://localhost:3012/docs
```
