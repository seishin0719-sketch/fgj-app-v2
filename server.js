'use strict';
/* 房管家 v2 伺服器：Express + SQLite */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const { open } = require('./lib/db');
const S = require('./lib/security');
const ai = require('./lib/ai');
const payments = require('./lib/payments');

// ---------- 設定 ----------
loadDotEnv(path.join(__dirname, '.env'));
const PROD = process.env.NODE_ENV === 'production';
const PORT = +process.env.PORT || 3000;
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true' || PROD;
const DB_FILE = path.resolve(__dirname, process.env.DB_FILE || './data/fgj.sqlite');
const PRICES = JSON.parse(fs.readFileSync(path.resolve(__dirname, process.env.PRICES_FILE || './config/prices.json'), 'utf8'));
const PLANS = JSON.parse(fs.readFileSync(path.join(__dirname, 'config/plans.json'), 'utf8'));
const PAYMENT_PROVIDER = process.env.PAYMENT_PROVIDER || 'mock';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const ADMIN_SESSION_TTL_MS = 8 * 3600 * 1000;
const TIER_RANK = { free: 0, gold: 1, diamond: 2 };

if (PROD && PAYMENT_PROVIDER === 'mock') console.warn('[警告] production 環境仍設定 PAYMENT_PROVIDER=mock，付款功能將無法使用。');
if (PROD && !COOKIE_SECURE) console.warn('[警告] production 必須使用 HTTPS 與 COOKIE_SECURE=true');

const db = open(DB_FILE);
const SERVER_SECRET = loadOrCreateSecret(path.join(path.dirname(DB_FILE), '.server_secret'));
ensureAdmin();

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY && process.env.TRUST_PROXY !== '0') app.set('trust proxy', +process.env.TRUST_PROXY || 1);

// ---------- 安全標頭 ----------
const baseCsp = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  // 前台沿用原版大量 onclick 屬性，因此前台允許「屬性型」inline handler；後台不允許（見下方 adminCsp）
  scriptSrcAttr: ["'unsafe-inline'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  fontSrc: ["'self'", 'data:'],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"], // 接綠界/藍新時需加入其付款網域
  frameAncestors: ["'none'"],
  upgradeInsecureRequests: COOKIE_SECURE ? [] : null
};
app.use(helmet({
  contentSecurityPolicy: { useDefaults: false, directives: baseCsp },
  hsts: PROD ? { maxAge: 15552000, includeSubDomains: true } : false,
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'same-origin' }
}));
const adminCsp = Object.entries({ ...baseCsp, scriptSrcAttr: ["'none'"] })
  .filter(([, v]) => v !== null)
  .map(([k, v]) => k.replace(/[A-Z]/g, c => '-' + c.toLowerCase()) + (v.length ? ' ' + v.join(' ') : '')).join('; ');
function strictCsp(req, res, next) { res.set('Content-Security-Policy', adminCsp); res.set('Cache-Control', 'no-store'); next(); }

// webhook 需要原始 body 驗簽
app.use('/api/payments/webhook', express.raw({ type: '*/*', limit: '64kb' }), (req, res, next) => {
  req.rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''; next();
});
app.use(express.json({ limit: '32kb' }));
app.use(cookies);
app.use(loadSession);
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use('/api', csrfGuard);

// ---------- 靜態前台 ----------
app.get('/', (req, res) => res.redirect('/app.html'));
app.get('/favicon.ico', (req, res) => res.redirect(301, '/assets/logo.svg'));
app.get('/admin.html', (req, res) => res.redirect('/admin'));
app.use(express.static(path.join(__dirname, 'public'), { index: false, extensions: false, redirect: false }));

// ---------- 公開 API ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/session', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null, csrfToken: csrfFor(req, res) });
});

app.get('/api/config', (req, res) => {
  res.json({
    currency: PRICES.currency,
    plans: Object.fromEntries(Object.entries(PRICES.plans).map(([k, p]) => [k, { name: p.name, monthly: p.monthly, yearly: p.yearly }])),
    tiers: Object.fromEntries(Object.entries(PLANS.tiers).map(([k, t]) => [k, { label: t.label, aiPerDay: t.aiPerDay, booking: t.booking }])),
    booking: { slots: PLANS.bookingSlots, types: PLANS.bookingTypes, categories: PLANS.bookingCategories },
    paymentProvider: PAYMENT_PROVIDER
  });
});

const authLimiter = S.memoryLimiter({ windowMs: 15 * 60 * 1000, max: 20 });

