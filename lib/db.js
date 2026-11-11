'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    phone TEXT UNIQUE,
    identity TEXT,
    password_hash TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free','gold','diamond')),
    tier_expires_at TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    plan TEXT NOT NULL CHECK (plan IN ('gold','diamond')),
    cycle TEXT NOT NULL CHECK (cycle IN ('monthly','yearly')),
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'TWD',
    provider TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','cancelled','refunded')),
    provider_trade_no TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at TEXT
  );
  CREATE TABLE IF NOT EXISTS payment_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    order_no TEXT,
    verified INTEGER NOT NULL,
    payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS kb_articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    source_url TEXT,
    min_tier TEXT NOT NULL DEFAULT 'free' CHECK (min_tier IN ('free','gold','diamond')),
    published INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    fields TEXT NOT NULL DEFAULT '[]',
    body TEXT NOT NULL DEFAULT '',
    min_tier TEXT NOT NULL DEFAULT 'gold' CHECK (min_tier IN ('free','gold','diamond')),
    published INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_no TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    category TEXT NOT NULL,
    date TEXT NOT NULL,
    slot TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','done','cancelled')),
    admin_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ai_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    ts INTEGER NOT NULL,
    mode TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ai_usage_user_ts ON ai_usage(user_id, ts);
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT,
    ip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `);
  seed(db);
  return db;
}

// 只放「非個資」的內容種子（法規連結、範本目錄）；原版的示範會員／訂單資料不匯入。
function seed(db) {
  const n = db.prepare('SELECT COUNT(*) c FROM kb_articles').get().c;
  if (n === 0) {
    const ins = db.prepare('INSERT INTO kb_articles (category,title,body,source_url,min_tier) VALUES (?,?,?,?,?)');
    [
      ['法規', '租賃住宅市場發展及管理條例（租賃專法）', '請至全國法規資料庫查閱最新條文。（內容待法務校正後補充）', 'https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=D0060125', 'free'],
      ['法規', '民法 — 租賃章（第421~463條之1）', '請至全國法規資料庫查閱最新條文。（內容待法務校正後補充）', 'https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=B0000001', 'free'],
      ['法規', '消費者保護法', '請至全國法規資料庫查閱最新條文。（內容待法務校正後補充）', 'https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=J0170001', 'free'],
      ['法規', '強制執行法', '請至全國法規資料庫查閱最新條文。（內容待法務校正後補充）', 'https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=B0010004', 'free'],
      ['查詢', '司法院 — 裁判書查詢', '', 'https://judgment.judicial.gov.tw/FJUD/default.aspx', 'free']
    ].forEach(r => ins.run(...r));
  }
  const t = db.prepare('SELECT COUNT(*) c FROM templates').get().c;
  if (t === 0) {
    const ins = db.prepare('INSERT INTO templates (category,name,description,fields,body,min_tier,published) VALUES (?,?,?,?,?,?,?)');
    ins.run('通知書', '（範例）催繳通知書', '後台維護範本示範，內容請由法務審定後再上架。',
      JSON.stringify([{ k: 'tenant', l: '承租人姓名' }, { k: 'addr', l: '租賃標的地址' }, { k: 'amount', l: '欠繳金額' }, { k: 'deadline', l: '繳納期限' }]),
      '催繳通知書\n\n{{tenant}} 君：\n\n台端承租之 {{addr}} 房屋，尚欠租金新台幣 {{amount}} 元，請於 {{deadline}} 前繳清。\n\n出租人：＿＿＿＿＿\n日期：＿＿＿＿＿',
      'gold', 0);
  }
}

module.exports = { open };
