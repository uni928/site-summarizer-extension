// summary.js (streaming display)

const key = location.hash.replace("#", "");

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

let accumulated = "";

async function loadInitial() {
  if (!key) return null;
  const data = (await chrome.storage.session.get(key))[key];
  return data || null;
}

function renderMeta(data) {
  document.title = `要約: ${data.title || ""}`;
  const titleEl = document.getElementById("title");
  if (titleEl) titleEl.textContent = data.title || "要約";

  const meta = document.getElementById("meta");
  if (meta) {
    meta.innerHTML = `
      <div>Provider: ${escapeHtml(data.provider)} / Model: ${escapeHtml(data.model)}</div>
      <div>Created: ${escapeHtml(new Date(data.createdAt).toLocaleString())}</div>
      <div>URL: <a href="${escapeHtml(data.url)}" target="_blank" rel="noreferrer">${escapeHtml(data.url)}</a></div>
    `;
  }

  const openBtn = document.getElementById("openBtn");
  if (openBtn) {
    openBtn.onclick = () => window.open(data.url, "_blank", "noreferrer");
  }

  const copyBtn = document.getElementById("copyBtn");
  if (copyBtn) {
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(accumulated);
    };
  }
}

function setText(text) {
  const el = document.getElementById("summary");
  if (el) el.textContent = text;
}

function appendDelta(delta) {
  if (!delta) return;
  accumulated += delta;
  setText(accumulated);
}

async function main() {
  const data = await loadInitial();
  if (!data) {
    setText("要約データが見つかりません（期限切れの可能性）。もう一度要約してください。");
    return;
  }

  renderMeta(data);

  accumulated = data.summary || "";
  setText(accumulated || "生成中…（結果が届き次第ここに表示されます）");

  // background からのストリーム受信
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.key !== key) return;

    if (msg.type === "SUMMARY_INIT") {
      if (!accumulated) setText("生成中…");
    } else if (msg.type === "SUMMARY_DELTA") {
      appendDelta(msg.delta);
    } else if (msg.type === "SUMMARY_DONE") {
      // 完了表示したければここで追記できます
      // setText(accumulated + "\n\n(完了)");
    }
  });
}

main().catch((e) => {
  setText(String(e?.message || e));
});