app.post('/api/auth/register', authLimiter, wrap(async (req, res) => {
  const b = req.body || {};
  const name = S.V.str(b.name, { min: 1, max: 40, name: '姓名' });
  const phone = S.V.phone(b.phone);
  const email = S.V.email(b.email);
  const identity = S.V.str(b.identity || '其他', { max: 30, name: '身份' });
  const password = S.V.password(b.password);
  if (b.password !== b.password2) throw S.bad('兩次密碼不一致');
  if (b.agree !== true) throw S.bad('請先閱讀並同意服務條款與隱私權政策');
  const dup = db.prepare('SELECT id FROM users WHERE email=? OR phone=?').get(email, phone);
  if (dup) throw S.bad('此 Email 或手機已註冊', 409);
  const r = db.prepare('INSERT INTO users (name,email,phone,identity,password_hash) VALUES (?,?,?,?,?)')
    .run(name, email, phone, identity, S.hashPassword(password));
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
  startSession(res, user, SESSION_TTL_MS);
  audit(user.id, 'register', 'user:' + user.id, null, req);
  res.json({ user: publicUser(user) });
}));

function findByLogin(acc) {
  const a = String(acc || '').trim().toLowerCase();
  const phone = a.replace(/[\s-]/g, '');
  return db.prepare('SELECT * FROM users WHERE email=? OR phone=?').get(a, phone);
}
function checkLogin(b) {
  const acc = S.V.str(b.account, { min: 3, max: 254, name: '帳號' });
  const pw = typeof b.password === 'string' ? b.password : '';
  const u = findByLogin(acc);
  const ok = S.verifyPassword(pw, u ? u.password_hash : S.DUMMY_HASH);
  if (!u || !ok) throw S.bad('帳號或密碼錯誤', 401);
  if (u.status !== 'active') throw S.bad('帳號已停用，請聯繫客服', 403);
  return u;
}

app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const u = checkLogin(req.body || {});
  if (u.role === 'admin') throw S.bad('管理員請由後台登入頁登入', 403);
  db.prepare("UPDATE users SET last_login_at=datetime('now') WHERE id=?").run(u.id);
  startSession(res, u, SESSION_TTL_MS);
  res.json({ user: publicUser(u) });
}));

app.post('/api/auth/logout', (req, res) => {
  if (req.sessionId) db.prepare('DELETE FROM sessions WHERE id_hash=?').run(S.sha256(req.sessionId));
  clearCookie(res, 'fgj_sid');
  res.json({ ok: true });
});

app.get('/api/me', requireMember, (req, res) => {
  const orders = db.prepare('SELECT order_no,plan,cycle,amount,status,created_at,paid_at FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 20').all(req.user.id);
  res.json({ user: publicUser(req.user), orders });
});

// ---------- AI 代理 ----------
app.post('/api/ai/chat', requireMember, wrap(async (req, res) => {
  const tier = effectiveTier(req.user);
  const lim = PLANS.tiers[tier];
  if (!lim || lim.aiPerDay <= 0) throw S.bad('線上 AI 諮詢為金牌會員以上功能，請先升級', 403);
  const now = Date.now();
  const day = db.prepare('SELECT COUNT(*) c FROM ai_usage WHERE user_id=? AND ts>?').get(req.user.id, startOfTaipeiDay(now)).c;
  const min = db.prepare('SELECT COUNT(*) c FROM ai_usage WHERE user_id=? AND ts>?').get(req.user.id, now - 60000).c;
  if (day >= lim.aiPerDay) throw S.bad(`今日 AI 諮詢次數已達上限（${lim.aiPerDay} 次），明天再試或聯繫專人`, 429);
  if (min >= lim.aiPerMinute) throw S.bad('發問太頻繁，請稍候一分鐘', 429);
  const msgs = Array.isArray(req.body?.messages) ? req.body.messages.slice(-12) : [];
  if (!msgs.length) throw S.bad('請輸入問題');
  const clean = msgs.map(m => ({ role: m.role === 'model' ? 'model' : 'user', text: S.V.str(m.text, { min: 1, max: 2000, name: '訊息' }) }));
  if (clean[clean.length - 1].role !== 'user') throw S.bad('訊息格式錯誤');
  let out;
  try { out = await ai.chat(clean); }
  catch (e) { console.error('[AI] upstream error:', e.message); throw S.bad('目前 AI 連線較忙，請稍後再試', 502); }
  db.prepare('INSERT INTO ai_usage (user_id,ts,mode) VALUES (?,?,?)').run(req.user.id, now, out.mode);
  res.json({ reply: out.reply, mode: out.mode, remainingToday: lim.aiPerDay - day - 1 });
}));

