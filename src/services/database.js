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
    logger.info(`[DB] Criando pool | server=${config.server} | database=${config.database} | user=${config.user} | pool.max=${config.pool.max}`);
    try {
      pool = await new sql.ConnectionPool(config).connect();
      const dbCheck = await pool.request().query(`SELECT DB_NAME() AS banco, @@VERSION AS versao`);
      const row = dbCheck.recordset[0];
      logger.info(`[DB] Conectado | banco=${row.banco}`);
      logger.info(`[DB] Versão SQL Server: ${String(row.versao).split('\n')[0]}`);
    } catch (err) {
      logger.error(`[DB] Falha ao conectar no banco | server=${config.server} | database=${config.database} | ${err.message}`);
      logger.error(`[DB] Stack: ${err.stack}`);
      pool = null;
      throw err;
    }
  }
  return pool;
}

async function verificarElegibilidadePix(nf, filial) {
  logger.info(`[DB] verificarElegibilidadePix | NF=${nf} | filial=${filial || 'null'}`);
  const p = await getPool();
  let result;
  try {
    result = await p.request()
      .input('nf',     sql.VarChar(20), nf)
      .input('filial', sql.VarChar(10), filial || null)
      .query(`
        SELECT F71_STATUS, F71_IDTRAN
        FROM   F71010
        WHERE  F71_NUM     = @nf
          AND  D_E_L_E_T_  = ' '
          AND  F71_STATUS  = '1'
          AND  (@filial IS NULL OR F71_FILIAL = @filial)
      `);
  } catch (err) {
    logger.error(`[DB] Erro ao consultar F71010 | NF=${nf} | filial=${filial || 'null'} | ${err.message}`);
    logger.error(`[DB] Stack: ${err.stack}`);
    throw err;
  }

  logger.info(`[DB] F71010 retornou ${result.recordset.length} registro(s) | NF=${nf}`);

  if (result.recordset.length === 0) {
    throw new Error(`NF ${nf} não encontrada na F71010${filial ? ` (filial ${filial})` : ''}.`);
  }

  const row    = result.recordset[0];
  const status = String(row.F71_STATUS || '').trim();
  const idtran = String(row.F71_IDTRAN || '').trim();
  logger.info(`[DB] F71010 dados | NF=${nf} | F71_STATUS='${status}' | F71_IDTRAN='${idtran}'`);

  if (status !== '1') {
    throw new Error(`NF ${nf} com status '${status}' na F71010 — esperado '1'.`);
  }
  if (idtran !== '') {
    throw new Error(`NF ${nf} já possui IDTRAN preenchido na F71010: '${idtran}'.`);
  }
  logger.info(`[DB] NF=${nf} elegível para PIX.`);
}

async function salvarPix(nf, txid, emvPix, filial) {
  logger.info(`[DB] salvarPix | NF=${nf} | filial=${filial || 'null'} | txid=${txid} | emvPix.length=${(emvPix || '').length}`);
  const p = await getPool();
  let result;
  try {
    result = await p.request()
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
  } catch (err) {
    logger.error(`[DB] Erro ao atualizar F71010 (PIX) | NF=${nf} | filial=${filial || 'null'} | ${err.message}`);
    logger.error(`[DB] Stack: ${err.stack}`);
    throw err;
  }
  const rowsAffected = result.rowsAffected?.[0] ?? '?';
  logger.info(`[DB] F71010 atualizado (PIX) | NF=${nf} | Filial=${filial || '-'} | txid=${txid} | rowsAffected=${rowsAffected}`);
  if (rowsAffected === 0) {
    logger.warn(`[DB] ATENÇÃO: nenhuma linha atualizada em F71010 para NF=${nf} | filial=${filial || 'null'}`);
  }
}

