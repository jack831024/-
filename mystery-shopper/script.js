const PAGE_LOADED_AT = Date.now();

// 體驗評分維度與權重（滿意度區塊，合計 100）
const scoreItems = [
  { key: "entry", title: "門口與候位體驗", hint: "主動招呼、訂位確認、候位時間說明是否清楚。", weight: 10 },
  { key: "uniform", title: "儀容與制服", hint: "制服一致、名牌、鞋子、頭髮、整潔度。", weight: 10 },
  { key: "menu", title: "點餐與介紹", hint: "鍋底差異、加點建議、優惠或活動說明。", weight: 10 },
  { key: "service", title: "桌邊服務", hint: "加湯、收空盤、回應速度、服務態度。", weight: 20 },
  { key: "food", title: "出餐品質與速度", hint: "鍋底正確、食材完整、溫度、出餐速度、漏單、擺盤。", weight: 20 },
  { key: "safety", title: "顧客可見衛生與安全", hint: "桌面、餐具、醬料區、廁所、地板、爐具提醒。", weight: 15 },
  { key: "checkout", title: "結帳與會員", hint: "帳單正確、發票、會員介紹、優惠核銷清楚。", weight: 10 },
  { key: "brand", title: "品牌一致性", hint: "服務節奏、話術、門市氛圍是否符合品牌感。", weight: 5 },
];

// 文字量表（不給秘密客看到數字，背後對應 0-100 的分數）
const RATING_SCALE = [
  { label: "很不滿意", points: 10 },
  { label: "不滿意", points: 40 },
  { label: "普通", points: 65 },
  { label: "滿意", points: 85 },
  { label: "很滿意", points: 100 },
];

// 服務 SOP 細項（是／否），折入總分
const sopItems = [
  { key: "sop1", label: "介紹詞有提到加 Line 好友；女生有給髮圈" },
  { key: "sop2", label: "上湯時有說「太鹹或太淡都可以調整」" },
  { key: "sop3", label: "加湯時有詢問「會太鹹或太淡嗎」" },
  { key: "sop4", label: "老顧客／壽星優惠有說明：出示優惠券、證件、拍照打卡" },
  { key: "sop5", label: "上蛤蠣有給撈網＋說明「有沙或沒開可更換」" },
  { key: "sop6", label: "上白蝦有給濕紙巾＋說明「剝完蝦可擦手」" },
  { key: "sop7", label: "雪花魚卷有說明「需煮 5 分鐘以上才會熟」" },
  { key: "sop8", label: "看到客人手機放桌上，主動提供手機支架" },
  { key: "sop9", label: "結帳有詢問是否使用湯頭兌換券" },
  { key: "sop10", label: "結帳有詢問統編／載具" },
  { key: "sop11", label: "結帳有詢問集點卡" },
  { key: "sop12", label: "結帳有告知有芳香劑" },
];

// 滿意度與 SOP 在總分的占比（可調）
const WEIGHT_SAT = 0.6;
const WEIGHT_SOP = 0.4;

function pointsForLabel(label) {
  const found = RATING_SCALE.find((s) => s.label === label);
  return found ? found.points : null;
}

const scoreItemsEl = document.getElementById("scoreItems");
const sopItemsEl = document.getElementById("sopItems");
const submittedDialog = document.getElementById("submittedDialog");
const submittedText = document.getElementById("submittedText");
const appConfig = window.MYSTERY_SHOPPER_CONFIG || {};

// 從總部連結帶入：?code=秘密客代號&meal=套餐內容
const TASK = (function () {
  const p = new URLSearchParams(location.search);
  return { code: (p.get("code") || "").trim(), meal: (p.get("meal") || "").trim() };
})();

function showGate(icon, title, msg) {
  document.getElementById("gateIcon").textContent = icon;
  document.getElementById("gateTitle").textContent = title;
  document.getElementById("gateMsg").textContent = msg;
  document.getElementById("gate").style.display = "block";
  document.getElementById("scoreForm").style.display = "none";
}

async function initTask() {
  if (!TASK.code) {
    showGate("🔗", "請用總部提供的連結開啟", "這份評分表需要從總部指派的專屬連結進入才能填寫。");
    return;
  }
  document.getElementById("taskCode").textContent = TASK.code;
  document.getElementById("taskMeal").textContent = TASK.meal || "（未指定）";
  // 本機已送出過此連結 → 直接鎖（同瀏覽器重開即時生效，不用等後端）
  try {
    if (localStorage.getItem("ms_done_" + TASK.code)) {
      showGate("✅", "此連結已使用過", "這份任務已經評分送出，無法重複填寫。感謝你的協助！");
      return;
    }
  } catch (e) {}
  // 後端再查一次（跨裝置／清快取也擋得住）
  const url = (appConfig.APPS_SCRIPT_URL || "").trim();
  if (url) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "checkCode", code: TASK.code }),
      });
      const j = await r.json();
      if (j && j.used) {
        showGate("✅", "此連結已使用過", "這份任務已經評分送出，無法重複填寫。感謝你的協助！");
      }
    } catch (e) {}
  }
}