// ---------- 訂單與金流 ----------
app.post('/api/orders', requireMember, wrap(async (req, res) => {
  const plan = S.V.oneOf(req.body?.plan, ['gold', 'diamond'], '方案');
  const cycle = S.V.oneOf(req.body?.cycle, ['monthly', 'yearly'], '繳費週期');
  const amount = PRICES.plans[plan]?.[cycle];
  if (!Number.isInteger(amount) || amount <= 0) throw S.bad('此方案價格尚未公布，暫時無法線上付款', 409);
  const provider = payments.get(PAYMENT_PROVIDER);
  // 同一會員 30 分鐘內同方案未付款訂單直接沿用，避免重複建立
  let order = db.prepare("SELECT * FROM orders WHERE user_id=? AND plan=? AND cycle=? AND status='pending' AND created_at>datetime('now','-30 minutes') ORDER BY id DESC").get(req.user.id, plan, cycle);
  if (!order || order.amount !== amount) {
    const orderNo = 'FGJ' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
    db.prepare('INSERT INTO orders (order_no,user_id,plan,cycle,amount,currency,provider) VALUES (?,?,?,?,?,?,?)')
      .run(orderNo, req.user.id, plan, cycle, amount, PRICES.currency, PAYMENT_PROVIDER);
    order = db.prepare('SELECT * FROM orders WHERE order_no=?').get(orderNo);
  }
  const checkout = provider.createCheckout(order, { baseUrl: process.env.PUBLIC_BASE_URL });
  res.json({ order: { order_no: order.order_no, plan, cycle, amount, status: order.status }, checkout });
}));

app.post('/api/payments/webhook/:provider', wrap(async (req, res) => {
  const name = req.params.provider;
  if (name !== PAYMENT_PROVIDER) return res.status(404).send('not found');
  const p = payments.get(name);
  const r = p.parseWebhook(req);
  db.prepare('INSERT INTO payment_events (provider,order_no,verified,payload) VALUES (?,?,?,?)').run(name, r.orderNo || null, r.verified ? 1 : 0, String(r.raw).slice(0, 4000));
  if (!r.verified) return res.status(400).send('bad signature');
  const order = db.prepare('SELECT * FROM orders WHERE order_no=?').get(r.orderNo);
  if (!order) return res.status(404).send('no order');
  if (r.paid) markPaid(order, r.tradeNo, null, req);
  else if (order.status === 'pending') db.prepare("UPDATE orders SET status='failed' WHERE id=?").run(order.id);
  res.type('text/plain').send(r.ackBody || 'OK');
}));

function markPaid(order, tradeNo, actorId, req) {
  const tx = db.transaction(() => {
    const cur = db.prepare('SELECT * FROM orders WHERE id=?').get(order.id);
    if (cur.status === 'paid') return false; // 冪等：重複通知不重複加值
    if (!['pending', 'failed'].includes(cur.status)) return false;
    db.prepare("UPDATE orders SET status='paid', paid_at=datetime('now'), provider_trade_no=? WHERE id=?").run(tradeNo, cur.id);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(cur.user_id);
    const now = Date.now();
    let base = now;
    if (u.tier === cur.plan && u.tier_expires_at && parseDbTime(u.tier_expires_at) > now) base = parseDbTime(u.tier_expires_at);
    const d = new Date(base);
    if (cur.cycle === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1); else d.setUTCFullYear(d.getUTCFullYear() + 1);
    const newTier = TIER_RANK[cur.plan] >= TIER_RANK[effectiveTier(u)] ? cur.plan : u.tier;
    db.prepare('UPDATE users SET tier=?, tier_expires_at=? WHERE id=?').run(newTier, d.toISOString().slice(0, 19).replace('T', ' '), u.id);
    return true;
  });
  const changed = tx();
  if (changed) audit(actorId, actorId ? 'order.mark_paid_manual' : 'order.paid_webhook', 'order:' + order.order_no, null, req);
  return changed;
}

