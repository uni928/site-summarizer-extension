/* background.js (fast streaming version) */

const DEBUG = true;
const log = (...a) => DEBUG && console.log("[Summarizer]", ...a);
const warn = (...a) => DEBUG && console.warn("[Summarizer]", ...a);
const errlog = (...a) => console.error("[Summarizer]", ...a);

function safeString(x) {
  try {
    if (typeof x === "string") return x;
    if (x == null) return "";
    return String(x);
  } catch {
    return "";
  }
}

function buildPrompt({ title, url, text }, length) {
  const lengthGuide =
    length === "short" ? "200〜350字程度" :
    length === "long" ? "700〜1000字程度" :
    "400〜700字程度";

  return [
    "あなたはプロの編集者です。以下のWebページを日本語で要約してください。",
    "",
    "【出力要件】",
    `- 分量: ${lengthGuide}`,
    "- 構成: 1) 一言要約（1文） 2) 重要ポイント（箇条書き3〜6個） 3) 用語/背景（必要なら）",
    "- 宣伝文句は避け、事実と主張を分けて書く",
    "",
    "【ページ情報】",
    `タイトル: ${title || ""}`,
    `URL: ${url || ""}`,
    "",
    "【本文（抜粋/整形済み）】",
    text || ""
  ].join("\n");
}

async function executeInTab(tabId, func) {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func });
    return (Array.isArray(results) && results[0]) ? (results[0].result ?? null) : null;
  } catch (e) {
    warn("executeScript failed:", e);
    return null;
  }
}

async function extractFromTab(tabId) {
  const r1 = await executeInTab(tabId, () => {
    const title = document.title || "";
    const url = location.href;

    const sel = window.getSelection?.().toString?.().trim?.() || "";
    if (sel && sel.length > 200) return { title, url, text: sel };

    const el = document.querySelector("main") || document.querySelector("article") || document.body;
    const text = (el?.innerText || "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();

    return { title, url, text };
  });

  const r2 = r1 ?? await executeInTab(tabId, () => ({
    title: document.title || "",
    url: location.href,
    text: (document.body?.innerText || "").trim()
  }));

  const title = safeString(r2?.title);
  const url = safeString(r2?.url);
  let text = safeString(r2?.text);

  // 速度優先：入力を軽くする（ここが効きます）
  const maxChars = 8000;
  if (text.length > maxChars) text = text.slice(0, maxChars);

  return { title, url, text };
}

async function openSummaryTabInitial({ title, url, provider, model }) {
  const key = `summary_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await chrome.storage.session.set({
    [key]: {
      ok: true,
      provider,
      model,
      title,
      url,
      summary: "",
      createdAt: new Date().toISOString()
    }
  });
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(`summary.html#${key}`) });
  return { key, tabId: tab.id };
}

function sendToSummary(key, msg) {
  // 拡張内（summary.html）へブロードキャスト。keyで受け側が絞り込みます。
  chrome.runtime.sendMessage({ ...msg, key }).catch(() => {});
}

function parseSSELines(buffer) {
  // ✅ CRLF を LF に正規化（GeminiのSSEで効く）
  const normalized = buffer.replace(/\r\n/g, "\n");

  // SSEは「空行」でイベント区切り
  const events = [];
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? "";

  for (const chunk of parts) {
    // data: が複数行になることがあるので全部拾って連結
    const dataLines = chunk
      .split("\n")
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim());

    if (dataLines.length) {
      events.push(dataLines.join("\n"));
    }
  }

  return { events, rest };
}


async function streamOpenAI({ apiKey, model, prompt, onDelta }) {
  const usedModel = model || "gpt-5-mini";

  let resp;

if(0 <= usedModel.indexOf("gpt-5")) {
 resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: usedModel,
      input: prompt,
      stream: true,
      reasoning_effort: "minimal",
service_tier: "flex", // ←追加
    })
  });

