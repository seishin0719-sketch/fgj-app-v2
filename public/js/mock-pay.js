(async function () {
  const orderNo = decodeURIComponent(location.pathname.split('/').pop());
  const s = await (await fetch('/api/session')).json();
  const info = document.getElementById('info'), msg = document.getElementById('msg');
  const r = await fetch('/api/pay/mock/' + encodeURIComponent(orderNo));
  const d = await r.json();
  if (!r.ok) { info.textContent = d.error || '讀取失敗'; return; }
  const o = d.order;
  info.textContent = `訂單 ${o.order_no}｜${o.plan === 'gold' ? '金牌' : '鑽石'}｜${o.cycle === 'monthly' ? '月繳' : '年繳'}｜NT$${o.amount}｜狀態：${o.status}`;
  async function done(result) {
    const x = await fetch('/api/pay/mock/' + encodeURIComponent(orderNo) + '/complete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrfToken }, body: JSON.stringify({ result }) });
    const y = await x.json();
    if (!x.ok) { msg.textContent = y.error; return; }
    msg.textContent = '金流通知結果：' + y.status;
    if (y.status === 'paid') setTimeout(() => location.href = '/app.html?paid=' + encodeURIComponent(orderNo), 800);
  }
  document.getElementById('ok').addEventListener('click', () => done('paid'));
  document.getElementById('fail').addEventListener('click', () => done('fail'));
})();