async function salvarBoleto(nf, txid, emvPix, nossoNumero, codigoBarras, agedep, filial) {
  logger.info(`[DB] salvarBoleto | NF=${nf} | filial=${filial || 'null'} | txid=${txid} | nossoNumero=${nossoNumero} | codigoBarras=${codigoBarras} | emvPix.length=${(emvPix || '').length}`);
  const p = await getPool();
  if (!nossoNumero || ( (!txid || String(txid).trim()==='') && (!codigoBarras || String(codigoBarras).trim()==='') )) {
    logger.warn(`[DB] salvarBoleto: dados incompletos, pulando atualização | NF=${nf} | txid=${txid} | nossoNumero=${nossoNumero} | codigoBarras=${codigoBarras}`);
    return;
  }
  let r1;
  try {
    r1 = await p.request()
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
  } catch (err) {
    logger.error(`[DB] Erro ao atualizar F71010 (boleto) | NF=${nf} | filial=${filial || 'null'} | ${err.message}`);
    logger.error(`[DB] Stack: ${err.stack}`);
    throw err;
  }
  const rows1 = r1.rowsAffected?.[0] ?? '?';
  logger.info(`[DB] F71010 atualizado (boleto) | NF=${nf} | Filial=${filial || '-'} | rowsAffected=${rows1}`);
  if (rows1 === 0) {
    logger.warn(`[DB] ATENÇÃO: nenhuma linha atualizada em F71010 para NF=${nf} | filial=${filial || 'null'}`);
  }

  logger.info(`[DB] Atualizando SE1010 | NF=${nf} | filial=${filial || 'null'} | nossoNumero=${nossoNumero} | codigoBarras=${codigoBarras}`);
  const p2 = await getPool();
  let r2;
  try {
    r2 = await p2.request()
      .input('numbco', sql.VarChar(20),  nossoNumero  || '')
      .input('codbar', sql.VarChar(60),  codigoBarras || '')
      .input('nf',     sql.VarChar(20),  nf)
      .input('filial', sql.VarChar(10),  filial || null)
      .query(`
        UPDATE SE1010
        SET    E1_NUMBCO  = @numbco,
               E1_CODBAR  = @codbar,
               E1_SITUACA = '1',
               E1_AGEDEP  = '0730',
               E1_PORTADO = '748',
               E1_CONTA   = '46201'
        WHERE  E1_NUM      = @nf
          AND  D_E_L_E_T_  = ' '
          AND  (@filial IS NULL OR E1_FILIAL = @filial)
      `);
  } catch (err) {
    logger.error(`[DB] Erro ao atualizar SE1010 | NF=${nf} | filial=${filial || 'null'} | ${err.message}`);
    logger.error(`[DB] Stack: ${err.stack}`);
    throw err;
  }
  const rows2 = r2.rowsAffected?.[0] ?? '?';
  logger.info(`[DB] SE1010 atualizado | NF=${nf} | Filial=${filial || '-'} | nossoNumero=${nossoNumero} | rowsAffected=${rows2}`);
  if (rows2 === 0) {
    logger.warn(`[DB] ATENÇÃO: nenhuma linha atualizada em SE1010 para NF=${nf} | filial=${filial || 'null'}`);
  }
}

async function buscarProximoDiaUtil(dataVencto) {
  logger.info(`[DB] buscarProximoDiaUtil | dataVencto=${dataVencto}`);
  const data = new Date(dataVencto + 'T00:00:00Z');
  data.setUTCDate(data.getUTCDate() + 1);
  const dataInicioStr = data.toISOString().slice(0, 10);
  const dataFimDate   = new Date(data);
  dataFimDate.setUTCDate(dataFimDate.getUTCDate() + 60);
  const dataFimStr = dataFimDate.toISOString().slice(0, 10);
  logger.info(`[DB] Buscando feriados | de=${dataInicioStr} até=${dataFimStr}`);
  const p = await getPool();
  let result;
  try {
    result = await p.request()
      .input('dataInicio', sql.Date, new Date(dataInicioStr + 'T00:00:00Z'))
      .input('dataFim',    sql.Date, new Date(dataFimStr    + 'T00:00:00Z'))
      .query(`
        SELECT CONVERT(varchar(10), DATA, 120) AS DATA
        FROM   [dw].[dbo].[CALENDARIO]
        WHERE  DATA    >= @dataInicio
          AND  DATA    <= @dataFim
          AND  FERIADO  = 1
      `);
  } catch (err) {
    logger.error(`[DB] Erro ao buscar CALENDARIO | ${err.message}`);
    logger.error(`[DB] Stack: ${err.stack}`);
    throw err;
  }

  const feriados = new Set(result.recordset.map(r => String(r.DATA).slice(0, 10)));
  logger.info(`[DB] Feriados encontrados (${feriados.size}): ${[...feriados].join(', ') || 'nenhum'}`);

  while (true) {
    const diaSemana = data.getUTCDay();
    const dataKey   = data.toISOString().slice(0, 10);
    if (diaSemana !== 0 && diaSemana !== 6 && !feriados.has(dataKey)) {
      logger.info(`[DB] Próximo dia útil: ${dataKey}`);
      return dataKey;
    }
    const motivo = diaSemana === 0 ? 'domingo' : diaSemana === 6 ? 'sábado' : `feriado`;
    logger.info(`[DB] Pulando ${dataKey} (${motivo})`);
    data.setUTCDate(data.getUTCDate() + 1);
  }
}

module.exports = { verificarElegibilidadePix, salvarPix, salvarBoleto, buscarProximoDiaUtil };