if (!resp.ok && resp.status === 429) {
 resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: usedModel,
      input: prompt,
      stream: true,
      reasoning_effort: "minimal",
    })
  });
}

} else {
 resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: usedModel,
      input: prompt,
      stream: true
    })
  });
}


  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`OpenAI API error: ${resp.status} ${resp.statusText}\n${t}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });
    const parsed = parseSSELines(buf);
    buf = parsed.rest;

    for (const data of parsed.events) {
      if (data === "[DONE]") return;

      let obj;
      try { obj = JSON.parse(data); } catch { continue; }

      // 代表: type === "response.output_text.delta", delta が文字列 :contentReference[oaicite:3]{index=3}
      const delta = (typeof obj?.delta === "string") ? obj.delta : "";
      if (delta) onDelta(delta);

      // たまに別形式が混じる場合の保険（textフィールド拾い）
      //if (!delta && typeof obj?.text === "string") onDelta(obj.text);
    }
  }
}

async function streamGemini({ apiKey, model, prompt, onDelta }) {
  // 公式: streamGenerateContent エンドポイント :contentReference[oaicite:1]{index=1}
  const usedModel = model || "gemini-1.5-flash";

  // ✅ key はクエリに載せる方が安定（ヘッダも併用）
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(usedModel)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      // SSEを明示（効く環境がある）
      "Accept": "text/event-stream",
      "Content-Type": "application/json",
      // 念のため残す（keyクエリが主）
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    })
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Gemini API error: ${resp.status} ${resp.statusText}\n${t}`);
  }

  if (!resp.body) throw new Error("Gemini response body is empty (no stream).");

  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  // ✅ Geminiは「そのイベント時点の差分」か「短い断片」が来る想定で append
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });
    const { events, rest } = parseSSELines(buf);
    buf = rest;

    for (const data of events) {
      // data が空や keep-alive のことがある
      if (!data || data === "[DONE]") continue;

      let obj;
      try { obj = JSON.parse(data); } catch { continue; }

      const parts = obj?.candidates?.[0]?.content?.parts;
      if (Array.isArray(parts)) {
        const text = parts.map(p => (typeof p?.text === "string" ? p.text : "")).join("");
        if (text) onDelta(text);
      }
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "PING") {
        sendResponse({ ok: true, pong: true });
        return;
      }

      if (msg.type !== "SUMMARIZE_ACTIVE_TAB") return;

      const { tabId, provider, apiKey, model, length } = msg;
      if (!tabId) throw new Error("tabId is missing.");
      if (!apiKey) throw new Error("API Key is empty.");

      const page = await extractFromTab(tabId);
      log("extracted:", { title: page.title, url: page.url, len: page.text?.length });

      if (!page.text || page.text.length < 80) {
        throw new Error("本文が十分に取得できませんでした（テキストが少なすぎます）。別の通常Webページで試してください。");
      }

      // ✅ 先にタブを開く（体感速度アップ）
      const usedProvider = provider === "gemini" ? "gemini" : "openai";
      const usedModel = model || (usedProvider === "gemini" ? "gemini-2.5-flash" : "gpt-5-mini");
      const { key } = await openSummaryTabInitial({
        title: page.title,
        url: page.url,
        provider: usedProvider,
        model: usedModel
      });

      // ✅ popupへは即OK返す（待たせない）
      sendResponse({ ok: true });

      // ここからストリーミング（popupは閉じてOK）
      sendToSummary(key, { type: "SUMMARY_INIT" });

      const prompt = buildPrompt(page, length);

      let total = "";
      const onDelta = (d) => {
        total += d;
        sendToSummary(key, { type: "SUMMARY_DELTA", delta: d });
      };

      if (usedProvider === "gemini") {
        await streamGemini({ apiKey, model: usedModel, prompt, onDelta });
      } else {
        await streamOpenAI({ apiKey, model: usedModel, prompt, onDelta });
      }

      // 最終保存（リロードしても残る）
      await chrome.storage.session.set({
        [key]: {
          ok: true,
          provider: usedProvider,
          model: usedModel,
          title: page.title,
          url: page.url,
          summary: total,
          createdAt: new Date().toISOString()
        }
      });

      sendToSummary(key, { type: "SUMMARY_DONE" });
    } catch (e) {
      const message = safeString(e?.message || e);
      errlog("handler error:", e);
      // popupへエラー
      try { sendResponse({ ok: false, error: message }); } catch {}
    }
  })();

  return true; // async
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "summarize-now") return;

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });
    if (!tab?.id) return;

    const {
      provider = "openai",
      apiKey = "",
      model = "",
      length = "medium"
    } = await chrome.storage.sync.get([
      "provider",
      "apiKey",
      "model",
      "length"
    ]);

    if (!apiKey) {
      await chrome.tabs.create({
        url: chrome.runtime.getURL("popup.html")
      });
      return;
    }

    await handleSummarizeCore({
      tabId: tab.id,
      provider,
      apiKey,
      model,
      length
    });

  } catch (e) {
    console.error("Alt+G summarize error:", e);
  }
});


async function handleSummarizeCore({ tabId, provider, apiKey, model, length }) {
  if (!tabId) throw new Error("tabId is missing.");
  if (!apiKey) throw new Error("API Key is empty.");

  const page = await extractFromTab(tabId);

  if (!page.text || page.text.length < 80) {
    throw new Error("本文が十分に取得できませんでした。");
  }

  // 先に summary タブを開く（高速表示用）
  const usedProvider = provider === "gemini" ? "gemini" : "openai";
  const usedModel =
    model || (usedProvider === "gemini" ? "gemini-2.5-flash" : "gpt-4o-mini");

  const { key } = await openSummaryTabInitial({
    title: page.title,
    url: page.url,
    provider: usedProvider,
    model: usedModel
  });

  const prompt = buildPrompt(page, length);

  let total = "";

  const onDelta = (d) => {
    total += d;
    sendToSummary(key, { type: "SUMMARY_DELTA", delta: d });
  };

  if (usedProvider === "gemini") {
    await streamGemini({ apiKey, model: usedModel, prompt, onDelta });
  } else {
    await streamOpenAI({ apiKey, model: usedModel.trim(), prompt, onDelta });
  }

  await chrome.storage.session.set({
    [key]: {
      ok: true,
      provider: usedProvider,
      model: usedModel,
      title: page.title,
      url: page.url,
      summary: total,
      createdAt: new Date().toISOString()
    }
  });

  sendToSummary(key, { type: "SUMMARY_DONE" });
}



log("service worker loaded");