// 模擬付款頁（僅非 production 且 PAYMENT_PROVIDER=mock）
app.get('/pay/mock/:orderNo', strictCsp, (req, res) => {
  if (PROD || PAYMENT_PROVIDER !== 'mock') return res.status(404).send('Not found');
  res.sendFile(path.join(__dirname, 'views/mock-pay.html'));
});
app.get('/api/pay/mock/:orderNo', requireMember, (req, res) => {
  if (PROD || PAYMENT_PROVIDER !== 'mock') return res.status(404).json({ error: 'not found' });
  const o = db.prepare('SELECT order_no,plan,cycle,amount,status FROM orders WHERE order_no=? AND user_id=?').get(req.params.orderNo, req.user.id);
  if (!o) return res.status(404).json({ error: '找不到訂單' });
  res.json({ order: o });
});
app.post('/api/pay/mock/:orderNo/complete', requireMember, wrap(async (req, res) => {
  if (PROD || PAYMENT_PROVIDER !== 'mock') return res.status(404).json({ error: 'not found' });
  const o = db.prepare('SELECT * FROM orders WHERE order_no=? AND user_id=?').get(req.params.orderNo, req.user.id);
  if (!o) throw S.bad('找不到訂單', 404);
  const result = req.body?.result === 'fail' ? 'failed' : 'paid';
  // 模擬「金流商伺服器 → 我方 webhook」的完整路徑（含簽章驗證）
  const payload = JSON.stringify({ orderNo: o.order_no, status: result, tradeNo: 'MOCK' + Date.now() });
  const sig = require('./lib/payments/mock').sign(payload);
  const r = await fetch(`http://127.0.0.1:${PORT}/api/payments/webhook/mock`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mock-Signature': sig }, body: payload });
  if (!r.ok) throw S.bad('模擬通知失敗', 502);
  const after = db.prepare('SELECT status FROM orders WHERE id=?').get(o.id);
  res.json({ status: after.status });
}));

// ---------- 鑽石預約 ----------
app.post('/api/bookings', requireMember, wrap(async (req, res) => {
  if (!PLANS.tiers[effectiveTier(req.user)].booking) throw S.bad('預約 Live 諮詢為鑽石會員功能', 403);
  const b = req.body || {};
  const type = S.V.oneOf(b.type, PLANS.bookingTypes, '諮詢方式');
  const category = S.V.oneOf(b.category, PLANS.bookingCategories, '問題類別');
  const date = S.V.date(b.date);
  const slot = S.V.oneOf(b.slot, PLANS.bookingSlots, '時段');
  const summary = S.V.str(b.summary, { min: 5, max: 1000, name: '問題簡述' });
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  if (date <= today) throw S.bad('請選擇明天以後的日期');
  const open = db.prepare("SELECT COUNT(*) c FROM bookings WHERE user_id=? AND status IN ('pending','confirmed')").get(req.user.id).c;
  if (open >= 5) throw S.bad('您已有 5 筆待處理預約，請等候確認');
  const no = 'BK' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
  db.prepare('INSERT INTO bookings (booking_no,user_id,type,category,date,slot,summary) VALUES (?,?,?,?,?,?,?)').run(no, req.user.id, type, category, date, slot, summary);
  res.json({ booking_no: no, status: 'pending' });
}));
app.get('/api/bookings', requireMember, (req, res) => {
  res.json({ bookings: db.prepare('SELECT booking_no,type,category,date,slot,status,created_at FROM bookings WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.user.id) });
});

// ---------- 知識庫與範本（前台讀取） ----------
app.get('/api/kb', (req, res) => {
  const tier = req.user ? effectiveTier(req.user) : 'free';
  const rows = db.prepare('SELECT id,category,title,body,source_url,min_tier,updated_at FROM kb_articles WHERE published=1 ORDER BY id').all();
  res.json({ articles: rows.map(r => TIER_RANK[tier] >= TIER_RANK[r.min_tier] ? { ...r, locked: false } : { ...r, body: '', locked: true }) });
});
app.get('/api/templates', (req, res) => {
  const tier = req.user ? effectiveTier(req.user) : 'free';
  const rows = db.prepare('SELECT id,category,name,description,fields,body,min_tier FROM templates WHERE published=1 ORDER BY id').all();
  res.json({ templates: rows.map(r => ({ ...r, fields: JSON.parse(r.fields), body: TIER_RANK[tier] >= TIER_RANK[r.min_tier] ? r.body : '', locked: TIER_RANK[tier] < TIER_RANK[r.min_tier] })) });
});

// ================= 後台 =================
const adminLoginLimiter = S.memoryLimiter({ windowMs: 15 * 60 * 1000, max: 10, message: '登入失敗次數過多，請 15 分鐘後再試' });
app.get('/admin/login', strictCsp, (req, res) => {
  if (isAdmin(req)) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'views/admin/login.html'));
});
app.get('/admin/login.js', strictCsp, (req, res) => res.sendFile(path.join(__dirname, 'views/admin/login.js')));
app.get('/admin/admin.css', strictCsp, (req, res) => res.sendFile(path.join(__dirname, 'views/admin/admin.css')));
// 其餘 /admin 一律需管理員登入
app.use('/admin', strictCsp, (req, res, next) => {
  if (!isAdmin(req)) return res.redirect('/admin/login');
  next();
});
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'views/admin/index.html')));
app.get('/admin/admin.js', (req, res) => res.sendFile(path.join(__dirname, 'views/admin/admin.js')));

app.post('/api/admin/login', adminLoginLimiter, wrap(async (req, res) => {
  let u;
  try { u = checkLogin(req.body || {}); } catch (e) { audit(null, 'admin.login_failed', null, null, req); throw e; }
  if (u.role !== 'admin') { audit(u.id, 'admin.login_denied', null, null, req); throw S.bad('帳號或密碼錯誤', 401); }
  db.prepare("UPDATE users SET last_login_at=datetime('now') WHERE id=?").run(u.id);
  startSession(res, u, ADMIN_SESSION_TTL_MS);
  audit(u.id, 'admin.login', null, null, req);
  res.json({ ok: true });
}));

