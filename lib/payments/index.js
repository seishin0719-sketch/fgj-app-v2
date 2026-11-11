'use strict';
/*
 * 金流介面（Provider 介面）
 * 每個金流商實作兩個方法：
 *   createCheckout(order, ctx) -> { type:'redirect', url } 或 { type:'form', action, fields }
 *   parseWebhook(req)          -> { verified:boolean, orderNo, paid:boolean, tradeNo, raw }
 *                                 並回傳金流商要求的回應字串 ackBody（例如綠界需回 "1|OK"）
 * 訂單狀態只能由「驗證通過的 webhook」改為 paid，前端或使用者無法直接升級。
 */
const providers = {
  mock: require('./mock'),
  ecpay: require('./ecpay'),
  newebpay: require('./newebpay')
};
function get(name) {
  const p = providers[name];
  if (!p) throw new Error('未知的金流商：' + name);
  return p;
}
module.exports = { get };