function setDefaultDate() {
  const dateInput = document.getElementById("visitDate");
  if (!dateInput.value) {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    dateInput.value = `${yyyy}-${mm}-${dd}`;
    dateInput.max = `${yyyy}-${mm}-${dd}`;
  }
}

function renderScoreItems() {
  scoreItemsEl.innerHTML = scoreItems
    .map((item) => {
      const options = RATING_SCALE.map(
        (s) => `
          <label class="rate-option">
            <input type="radio" name="score-${item.key}" value="${s.label}" />
            <span>${s.label}</span>
          </label>`
      ).join("");
      return `
        <div class="score-item">
          <div class="score-copy">
            <strong>${item.title}</strong>
            <span>${item.hint}</span>
          </div>
          <div class="score-options" role="radiogroup" aria-label="${item.title}">
            ${options}
          </div>
        </div>`;
    })
    .join("");
}

function renderSopItems() {
  sopItemsEl.innerHTML = sopItems
    .map((item, idx) => {
      return `
        <div class="score-item">
          <div class="score-copy">
            <strong>${idx + 1}. ${item.label}</strong>
          </div>
          <div class="score-options sop-options" role="radiogroup" aria-label="${item.label}">
            <label class="rate-option sop-yes">
              <input type="radio" name="sop-${item.key}" value="是" />
              <span>是</span>
            </label>
            <label class="rate-option sop-no">
              <input type="radio" name="sop-${item.key}" value="否" />
              <span>否</span>
            </label>
          </div>
        </div>`;
    })
    .join("");
}

function hasCriticalIssue() {
  return Array.from(document.querySelectorAll('input[name="critical"]')).some((input) => input.checked);
}

function getSelection(key) {
  const selected = document.querySelector(`input[name="score-${key}"]:checked`);
  return selected ? selected.value : null;
}

function getSopSelection(key) {
  const selected = document.querySelector(`input[name="sop-${key}"]:checked`);
  return selected ? selected.value : null;
}

function answeredCount() {
  return scoreItems.filter((item) => getSelection(item.key) !== null).length;
}

function sopAnsweredCount() {
  return sopItems.filter((item) => getSopSelection(item.key) !== null).length;
}

// 背後計分：滿意度（正規化 0-100）× 60% + SOP 合格率（是/12 ×100）× 40%
function computeScore() {
  let earned = 0;
  let applicableWeight = 0;
  scoreItems.forEach((item) => {
    const sel = getSelection(item.key);
    if (sel && sel !== "NA") {
      const pts = pointsForLabel(sel);
      if (pts !== null) {
        earned += (pts / 100) * item.weight;
        applicableWeight += item.weight;
      }
    }
  });
  const satScore = applicableWeight > 0 ? (earned / applicableWeight) * 100 : 0;

  const yesCount = sopItems.filter((item) => getSopSelection(item.key) === "是").length;
  const sopScore = (yesCount / sopItems.length) * 100;

  const total = satScore * WEIGHT_SAT + sopScore * WEIGHT_SOP;
  const critical = hasCriticalIssue();

  let level;
  if (critical) level = "一票否決";
  else if (total >= 90) level = "優秀";
  else if (total >= 85) level = "合格";
  else if (total >= 80) level = "警戒";
  else level = "需改善";

  return { satScore, sopScore, total, level, critical };
}

function bindPhotoPreview() {
  document.querySelectorAll("input[type='file'][data-preview]").forEach((input) => {
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      const output = document.getElementById(input.dataset.preview);
      output.innerHTML = "";
      if (!file) return;
      const image = document.createElement("img");
      image.alt = file.name;
      image.src = URL.createObjectURL(file);
      output.appendChild(image);
    });
  });
}

function getCheckedLabelText(name) {
  return Array.from(document.querySelectorAll(`input[name="${name}"]:checked`)).map((input) =>
    input.parentElement.textContent.trim()
  );
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function imageFileToUpload(file) {
  if (!file) return null;
  const originalDataUrl = await readFileAsDataUrl(file);
  if (!file.type.startsWith("image/")) {
    return { name: file.name, mimeType: file.type || "application/octet-stream", dataUrl: originalDataUrl, originalSize: file.size };
  }
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = originalDataUrl;
    });
    const maxSide = 1400;
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(image, 0, 0, width, height);
    return { name: file.name.replace(/\.[^.]+$/, ".jpg"), mimeType: "image/jpeg", dataUrl: canvas.toDataURL("image/jpeg", 0.76), originalSize: file.size };
  } catch (error) {
    return { name: file.name, mimeType: file.type || "image/jpeg", dataUrl: originalDataUrl, originalSize: file.size };
  }
}