const admin = express.Router();
app.use('/api/admin', requireAdmin, admin);

admin.get('/me', (req, res) => res.json({ name: req.user.name, email: req.user.email }));
admin.post('/password', wrap(async (req, res) => {
  const b = req.body || {};
  if (!S.verifyPassword(String(b.current || ''), req.user.password_hash)) throw S.bad('目前密碼錯誤', 401);
  const pw = S.V.password(b.next);
  if (pw.length < 12) throw S.bad('管理員密碼至少 12 碼');
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(S.hashPassword(pw), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id=? AND id_hash<>?').run(req.user.id, S.sha256(req.sessionId));
  audit(req.user.id, 'admin.password_changed', null, null, req);
  res.json({ ok: true });
}));

admin.get('/stats', (req, res) => {
  const q = sql => db.prepare(sql).get();
  res.json({
    members: q("SELECT COUNT(*) c FROM users WHERE role='member'").c,
    paid: q("SELECT COUNT(*) c FROM users WHERE role='member' AND tier<>'free' AND tier_expires_at>datetime('now')").c,
    gold: q("SELECT COUNT(*) c FROM users WHERE role='member' AND tier='gold' AND tier_expires_at>datetime('now')").c,
    diamond: q("SELECT COUNT(*) c FROM users WHERE role='member' AND tier='diamond' AND tier_expires_at>datetime('now')").c,
    revenueThisMonth: q("SELECT COALESCE(SUM(amount),0) s FROM orders WHERE status='paid' AND strftime('%Y-%m',paid_at,'+8 hours')=strftime('%Y-%m','now','+8 hours')").s,
    pendingOrders: q("SELECT COUNT(*) c FROM orders WHERE status='pending'").c,
    pendingBookings: q("SELECT COUNT(*) c FROM bookings WHERE status='pending'").c,
    aiToday: db.prepare('SELECT COUNT(*) c FROM ai_usage WHERE ts>?').get(startOfTaipeiDay(Date.now())).c,
    paymentProvider: PAYMENT_PROVIDER,
    aiMode: process.env.GEMINI_API_KEY ? 'gemini' : 'mock'
  });
});

admin.get('/members', (req, res) => {
  const { q = '', tier = '', status = '' } = req.query;
  let sql = "SELECT id,name,email,phone,identity,tier,tier_expires_at,status,created_at,last_login_at FROM users WHERE role='member'";
  const args = [];
  if (q) { sql += ' AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)'; const l = '%' + String(q).slice(0, 50) + '%'; args.push(l, l, l); }
  if (['free', 'gold', 'diamond'].includes(tier)) { sql += ' AND tier=?'; args.push(tier); }
  if (['active', 'disabled'].includes(status)) { sql += ' AND status=?'; args.push(status); }
  sql += ' ORDER BY id DESC LIMIT 500';
  res.json({ members: db.prepare(sql).all(...args).map(m => ({ ...m, email: S.maskEmail(m.email), phone: S.maskPhone(m.phone), effectiveTier: effectiveTier(m) })) });
});
admin.post('/members/:id/reveal', wrap(async (req, res) => {
  const id = S.V.id(req.params.id);
  const m = db.prepare("SELECT email,phone FROM users WHERE id=? AND role='member'").get(id);
  if (!m) throw S.bad('找不到會員', 404);
  audit(req.user.id, 'member.reveal_pii', 'user:' + id, String(req.body?.reason || '').slice(0, 200), req);
  res.json(m);
}));
admin.patch('/members/:id', wrap(async (req, res) => {
  const id = S.V.id(req.params.id);
  const m = db.prepare("SELECT * FROM users WHERE id=? AND role='member'").get(id);
  if (!m) throw S.bad('找不到會員', 404);
  const b = req.body || {};
  const tier = b.tier !== undefined ? S.V.oneOf(b.tier, ['free', 'gold', 'diamond'], '等級') : m.tier;
  const status = b.status !== undefined ? S.V.oneOf(b.status, ['active', 'disabled'], '狀態') : m.status;
  let exp = m.tier_expires_at;
  if (b.tier_expires_at !== undefined) exp = b.tier_expires_at ? S.V.date(b.tier_expires_at) + ' 15:59:59' /* = 台北時間 23:59:59 */ : null;
  if (tier !== 'free' && !exp) throw S.bad('付費等級需設定到期日');
  db.prepare('UPDATE users SET tier=?, tier_expires_at=?, status=? WHERE id=?').run(tier, exp, status, id);
  if (status === 'disabled') db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  audit(req.user.id, 'member.update', 'user:' + id, JSON.stringify({ tier, exp, status, reason: String(b.reason || '').slice(0, 200) }), req);
  res.json({ ok: true });
}));

admin.get('/orders', (req, res) => {
  const st = req.query.status;
  let sql = 'SELECT o.id,o.order_no,o.plan,o.cycle,o.amount,o.currency,o.provider,o.status,o.provider_trade_no,o.created_at,o.paid_at,u.name member_name FROM orders o JOIN users u ON u.id=o.user_id';
  const args = [];
  if (['pending', 'paid', 'failed', 'cancelled', 'refunded'].includes(st)) { sql += ' WHERE o.status=?'; args.push(st); }
  res.json({ orders: db.prepare(sql + ' ORDER BY o.id DESC LIMIT 500').all(...args) });
});
admin.post('/orders/:id/mark-paid', wrap(async (req, res) => {
  const id = S.V.id(req.params.id);
  const note = S.V.str(req.body?.note || '', { min: 2, max: 200, name: '對帳備註' });
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) throw S.bad('找不到訂單', 404);
  if (!markPaid(o, 'MANUAL', req.user.id, req)) throw S.bad('訂單狀態不允許標記已付款');
  audit(req.user.id, 'order.manual_note', 'order:' + o.order_no, note, req);
  res.json({ ok: true });
}));
admin.post('/orders/:id/cancel', wrap(async (req, res) => {
  const id = S.V.id(req.params.id);
  const r = db.prepare("UPDATE orders SET status='cancelled' WHERE id=? AND status IN ('pending','failed')").run(id);
  if (!r.changes) throw S.bad('只有待付款／失敗的訂單可取消');
  audit(req.user.id, 'order.cancel', 'order:' + id, null, req);
  res.json({ ok: true });
}));

