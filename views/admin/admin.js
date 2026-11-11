/* 房管家後台 v2：所有資料透過 /api/admin 讀寫；不使用 inline 事件，輸出一律跳脫 */
(function () {
  'use strict';
  let CSRF = null;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TIER = { free: '免費', gold: '金牌', diamond: '鑽石' };
  const OST = { pending: '待付款', paid: '已付款', failed: '付款失敗', cancelled: '已取消', refunded: '已退款' };
  const BST = { pending: '待確認', confirmed: '已確認', done: '已完成', cancelled: '已取消' };
  const tierTag = t => `<span class="tg ${t === 'gold' ? 'tg-gold' : t === 'diamond' ? 'tg-dia' : ''}">${esc(TIER[t] || t)}</span>`;
  const tw = s => s ? new Date(String(s).replace(' ', 'T') + 'Z').toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '—';
  const twDate = s => s ? new Date(String(s).replace(' ', 'T') + 'Z').toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }) : '';

  async function api(method, url, body) {
    const opt = { method, headers: {}, credentials: 'same-origin' };
    if (method !== 'GET') { opt.headers['Content-Type'] = 'application/json'; opt.headers['X-CSRF-Token'] = CSRF; opt.body = JSON.stringify(body || {}); }
    const r = await fetch('/api/admin' + url, opt);
    if (r.status === 401) { location.href = '/admin/login'; throw new Error('請重新登入'); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
    return d;
  }
  function modal(html) { $('md').innerHTML = html; $('mo').classList.add('show'); }
  function closeModal() { $('mo').classList.remove('show'); }
  $('mo').addEventListener('click', e => { if (e.target.id === 'mo' || e.target.dataset.act === 'close') closeModal(); });
  function flash(msg) { alert(msg); }

  const SECTIONS = {
    async dashboard() {
      const s = await api('GET', '/stats');
      return `<div class="sg">
        ${[['會員總數', s.members], ['有效付費會員', s.paid], ['金牌', s.gold], ['鑽石', s.diamond], ['本月營收（NT$）', s.revenueThisMonth.toLocaleString()], ['待付款訂單', s.pendingOrders], ['待確認預約', s.pendingBookings], ['今日 AI 諮詢次數', s.aiToday]]
          .map(([l, n]) => `<div class="st"><div class="nm">${esc(n)}</div><div class="lb">${esc(l)}</div></div>`).join('')}</div>
        <div class="cd"><b>系統狀態</b><br>AI：${s.aiMode === 'gemini' ? '已連線 Gemini（伺服器端）' : '測試模式（未設定 GEMINI_API_KEY）'}<br>金流：${esc(s.paymentProvider)}${s.paymentProvider === 'mock' ? '（模擬，正式上線前需改為綠界或藍新）' : ''}</div>`;
    },
    async members() {
      return `<div class="cd"><div class="bar"><input id="mq" placeholder="搜尋姓名／Email／手機"><select id="mt"><option value="">全部等級</option><option value="free">免費</option><option value="gold">金牌</option><option value="diamond">鑽石</option></select>
        <select id="ms"><option value="">全部狀態</option><option value="active">啟用</option><option value="disabled">停用</option></select><button class="btn btn-p" data-act="msearch">搜尋</button></div>
        <div class="note">為保護個資，Email 與手機預設遮罩；點「查看完整」會留下操作紀錄。</div><div id="mlist">載入中…</div></div>`;
    },
    async orders() {
      const d = await api('GET', '/orders');
      return `<div class="cd"><div class="note">訂單只會由「金流通知（webhook）驗證通過」自動改為已付款。若為銀行轉帳等人工收款，可用「人工對帳」並填寫備註（會留紀錄）。</div>
        <table><thead><tr><th>訂單號</th><th>會員</th><th>方案</th><th>金額</th><th>金流</th><th>建立</th><th>付款</th><th>狀態</th><th>操作</th></tr></thead><tbody>
        ${d.orders.map(o => `<tr><td>${esc(o.order_no)}</td><td>${esc(o.member_name)}</td><td>${tierTag(o.plan)} ${o.cycle === 'monthly' ? '月繳' : '年繳'}</td><td>${esc(o.amount.toLocaleString())}</td><td>${esc(o.provider)}</td><td>${tw(o.created_at)}</td><td>${tw(o.paid_at)}</td>
          <td><span class="tg ${o.status === 'paid' ? 'tg-ok' : o.status === 'pending' ? '' : 'tg-bad'}">${esc(OST[o.status] || o.status)}</span></td>
          <td>${['pending', 'failed'].includes(o.status) ? `<button class="btn btn-o btn-s" data-act="opaid" data-id="${o.id}">人工對帳</button> <button class="btn btn-d btn-s" data-act="ocancel" data-id="${o.id}">取消</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="9">尚無訂單</td></tr>'}
        </tbody></table></div>`;
    },
    async revenue() {
      const d = await api('GET', '/revenue');
      return `<div class="sg"><div class="st"><div class="nm">${esc(d.total.toLocaleString())}</div><div class="lb">累計已付款金額（${esc(d.currency)}）</div></div><div class="st"><div class="nm">${esc(d.count)}</div><div class="lb">已付款訂單數</div></div></div>
        <div class="cd"><div class="note">${esc(d.note)}</div><table><thead><tr><th>月份（台北）</th><th>方案</th><th>週期</th><th>筆數</th><th>金額</th></tr></thead><tbody>
        ${d.byMonth.map(r => `<tr><td>${esc(r.month)}</td><td>${tierTag(r.plan)}</td><td>${r.cycle === 'monthly' ? '月繳' : '年繳'}</td><td>${esc(r.n)}</td><td>${esc(r.total.toLocaleString())}</td></tr>`).join('') || '<tr><td colspan="5">尚無已付款訂單</td></tr>'}
        </tbody></table><div class="row"><button class="btn btn-o" data-act="revcsv">匯出 CSV</button></div></div>`;
    },
    async bookings() {
      const d = await api('GET', '/bookings');
      window.__bk = d.bookings;
      return `<div class="cd"><table><thead><tr><th>編號</th><th>會員</th><th>方式</th><th>類別</th><th>日期時段</th><th>問題簡述</th><th>狀態</th><th>備註</th><th></th></tr></thead><tbody>
        ${d.bookings.map((b, i) => `<tr><td>${esc(b.booking_no)}</td><td>${esc(b.member_name)}</td><td>${esc(b.type)}</td><td>${esc(b.category)}</td><td>${esc(b.date)}<br>${esc(b.slot)}</td><td style="max-width:280px;white-space:pre-wrap">${esc(b.summary)}</td><td>${esc(BST[b.status])}</td><td>${esc(b.admin_note)}</td>
          <td><button class="btn btn-o btn-s" data-act="bedit" data-i="${i}">處理</button></td></tr>`).join('') || '<tr><td colspan="9">尚無預約</td></tr>'}
        </tbody></table></div>`;
    },
    async kb() {
      const d = await api('GET', '/kb'); window.__kb = d.articles;
      return `<div class="cd"><div class="row" style="margin:0 0 12px"><button class="btn btn-p" data-act="kbnew">＋ 新增條目</button></div>
        <div class="note">法律內容上架前請先經法務（阿法／合作律師）校正。</div>
        <table><thead><tr><th>分類</th><th>標題</th><th>等級</th><th>上架</th><th>更新</th><th></th></tr></thead><tbody>
        ${d.articles.map((a, i) => `<tr><td>${esc(a.category)}</td><td>${esc(a.title)}</td><td>${tierTag(a.min_tier)}</td><td>${a.published ? '✅' : '—'}</td><td>${tw(a.updated_at)}</td>
          <td><button class="btn btn-o btn-s" data-act="kbedit" data-i="${i}">編輯</button> <button class="btn btn-d btn-s" data-act="kbdel" data-id="${a.id}">刪除</button></td></tr>`).join('')}
        </tbody></table></div>`;
    },
    async templates() {
      const d = await api('GET', '/templates'); window.__tp = d.templates;
      return `<div class="cd"><div class="row" style="margin:0 0 12px"><button class="btn btn-p" data-act="tpnew">＋ 新增範本</button></div>
        <div class="note">此處管理「後台新增範本」。原版 APP 內建的 16 種範本仍寫在前端程式中（app.js），日後可逐步搬進此處統一管理。範本內容用 {{欄位代號}} 代入。</div>
        <table><thead><tr><th>分類</th><th>名稱</th><th>欄位數</th><th>等級</th><th>上架</th><th></th></tr></thead><tbody>
        ${d.templates.map((t, i) => `<tr><td>${esc(t.category)}</td><td>${esc(t.name)}</td><td>${JSON.parse(t.fields).length}</td><td>${tierTag(t.min_tier)}</td><td>${t.published ? '✅' : '—'}</td>
          <td><button class="btn btn-o btn-s" data-act="tpedit" data-i="${i}">編輯</button> <button class="btn btn-d btn-s" data-act="tpdel" data-id="${t.id}">刪除</button></td></tr>`).join('')}
        </tbody></table></div>`;
    },
    async audit() {
      const d = await api('GET', '/audit');
      return `<div class="cd"><table><thead><tr><th>時間（台北）</th><th>操作者</th><th>動作</th><th>對象</th><th>說明</th></tr></thead><tbody>
        ${d.logs.map(l => `<tr><td>${tw(l.created_at)}</td><td>${esc(l.actor || '系統')}</td><td>${esc(l.action)}</td><td>${esc(l.target)}</td><td>${esc(l.detail)}</td></tr>`).join('')}</tbody></table></div>`;
    },
    async settings() {
      const c = await api('GET', '/config');
      const p = c.prices.plans;
      const m = v => v == null ? '<span class="tg tg-bad">未定</span>' : 'NT$' + esc(v);
      return `<div class="cd"><h3>方案價格（唯讀）</h3><div class="note">價格只在伺服器的 config/prices.json 設定一處，修改後重啟生效。未定價的方案前台無法下單。</div>
        <table><thead><tr><th>方案</th><th>月繳</th><th>年繳</th></tr></thead><tbody>${Object.entries(p).map(([k, v]) => `<tr><td>${esc(v.name)}</td><td>${m(v.monthly)}</td><td>${m(v.yearly)}</td></tr>`).join('')}</tbody></table>
        <h3 style="margin-top:16px">AI 使用額度</h3><table><thead><tr><th>等級</th><th>每日</th><th>每分鐘</th><th>可預約</th></tr></thead><tbody>${Object.entries(c.plans.tiers).map(([k, t]) => `<tr><td>${esc(t.label)}</td><td>${esc(t.aiPerDay)}</td><td>${esc(t.aiPerMinute)}</td><td>${t.booking ? '是' : '否'}</td></tr>`).join('')}</tbody></table></div>
        <div class="cd"><h3>修改管理員密碼</h3><label>目前密碼</label><input type="password" id="pw0" autocomplete="current-password"><label>新密碼（至少 12 碼，含英文與數字）</label><input type="password" id="pw1" autocomplete="new-password">
        <div class="row"><button class="btn btn-p" data-act="pwchg">更新密碼</button></div></div>`;
    }
  };
  const TITLES = { dashboard: '儀表板', members: '會員管理', orders: '訂單與付款', revenue: '營收報表', bookings: '鑽石預約管理', kb: '法律知識庫', templates: '範本管理', audit: '操作紀錄', settings: '設定與密碼' };
  let cur = 'dashboard';
  async function show(sec) {
    cur = sec; $('title').textContent = TITLES[sec];
    document.querySelectorAll('.ni[data-sec]').forEach(n => n.classList.toggle('act', n.dataset.sec === sec));
    try { $('view').innerHTML = await SECTIONS[sec](); if (sec === 'members') loadMembers(); }
    catch (e) { $('view').innerHTML = `<div class="cd err">${esc(e.message)}</div>`; }
  }
  async function loadMembers() {
    const q = new URLSearchParams({ q: $('mq').value, tier: $('mt').value, status: $('ms').value });
    const d = await api('GET', '/members?' + q); window.__mem = d.members;
    $('mlist').innerHTML = `<table><thead><tr><th>姓名</th><th>Email／手機</th><th>身份</th><th>等級</th><th>到期</th><th>狀態</th><th>註冊</th><th></th></tr></thead><tbody>
      ${d.members.map((m, i) => `<tr><td>${esc(m.name)}</td><td id="pii-${m.id}">${esc(m.email)}<br>${esc(m.phone)}</td><td>${esc(m.identity)}</td><td>${tierTag(m.effectiveTier)}${m.tier !== m.effectiveTier ? '<br><small>（' + esc(TIER[m.tier]) + '已過期）</small>' : ''}</td>
        <td>${m.tier_expires_at ? esc(twDate(m.tier_expires_at)) : '—'}</td><td>${m.status === 'active' ? '<span class="tg tg-ok">啟用</span>' : '<span class="tg tg-bad">停用</span>'}</td><td>${esc(twDate(m.created_at))}</td>
        <td><button class="btn btn-o btn-s" data-act="mreveal" data-id="${m.id}">查看完整</button> <button class="btn btn-o btn-s" data-act="medit" data-i="${i}">調整</button></td></tr>`).join('') || '<tr><td colspan="8">尚無會員</td></tr>'}</tbody></table>`;
  }
  const tierSel = (id, v) => `<select id="${id}">${['free', 'gold', 'diamond'].map(t => `<option value="${t}" ${t === v ? 'selected' : ''}>${TIER[t]}</option>`).join('')}</select>`;
  function kbForm(a) {
    a = a || { category: '法規', title: '', body: '', source_url: '', min_tier: 'free', published: 1 };
    modal(`<h3>${a.id ? '編輯' : '新增'}知識庫條目</h3><label>分類</label><input id="f-cat" maxlength="30" value="${esc(a.category)}"><label>標題</label><input id="f-title" maxlength="120" value="${esc(a.title)}">
      <label>內容</label><textarea id="f-body" maxlength="20000">${esc(a.body)}</textarea><label>官方來源連結</label><input id="f-url" maxlength="500" value="${esc(a.source_url || '')}">
      <label>可閱讀等級</label>${tierSel('f-tier', a.min_tier)}<label><input type="checkbox" id="f-pub" style="width:auto" ${a.published ? 'checked' : ''}> 上架</label>
      <div class="row"><button class="btn btn-p" data-act="kbsave" data-id="${a.id || ''}">儲存</button><button class="btn btn-o" data-act="close">取消</button></div><div class="err" id="f-err"></div>`);
  }
  function tpForm(t) {
    t = t || { category: '通知書', name: '', description: '', fields: '[{"k":"tenant","l":"承租人姓名"}]', body: '', min_tier: 'gold', published: 0 };
    modal(`<h3>${t.id ? '編輯' : '新增'}範本</h3><label>分類</label><input id="f-cat" maxlength="30" value="${esc(t.category)}"><label>名稱</label><input id="f-name" maxlength="80" value="${esc(t.name)}">
      <label>說明</label><input id="f-desc" maxlength="300" value="${esc(t.description)}"><label>欄位（JSON 陣列：k=代號、l=顯示名稱）</label><textarea id="f-fields" style="min-height:70px">${esc(t.fields)}</textarea>
      <label>範本內容（用 {{代號}} 代入欄位）</label><textarea id="f-body" maxlength="20000">${esc(t.body)}</textarea>
      <label>可使用等級</label>${tierSel('f-tier', t.min_tier)}<label><input type="checkbox" id="f-pub" style="width:auto" ${t.published ? 'checked' : ''}> 上架</label>
      <div class="row"><button class="btn btn-p" data-act="tpsave" data-id="${t.id || ''}">儲存</button><button class="btn btn-o" data-act="close">取消</button></div><div class="err" id="f-err"></div>`);
  }
  async function guarded(fn) { try { await fn(); } catch (e) { const el = $('f-err'); if (el && $('mo').classList.contains('show')) el.textContent = e.message; else flash(e.message); } }

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act],[data-sec],#logout'); if (!b) return;
    if (b.id === 'logout') return guarded(async () => { await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': CSRF, 'Content-Type': 'application/json' }, body: '{}' }); location.href = '/admin/login'; });
    if (b.dataset.sec) return show(b.dataset.sec);
    const a = b.dataset.act, id = b.dataset.id, i = b.dataset.i;
    const A = {
      msearch: () => loadMembers(),
      mreveal: async () => { const reason = prompt('查看完整個資的原因（會記錄）：'); if (!reason) return; const d = await api('POST', `/members/${id}/reveal`, { reason }); $('pii-' + id).textContent = d.email + ' ／ ' + d.phone; },
      medit: () => { const m = window.__mem[i]; modal(`<h3>調整會員：${esc(m.name)}</h3><label>等級</label>${tierSel('f-tier', m.tier)}<label>到期日（台北）</label><input type="date" id="f-exp" value="${esc(twDate(m.tier_expires_at))}">
          <label>狀態</label><select id="f-st"><option value="active" ${m.status === 'active' ? 'selected' : ''}>啟用</option><option value="disabled" ${m.status === 'disabled' ? 'selected' : ''}>停用</option></select>
          <label>調整原因（會記錄）</label><input id="f-reason" maxlength="200"><div class="row"><button class="btn btn-p" data-act="msave" data-id="${m.id}">儲存</button><button class="btn btn-o" data-act="close">取消</button></div><div class="err" id="f-err"></div>`); },
      msave: async () => { await api('PATCH', `/members/${id}`, { tier: $('f-tier').value, tier_expires_at: $('f-exp').value || null, status: $('f-st').value, reason: $('f-reason').value }); closeModal(); loadMembers(); },
      opaid: async () => { const note = prompt('人工對帳備註（例如：轉帳末五碼、日期）：'); if (!note) return; await api('POST', `/orders/${id}/mark-paid`, { note }); show('orders'); },
      ocancel: async () => { if (!confirm('確定取消此訂單？')) return; await api('POST', `/orders/${id}/cancel`); show('orders'); },
      revcsv: async () => { const d = await api('GET', '/revenue'); const csv = '\ufeff月份,方案,週期,筆數,金額\n' + d.byMonth.map(r => [r.month, TIER[r.plan], r.cycle === 'monthly' ? '月繳' : '年繳', r.n, r.total].join(',')).join('\n');
        const u = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); const l = document.createElement('a'); l.href = u; l.download = 'revenue.csv'; l.click(); URL.revokeObjectURL(u); },
      bedit: () => { const k = window.__bk[i]; modal(`<h3>處理預約 ${esc(k.booking_no)}</h3><div class="note">${esc(k.date)} ${esc(k.slot)}｜${esc(k.type)}｜${esc(k.category)}<br>${esc(k.summary)}</div>
          <label>狀態</label><select id="f-st">${Object.entries(BST).map(([v, l]) => `<option value="${v}" ${v === k.status ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <label>內部備註（律師、會議方式等）</label><textarea id="f-note" maxlength="1000">${esc(k.admin_note)}</textarea><div class="row"><button class="btn btn-p" data-act="bsave" data-id="${k.id}">儲存</button><button class="btn btn-o" data-act="close">取消</button></div><div class="err" id="f-err"></div>`); },
      bsave: async () => { await api('PATCH', `/bookings/${id}`, { status: $('f-st').value, admin_note: $('f-note').value }); closeModal(); show('bookings'); },
      kbnew: () => kbForm(), kbedit: () => kbForm(window.__kb[i]),
      kbsave: async () => { const body = { category: $('f-cat').value, title: $('f-title').value, body: $('f-body').value, source_url: $('f-url').value, min_tier: $('f-tier').value, published: $('f-pub').checked };
        await api(id ? 'PUT' : 'POST', id ? `/kb/${id}` : '/kb', body); closeModal(); show('kb'); },
      kbdel: async () => { if (!confirm('確定刪除？')) return; await api('DELETE', `/kb/${id}`); show('kb'); },
      tpnew: () => tpForm(), tpedit: () => tpForm(window.__tp[i]),
      tpsave: async () => { const body = { category: $('f-cat').value, name: $('f-name').value, description: $('f-desc').value, fields: $('f-fields').value, body: $('f-body').value, min_tier: $('f-tier').value, published: $('f-pub').checked };
        await api(id ? 'PUT' : 'POST', id ? `/templates/${id}` : '/templates', body); closeModal(); show('templates'); },
      tpdel: async () => { if (!confirm('確定刪除？')) return; await api('DELETE', `/templates/${id}`); show('templates'); },
      pwchg: async () => { await api('POST', '/password', { current: $('pw0').value, next: $('pw1').value }); $('pw0').value = $('pw1').value = ''; flash('密碼已更新'); }
    };
    if (A[a]) guarded(A[a]);
  });

  (async function init() {
    const s = await (await fetch('/api/session')).json();
    CSRF = s.csrfToken;
    const me = await api('GET', '/me'); $('who').textContent = me.name + '（' + me.email + '）';
    show('dashboard');
  })();
})();
