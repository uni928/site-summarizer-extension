const key = location.hash.replace("#", "");

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

let accumulated = "";

async function loadInitial() {
  if (!key) {
    document.getElementById("summary").textContent = "データキーが見つかりません。";
    return null;
  }
  const data = (await chrome.storage.session.get(key))[key];
  return data || null;
}

function renderMeta(data) {
  document.title = `要約: ${data.title || ""}`;
  document.getElementById("title").textContent = data.title || "要約";

  const meta = document.getElementById("meta");
  meta.innerHTML = `
    <div>Provider: ${escapeHtml(data.provider)} / Model: ${escapeHtml(data.model)}</div>
    <div>Created: ${escapeHtml(new Date(data.createdAt).toLocaleString())}</div>
    <div>URL: <a href="${escapeHtml(data.url)}" target="_blank" rel="noreferrer">${escapeHtml(data.url)}</a></div>
  `;

  document.getElementById("openBtn").onclick = () => {
    window.open(data.url, "_blank", "noreferrer");
  };

  document.getElementById("copyBtn").onclick = async () => {
    await navigator.clipboard.writeText(accumulated);
  };
}

function appendDelta(delta) {
  if (!delta) return;
  accumulated += delta;
  // 追記：毎回全文を書き直すけど十分速い。重いなら requestAnimationFrame で間引けます。
  document.getElementById("summary").textContent = accumulated;
}

async function main() {
  const data = await loadInitial();
  if (!data) {
    document.getElementById("summary").textContent =
      "要約データが見つかりません（期限切れの可能性）。もう一度要約してください。";
    return;
  }

  renderMeta(data);

  accumulated = data.summary || "";
  document.getElementById("summary").textContent =
    accumulated || "生成中…（結果が届き次第ここに表示されます）";

  // ✅ background からストリームを受けて即反映
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.key !== key) return;

    if (msg.type === "SUMMARY_INIT") {
      if (!accumulated) document.getElementById("summary").textContent = "生成中…";
    } else if (msg.type === "SUMMARY_DELTA") {
      appendDelta(msg.delta);
    } else if (msg.type === "SUMMARY_DONE") {
      // 必要ならここで「完了」を表示してもOK
    }
  });
}

main().catch((e) => {
  document.getElementById("summary").textContent = String(e?.message || e);
});
