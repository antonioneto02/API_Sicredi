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
    pool = await sql.connect(config);
    logger.info('Conexão com banco de dados estabelecida.');
  }
  return pool;
}

async function salvarPix(nf, txid, emvPix) {
  const p = await getPool();
  await p.request()
    .input('txid', sql.VarChar(50),  txid   || '')
    .input('emv',  sql.VarChar(500), emvPix || '')
    .input('nf',   sql.VarChar(20),  nf)
    .query(`
      UPDATE F71010
      SET    F71_STATUS = '3',
             F71_IDTRAN = @txid,
             F71_EMVPIX = @emv
      WHERE  F71_NFNUM   = @nf
        AND  D_E_L_E_T_  = ' '
    `);
  logger.info(`F71010 atualizado | NF=${nf} | txid=${txid}`);
}

async function salvarBoleto(nf, txid, emvPix, nossoNumero, codigoBarras, agedep) {
  const p = await getPool();
  await p.request()
    .input('txid', sql.VarChar(50),  txid   || '')
    .input('emv',  sql.VarChar(500), emvPix || '')
    .input('nf',   sql.VarChar(20),  nf)
    .query(`
      UPDATE F71010
      SET    F71_STATUS = '3',
             F71_IDTRAN = @txid,
             F71_EMVPIX = @emv
      WHERE  F71_NFNUM   = @nf
        AND  D_E_L_E_T_  = ' '
    `);
  logger.info(`F71010 atualizado | NF=${nf}`);

  await p.request()
    .input('numbco', sql.VarChar(20),  nossoNumero  || '')
    .input('codbar', sql.VarChar(60),  codigoBarras || '')
    .input('agedep', sql.VarChar(10),  agedep       || '')
    .input('nf',     sql.VarChar(20),  nf)
    .query(`
      UPDATE SE1010
      SET    E1_NUMBCO  = @numbco,
             E1_CODBAR  = @codbar,
             E1_SITUACA = '1',
             E1_AGEDEP  = @agedep,
             E1_CONTA   = '462013'
      WHERE  E1_NUM      = @nf
        AND  D_E_L_E_T_  = ' '
    `);
  logger.info(`SE1010 atualizado | NF=${nf} | nossoNumero=${nossoNumero}`);
}

module.exports = { salvarPix, salvarBoleto };
