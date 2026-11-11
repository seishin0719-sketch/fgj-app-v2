/* 本機自動測試：node scripts/smoke-test.js（會啟動一個使用暫存資料庫的伺服器） */
'use strict';
const { spawn } = require('child_process');
const path = require('path'); const fs = require('fs'); const os = require('os');
const PORT = 3100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fgj-'));
const ADMIN_EMAIL = 'admin@test.local', ADMIN_PW = 'TestAdmin12345';
let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name); } }

class Client {
  constructor() { this.jar = {}; this.csrf = null; }
  cookie() { return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(method, url, body, extra = {}) {
    const h = { Cookie: this.cookie(), ...(extra.headers || {}) };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (method !== 'GET' && this.csrf && !extra.noCsrf) h['X-CSRF-Token'] = this.csrf;
    const r = await fetch(BASE + url, { method, headers: h, body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined, redirect: 'manual' });
    (r.headers.getSetCookie?.() || []).forEach(c => { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (/Max-Age=0/.test(c)) delete this.jar[k]; else this.jar[k] = v; });
    let data = null; const t = await r.text(); try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data, headers: r.headers };
  }
  async session() { const r = await this.req('GET', '/api/session'); this.csrf = r.data.csrfToken; return r.data; }
}

(async () => {
  const env = { ...process.env, NODE_ENV: 'development', PORT: String(PORT), DB_FILE: path.join(tmp, 'test.sqlite'), PRICES_FILE: './config/prices.test.json',
    ADMIN_EMAIL, ADMIN_PASSWORD: ADMIN_PW, PAYMENT_PROVIDER: 'mock', PAYMENT_WEBHOOK_SECRET: 'test-secret-0123456789abcdef', GEMINI_API_KEY: '' };
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  try {
    console.log('\n[1] 後台未登入不可進入');
    const anon = new Client();
    let r = await anon.req('GET', '/admin'); ok(r.status === 302 && r.headers.get('location') === '/admin/login', 'GET /admin → 轉址登入頁');
    r = await anon.req('GET', '/admin/admin.js'); ok(r.status === 302, 'GET /admin/admin.js → 轉址（後台程式也不外流）');
    r = await anon.req('GET', '/admin.html'); ok(r.status === 302, '舊網址 /admin.html → 轉址');
    r = await anon.req('GET', '/api/admin/stats'); ok(r.status === 401, 'GET /api/admin/stats → 401');
    r = await anon.req('GET', '/api/admin/members'); ok(r.status === 401, 'GET /api/admin/members → 401');
    r = await anon.req('GET', '/admin/login'); ok(r.status === 200, '登入頁可開啟');

    console.log('\n[2] 安全標頭與金鑰');
    r = await anon.req('GET', '/app.html');
    ok(r.status === 200, '前台 app.html 可開啟');
    ok(/script-src 'self'/.test(r.headers.get('content-security-policy') || ''), 'CSP 標頭存在');
    ok(r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('x-frame-options'), 'nosniff / X-Frame-Options');
    const js = (await anon.req('GET', '/js/app.js')).data;
    ok(!/AQ\.[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}|generativelanguage/.test(String(r.data) + js), '前端不含任何 API 金鑰或直連 Gemini');
    r = await anon.req('GET', '/admin/login'); ok(/script-src-attr 'none'/.test(r.headers.get('content-security-policy') || ''), '後台使用更嚴格 CSP');

    console.log('\n[3] 註冊 / CSRF / 驗證');
    const m = new Client();
    r = await m.req('POST', '/api/auth/register', { name: '測試', phone: '0900000001', email: 't1@example.com', password: 'abc12345', password2: 'abc12345', agree: true });
    ok(r.status === 403, '沒有 CSRF token → 403');
    await m.session();
    r = await m.req('POST', '/api/auth/register', { name: '測試', phone: '0900000001', email: 't1@example.com', password: '12345678', password2: '12345678', agree: true });
    ok(r.status === 400, '弱密碼（無英文）→ 400');
    r = await m.req('POST', '/api/auth/register', { name: '測試', phone: '123', email: 't1@example.com', password: 'abc12345', password2: 'abc12345', agree: true });
    ok(r.status === 400, '手機格式錯誤 → 400');
    r = await m.req('POST', '/api/auth/register', { name: '測試', phone: '0900000001', email: 't1@example.com', password: 'abc12345', password2: 'abc12345', agree: false });
    ok(r.status === 400, '未勾選同意條款 → 400');
    r = await m.req('POST', '/api/auth/register', { name: '測試會員', phone: '0900-000-001', email: 'T1@example.com', identity: '房東（自有房屋出租）', password: 'abc12345', password2: 'abc12345', agree: true });
    ok(r.status === 200 && r.data.user.tier === 'free', '註冊成功，預設免費');
    ok(r.data.user.email !== 't1@example.com' && r.data.user.phone.includes('*'), '回傳的個資已遮罩');
    r = await m.req('POST', '/api/auth/register', { name: 'x', phone: '0900000001', email: 'other@example.com', password: 'abc12345', password2: 'abc12345', agree: true }, { noCsrf: false });
    await m.session();
    r = await m.req('POST', '/api/auth/register', { name: 'x', phone: '0900000001', email: 'other@example.com', password: 'abc12345', password2: 'abc12345', agree: true });
    ok(r.status === 409, '重複手機 → 409');
    r = await m.req('POST', '/api/auth/logout', {}); await m.session();
    r = await m.req('POST', '/api/auth/login', { account: 't1@example.com', password: 'wrong1234' }); ok(r.status === 401, '錯誤密碼 → 401');
    r = await m.req('POST', '/api/auth/login', { account: '0900-000-001', password: 'abc12345' }); ok(r.status === 200, '以手機登入成功');
    await m.session();
    r = await m.req('POST', '/api/auth/logout', {}, { headers: { Origin: 'https://evil.example' } }); ok(r.status === 403, '跨站 Origin → 403');

    console.log('\n[4] 會員不可進後台');
    r = await m.req('GET', '/api/admin/stats'); ok(r.status === 403, '會員呼叫後台 API → 403');
    r = await m.req('GET', '/admin'); ok(r.status === 302, '會員開 /admin → 轉址');
    r = await m.req('POST', '/api/admin/login', { account: 't1@example.com', password: 'abc12345' }); ok(r.status === 401, '會員帳號用後台登入 → 拒絕');
    await m.session();

    console.log('\n[5] AI 代理（無金鑰 → 模擬）');
    r = await m.req('POST', '/api/ai/chat', { messages: [{ role: 'user', text: '房客欠租怎麼辦' }] }); ok(r.status === 403, '免費會員使用 AI → 403');

    console.log('\n[6] 升級流程（金流 stub）');
    r = await m.req('POST', '/api/orders', { plan: 'gold', cycle: 'monthly' });
    ok(r.status === 200 && r.data.order.status === 'pending' && r.data.checkout.url.startsWith('/pay/mock/'), '建立訂單 → 待付款，導向模擬付款頁');
    const orderNo = r.data.order.order_no;
    r = await m.req('GET', '/api/me'); ok(r.data.user.tier === 'free', '尚未付款 → 仍是免費');
    r = await m.req('POST', '/api/orders', { plan: 'platinum', cycle: 'monthly' }); ok(r.status === 400, '不存在的方案 → 400');
    const fake = JSON.stringify({ orderNo, status: 'paid' });
    r = await anon.req('POST', '/api/payments/webhook/mock', fake, { headers: { 'X-Mock-Signature': 'deadbeef' } }); ok(r.status === 400, '偽造 webhook（簽章錯）→ 400');
    r = await m.req('GET', '/api/me'); ok(r.data.user.tier === 'free', '偽造通知後仍是免費');
    r = await m.req('POST', `/api/pay/mock/${orderNo}/complete`, { result: 'paid' }); ok(r.status === 200 && r.data.status === 'paid', '模擬付款成功 → webhook 驗簽 → 已付款');
    r = await m.req('GET', '/api/me'); ok(r.data.user.tier === 'gold', '會員已升級金牌');
    const exp1 = r.data.user.tierExpiresAt;
    r = await m.req('POST', `/api/pay/mock/${orderNo}/complete`, { result: 'paid' });
    r = await m.req('GET', '/api/me'); ok(r.data.user.tierExpiresAt === exp1, '重複通知不重複加值（冪等）');

    console.log('\n[7] AI 代理（金牌）與限流');
    r = await m.req('POST', '/api/ai/chat', { messages: [{ role: 'user', text: '房客欠租怎麼辦' }] });
    ok(r.status === 200 && r.data.mode === 'mock' && /測試模式/.test(r.data.reply), '金牌會員取得模擬回覆（未設金鑰）');
    r = await m.req('POST', '/api/ai/chat', { messages: [{ role: 'user', text: 'x'.repeat(2001) }] }); ok(r.status === 400, '超長訊息 → 400');
    let last; for (let i = 0; i < 5; i++) last = await m.req('POST', '/api/ai/chat', { messages: [{ role: 'user', text: '第' + i + '題' }] });
    ok(last.status === 429, '金牌每分鐘上限 5 次 → 第 6 次 429');

    console.log('\n[8] 鑽石預約');
    r = await m.req('POST', '/api/bookings', { type: '電話諮詢', category: '其他', date: '2099-01-01', slot: '09:00-10:00', summary: '測試預約內容' }); ok(r.status === 403, '金牌預約 → 403');
    r = await m.req('POST', '/api/orders', { plan: 'diamond', cycle: 'yearly' }); const o2 = r.data.order.order_no;
    await m.req('POST', `/api/pay/mock/${o2}/complete`, { result: 'paid' });
    r = await m.req('GET', '/api/me'); ok(r.data.user.tier === 'diamond', '付款後升級鑽石');
    r = await m.req('POST', '/api/bookings', { type: '電話諮詢', category: '其他', date: '2020-01-01', slot: '09:00-10:00', summary: '測試預約內容' }); ok(r.status === 400, '過去日期 → 400');
    r = await m.req('POST', '/api/bookings', { type: '電話諮詢', category: '其他', date: '2099-01-01', slot: '03:00-04:00', summary: '測試預約內容' }); ok(r.status === 400, '不存在時段 → 400');
    r = await m.req('POST', '/api/bookings', { type: '電話諮詢', category: '租金／欠租糾紛', date: '2099-01-01', slot: '09:00-10:00', summary: '房客欠租三個月<script>alert(1)</script>' }); ok(r.status === 200, '鑽石會員預約成功');
    r = await m.req('POST', '/api/orders', { plan: 'gold', cycle: 'monthly' }); const o3 = r.data.order.order_no;
    await m.req('POST', `/api/pay/mock/${o3}/complete`, { result: 'fail' });
    r = await m.req('GET', '/api/me'); ok(r.data.user.tier === 'diamond' && r.data.orders.find(o => o.order_no === o3).status === 'failed', '付款失敗 → 訂單 failed，等級不變');

    console.log('\n[9] 管理員');
    const ad = new Client(); await ad.session();
    r = await ad.req('POST', '/api/admin/login', { account: ADMIN_EMAIL, password: 'wrongpassword1' }); ok(r.status === 401, '管理員錯誤密碼 → 401');
    r = await ad.req('POST', '/api/auth/login', { account: ADMIN_EMAIL, password: ADMIN_PW }); ok(r.status === 403, '管理員不可從前台登入');
    r = await ad.req('POST', '/api/admin/login', { account: ADMIN_EMAIL, password: ADMIN_PW }); ok(r.status === 200, '管理員登入成功');
    await ad.session();
    r = await ad.req('GET', '/admin'); ok(r.status === 200 && /後台管理系統 v2/.test(r.data), '登入後可開 /admin');
    r = await ad.req('GET', '/api/admin/stats'); ok(r.status === 200 && r.data.members === 1 && r.data.diamond === 1, '儀表板統計正確（1 位會員、1 位鑽石）');
    r = await ad.req('GET', '/api/admin/members'); const mem = r.data.members[0];
    ok(mem && mem.email.includes('***') && mem.phone.includes('*') && !('password_hash' in mem), '會員列表遮罩 Email／手機，不回傳密碼雜湊');
    r = await ad.req('POST', `/api/admin/members/${mem.id}/reveal`, { reason: '客服核對' }); ok(r.data.email === 't1@example.com', '查看完整個資（留紀錄）');
    r = await ad.req('PATCH', `/api/admin/members/${mem.id}`, { tier: 'gold', tier_expires_at: null }); ok(r.status === 400, '付費等級未給到期日 → 400');
    r = await ad.req('GET', '/api/admin/orders'); ok(r.data.orders.length === 3, '訂單列表 3 筆');
    r = await ad.req('GET', '/api/admin/revenue'); ok(r.data.total === 1 + 20 && r.data.count === 2, '營收報表 = 已付款訂單加總（測試價 1+20）');
    r = await ad.req('GET', '/api/admin/bookings'); const bk = r.data.bookings[0]; ok(bk && bk.status === 'pending', '後台看得到預約');
    r = await ad.req('PATCH', `/api/admin/bookings/${bk.id}`, { status: 'confirmed', admin_note: '已安排律師' }); ok(r.status === 200, '確認預約');
    r = await m.req('GET', '/api/bookings'); ok(r.data.bookings[0].status === 'confirmed', '前台同步看到「已確認」');
    r = await ad.req('POST', '/api/admin/kb', { category: '法規', title: '<img src=x onerror=alert(1)>', body: '內容', source_url: 'javascript:alert(1)', min_tier: 'free', published: true }); ok(r.status === 400, 'javascript: 連結 → 400');
    r = await ad.req('POST', '/api/admin/kb', { category: '實務', title: '付費條目', body: '付費內容', source_url: 'https://law.moj.gov.tw/', min_tier: 'gold', published: true }); ok(r.status === 200, '新增知識庫條目');
    const kid = r.data.id;
    r = await anon.req('GET', '/api/kb'); const lockedItem = r.data.articles.find(a => a.id === kid); ok(lockedItem && lockedItem.locked && lockedItem.body === '', '未登入看付費條目 → 只見標題、內容鎖住');
    r = await m.req('GET', '/api/kb'); ok(r.data.articles.find(a => a.id === kid).body === '付費內容', '鑽石會員看得到內容（前後台同步）');
    r = await ad.req('PUT', `/api/admin/kb/${kid}`, { category: '實務', title: '付費條目（改）', body: '新內容', source_url: '', min_tier: 'gold', published: false }); ok(r.status === 200, '編輯條目（下架）');
    r = await m.req('GET', '/api/kb'); ok(!r.data.articles.find(a => a.id === kid), '下架後前台不顯示');
    r = await ad.req('DELETE', `/api/admin/kb/${kid}`); ok(r.status === 200, '刪除條目');
    r = await ad.req('POST', '/api/admin/templates', { category: '通知書', name: '測試範本', description: '', fields: [{ k: 'a', l: '姓名' }], body: '你好 {{a}}', min_tier: 'gold', published: true }); ok(r.status === 200, '新增範本');
    r = await anon.req('GET', '/api/templates'); ok(r.data.templates.find(t => t.name === '測試範本').body === '', '未付費看不到範本內容');
    r = await m.req('GET', '/api/templates'); ok(r.data.templates.find(t => t.name === '測試範本').body === '你好 {{a}}', '付費會員取得範本內容');
    r = await ad.req('GET', '/api/admin/audit'); ok(r.data.logs.some(l => l.action === 'member.reveal_pii') && r.data.logs.some(l => l.action === 'order.paid_webhook'), '操作紀錄含個資查看與付款入帳');
    r = await ad.req('POST', '/api/ai/chat', { messages: [{ role: 'user', text: 'hi' }] }); ok(r.status === 403, '管理員帳號不可用會員 AI');
    r = await ad.req('POST', '/api/auth/logout', {}); r = await ad.req('GET', '/api/admin/stats'); ok(r.status === 401, '管理員登出後無法存取');

    console.log('\n[10] 登入暴力破解限制');
    const bf = new Client(); await bf.session(); let st;
    for (let i = 0; i < 12; i++) st = (await bf.req('POST', '/api/admin/login', { account: ADMIN_EMAIL, password: 'guess' + i + 'xxxxxxx' })).status;
    ok(st === 429, '後台登入連續失敗 → 429');
  } catch (e) { fail++; console.error(e); }
  finally {
    srv.kill();
    if (/AQ\.[A-Za-z0-9_-]{20,}|AIza/.test(log)) { fail++; console.log('  ❌ 伺服器日誌含金鑰'); }
    console.log(`\n結果：${pass} 通過，${fail} 失敗`);
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(fail ? 1 : 0);
  }
})();