admin.get('/revenue', (req, res) => {
  const byMonth = db.prepare("SELECT strftime('%Y-%m',paid_at,'+8 hours') month, plan, cycle, COUNT(*) n, SUM(amount) total FROM orders WHERE status='paid' GROUP BY month,plan,cycle ORDER BY month DESC LIMIT 120").all();
  const total = db.prepare("SELECT COALESCE(SUM(amount),0) s, COUNT(*) n FROM orders WHERE status='paid'").get();
  res.json({ byMonth, total: total.s, count: total.n, currency: PRICES.currency, note: '金額為訂單金額（含稅），未扣除金流手續費與退款。' });
});

// 知識庫 CRUD
function kbInput(b) {
  return {
    category: S.V.str(b.category, { min: 1, max: 30, name: '分類' }),
    title: S.V.str(b.title, { min: 1, max: 120, name: '標題' }),
    body: S.V.str(b.body || '', { max: 20000, name: '內容' }),
    source_url: S.V.url(b.source_url),
    min_tier: S.V.oneOf(b.min_tier || 'free', ['free', 'gold', 'diamond'], '等級'),
    published: b.published ? 1 : 0
  };
}
admin.get('/kb', (req, res) => res.json({ articles: db.prepare('SELECT * FROM kb_articles ORDER BY id DESC').all() }));
admin.post('/kb', wrap(async (req, res) => {
  const d = kbInput(req.body || {});
  const r = db.prepare('INSERT INTO kb_articles (category,title,body,source_url,min_tier,published) VALUES (@category,@title,@body,@source_url,@min_tier,@published)').run(d);
  audit(req.user.id, 'kb.create', 'kb:' + r.lastInsertRowid, d.title, req);
  res.json({ id: r.lastInsertRowid });
}));
admin.put('/kb/:id', wrap(async (req, res) => {
  const id = S.V.id(req.params.id); const d = kbInput(req.body || {});
  const r = db.prepare("UPDATE kb_articles SET category=@category,title=@title,body=@body,source_url=@source_url,min_tier=@min_tier,published=@published,updated_at=datetime('now') WHERE id=@id").run({ ...d, id });
  if (!r.changes) throw S.bad('找不到資料', 404);
  audit(req.user.id, 'kb.update', 'kb:' + id, d.title, req);
  res.json({ ok: true });
}));
admin.delete('/kb/:id', wrap(async (req, res) => {
  const id = S.V.id(req.params.id);
  if (!db.prepare('DELETE FROM kb_articles WHERE id=?').run(id).changes) throw S.bad('找不到資料', 404);
  audit(req.user.id, 'kb.delete', 'kb:' + id, null, req);
  res.json({ ok: true });
}));

