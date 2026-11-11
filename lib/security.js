'use strict';
const crypto = require('crypto');

// ---------- 密碼雜湊（scrypt，Node 內建，無需原生套件） ----------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, saltB64, dkB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const dk = Buffer.from(dkB64, 'base64');
    const test = crypto.scryptSync(pw, Buffer.from(saltB64, 'base64'), dk.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(dk, test);
  } catch { return false; }
}
// 用於帳號不存在時也花相同時間，避免帳號列舉
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

const randomToken = (n = 32) => crypto.randomBytes(n).toString('base64url');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// ---------- 個資遮罩 ----------
function maskEmail(e) {
  if (!e) return '';
  const [u, d] = e.split('@');
  return (u.length <= 2 ? u[0] + '***' : u.slice(0, 2) + '***') + '@' + (d || '');
}
function maskPhone(p) {
  if (!p) return '';
  const digits = p.replace(/\D/g, '');
  if (digits.length < 6) return '***';
  return digits.slice(0, 2) + '**-***-' + digits.slice(-3);
}

// ---------- 輸入驗證 ----------
const V = {
  str(v, { min = 0, max = 200, name = '欄位' } = {}) {
    if (typeof v !== 'string') throw bad(`${name}格式錯誤`);
    const s = v.trim();
    if (s.length < min) throw bad(`${name}至少 ${min} 字`);
    if (s.length > max) throw bad(`${name}不可超過 ${max} 字`);
    return s;
  },
  email(v) {
    const s = V.str(v, { min: 3, max: 254, name: 'Email' }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad('Email 格式錯誤');
    return s;
  },
  phone(v) {
    const s = V.str(v, { min: 8, max: 20, name: '手機' }).replace(/[\s-]/g, '');
    if (!/^09\d{8}$/.test(s)) throw bad('手機號碼格式錯誤（09 開頭共 10 碼）');
    return s;
  },
  password(v) {
    const s = typeof v === 'string' ? v : '';
    if (s.length < 8 || s.length > 128 || !/[A-Za-z]/.test(s) || !/\d/.test(s)) throw bad('密碼需 8 碼以上且包含英文與數字');
    return s;
  },
  oneOf(v, list, name = '欄位') {
    if (!list.includes(v)) throw bad(`${name}不正確`);
    return v;
  },
  url(v, { optional = true } = {}) {
    if ((v === undefined || v === null || v === '') && optional) return null;
    const s = V.str(v, { max: 500, name: '連結' });
    let u; try { u = new URL(s); } catch { throw bad('連結格式錯誤'); }
    if (!['https:', 'http:'].includes(u.protocol)) throw bad('連結只接受 http/https');
    return u.toString();
  },
  date(v) {
    const s = V.str(v, { min: 10, max: 10, name: '日期' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) throw bad('日期格式錯誤');
    return s;
  },
  id(v) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw bad('ID 錯誤');
    return n;
  }
};
function bad(msg, status = 400) { const e = new Error(msg); e.status = status; e.expose = true; return e; }

// ---------- 簡易記憶體限流（登入、註冊等） ----------
function memoryLimiter({ windowMs, max, key = req => req.ip, message = '嘗試次數過多，請稍後再試' }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const k = key(req); const now = Date.now();
    let h = hits.get(k);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(k, h); }
    h.n++;
    if (h.n > max) { res.set('Retry-After', Math.ceil((h.reset - now) / 1000)); return res.status(429).json({ error: message }); }
    next();
  };
}

module.exports = { hashPassword, verifyPassword, DUMMY_HASH, randomToken, sha256, safeEqual, maskEmail, maskPhone, V, bad, memoryLimiter };
