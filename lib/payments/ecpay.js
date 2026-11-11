'use strict';
/*
 * 綠界 ECPay（尚未實作 — 待育誠以公司名義申請特約商店後再接）
 * 需要的環境變數：ECPAY_MERCHANT_ID、ECPAY_HASH_KEY、ECPAY_HASH_IV、ECPAY_ENV(stage|prod)
 * 實作要點：
 *  1. createCheckout：組 AioCheckOut 參數（MerchantTradeNo=order_no、TotalAmount、ItemName、
 *     ReturnURL=PUBLIC_BASE_URL/api/payments/webhook/ecpay、ChoosePayment=Credit；定期定額加 PeriodAmount 等），
 *     依官方規則計算 CheckMacValue（SHA256），回傳 { type:'form', action, fields } 由前端自動送出。
 *  2. parseWebhook：用相同規則驗證 CheckMacValue，RtnCode==1 視為付款成功；回應 ackBody '1|OK'。
 *  3. 金額必須與資料庫訂單金額比對一致才可入帳。
 */
function notReady() { const e = new Error('綠界金流尚未啟用（待申請特約商店）'); e.status = 503; e.expose = true; throw e; }
module.exports = { name: 'ecpay', createCheckout: notReady, parseWebhook: notReady };