// 範本 CRUD
function tplInput(b) {
  let fields = b.fields;
  if (typeof fields === 'string') { try { fields = JSON.parse(fields); } catch { throw S.bad('欄位格式需為 JSON 陣列'); } }
  if (!Array.isArray(fields) || fields.length > 30) throw S.bad('欄位格式需為陣列（最多 30 個）');
  fields = fields.map(f => ({ k: S.V.str(f.k, { min: 1, max: 30, name: '欄位代號' }).replace(/[^\w]/g, ''), l: S.V.str(f.l, { min: 1, max: 40, name: '欄位名稱' }) }));
  return {
    category: S.V.str(b.category, { min: 1, max: 30, name: '分類' }),
    name: S.V.str(b.name, { min: 1, max: 80, name: '範本名稱' }),
    description: S.V.str(b.description || '', { max: 300, name: '說明' }),
    fields: JSON.stringify(fields),
    body: S.V.str(b.body || '', { max: 20000, name: '範本內容' }),
    min_tier: S.V.oneOf(b.min_tier || 'gold', ['free', 'gold', 'diamond'], '等級'),
    published: b.published ? 1 : 0
  };
}
admin.get('/templates', (req, res) => res.json({ templates: db.prepare('SELECT * FROM templates ORDER BY id DESC').all() }));
admin.post('/templates', wrap(async (req, res) => {
  const d = tplInput(req.body || {});
  const r = db.prepare('INSERT INTO templates (category,name,description,fields,body,min_tier,published) VALUES (@category,@name,@description,@fields,@body,@min_tier,@published)').run(d);
  audit(req.user.id, 'template.create', 'tpl:' + r.lastInsertRowid, d.name, req);
  res.json({ id: r.lastInsertRowid });
}));
admin.put('/templates/:id', wrap(async (req, res) => {
  const id = S.V.id(req.params.id); const d = tplInput(req.body || {});
  const r = db.prepare("UPDATE templates SET category=@category,name=@name,description=@description,fields=@fields,body=@body,min_tier=@min_tier,published=@published,updated_at=datetime('now') WHERE id=@id").run({ ...d, id });
  if (!r.changes) throw S.bad('找不到資料', 404);
  audit(req.user.id, 'template.update', 'tpl:' + id, d.name, req);
  res.json({ ok: true });
}));
admin.delete('/templates/:id', wrap(async (req, res) => {
  const id = S.V.id(req.params.id);
  if (!db.prepare('DELETE FROM templates WHERE id=?').run(id).changes) throw S.bad('找不到資料', 404);
  audit(req.user.id, 'template.delete', 'tpl:' + id, null, req);
  res.json({ ok: true });
}));

// 預約管理
admin.get('/bookings', (req, res) => {
  const st = req.query.status;
  let sql = 'SELECT b.id,b.booking_no,b.type,b.category,b.date,b.slot,b.summary,b.status,b.admin_note,b.created_at,u.name member_name FROM bookings b JOIN users u ON u.id=b.user_id';
  const args = [];
  if (['pending', 'confirmed', 'done', 'cancelled'].includes(st)) { sql += ' WHERE b.status=?'; args.push(st); }
  res.json({ bookings: db.prepare(sql + ' ORDER BY b.date DESC, b.id DESC LIMIT 500').all(...args) });
});
admin.patch('/bookings/:id', wrap(async (req, res) => {
  const id = S.V.id(req.params.id);
  const status = S.V.oneOf(req.body?.status, ['pending', 'confirmed', 'done', 'cancelled'], '狀態');
  const note = S.V.str(req.body?.admin_note || '', { max: 1000, name: '備註' });
  if (!db.prepare("UPDATE bookings SET status=?, admin_note=?, updated_at=datetime('now') WHERE id=?").run(status, note, id).changes) throw S.bad('找不到預約', 404);
  audit(req.user.id, 'booking.update', 'booking:' + id, status, req);
  res.json({ ok: true });
}));

admin.get('/audit', (req, res) => {
  res.json({ logs: db.prepare('SELECT a.id,a.action,a.target,a.detail,a.created_at,u.name actor FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 300').all() });
});
admin.get('/config', (req, res) => res.json({ prices: PRICES, plans: PLANS }));

// ---------- 404 與錯誤 ----------
app.use('/api', (req, res) => res.status(404).json({ error: '找不到 API' }));
app.use((req, res) => res.status(404).send('Not found'));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500 && !err.expose) console.error(err);
  res.status(status).json({ error: err.expose || status < 500 ? (err.type === 'entity.parse.failed' ? '資料格式錯誤' : err.message) : '伺服器錯誤，請稍後再試' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`房管家 v2 已啟動：http://localhost:${PORT}  （AI：${process.env.GEMINI_API_KEY ? 'Gemini' : '測試模式'}；金流：${PAYMENT_PROVIDER}）`));
}
module.exports = app;

// ================= 輔助函式 =================
function wrap(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }

