const $ = (id) => document.getElementById(id);

function setStatus(msg, kind = "ok") {
  const el = $("status");
  el.className = kind;
  el.textContent = msg;
}

async function loadSettings() {
  const { provider, apiKey, model, length } = await chrome.storage.sync.get({
    provider: "openai",
    apiKey: "",
    model: "",
    length: "medium",
  });
  $("provider").value = provider;
  $("apiKey").value = apiKey;
  $("model").value = model;
  $("length").value = length;
}

async function saveSettings() {
  const provider = $("provider").value;
  const apiKey = $("apiKey").value.trim();
  const model = $("model").value.trim();
  const length = $("length").value;

  if (!apiKey) {
    setStatus("API Key を入力してください。", "error");
    return;
  }

  await chrome.storage.sync.set({ provider, apiKey, model, length });
  setStatus("保存しました。");
}

async function summarize() {
  setStatus("要約中…");

  const provider = $("provider").value;
  const apiKey = $("apiKey").value.trim();
  const model = $("model").value.trim();
  const length = $("length").value;

  if (!apiKey) {
    setStatus("API Key を入力してください。", "error");
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus("アクティブなタブが見つかりません。", "error");
    return;
  }

  try {
    const res = await chrome.runtime.sendMessage({
      type: "SUMMARIZE_ACTIVE_TAB",
      tabId: tab.id,
      provider,
      apiKey,
      model,
      length,
    });

    if (!res?.ok) {
      setStatus(res?.error || "失敗しました。", "error");
      return;
    }

    setStatus("新しいタブに表示しました。");
    window.close();
  } catch (e) {
    setStatus(String(e?.message || e), "error");
  }
}

$("saveBtn").addEventListener("click", saveSettings);
$("summarizeBtn").addEventListener("click", summarize);
document.addEventListener("DOMContentLoaded", loadSettings);
