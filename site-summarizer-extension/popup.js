// popup.js (complete)
// Requires: popup.html includes <script type="module" src="popup.js"></script>
// Requires: crypto.js in same folder exporting encryptString/decryptString

import { encryptString, decryptString } from "./crypto.js";

const $ = (id) => document.getElementById(id);

function setStatus(text, isError = false) {
  const el = $("status");
  if (!el) return;
  el.textContent = text || "";
  el.style.color = isError ? "#b00020" : "#0a7b34";
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id || null;
}

async function migratePlainKeyIfNeeded() {
  const { apiKeyEnc = "", apiKey = "" } = await chrome.storage.sync.get(["apiKeyEnc", "apiKey"]);
  if (!apiKeyEnc && apiKey) {
    try {
      const enc = await encryptString(apiKey);
      await chrome.storage.sync.set({ apiKeyEnc: enc });
      await chrome.storage.sync.remove(["apiKey"]);
    } catch {
      // ignore
    }
  }
}

async function saveEncryptedApiKey(apiKeyPlain) {
  const enc = await encryptString(apiKeyPlain);
  await chrome.storage.sync.set({ apiKeyEnc: enc });
}

async function loadDecryptedApiKey() {
  const { apiKeyEnc = "" } = await chrome.storage.sync.get(["apiKeyEnc"]);
  if (!apiKeyEnc) return "";
  try {
    return await decryptString(apiKeyEnc);
  } catch {
    return "";
  }
}

async function saveSettings() {
  const provider = ($("provider")?.value || "openai").trim();
  const model = ($("model")?.value || "").trim();
  const length = ($("length")?.value || "medium").trim();
  const apiKey = ($("apiKey")?.value || "").trim();

  // Save non-secret settings always
  await chrome.storage.sync.set({ provider, model, length });

  // Save secret only if provided (so user can keep existing)
  if (apiKey) {
    await saveEncryptedApiKey(apiKey);
  }

  setStatus("保存しました。");
}

async function summarizeNow() {
  setStatus("");

  const tabId = await getActiveTabId();
  if (!tabId) {
    setStatus("アクティブタブを取得できません。", true);
    return;
  }

  const provider = ($("provider")?.value || "openai").trim();
  const model = ($("model")?.value || "").trim();
  const length = ($("length")?.value || "medium").trim();

  // Prefer user input, otherwise decrypt stored key
  let apiKey = ($("apiKey")?.value || "").trim();
  if (!apiKey) {
    apiKey = await loadDecryptedApiKey();
  }

  if (!apiKey) {
    setStatus("API Key を入力して保存してください。", true);
    return;
  }

  // Optional: disable buttons during request
  const btnSum = $("summarizeBtn");
  const btnSave = $("saveBtn");
  if (btnSum) btnSum.disabled = true;
  if (btnSave) btnSave.disabled = true;

  try {
    // Send plaintext key only to background (extension internal).
    // If you prefer not to send plaintext, change background to decrypt itself.
    const res = await chrome.runtime.sendMessage({
      type: "SUMMARIZE_ACTIVE_TAB",
      tabId,
      provider,
      apiKey,
      model,
      length
    });

    if (!res || res.ok !== true) {
      throw new Error(res?.error || "要約に失敗しました。");
    }

    setStatus("要約を開始しました（新しいタブを確認してください）。");
  } catch (e) {
    setStatus(String(e?.message || e), true);
  } finally {
    if (btnSum) btnSum.disabled = false;
    if (btnSave) btnSave.disabled = false;
  }
}

async function clearSavedKey() {
  await chrome.storage.sync.remove(["apiKeyEnc", "apiKey"]);
  if ($("apiKey")) $("apiKey").value = "";
  setStatus("保存済みAPI Keyを削除しました。");
}

async function init() {
  setStatus("");

  // Migrate old plain key -> encrypted if present
  await migratePlainKeyIfNeeded();

  const { provider = "openai", model = "", length = "medium" } =
    await chrome.storage.sync.get(["provider", "model", "length"]);

  if ($("provider")) $("provider").value = provider;
  if ($("model")) $("model").value = model;
  if ($("length")) $("length").value = length;

  // Optionally prefill apiKey field (you may prefer NOT to show it)
  const apiKey = await loadDecryptedApiKey();
  if ($("apiKey")) $("apiKey").value = apiKey;

  // Wire events
  $("saveBtn")?.addEventListener("click", async () => {
    try {
      await saveSettings();
    } catch (e) {
      setStatus(String(e?.message || e), true);
    }
  });

  $("summarizeBtn")?.addEventListener("click", async () => {
    await summarizeNow();
  });

  $("clearKeyBtn")?.addEventListener("click", async () => {
    await clearSavedKey();
  });

  // Ctrl+Enter to summarize (optional)
  document.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
      summarizeNow();
    }
  });
}

init().catch((e) => setStatus(String(e?.message || e), true));