function cookies(req, res, next) {
  req.cookies = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) req.cookies[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  next();
}
function setCookie(res, name, value, maxAgeMs) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (maxAgeMs) parts.push('Max-Age=' + Math.floor(maxAgeMs / 1000));
  if (COOKIE_SECURE) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
function clearCookie(res, name) { res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${COOKIE_SECURE ? '; Secure' : ''}`); }

function startSession(res, user, ttl) {
  const sid = S.randomToken(32);
  db.prepare('INSERT INTO sessions (id_hash,user_id,csrf,expires_at) VALUES (?,?,?,?)').run(S.sha256(sid), user.id, S.randomToken(24), Date.now() + ttl);
  setCookie(res, 'fgj_sid', sid, ttl);
}
function loadSession(req, res, next) {
  const sid = req.cookies.fgj_sid;
  if (sid && sid.length < 100) {
    const s = db.prepare('SELECT * FROM sessions WHERE id_hash=?').get(S.sha256(sid));
    if (s && s.expires_at > Date.now()) {
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id);
      if (u && u.status === 'active') { req.user = u; req.session = s; req.sessionId = sid; }
    } else if (s) db.prepare('DELETE FROM sessions WHERE id_hash=?').run(s.id_hash);
  }
  next();
}
// CSRF：已登入用 session 內 token；未登入用 HttpOnly 預備 cookie 的 HMAC。另檢查 Origin。
function csrfFor(req, res) {
  if (req.session) return req.session.csrf;
  let pre = req.cookies.fgj_pre;
  if (!pre || pre.length > 100) { pre = S.randomToken(24); setCookie(res, 'fgj_pre', pre, 24 * 3600e3); req.cookies.fgj_pre = pre; }
  return crypto.createHmac('sha256', SERVER_SECRET).update(pre).digest('base64url');
}
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/payments/webhook/')) return next(); // 以金流簽章驗證
  const origin = req.get('Origin');
  if (origin) {
    const host = req.get('Host');
    try { if (new URL(origin).host !== host) return res.status(403).json({ error: '來源不符（CSRF 防護）' }); } catch { return res.status(403).json({ error: '來源不符' }); }
  }
  const sent = req.get('X-CSRF-Token') || '';
  let expect;
  if (req.session) expect = req.session.csrf;
  else if (req.cookies.fgj_pre) expect = crypto.createHmac('sha256', SERVER_SECRET).update(req.cookies.fgj_pre).digest('base64url');
  if (!expect || !S.safeEqual(sent, expect)) return res.status(403).json({ error: '安全驗證失敗，請重新整理頁面（CSRF）' });
  next();
}
function requireMember(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '請先登入' });
  if (req.user.role !== 'member') return res.status(403).json({ error: '管理員帳號不可使用會員功能' });
  next();
}
function isAdmin(req) { return !!(req.user && req.user.role === 'admin'); }
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '請先登入後台' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: '沒有後台權限' });
  next();
}
function effectiveTier(u) {
  if (u.tier === 'free') return 'free';
  if (!u.tier_expires_at || parseDbTime(u.tier_expires_at) < Date.now()) return 'free';
  return u.tier;
}
function publicUser(u) {
  return { id: u.id, name: u.name, email: S.maskEmail(u.email), phone: S.maskPhone(u.phone), identity: u.identity, tier: effectiveTier(u), tierExpiresAt: u.tier_expires_at };
}
function parseDbTime(s) { return Date.parse(String(s).replace(' ', 'T') + 'Z'); } // DB 時間一律存 UTC
function startOfTaipeiDay(ms) { const off = 8 * 3600e3; return Math.floor((ms + off) / 86400e3) * 86400e3 - off; }
function audit(actorId, action, target, detail, req) {
  db.prepare('INSERT INTO audit_log (actor_id,action,target,detail,ip) VALUES (?,?,?,?,?)').run(actorId, action, target, detail, req ? req.ip : null);
}
function ensureAdmin() {
  const has = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
  if (has) return;
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const pw = process.env.ADMIN_PASSWORD || '';
  if (!email || pw.length < 12 || /請改/.test(pw)) {
    console.error('[初始化] 尚無管理員帳號。請設定環境變數 ADMIN_EMAIL 與 ADMIN_PASSWORD（至少 12 碼）後重新啟動。');
    process.exit(1);
  }
  S.V.email(email); S.V.password(pw);
  db.prepare("INSERT INTO users (role,name,email,password_hash) VALUES ('admin','管理員',?,?)").run(email, S.hashPassword(pw));
  console.log('[初始化] 已建立管理員帳號：' + email + '（建議登入後台後立即修改密碼，並從環境變數移除 ADMIN_PASSWORD）');
}
function loadOrCreateSecret(file) {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try { return fs.readFileSync(file, 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
