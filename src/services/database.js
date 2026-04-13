const sql    = require('mssql');
const logger = require('../logger');

const config = {
  server:   process.env.DB_HOST_SD,
  database: process.env.DB_NAME_SD,
  user:     process.env.DB_USER_SD,
  password: process.env.DB_PASSWORD_SD,
  options: {
    encrypt:                false,
    trustServerCertificate: true,
    enableArithAbort:       true,
    database:               process.env.DB_NAME_SD,
  },
  pool: {
    max:                5,
    min:                0,
    idleTimeoutMillis:  30000,
  },
};

let pool = null;

async function getPool() {
  if (!pool) {
    logger.info(`Conectando ao banco | server=${config.server} | database=${config.database} | user=${config.user}`);
    pool = await new sql.ConnectionPool(config).connect();
    const dbCheck = await pool.request().query(`SELECT DB_NAME() AS banco`);
    logger.info(`Banco de dados conectado: ${dbCheck.recordset[0].banco}`);
  }
  return pool;
}

async function verificarElegibilidadePix(nf, filial) {
  const p = await getPool();
  const result = await p.request()
    .input('nf',     sql.VarChar(20), nf)
    .input('filial', sql.VarChar(10), filial || null)
    .query(`
      SELECT F71_STATUS, F71_IDTRAN
      FROM   F71010
      WHERE  F71_NUM     = @nf
        AND  D_E_L_E_T_  = ' '
        AND  F71_STATUS  = '5'
        AND  F71_STATUS <> '1'
        AND  (@filial IS NULL OR F71_FILIAL = @filial)
    `);

  if (result.recordset.length === 0) {
    throw new Error(`NF ${nf} não encontrada na F71010${filial ? ` (filial ${filial})` : ''}.`);
  }

  const row    = result.recordset[0];
  const status = String(row.F71_STATUS || '').trim();
  const idtran = String(row.F71_IDTRAN || '').trim();

  if (status !== '5') {
    throw new Error(`NF ${nf} com status '${status}' na F71010 — esperado '5'.`);
  }
  if (idtran !== '') {
    throw new Error(`NF ${nf} já possui IDTRAN preenchido na F71010: '${idtran}'.`);
  }
}

async function salvarPix(nf, txid, emvPix, filial) {
  const p = await getPool();
  await p.request()
    .input('txid',   sql.VarChar(50),  txid   || '')
    .input('emv',    sql.VarChar(500), emvPix || '')
    .input('nf',     sql.VarChar(20),  nf)
    .input('filial', sql.VarChar(10),  filial || null)
    .query(`
      UPDATE F71010
      SET    F71_STATUS = '3',
             F71_IDTRAN = @txid,
             F71_EMVPIX = CONVERT(varbinary(MAX),@emv)
      WHERE  F71_NUM     = @nf
        AND  D_E_L_E_T_  = ' '
        AND  (@filial IS NULL OR F71_FILIAL = @filial)
    `);
  logger.info(`F71010 atualizado | NF=${nf} | Filial=${filial || '-'} | txid=${txid}`);
}

async function salvarBoleto(nf, txid, emvPix, nossoNumero, codigoBarras, agedep, filial) {
  const p = await getPool();
  await p.request()
    .input('txid',   sql.VarChar(50),  txid   || '')
    .input('emv',    sql.VarChar(500), emvPix || '')
    .input('nf',     sql.VarChar(20),  nf)
    .input('filial', sql.VarChar(10),  filial || null)
    .query(`
      UPDATE F71010
      SET    F71_STATUS = '3',
             F71_IDTRAN = @txid,
             F71_EMVPIX = CONVERT(varbinary(MAX), @emv)
      WHERE  F71_NUM     = @nf
        AND  D_E_L_E_T_  = ' '
        AND  (@filial IS NULL OR F71_FILIAL = @filial)
    `);
  logger.info(`F71010 atualizado | NF=${nf} | Filial=${filial || '-'}`);

  const p2 = await getPool();
  await p2.request()
    .input('numbco', sql.VarChar(20),  nossoNumero  || '')
    .input('codbar', sql.VarChar(60),  codigoBarras || '')
    .input('agedep', sql.VarChar(10),  agedep       || '')
    .input('nf',     sql.VarChar(20),  nf)
    .input('filial', sql.VarChar(10),  filial || null)
    .query(`
      UPDATE SE1010
      SET    E1_NUMBCO  = @numbco,
             E1_CODBAR  = @codbar,
             E1_SITUACA = '1',
             E1_AGEDEP  = @agedep,
             E1_CONTA   = '46201'
      WHERE  E1_NUM      = @nf
        AND  D_E_L_E_T_  = ' '
        AND  (@filial IS NULL OR E1_FILIAL = @filial)
    `);
  logger.info(`SE1010 atualizado | NF=${nf} | Filial=${filial || '-'} | nossoNumero=${nossoNumero}`);
}

async function buscarProximoDiaUtil(dataVencto) {
  // Começa do dia seguinte ao vencimento
  const data = new Date(dataVencto + 'T00:00:00Z');
  data.setUTCDate(data.getUTCDate() + 1);

  // Busca feriados a partir da data calculada (próximos 60 dias por segurança)
  const dataInicioStr = data.toISOString().slice(0, 10);
  const dataFimDate   = new Date(data);
  dataFimDate.setUTCDate(dataFimDate.getUTCDate() + 60);
  const dataFimStr = dataFimDate.toISOString().slice(0, 10);

  const p = await getPool();
  const result = await p.request()
    .input('dataInicio', sql.Date, new Date(dataInicioStr + 'T00:00:00Z'))
    .input('dataFim',    sql.Date, new Date(dataFimStr    + 'T00:00:00Z'))
    .query(`
      SELECT CONVERT(varchar(10), DATA, 120) AS DATA
      FROM   [dw].[dbo].[CALENDARIO]
      WHERE  DATA    >= @dataInicio
        AND  DATA    <= @dataFim
        AND  FERIADO  = 1
    `);

  const feriados = new Set(result.recordset.map(r => String(r.DATA).slice(0, 10)));

  // Avança até encontrar um dia útil (não é sábado=6, domingo=0 e não é feriado)
  while (true) {
    const diaSemana = data.getUTCDay();
    const dataKey   = data.toISOString().slice(0, 10);
    if (diaSemana !== 0 && diaSemana !== 6 && !feriados.has(dataKey)) {
      return dataKey;
    }
    data.setUTCDate(data.getUTCDate() + 1);
  }
}

module.exports = { verificarElegibilidadePix, salvarPix, salvarBoleto, buscarProximoDiaUtil };
