'use strict';
// 模擬金流：只供本機／測試環境。production 一律拒絕。
const crypto = require('crypto');
function secret() {
  const s = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!s || s.length < 16) throw new Error('PAYMENT_WEBHOOK_SECRET 未設定或太短');
  return s;
}
function sign(payload) { return crypto.createHmac('sha256', secret()).update(payload).digest('hex'); }
function assertAllowed() {
  if (process.env.NODE_ENV === 'production') throw new Error('production 環境不可使用模擬金流');
}
module.exports = {
  name: 'mock',
  sign,
  createCheckout(order) {
    assertAllowed();
    return { type: 'redirect', url: `/pay/mock/${encodeURIComponent(order.order_no)}` };
  },
  parseWebhook(req) {
    assertAllowed();
    const raw = req.rawBody || '';
    const sig = req.get('X-Mock-Signature') || '';
    let verified = false;
    try {
      const expect = sign(raw);
      verified = sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
    } catch { verified = false; }
    let body = {};
    try { body = JSON.parse(raw); } catch {}
    return { verified, orderNo: body.orderNo, paid: body.status === 'paid', tradeNo: body.tradeNo || null, raw, ackBody: 'OK' };
  }
};
