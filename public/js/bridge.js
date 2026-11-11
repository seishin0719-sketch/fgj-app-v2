/* 房管家 v2 前台 ↔ 伺服器 API 串接層
 * 覆寫原版的展示用函式（登入、註冊、升級、AI 諮詢、預約），改為呼叫 /api。
 * 權限一律由伺服器判斷；前端的 LEVEL 只用於畫面顯示。 */
(function () {
  'use strict';
  let CSRF = null, ME = null, CFG = null;
  let aiHistory = [];
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(method, url, body) {
    const opt = { method, headers: {}, credentials: 'same-origin' };
    if (method !== 'GET') { opt.headers['Content-Type'] = 'application/json'; opt.headers['X-CSRF-Token'] = CSRF || ''; opt.body = JSON.stringify(body || {}); }
    const r = await fetch(url, opt);
    let data = {}; try { data = await r.json(); } catch (_) {}
    if (!r.ok) { const e = new Error(data.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
    return data;
  }
  async function refreshSession() {
    const s = await api('GET', '/api/session');
    CSRF = s.csrfToken; ME = s.user; applyUser();
    return s;
  }

  // 依伺服器回傳的等級更新畫面（沿用原版 setLevel 的畫面邏輯，但不顯示「展示用」提示）
  const origSetLevel = window.setLevel;
  function applyLevel(l) {
    const t = window.toast; window.toast = function () {};
    try { origSetLevel(l); } finally { window.toast = t; }
  }
  window.setLevel = function () { /* v2：等級只能由伺服器（付款完成）變更 */ openMember(); };

  function applyUser() {
    applyLevel(ME ? ME.tier : 'free');
    if ($('meAcc')) $('meAcc').textContent = ME ? (ME.name + ' │ ' + ME.phone) : '尚未登入';
    if (ME && ME.tier !== 'free' && ME.tierExpiresAt && $('mePlanSub')) {
      $('mePlanSub').textContent = '目前：' + (CFG ? CFG.tiers[ME.tier].label : ME.tier) + '（到期：' + toTaipeiDate(ME.tierExpiresAt) + '）';
    }
    loadKb(); loadServerTemplates(); loadMyBookings();
  }
  function toTaipeiDate(s) {
    const d = new Date(String(s).replace(' ', 'T') + 'Z');
    return d.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
  }

  // ---------- 登入 / 註冊 / 登出 ----------
  window.doLogin = async function () {
    try {
      const r = await api('POST', '/api/auth/login', { account: $('lg-acc').value, password: $('lg-pwd').value });
      $('lg-pwd').value = '';
      await refreshSession(); aiHistory = [];
      toast('登入成功，歡迎回來，' + r.user.name + '！'); go('sc-home');
    } catch (e) { toast(e.message); }
  };
  window.doRegister = async function () {
    try {
      await api('POST', '/api/auth/register', {
        name: $('rg-name').value, phone: $('rg-phone').value, email: $('rg-email').value,
        identity: $('rg-identity').value, password: $('rg-pwd').value, password2: $('rg-pwd2').value,
        agree: $('rg-agree').checked
      });
      $('rg-pwd').value = ''; $('rg-pwd2').value = '';
      await refreshSession(); aiHistory = [];
      toast('註冊成功，歡迎加入房管家！'); go('sc-home');
    } catch (e) { toast(e.message); }
  };
  window.doLogout = async function () {
    try { await api('POST', '/api/auth/logout'); } catch (_) {}
    aiHistory = []; await refreshSession();
    toast('已登出'); go('sc-login');
  };

  // ---------- 升級方案（價格來自 config/prices.json） ----------
  let selPlan = 'gold', selCycle = 'yearly';
  function money(n) { return (n === null || n === undefined) ? '價格未定' : '$' + Number(n).toLocaleString(); }
  window.openMember = function () {
    const p = CFG ? CFG.plans : {};
    const cur = ME ? ME.tier : 'free';
    const row = (k, icon) => {
      const pl = p[k] || {};
      return `<div class="plan vip ${selPlan === k ? 'sel' : ''}" onclick="fgjSelPlan('${k}')">
        <div class="pname">${icon} ${esc(pl.name || k)}${cur === k ? '（目前方案）' : ''}</div>
        <div class="pprice"><span class="cur">${esc(money(pl.monthly))}</span><span class="per">／月繳</span></div>
        <div class="pprice"><span class="cur">${esc(money(pl.yearly))}</span><span class="per">／年繳</span></div>
        <div class="pfeat">${k === 'gold'
          ? '<span>✓</span>每日報完整內容<br><span>✓</span>線上 AI 法務諮詢（文字）<br><span>✓</span>全部範本產生器'
          : '<span>✓</span>金牌會員全部功能<br><span>✓</span>預約 Live 諮詢（線上視訊／面對面／電話）'}</div></div>`;
    };
    openModal('升級會員方案', `
      <div style="text-align:center;margin-bottom:14px"><div style="font-size:14px;font-weight:800;color:var(--violet-deep)">選擇方案與繳費週期</div></div>
      <div class="plan ${cur === 'free' ? 'sel' : ''}"><div class="pname">🥉 免費會員</div><div class="pprice"><span class="cur">$0</span></div>
        <div class="pfeat"><span>✓</span>基礎法律資料查詢<br><span>✓</span>租管問題情境瀏覽<br><span>✓</span>部分範本預覽</div></div>
      ${row('gold', '🥇')}${row('diamond', '💎')}
      <label class="fl">繳費週期</label>
      <select class="input" id="fgjCycle" onchange="fgjSelCycle(this.value)">
        <option value="monthly" ${selCycle === 'monthly' ? 'selected' : ''}>月繳</option>
        <option value="yearly" ${selCycle === 'yearly' ? 'selected' : ''}>年繳</option>
      </select>
      <button class="btn btn-gold" onclick="fgjCheckout()">確認升級並付款</button>
      <div class="hint">※ 付款完成並經金流通知確認後才會開通。價格以本頁顯示為準。</div>`);
  };
  window.fgjSelPlan = function (k) { selPlan = k; openMember(); };
  window.fgjSelCycle = function (c) { selCycle = c; };
  window.fgjCheckout = async function () {
    if (!ME) { closeModal(); toast('請先登入或註冊'); go('sc-login'); return; }
    try {
      const r = await api('POST', '/api/orders', { plan: selPlan, cycle: selCycle });
      const c = r.checkout;
      if (c.type === 'redirect') { location.href = c.url; return; }
      if (c.type === 'form') {
        const f = document.createElement('form'); f.method = 'POST'; f.action = c.action;
        Object.entries(c.fields).forEach(([k, v]) => { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i); });
        document.body.appendChild(f); f.submit();
      }
    } catch (e) { toast(e.message); }
  };

  // ---------- AI 諮詢（經伺服器代理） ----------
  window.sendMsg = async function () {
    const el = $('chatIn'); const txt = el.value.trim(); if (!txt) return;
    const box = $('chatBox');
    box.insertAdjacentHTML('beforeend', '<div class="msg me"><div class="av">我</div><div><div class="bub">' + escapeHtml(txt) + '</div><div class="tm">' + nowTime() + '</div></div></div>');
    el.value = ''; box.scrollTop = box.scrollHeight;
    if (!ME) { addAIReply('請先登入會員後再使用線上諮詢。'); return; }
    aiHistory.push({ role: 'user', text: txt.slice(0, 2000) });
    addTyping();
    try {
      const r = await api('POST', '/api/ai/chat', { messages: aiHistory.slice(-12) });
      removeTyping(); addAIReply(r.reply);
      aiHistory.push({ role: 'model', text: String(r.reply).slice(0, 2000) });
    } catch (e) {
      removeTyping(); aiHistory.pop();
      addAIReply('⚠️ ' + e.message + (e.status >= 500 ? '\n若情況緊急，請加入 LINE OA（https://lin.ee/TMsTOY1）由專人協助。' : ''));
    }
  };

  // ---------- 鑽石預約 ----------
  window.submitBooking = async function () {
    if (!ME) { toast('請先登入'); go('sc-login'); return; }
    try {
      const r = await api('POST', '/api/bookings', { type: $('bkType').value, category: $('bkCat').value, date: $('bkDate').value, slot: $('bkSlot').value, summary: $('bkSummary').value });
      $('bkSummary').value = '';
      toast('預約申請已送出（編號 ' + r.booking_no + '），將由專人聯繫確認 ✓');
      loadMyBookings();
    } catch (e) { toast(e.message); }
  };
  const BK_ST = { pending: '待確認', confirmed: '已確認', done: '已完成', cancelled: '已取消' };
  async function loadMyBookings() {
    const box = $('myBookings'); if (!box) return;
    if (!ME || ME.tier !== 'diamond') { box.innerHTML = ''; return; }
    try {
      const r = await api('GET', '/api/bookings');
      box.innerHTML = r.bookings.length ? '<div class="fl">我的預約</div>' + r.bookings.map(b =>
        `<div class="hint" style="margin:4px 0">${esc(b.date)} ${esc(b.slot)}｜${esc(b.type)}｜${esc(BK_ST[b.status] || b.status)}</div>`).join('') : '';
    } catch (_) {}
  }
  function fillSelect(id, list) { const s = $(id); if (s && list) s.innerHTML = list.map(v => `<option>${esc(v)}</option>`).join(''); }

  // ---------- 後台維護的知識庫與範本 ----------
  async function loadKb() {
    const box = $('kbServer'); if (!box) return;
    try {
      const r = await api('GET', '/api/kb');
      if (!r.articles.length) { box.innerHTML = ''; return; }
      box.innerHTML = '<div class="sec-title" style="margin:14px 0 8px"><span class="bar"></span>📌 後台維護的法律知識</div>' + r.articles.map(a => `
        <div class="card" style="margin-bottom:9px">
          <div style="font-weight:700;color:var(--violet-deep);font-size:13px">${esc(a.title)} <span class="tag tag-violet">${esc(a.category)}</span></div>
          ${a.locked ? '<div class="hint">🔒 此內容為付費會員專屬</div>' : `<div style="font-size:12px;line-height:1.8;white-space:pre-wrap;margin-top:6px">${esc(a.body)}</div>`}
          ${a.source_url ? `<a href="${esc(a.source_url)}" target="_blank" rel="noopener noreferrer" style="font-size:11.5px;color:var(--violet)">前往官方來源查閱 ›</a>` : ''}
        </div>`).join('');
    } catch (_) {}
  }
  let SERVER_TPL = [];
  async function loadServerTemplates() {
    const box = $('tplServer'); if (!box) return;
    try {
      const r = await api('GET', '/api/templates'); SERVER_TPL = r.templates;
      box.innerHTML = SERVER_TPL.length ? '<div class="sec-title" style="margin:14px 0 8px"><span class="bar"></span>🆕 後台新增範本</div>' + SERVER_TPL.map((t, i) => `
        <div class="list-item" onclick="fgjOpenTpl(${i})"><div class="li-ico">📄</div>
          <div class="li-c"><div class="lt">${esc(t.name)}${t.locked ? ' 🔒' : ''}</div><div class="ld">${esc(t.description)}</div></div><div class="li-ar">›</div></div>`).join('') : '';
    } catch (_) {}
  }
  window.fgjOpenTpl = function (i) {
    const t = SERVER_TPL[i]; if (!t) return;
    openModal(t.name, (t.locked ? '<div class="hint">🔒 此範本為付費會員功能，升級後即可產生文件。</div>' : '') +
      '<div id="fgjTplForm">' + t.fields.map(f => `<label class="fl">${esc(f.l)}</label><input class="input" data-k="${esc(f.k)}" maxlength="200">`).join('') +
      (t.locked ? '<button class="btn btn-gold" onclick="closeModal();openMember()">查看升級方案</button>' : `<button class="btn" onclick="fgjGenTpl(${i})">✨ 產生文件</button>`) + '</div>' +
      '<div id="fgjTplOut" style="display:none"><div class="doc-preview" id="fgjDoc"></div><div class="act-row"><button class="btn btn-outline" onclick="copyDoc()">📋 複製</button><button class="btn btn-gold" onclick="printDoc()">🖨️ 列印／存PDF</button></div></div>');
  };
  window.fgjGenTpl = function (i) {
    const t = SERVER_TPL[i]; const vals = {};
    document.querySelectorAll('#fgjTplForm [data-k]').forEach(el => vals[el.dataset.k] = el.value);
    const txt = t.body.replace(/\{\{(\w+)\}\}/g, (m, k) => vals[k] || '＿＿＿＿');
    $('fgjDoc').textContent = txt; window._cur = txt;
    $('fgjTplForm').style.display = 'none'; $('fgjTplOut').style.display = 'block';
  };

  // ---------- 初始化 ----------
  (async function init() {
    try {
      CFG = await api('GET', '/api/config');
      fillSelect('bkType', CFG.booking.types); fillSelect('bkCat', CFG.booking.categories); fillSelect('bkSlot', CFG.booking.slots);
      const tomorrow = new Date(Date.now() + 8 * 3600e3 + 86400e3).toISOString().slice(0, 10);
      if ($('bkDate')) $('bkDate').min = tomorrow;
      await refreshSession();
      if (ME) go('sc-home');
      const q = new URLSearchParams(location.search);
      if (q.get('paid')) { toast(ME && ME.tier !== 'free' ? '付款完成，已開通 ' + CFG.tiers[ME.tier].label : '付款結果確認中，請稍後重新整理'); history.replaceState(null, '', '/app.html'); go('sc-me'); }
    } catch (e) { console.error(e); toast('無法連線伺服器，請稍後再試'); }
  })();
})();
