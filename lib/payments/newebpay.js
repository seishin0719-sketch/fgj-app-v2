'use strict';
/*
 * 藍新 NewebPay（尚未實作 — 待申請商店後再接）
 * 需要的環境變數：NEWEBPAY_MERCHANT_ID、NEWEBPAY_HASH_KEY、NEWEBPAY_HASH_IV、NEWEBPAY_ENV(test|prod)
 * 實作要點：
 *  1. createCheckout：TradeInfo 以 AES-256-CBC 加密、TradeSha 以 SHA256 計算，回傳 { type:'form', action, fields }。
 *     定期定額使用藍新「信用卡定期定額」API。
 *  2. parseWebhook（NotifyURL）：解密 TradeInfo、驗 TradeSha，Status=='SUCCESS' 視為成功。
 *  3. 金額必須與資料庫訂單金額比對一致才可入帳。
 */
function notReady() { const e = new Error('藍新金流尚未啟用（待申請商店）'); e.status = 503; e.expose = true; throw e; }
module.exports = { name: 'newebpay', createCheckout: notReady, parseWebhook: notReady };
