'use strict';
// 伺服器端 AI 代理：金鑰只從環境變數 GEMINI_API_KEY 讀取，絕不送到瀏覽器。
const SYSTEM_PROMPT = `你是「房管家」APP 的 AI 法務助理，專精台灣租賃住宅相關法律，包括：
- 租賃住宅市場發展及管理條例（租賃專法）
- 民法第421-463條（租賃章）
- 消費者保護法及施行細則
- 強制執行法（遷讓房屋、點交、拍賣等）
- 內政部房屋租賃契約書範本及定型化契約應記載/不得記載事項

回答原則：
1. 以繁體中文回答，語氣專業但易懂
2. 引用具體條文時標明法規名稱及條號
3. 提供實務處理步驟與建議，必要時用條列方式
4. 若涉及訴訟或複雜法律判斷，建議預約 Live 諮詢（鑽石會員功能）
5. 不提供絕對保證，提醒用戶最終仍需律師確認
6. 若問題超出租賃法律範圍，禮貌引導回租賃主題
7. 回覆控制在 500 字以內，結構清晰`;

function mockReply(text) {
  return `【測試模式】目前伺服器未設定 GEMINI_API_KEY，這是模擬回覆，不是法律意見。\n您的問題：「${text.slice(0, 60)}${text.length > 60 ? '…' : ''}」\n正式上線後此處會由 AI 法務助理回覆；如需即時協助請加入 LINE OA 由專人服務。`;
}

async function chat(messages) {
  const key = process.env.GEMINI_API_KEY;
  const last = messages[messages.length - 1].text;
  if (!key) return { reply: mockReply(last), mode: 'mock' };
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: messages.map(m => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: m.text }] })),
    generationConfig: { temperature: 0.4, maxOutputTokens: 2048 }
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, // 金鑰放 header，不放網址
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error('AI upstream HTTP ' + res.status);
    const data = await res.json();
    const reply = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    if (!reply) throw new Error('AI upstream empty');
    return { reply, mode: 'gemini' };
  } finally { clearTimeout(timer); }
}

module.exports = { chat };