async function buildPayload(scoreResult) {
  const fileInput = (previewId) => document.querySelector(`input[data-preview="${previewId}"]`);

  const scorePayload = {};
  scoreItems.forEach((item) => {
    const sel = getSelection(item.key);
    const pts = sel && sel !== "NA" ? pointsForLabel(sel) : "";
    scorePayload[item.key] = {
      title: item.title,
      rawScore: sel === null ? "" : sel,
      points: pts,
      weight: item.weight,
      weightedScore: typeof pts === "number" ? (pts / 100) * item.weight : "",
    };
  });

  const sopPayload = {};
  sopItems.forEach((item) => {
    sopPayload[item.key] = getSopSelection(item.key) || "";
  });

  return {
    token: appConfig.FORM_TOKEN || "",
    hp: document.getElementById("hpField").value,
    elapsedSeconds: Math.round((Date.now() - PAGE_LOADED_AT) / 1000),
    submittedAtClient: new Date().toISOString(),
    userAgent: navigator.userAgent,
    storeName: document.getElementById("storeName").value,
    visitDate: document.getElementById("visitDate").value,
    visitPeriod: document.getElementById("visitPeriod").value,
    guestCount: Number(document.getElementById("guestCount").value || 0),
    shopperCode: TASK.code,
    meal: TASK.meal,
    totalScore: Number(scoreResult.total.toFixed(1)),
    satScore: Number(scoreResult.satScore.toFixed(1)),
    sopScore: Number(scoreResult.sopScore.toFixed(1)),
    level: scoreResult.level,
    visibleSafety: getCheckedLabelText("visibleSafety"),
    criticalItems: getCheckedLabelText("critical"),
    scores: scorePayload,
    sop: sopPayload,
    goodNotes: document.getElementById("goodNotes").value.trim(),
    badNotes: document.getElementById("badNotes").value.trim(),
    files: {
      meal: await imageFileToUpload(fileInput("mealPreview").files[0]),
      area: await imageFileToUpload(fileInput("areaPreview").files[0]),
      issue: await imageFileToUpload(fileInput("issuePreview").files[0]),
    },
  };
}

async function submitToAppsScript(payload) {
  const endpoint = (appConfig.APPS_SCRIPT_URL || "").trim();
  if (!endpoint) return { mode: "demo" };
  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
    const result = await r.json();
    return { mode: "apps-script", result };
  } catch (e) {
    // 後備：CORS/網路問題 → no-cors 送出（讀不到結果但有送達）
    try {
      await fetch(endpoint, { method: "POST", mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(payload) });
    } catch (e2) {}
    return { mode: "apps-script", result: null };
  }
}

// 送出成功後把整張表單清空，回到全新的空白畫面（不保留剛剛填的內容）
function resetForm() {
  const form = document.getElementById("scoreForm");
  form.reset();
  renderScoreItems();
  renderSopItems();
  ["mealPreview", "areaPreview", "issuePreview"].forEach((id) => {
    const out = document.getElementById(id);
    if (out) out.innerHTML = "";
  });
  setDefaultDate();
  window.scrollTo(0, 0);
}

function bindEvents() {
  document.getElementById("scoreForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const missingScore = scoreItems.length - answeredCount();
    const missingSop = sopItems.length - sopAnsweredCount();
    if (missingScore > 0 || missingSop > 0) {
      alert(`還有未作答的項目：體驗評分 ${missingScore} 項、SOP 細項 ${missingSop} 項，請全部選擇後再送出。`);
      return;
    }

    const scoreResult = computeScore();
    const store = document.getElementById("storeName").value;
    const critical = scoreResult.critical;
    const submitButton = event.submitter;

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "送出中...";
    }

    try {
      const payload = await buildPayload(scoreResult);
      const result = await submitToAppsScript(payload);
      // 後端明確回報「已使用過」→ 顯示連結失效畫面
      if (result.result && result.result.ok === false) {
        const err = String(result.result.error || "");
        if (/used|duplicate|已使用/i.test(err)) {
          try { localStorage.setItem("ms_done_" + TASK.code, "1"); } catch (e) {}
          showGate("✅", "此連結已使用過", "這份任務已經評分送出，無法重複填寫。感謝你的協助！");
        } else {
          alert("送出失敗：" + err);
        }
        return;
      }
      // 一次性：送出後鎖定畫面＋本機標記，不再重填
      try { localStorage.setItem("ms_done_" + TASK.code, "1"); } catch (e) {}
      showGate(
        "🎉",
        `${store} 的評分已送出`,
        (critical ? "你勾選了需要立即注意的項目，總部會優先處理。" : "") + "感謝你的協助，此連結已失效。"
      );
    } catch (error) {
      alert(`送出失敗：${error.message || error}`);
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "送出評分";
      }
    }
  });

  document.getElementById("closeDialog").addEventListener("click", () => {
    submittedDialog.close();
    window.scrollTo(0, 0);
  });
}

renderScoreItems();
renderSopItems();
setDefaultDate();
bindPhotoPreview();
bindEvents();
initTask();
