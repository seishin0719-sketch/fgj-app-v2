(function () {
  let csrf = null;
  fetch('/api/session').then(r => r.json()).then(s => { csrf = s.csrfToken; });
  document.getElementById('f').addEventListener('submit', async e => {
    e.preventDefault();
    const err = document.getElementById('err'); err.textContent = '';
    const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf || '' },
      body: JSON.stringify({ account: document.getElementById('acc').value, password: document.getElementById('pwd').value }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) location.href = '/admin'; else { err.textContent = d.error || '登入失敗'; document.getElementById('pwd').value = ''; }
  });
})();
