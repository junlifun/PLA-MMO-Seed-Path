const $ = (id) => document.getElementById(id);
let speciesData = [];
let speciesMappingComplete = true;
let speciesNameMap = {};
let researchCatalog = [];
let researchCatalogNameMap = {};
let pokemonResearchLevels = {};
let defaultResearchLevel = "level10";
let settingsLoaded = false;
let pokemonSettingsSaveQueue = Promise.resolve();
let lastCalculation = null;
let toastTimer = null;
let engineVerified = false;
let engineProblemMessage = "";
let lastCalculationFailed = false;
let lastCalculationErrorMessage = "";
let lastAssetAvailableCount = -1;
// 结果按计算模式分组保存，避免切换到定点头目后仍显示其它模式的结果。
let activeResultGroup = null;
const resultGroupCache = new Map();
let appearanceSaveQueue = Promise.resolve();

const RESEARCH_LABELS = {
  base: "基础研究",
  level10: "研究等级 10",
  perfect: "完美研究"
};

async function api(url, options = {}) {
  const { timeoutMs = 45000, ...requestOptions } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...requestOptions,
      headers: { "Content-Type": "application/json", ...(requestOptions.headers || {}) },
      signal: controller.signal
    });
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`服务器响应不是 JSON（HTTP ${response.status}）`); }
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
    }
    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`请求超时（${Math.ceil(timeoutMs / 1000)} 秒）：${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function replayUiEntrance(node, className = "ui-soft-enter") {
  if (!node) return;
  if (node._uiEntranceCleanup) {
    node.removeEventListener("animationend", node._uiEntranceCleanup);
    node._uiEntranceCleanup = null;
  }
  node.classList.remove(className);
  // Force a style flush so repeated updates can replay the same small entrance.
  void node.offsetWidth;
  node.classList.add(className);
  const cleanup = event => {
    if (event.target !== node || event.animationName !== "plaUiSoftEnter") return;
    node.classList.remove(className);
    node.removeEventListener("animationend", cleanup);
    node._uiEntranceCleanup = null;
  };
  node._uiEntranceCleanup = cleanup;
  node.addEventListener("animationend", cleanup);
}

/* 弹窗退场：先标记 is-exiting 播放动画，动画结束后执行真正的隐藏。
   与入场（CSS animation，display:none→显示时自动重播）配对使用；
   只动 opacity/transform，不影响地图与计算。快速重复调用幂等。 */
function closeModalWithExit(modal, finalize) {
  if (!modal || modal.classList.contains("hidden") || modal.classList.contains("is-exiting")) return;
  modal.classList.add("is-exiting");
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    modal.removeEventListener("animationend", onEnd);
    // 退场期间若被重新打开，放弃本次收尾，避免把新打开的弹窗又关掉。
    if (!modal.classList.contains("is-exiting")) return;
    modal.classList.remove("is-exiting");
    finalize();
  };
  const onEnd = event => {
    if (event.target === modal && event.animationName === "uxBackdropFadeOut") finish();
  };
  modal.addEventListener("animationend", onEnd);
  // 动画未触发（reduce-motion 或旧浏览器）时的兜底，避免弹窗永久停留在退场态。
  window.setTimeout(finish, 260);
}

function showToast(message, kind) {
  const toast = $("toast");
  if (!toast) return;
  // 未显式指定时按语义自动分级：确认类低调短暂，错误类醒目持久。
  let level = kind;
  if (!level) {
    const text = String(message || "");
    level = /(失败|错误|无法|没有|未收录|超时|异常)/.test(text) ? "error"
      : /(已复制|已保存|已选择|已填入|已应用|已校验|已跳过|已开始|已打开|已导入|已切换)/.test(text) ? "ok"
      : "info";
  }
  toast.textContent = message;
  toast.classList.remove("hidden", "toast--ok", "toast--error", "toast--info");
  toast.classList.add(`toast--${level}`);
  replayUiEntrance(toast);
  clearTimeout(toastTimer);
  // 确认类一闪而过、错误类留足阅读时间、其它保持原时长。
  const duration = level === "ok" ? 1600 : level === "error" ? 4200 : 2800;
  toastTimer = setTimeout(() => toast.classList.add("hidden"), duration);
}

function showMessage(message, kind = "success") {
  const node = $("calculation-message");
  node.textContent = message;
  node.className = `message ${kind}`;
  node.classList.remove("hidden");
  replayUiEntrance(node);
}

function hideMessage() {
  $("calculation-message").classList.add("hidden");
}

function formatTime(value) {
  if (!value) return "—";
  return String(value).replace("T", " ").replace(/\+.*$/, "");
}

function renderSeedState(data) {
  $("current-seed").textContent = data.current_seed || "尚未读取";
  const quickSeed = $("quick-seed");
  if (quickSeed && document.activeElement !== quickSeed) quickSeed.value = data.current_seed || "";
  const status = $("seed-status");
  status.textContent = data.error ? "应用失败" : data.current_seed ? "已应用" : "未输入";
  status.className = "status-pill";
  if (data.error) status.classList.add("status-error");
  else if ((data.status || "").includes("等待确认")) status.classList.add("status-pending");
  else if (data.current_seed) status.classList.add("status-success");
  else status.classList.add("status-muted");

  const source = $("manual-seed-source");
  if (source) {
    const auto = data.origin === "link";
    source.textContent = auto ? "联机自动获取" : "手动输入";
    source.classList.toggle("is-auto", auto);
  }

  const err = $("seed-error");
  if (data.error) {
    err.textContent = data.error;
    err.classList.remove("hidden");
  } else {
    err.classList.add("hidden");
    err.textContent = "";
  }
}

async function loadSeedState() {
  const data = await api("/api/seed", { timeoutMs: 12000 });
  renderSeedState(data);
  return data;
}

let seedConfirmResolver = null;
let seedConfirmPreviousFocus = null;

function closeSeedConfirmation(accepted = false) {
  const modal = $("seed-confirm-modal");
  if (!modal || modal.classList.contains("hidden")) return;
  modal.classList.add("hidden");
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("seed-confirm-open");
  const resolver = seedConfirmResolver;
  seedConfirmResolver = null;
  if (resolver) resolver(Boolean(accepted));
  if (seedConfirmPreviousFocus && typeof seedConfirmPreviousFocus.focus === "function") {
    seedConfirmPreviousFocus.focus();
  }
  seedConfirmPreviousFocus = null;
}

function showSeedConfirmation(result, title = "确认切换 Seed", description = "检测到新的 Seed，是否应用？") {
  const modal = $("seed-confirm-modal");
  if (!modal) return Promise.resolve(false);
  if (seedConfirmResolver) closeSeedConfirmation(false);

  $("seed-confirm-title").textContent = title;
  $("seed-confirm-description").textContent = description;
  $("seed-confirm-current").textContent = String(result.previous_seed ?? "尚未读取");
  $("seed-confirm-candidate").textContent = String(result.candidate_seed ?? "未知");
  seedConfirmPreviousFocus = document.activeElement;

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("seed-confirm-open");

  return new Promise(resolve => {
    seedConfirmResolver = resolve;
    $("seed-confirm-cancel").focus();
  });
}

$("seed-confirm-cancel").addEventListener("click", () => closeSeedConfirmation(false));
$("seed-confirm-accept").addEventListener("click", () => closeSeedConfirmation(true));
$("seed-confirm-modal").addEventListener("click", event => {
  if (event.target === $("seed-confirm-modal")) closeSeedConfirmation(false);
});

async function confirmIfNeeded(result, confirmEndpoint) {
  if (!result.needs_confirmation) {
    renderSeedState(result);
    return result;
  }
  const yes = await showSeedConfirmation(
    result,
    "检测到 Seed 变化",
    "新 Seed 与当前 Seed 不同。请确认是否切换；取消后会保留当前 Seed。"
  );
  if (!yes) {
    const cancelled = await api("/api/seed/cancel-pending", {
      method: "POST",
      body: JSON.stringify({})
    }).catch(() => null);
    if (cancelled) renderSeedState(cancelled);
    else await loadSeedState();
    showToast("已保留当前 Seed；新 Seed 未应用。");
    return result;
  }
  const confirmed = await api(confirmEndpoint, {
    method: "POST",
    body: JSON.stringify({ confirm: true, expected_seed: result.candidate_seed })
  });
  if (confirmed.needs_confirmation) {
    return confirmIfNeeded(confirmed, confirmEndpoint);
  }
  renderSeedState(confirmed);
  showToast("Seed 已切换。当前结果会保留，直到下一次计算。");
  return confirmed;
}

async function copyText(text) {
  if (!text) {
    showToast("没有可复制的内容。");
    return;
  }
  try {
    await navigator.clipboard.writeText(String(text));
  } catch {
    const area = document.createElement("textarea");
    area.value = String(text);
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  showToast("已复制。");
}

function updateDiagnosticsBanner() {
  const banner = $("diagnostics-banner");
  if (!banner) return;
  if (!engineVerified) {
    $("diagnostics-banner-title").textContent = "本地计算引擎尚未通过验证";
    $("diagnostics-banner-message").textContent =
      `${engineProblemMessage || "本地引擎未通过验证。"} 请点击「复制诊断报告」收集完整日志。`;
    banner.classList.remove("hidden");
  } else if (lastCalculationFailed) {
    $("diagnostics-banner-title").textContent = "最近一次计算失败";
    $("diagnostics-banner-message").textContent =
      `${lastCalculationErrorMessage || "错误详情已保存到本地日志。"} 请点击「复制诊断报告」后发给开发者。`;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

async function copyDiagnosticsReport() {
  try {
    const data = await api("/api/diagnostics");
    await copyText(data.report || "");
    showToast("诊断报告已复制。请直接粘贴到反馈消息中；报告包含最近错误和本地日志末尾。");
  } catch (error) {
    showToast(`读取诊断报告失败：${error.message}。请手动收集 runtime_errors.log 和 offline_engine_setup.log。`);
  }
}


let settingsModalTrigger = null;
let settingsModalCloseTimer = null;
let settingsModalOpenTimer = null;

let resourceSnapshot = null;
let resourcePollTimer = null;
let resourcePromptSuppressed = false;
let pokemonAssetSnapshot = null;
let engineSnapshot = null;
let boardFlashSnapshot = null;
let boardFlashTimer = null;

function resourceIsActive(data) {
  return (data?.resources || []).some(item => {
    const state = item.progress?.status;
    return ["starting", "downloading", "extracting"].includes(state);
  });
}

function renderResources(data) {
  resourceSnapshot = data;
  const cards = $("resource-cards");
  if (!cards) return;
  cards.textContent = "";
  const resources = Array.isArray(data?.resources) ? data.resources : [];
  const visible = resources.filter(item => ["runtime", "solver", "firmware", "keys"].includes(item.id));
  const missing = visible.filter(item => !item.installed).length;

  const summary = $("resource-summary");
  if (summary) {
    summary.textContent = missing ? `缺少 ${missing} 项` : "全部就绪";
    summary.className = `status-pill ${missing ? "status-pending" : "status-success"}`;
  }

  visible.forEach(item => {
    const card = document.createElement("article");
    card.className = `resource-card${item.installed ? " is-installed" : ""}`;
    card.dataset.resourceId = item.id;

    const head = document.createElement("div");
    head.className = "resource-card-head";
    const title = document.createElement("strong");
    title.textContent = item.name;
    const status = document.createElement("span");
    status.className = `status-pill ${item.installed ? "status-success" : "status-pending"}`;
    status.textContent = item.installed ? "已就绪" : "未安装";
    head.append(title, status);

    const summaryNode = document.createElement("p");
    summaryNode.textContent = item.summary || "";

    const path = document.createElement("p");
    path.className = "resource-path";
    path.textContent = item.target || "";

    card.append(head, summaryNode, path);

    if (!item.installed && item.kind === "user") {
      const hint = document.createElement("p");
      hint.textContent = "需要你自己提供，不能从 GitHub 下载。";
      card.appendChild(hint);
    }

    const progress = item.progress || {};
    if (["starting", "downloading", "extracting"].includes(progress.status)) {
      const wrap = document.createElement("div");
      wrap.className = "resource-card-progress";
      const phead = document.createElement("div");
      phead.className = "resource-card-progress-head";
      const label = document.createElement("span");
      label.textContent = progress.message || "下载中…";
      const percent = document.createElement("strong");
      percent.textContent = `${Math.max(0, Math.min(100, Number(progress.percent) || 0))}%`;
      phead.append(label, percent);
      const track = document.createElement("div");
      track.className = "resource-card-track";
      const bar = document.createElement("div");
      bar.className = "resource-card-bar";
      bar.style.width = `${Math.max(0, Math.min(100, Number(progress.percent) || 0))}%`;
      track.appendChild(bar);
      wrap.append(phead, track);
      card.appendChild(wrap);
    } else if (progress.status === "failed") {
      const error = document.createElement("p");
      error.textContent = `下载失败：${progress.error || "未知错误"}`;
      error.style.color = "var(--danger)";
      card.appendChild(error);
    }

    const actions = document.createElement("div");
    actions.className = "resource-card-actions";
    if (item.id === "keys" || !item.installed) {
      const install = document.createElement("button");
      install.type = "button";
      install.className = "btn btn-primary";
      install.textContent = item.kind === "user" ? "导入/更换密钥" : "下载";
      install.addEventListener("click", () => {
        if (item.kind === "user") chooseLinkSeedKeys();
        else startResourceInstall(item.id);
      });
      actions.appendChild(install);
    }
    if (item.project_url) {
      const project = document.createElement("button");
      project.type = "button";
      project.className = "btn btn-ghost";
      project.textContent = "项目地址";
      project.addEventListener("click", () => openResourceProject(item.id));
      actions.appendChild(project);
    }
    const folder = document.createElement("button");
    folder.type = "button";
    folder.className = "btn btn-ghost";
    folder.textContent = "打开目录";
    folder.addEventListener("click", () => openResourceFolder(item.id));
    actions.appendChild(folder);
    card.appendChild(actions);

    cards.appendChild(card);
  });

  if (resourceIsActive(data)) {
    if (resourcePollTimer) window.clearTimeout(resourcePollTimer);
    resourcePollTimer = window.setTimeout(() => loadResources(), 1000);
  }
  renderUnifiedResources();
}

function formatResourceSize(size) {
  const bytes = Number(size) || 0;
  if (!bytes) return "";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function unifiedResourceRow({ name, note, size, state, progress, actions }) {
  const row = document.createElement("div");
  row.className = `resource-unified-row ${state === "ready" ? "is-ready" : state === "manual" ? "is-manual" : state === "active" ? "is-active" : "is-missing"}`;

  const dot = document.createElement("span");
  dot.className = "resource-unified-dot";
  dot.setAttribute("aria-hidden", "true");

  const main = document.createElement("div");
  main.className = "resource-unified-main";
  const title = document.createElement("strong");
  title.textContent = name;
  const copy = document.createElement("p");
  copy.textContent = note || "";
  main.append(title, copy);

  const meta = document.createElement("div");
  meta.className = "resource-unified-meta";
  const statusText = { ready: "已就绪", manual: "待导入", active: "下载中", missing: "未安装" }[state] || "未安装";
  const status = document.createElement("span");
  status.className = "resource-unified-status";
  status.textContent = statusText;
  meta.appendChild(status);
  if (size) {
    const sizeNode = document.createElement("span");
    sizeNode.textContent = size;
    meta.appendChild(sizeNode);
  }
  main.appendChild(meta);

  if (progress) {
    const wrap = document.createElement("div");
    wrap.className = "resource-unified-progress";
    const label = document.createElement("div");
    label.className = "resource-unified-progress-head";
    const text = document.createElement("span");
    text.textContent = progress.message || "下载中…";
    const percent = document.createElement("strong");
    percent.textContent = `${Math.max(0, Math.min(100, Number(progress.percent) || 0))}%`;
    label.append(text, percent);
    const track = document.createElement("div");
    track.className = "resource-unified-track";
    const bar = document.createElement("div");
    bar.className = "resource-unified-bar";
    bar.style.width = `${Math.max(0, Math.min(100, Number(progress.percent) || 0))}%`;
    track.appendChild(bar);
    wrap.append(label, track);
    main.appendChild(wrap);
  }

  const actionBox = document.createElement("div");
  actionBox.className = "resource-unified-actions";
  actions.forEach(action => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn ${action.primary ? "btn-primary" : "btn-ghost"}`;
    button.textContent = action.label;
    button.disabled = Boolean(action.disabled);
    button.addEventListener("click", action.onClick);
    actionBox.appendChild(button);
  });

  row.append(dot, main, actionBox);
  return row;
}

function renderUnifiedResources() {
  const list = $("resource-unified-list");
  const summary = $("resource-overview-summary");
  const downloadAll = $("unified-download-all");
  if (!list) return;

  const resources = Array.isArray(resourceSnapshot?.resources) ? resourceSnapshot.resources : [];
  const visible = resources.filter(item => ["runtime", "solver", "firmware", "keys"].includes(item.id));
  const asset = pokemonAssetSnapshot;
  const engine = engineSnapshot;
  const rows = [];
  let ready = 0;
  let missingAuto = 0;
  let manual = 0;
  const openAdvanced = () => {
    const details = document.querySelector(".resource-legacy-details");
    if (!details) return;
    details.open = true;
    details.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  visible.forEach(item => {
    const progress = item.progress || {};
    const active = ["starting", "downloading", "extracting"].includes(progress.status);
    const keys = item.kind === "user" || item.id === "keys";
    const state = active ? "active" : item.installed ? "ready" : keys ? "manual" : "missing";
    if (state === "ready") ready += 1;
    if (state === "missing") missingAuto += 1;
    if (state === "manual") manual += 1;
    const actions = [];
    if (active) {
      actions.push({ label: "下载中…", disabled: true });
    } else if (item.installed) {
      actions.push({ label: "打开目录", onClick: () => openResourceFolder(item.id) });
    } else if (keys) {
      actions.push({ label: "导入/更换", primary: true, onClick: chooseLinkSeedKeys });
      actions.push({ label: "打开目录", onClick: () => openResourceFolder(item.id) });
    } else {
      actions.push({ label: "自动下载", primary: true, onClick: () => startResourceInstall(item.id) });
      actions.push({ label: "打开目录", onClick: () => openResourceFolder(item.id) });
    }
    rows.push(unifiedResourceRow({
      name: item.name,
      note: item.summary || "",
      size: formatResourceSize(item.size),
      state,
      progress: active ? progress : null,
      actions,
    }));
  });

  if (asset) {
    const progress = asset.progress || {};
    const active = progress.status === "downloading";
    const complete = Boolean(asset.complete);
    const state = active ? "active" : complete ? "ready" : "missing";
    if (state === "ready") ready += 1;
    if (state === "missing") missingAuto += 1;    const actions = [];
    if (active) {
      actions.push({ label: "下载中…", disabled: true });
    } else if (complete) {
      actions.push({ label: "打开图片文件夹", onClick: () => $("open-pokemon-assets")?.click() });
    } else {
      actions.push({ label: "下载/补全", primary: true, onClick: () => $("download-pokemon-assets")?.click() });
      actions.push({ label: "打开图片文件夹", onClick: () => $("open-pokemon-assets")?.click() });
    }
    rows.push(unifiedResourceRow({
      name: "宝可梦图片资源",
      note: `${Number(asset.available || 0)} / ${Number(asset.total || 0)} 个图片文件可用`,
      size: "",
      state,
      progress: active ? progress : null,
      actions,
    }));
  }

  if (engine) {
    const installed = Boolean(engine.verified || engine.installed);
    const state = engine.verified ? "ready" : installed ? "manual" : "missing";
    if (state === "ready") ready += 1;
    if (state === "missing") missingAuto += 1;
    if (state === "manual") manual += 1;
    const actions = [];
    if (engine.verified) {
      actions.push({ label: "打开目录", onClick: () => $("open-engine-folder")?.click() });
    } else {
      actions.push({
        label: "自动安装",
        primary: true,
        onClick: () => { openAdvanced(); $("engine-auto-install")?.click(); },
      });
      actions.push({
        label: "ZIP 安装",
        onClick: () => { openAdvanced(); $("engine-pick-zip")?.click(); },
      });
    }
    rows.push(unifiedResourceRow({
      name: "本地计算引擎",
      note: engine.message || (engine.verified ? "引擎已验证，可以进行本地路径计算。" : "尚未安装或尚未验证。"),
      size: "",
      state,
      progress: null,
      actions,
    }));
  }

  const total = rows.length;
  const pending = missingAuto + manual;
  if (summary) {
    summary.textContent = total
      ? (pending ? `待处理 ${pending} 项 · 已就绪 ${ready} 项` : `全部就绪 · ${ready} 项`)
      : "正在检查";
    summary.className = `status-pill ${pending ? "status-pending" : total ? "status-success" : "status-muted"}`;
  }
  if (downloadAll) downloadAll.disabled = missingAuto === 0;

  list.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "resource-unified-empty";
    empty.textContent = "正在检查资源状态…";
    list.appendChild(empty);
  } else {
    rows.forEach(row => list.appendChild(row));
  }
}

async function refreshBoardStatus(withProbe = true) {
  const status = $("board-flash-status");
  if (status && !boardFlashSnapshot) status.textContent = "检测中…";
  try {
    const data = await api(`/api/board/status${withProbe ? "?probe=1" : ""}`, { timeoutMs: 30000 });
    boardFlashSnapshot = data;
    renderBoardPanel();
    if (data.needs_flash) showToast("检测到未确认固件的 ESP32 串口，可在资源管理烧录。");
    return data;
  } catch (error) {
    if (status) status.textContent = "检测失败";
    const note = $("board-flash-note");
    if (note) note.textContent = `检测失败：${error.message}`;
    return null;
  }
}

function renderBoardPanel() {
  const data = boardFlashSnapshot;
  const select = $("board-port");
  const status = $("board-flash-status");
  const copy = $("board-flash-copy");
  const note = $("board-flash-note");
  const prompt = $("board-flash-prompt");
  const flashButton = $("board-flash");
  const log = $("board-flash-log");
  if (!select || !data) return;
  const previous = select.value;
  select.innerHTML = "";
  const ports = Array.isArray(data.ports) ? data.ports : [];
  if (!ports.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "未检测到串口";
    select.appendChild(option);
  } else {
    ports.forEach(port => {
      const option = document.createElement("option");
      option.value = port.port;
      option.textContent = `${port.port} · ${port.description}${port.flashed ? " · 已烧录" : port.suitable ? " · 候选板子" : ""}`;
      option.disabled = !port.suitable && !port.flashed;
      select.appendChild(option);
    });
    const preferred = data.flashed_port || previous || data.selected?.port;
    if (preferred && [...select.options].some(item => item.value === preferred)) {
      select.value = preferred;
    }
  }

  const flash = data.flash || {};
  const running = flash.status === "running";
  if (status) {
    status.className = `status-pill ${
      running ? "status-pending" : data.flashed_port ? "status-success" : data.needs_flash ? "status-pending" : "status-muted"
    }`;
    status.textContent = running
      ? `烧录中 ${Number(flash.percent) || 0}%`
      : data.flashed_port ? "已识别已烧录板子" : data.needs_flash ? "检测到未烧录板子" : "未检测";
  }
  if (copy) {
    copy.textContent = data.message || "检测到板子后，可在这里写入 Pokeldn 无线固件。";
  }
  if (prompt) prompt.classList.toggle("hidden", !data.needs_flash || running);
  if (note) {
    const missing = [];
    if (!data.pyserial) missing.push("pyserial");
    if (!data.esptool) missing.push("esptool");
    if (!data.firmware_ready) missing.push("ESP32-S3 固件");
    note.textContent = missing.length
      ? `烧录前还需要：${missing.join("、")}${!data.esptool ? "。安装：python -m pip install esptool pyserial" : ""}`
      : "烧录会覆盖板子上的现有固件，请确认端口和板子型号。";
  }
  if (flashButton) {
    const selectedPort = (data.ports || []).find(port => port.port === select.value);
    flashButton.disabled = running || !selectedPort?.suitable || !data.esptool || !data.firmware_ready;
    flashButton.textContent = running ? `烧录中 ${Number(flash.percent) || 0}%` : "烧录固件";
  }
  if (log) {
    const lines = Array.isArray(flash.log) ? flash.log : [];
    log.textContent = lines.join("\n");
    log.classList.toggle("hidden", !lines.length);
    if (running) log.scrollTop = log.scrollHeight;
  }
  const now = $("board-flash-now");
  if (now) now.disabled = running || !data.esptool || !data.firmware_ready || !data.selected?.port;
}

async function startBoardFlash() {
  const select = $("board-port");
  const port = select?.value || "";
  if (!port) {
    showToast("请先选择 ESP32 串口。");
    return;
  }
  const label = select.options[select.selectedIndex]?.textContent || port;
  if (!window.confirm(`确认烧录到 ${label}？\n这会覆盖板子上的现有固件。`)) return;
  try {
    await api("/api/board/flash", {
      method: "POST",
      body: JSON.stringify({ port }),
      timeoutMs: 30000,
    });
    await refreshBoardFlashStatus();
    showToast("已开始烧录，请保持板子连接。");
  } catch (error) {
    showToast(`烧录失败：${error.message}`);
  }
}

async function refreshBoardFlashStatus() {
  try {
    const data = await api("/api/board/flash/status", { timeoutMs: 15000 });
    const flash = data.flash || {};
    boardFlashSnapshot = { ...(boardFlashSnapshot || {}), flash };
    renderBoardPanel();
    if (flash.status === "running") {
      if (boardFlashTimer) clearTimeout(boardFlashTimer);
      boardFlashTimer = window.setTimeout(refreshBoardFlashStatus, 1000);
    } else {
      if (boardFlashTimer) clearTimeout(boardFlashTimer);
      boardFlashTimer = null;
      if (flash.status === "success") {
        showToast("ESP32-S3 烧录完成。");
        await refreshBoardStatus(false);
      } else if (flash.status === "failed") {
        showToast(`烧录失败：${flash.error || "请查看烧录日志"}`);
      }
    }
  } catch (error) {
    showToast(`读取烧录进度失败：${error.message}`);
  }
}

async function refreshUnifiedResources() {
  await Promise.allSettled([
    loadResources(),
    refreshPokemonAssetStatus(false),
    loadEngineStatus(),
  ]);
  renderUnifiedResources();
}

function downloadAllAutoResources() {
  const resources = Array.isArray(resourceSnapshot?.resources) ? resourceSnapshot.resources : [];
  const missing = resources.filter(item => ["runtime", "solver", "firmware"].includes(item.id) && !item.installed);
  missing.forEach(item => startResourceInstall(item.id));
  if (pokemonAssetSnapshot && !pokemonAssetSnapshot.complete && pokemonAssetSnapshot.progress?.status !== "downloading") {
    choosePokemonAssetAction("download");
  }
  if (engineSnapshot && !engineSnapshot.verified) {
    $("engine-auto-install")?.click();
  }
  showToast(missing.length ? "已开始下载缺失资源。" : "已开始处理图片或引擎资源。");
}

async function loadResources() {
  try {
    const data = await api("/api/resources", { timeoutMs: 20000 });
    renderResources(data);
    maybeShowResourcePrompt(data);
    return data;
  } catch (error) {
    showToast(`资源状态读取失败：${error.message}`);
    return null;
  }
}
async function startResourceInstall(id) {
  try {
    const data = await api("/api/resources/install", {
      method: "POST",
      body: JSON.stringify({ id }),
      timeoutMs: 30000
    });
    showToast(data.already_running ? "已经在下载了。" : "已开始下载，请稍候…");
    await loadResources();
  } catch (error) {
    showToast(`下载失败：${error.message}`);
  }
}

async function openResourceFolder(id) {
  try {
    await api("/api/resources/open-folder", {
      method: "POST",
      body: JSON.stringify({ id }),
      timeoutMs: 15000
    });
  } catch (error) {
    showToast(`无法打开目录：${error.message}`);
  }
}

async function openResourceProject(id) {
  try {
    await api("/api/resources/open-project", {
      method: "POST",
      body: JSON.stringify({ id }),
      timeoutMs: 15000
    });
  } catch (error) {
    showToast(`无法打开项目主页：${error.message}`);
  }
}

function closeResourcePrompt() {
  $("resource-prompt")?.classList.add("hidden");
  document.body.classList.remove("resource-prompt-open");
}

function maybeShowResourcePrompt(data) {
  if (resourcePromptSuppressed) return;
  const missing = (data?.missing_required || []).filter(item => item.id !== "keys");
  if (!missing.length) return;
  try {
    if (localStorage.getItem("pla-resource-prompt-dismissed-v1") === "1") return;
  } catch (_) {}
  const list = $("resource-prompt-list");
  if (!list) return;
  list.textContent = "";
  missing.forEach(item => {
    const li = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = item.name;
    const note = document.createElement("span");
    note.textContent = "未安装";
    li.append(name, note);
    list.appendChild(li);
  });
  $("resource-prompt").classList.remove("hidden");
  document.body.classList.add("resource-prompt-open");
}

function downloadMissingResources() {
  const missing = (resourceSnapshot?.missing_required || []).filter(item => item.id !== "keys");
  resourcePromptSuppressed = true;
  closeResourcePrompt();
  if (!missing.length) return;
  openSettingsModal();
  activateSettingsTab("resources");
  missing.forEach(item => startResourceInstall(item.id));
  showToast("已开始下载联机所需组件，可在「资源管理」查看进度。");
}

function dismissResourcePrompt() {
  resourcePromptSuppressed = true;
  try { localStorage.setItem("pla-resource-prompt-dismissed-v1", "1"); } catch (_) {}
  closeResourcePrompt();
}

function openLinkSeedResources() {
  closeLinkSeedModal();
  openSettingsModal();
  activateSettingsTab("resources");
  loadResources();
}

function activateSettingsTab(tabName, focus = false) {
  const allowed = new Set(["appearance", "pokemon", "resources", "updates", "help"]);
  const target = allowed.has(tabName) ? tabName : "appearance";
  document.querySelectorAll("[data-settings-tab]").forEach(button => {
    const active = button.dataset.settingsTab === target;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && focus) button.focus();
  });
  document.querySelectorAll("[data-settings-panel]").forEach(panel => {
    const active = panel.dataset.settingsPanel === target;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
  const tabContent = document.querySelector(".settings-tab-content");
  if (tabContent) tabContent.scrollTop = 0;
  if (target === "resources") {
    loadResources();
    window.setTimeout(() => refreshBoardStatus(true), 250);
  }
  if (target === "updates") {
    loadUpdatePanel();
  }
}

document.querySelectorAll("[data-settings-tab]").forEach(button => {
  button.addEventListener("click", () => activateSettingsTab(button.dataset.settingsTab));
});

function finishSettingsModalClose(modal) {
  // 退场期间若被重新打开，放弃收尾，避免把新弹窗关掉。
  if (!modal.classList.contains("is-closing")) return;
  if (settingsModalCloseTimer !== null) {
    window.clearTimeout(settingsModalCloseTimer);
    settingsModalCloseTimer = null;
  }
  if (modal._settingsCloseAnimationEnd) {
    modal.removeEventListener("animationend", modal._settingsCloseAnimationEnd);
    delete modal._settingsCloseAnimationEnd;
  }
  modal.classList.add("hidden");
  modal.classList.remove("is-opening", "is-closing");
  modal.style.removeProperty("display");
  modal.style.removeProperty("pointer-events");
  modal.setAttribute("aria-hidden", "true");
  modal.inert = true;
  document.body.classList.remove("settings-modal-open");
  if (settingsModalTrigger && typeof settingsModalTrigger.focus === "function") {
    settingsModalTrigger.focus();
  }
  settingsModalTrigger = null;
}

function openSettingsModal(trigger = null) {
  const modal = $("settings-modal");
  if (!modal) return;
  if (settingsModalCloseTimer !== null) {
    window.clearTimeout(settingsModalCloseTimer);
    settingsModalCloseTimer = null;
  }
  if (settingsModalOpenTimer !== null) {
    window.clearTimeout(settingsModalOpenTimer);
    settingsModalOpenTimer = null;
  }
  if (modal._settingsCloseAnimationEnd) {
    modal.removeEventListener("animationend", modal._settingsCloseAnimationEnd);
    delete modal._settingsCloseAnimationEnd;
  }
  settingsModalTrigger = trigger || document.activeElement;
  activateSettingsTab(trigger?.dataset?.settingsTarget || "appearance");
  modal.classList.remove("hidden", "is-closing", "is-opening");
  modal.style.display = "grid";
  modal.style.removeProperty("pointer-events");
  modal.inert = false;
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("settings-modal-open");
  $("close-settings")?.focus();
}

function closeSettingsModal() {
  const modal = $("settings-modal");
  if (!modal || modal.classList.contains("hidden")) return;
  // 先播退场动画，结束后再真正隐藏；重复点击由 is-closing 幂等拦截。
  if (modal.classList.contains("is-closing")) return;
  modal.classList.remove("is-opening");
  modal.classList.add("is-closing");
  modal.style.pointerEvents = "none";
  if (settingsModalCloseTimer !== null) {
    window.clearTimeout(settingsModalCloseTimer);
    settingsModalCloseTimer = null;
  }
  // Wait for the backdrop fade to actually finish before hiding it. Hiding on a
  // bare 180 ms timer raced the 180 ms CSS animation and produced a one-frame
  // white flash on slower WebView2 windows.
  const onAnimationEnd = (event) => {
    if (event.target !== modal) return;
    modal.removeEventListener("animationend", onAnimationEnd);
    delete modal._settingsCloseAnimationEnd;
    if (settingsModalCloseTimer !== null) {
      window.clearTimeout(settingsModalCloseTimer);
      settingsModalCloseTimer = null;
    }
    finishSettingsModalClose(modal);
  };
  modal._settingsCloseAnimationEnd = onAnimationEnd;
  modal.addEventListener("animationend", onAnimationEnd);
  settingsModalCloseTimer = window.setTimeout(() => {
    settingsModalCloseTimer = null;
    onAnimationEnd({ target: modal });
  }, 260);
}

function setResultDetailsOpen(panel, button, label, shouldOpen) {
  const arrow = button.querySelector(".route-detail-arrow");
  if (panel._detailAnimationTimer) window.clearTimeout(panel._detailAnimationTimer);
  panel._detailAnimationTimer = null;
  button.classList.toggle("is-open", shouldOpen);
  button.setAttribute("aria-expanded", String(shouldOpen));
  button.setAttribute("aria-label", shouldOpen ? "收起详细操作步骤" : "展开详细操作步骤");
  label.textContent = shouldOpen ? "收起详细" : "查看详细";
  if (arrow) arrow.textContent = "⌄";
  panel.setAttribute("aria-hidden", String(!shouldOpen));
  panel.inert = !shouldOpen;

  const clearMotionStyles = () => {
    panel.style.removeProperty("max-height");
    panel.style.removeProperty("overflow");
    panel.style.removeProperty("opacity");
    panel.style.removeProperty("transform");
    panel.style.removeProperty("transition");
    panel._detailAnimationTimer = null;
  };
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    panel.classList.toggle("hidden", !shouldOpen);
    clearMotionStyles();
    return;
  }

  panel.style.transition = "none";
  if (shouldOpen) {
    panel.classList.remove("hidden");
    panel.style.overflow = "hidden";
    panel.style.maxHeight = "0px";
    panel.style.opacity = "0";
    panel.style.transform = "translateY(-4px)";
    void panel.offsetHeight;
    panel.style.transition = "max-height 220ms cubic-bezier(.2,.7,.2,1), opacity 180ms ease, transform 220ms cubic-bezier(.2,.7,.2,1)";
    panel.style.maxHeight = `${panel.scrollHeight}px`;
    panel.style.opacity = "1";
    panel.style.transform = "translateY(0)";
    panel._detailAnimationTimer = window.setTimeout(() => {
      if (button.getAttribute("aria-expanded") === "true") clearMotionStyles();
    }, 250);
  } else {
    if (panel.classList.contains("hidden")) {
      clearMotionStyles();
      return;
    }
    panel.style.overflow = "hidden";
    panel.style.maxHeight = `${panel.getBoundingClientRect().height}px`;
    panel.style.opacity = "1";
    panel.style.transform = "translateY(0)";
    void panel.offsetHeight;
    panel.style.transition = "max-height 220ms cubic-bezier(.2,.7,.2,1), opacity 180ms ease, transform 220ms cubic-bezier(.2,.7,.2,1)";
    panel.style.maxHeight = "0px";
    panel.style.opacity = "0";
    panel.style.transform = "translateY(-4px)";
    panel._detailAnimationTimer = window.setTimeout(() => {
      if (button.getAttribute("aria-expanded") === "false") {
        panel.classList.add("hidden");
        clearMotionStyles();
      }
    }, 250);
  }
}
$("settings-modal").addEventListener("click", event => {
  if (event.target === $("settings-modal")) closeSettingsModal();
});
$("close-settings").addEventListener("click", closeSettingsModal);
// Bind each settings entry directly. The script is loaded after the page markup,
// so the gear and all shortcuts are present at binding time.
document.querySelectorAll("[data-open-settings]").forEach(trigger => {
  trigger.addEventListener("click", event => {
    event.preventDefault();
    openSettingsModal(trigger);
  });
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && $("seed-confirm-modal") && !$("seed-confirm-modal").classList.contains("hidden")) {
    closeSeedConfirmation(false);
    event.stopPropagation();
    return;
  }
  if (event.key === "Escape" && !$("settings-modal").classList.contains("hidden")) {
    closeSettingsModal();
    return;
  }
  if (!$("settings-modal").classList.contains("hidden") &&
      ["ArrowLeft", "ArrowRight"].includes(event.key) &&
      event.target?.matches?.("[data-settings-tab]")) {
    const tabs = [...document.querySelectorAll("[data-settings-tab]")];
    const index = tabs.indexOf(event.target);
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    activateSettingsTab(next.dataset.settingsTab, true);
    event.preventDefault();
  }
});

function getNormalSpecies() {
  const normal = $("isnormal").checked;
  const expectedParent = normal ? "-1" : "0";
  const filtered = speciesData.filter(item => String(item.parent_id) === expectedParent);
  return filtered.length ? filtered : (speciesMappingComplete ? [] : speciesData);
}

function fillSelect(select, options, placeholder, preserveValue = true) {
  const oldValue = preserveValue ? select.value : "";
  select.innerHTML = "";
  const first = document.createElement("option");
  first.value = "";
  first.textContent = placeholder;
  select.appendChild(first);
  options.forEach(item => {
    const option = document.createElement("option");
    option.value = item.hash;
    option.textContent = item.label || item.species_zh || item.species;
    option.dataset.species = item.species;
    option.dataset.speciesZh = item.species_zh || localizePokemonName(item.species);
    option.dataset.sprite = item.sprite || "";
    option.dataset.search = `${item.species || ""} ${item.label_en || ""} ${item.species_zh || ""} ${item.label || ""}`.toLocaleLowerCase();
    select.appendChild(option);
  });
  if (oldValue && [...select.options].some(option => option.value === oldValue)) select.value = oldValue;
  refreshSearchableSelect(select);
}

function setupSearchableSelect(select) {
  if (select.dataset.searchableReady === "true") return;
  select.dataset.searchableReady = "true";
  const wrapper = document.createElement("div");
  wrapper.className = "search-select";
  const control = document.createElement("div");
  control.className = "search-select-control";
  const selectedArtWrap = document.createElement("span");
  selectedArtWrap.className = "search-select-selected-art-wrap";
  const selectedArt = document.createElement("img");
  selectedArt.className = "search-select-selected-art hidden";
  selectedArt.alt = "";
  selectedArt.setAttribute("aria-hidden", "true");
  const selectedArtFallback = document.createElement("span");
  selectedArtFallback.className = "search-select-selected-art-fallback hidden";
  selectedArtFallback.textContent = "✦";
  selectedArtFallback.setAttribute("aria-hidden", "true");
  selectedArtWrap.append(selectedArt, selectedArtFallback);
  const input = document.createElement("input");
  input.type = "text";
  input.id = `${select.id}-search-input`;
  input.className = "search-select-input";
  input.placeholder = "输入中文或英文搜索宝可梦…";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-label", select.id === "frpokemon" ? "搜索并选择第一轮宝可梦" : "搜索并选择第二轮宝可梦");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "search-select-toggle";
  toggle.textContent = "▾";
  toggle.setAttribute("aria-label", "显示宝可梦候选列表");
  const list = document.createElement("div");
  list.className = "search-select-list hidden";
  list.setAttribute("role", "listbox");
  list.id = `${select.id}-search-results`;
  input.setAttribute("aria-controls", list.id);
  control.append(selectedArtWrap, input, toggle);
  const parent = select.parentNode;
  parent.insertBefore(wrapper, select);
  wrapper.append(control, list, select);
  select.classList.add("search-select-native");
  select.tabIndex = -1;

  const close = () => closeSearchableList(input);
  const open = (query = "") => {
    if (list._closeTimer) window.clearTimeout(list._closeTimer);
    list._closeTimer = null;
    renderSearchableOptions(select, input, list, query);
    list.classList.remove("hidden", "is-closing", "is-opening");
    void list.offsetWidth;
    list.classList.add("is-opening");
    input.setAttribute("aria-expanded", "true");
  };
  list.addEventListener("animationend", event => {
    if (event.target !== list) return;
    if (list.classList.contains("is-opening")) list.classList.remove("is-opening");
    if (list.classList.contains("is-closing")) {
      list.classList.add("hidden");
      list.classList.remove("is-closing");
    }
  });
  input.addEventListener("focus", () => {
    const query = input.value === selectedLabel(select) ? "" : input.value;
    input.select();
    open(query);
  });
  input.addEventListener("click", () => {
    if (list.classList.contains("hidden")) open(input.value === selectedLabel(select) ? "" : input.value);
  });
  input.addEventListener("input", () => open(input.value));
  input.addEventListener("keydown", event => {
    if (event.key === "Escape") close();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (list.classList.contains("hidden")) open(input.value === selectedLabel(select) ? "" : input.value);
      list.querySelector(".search-select-option")?.focus();
    }
    if (event.key === "Enter") {
      const first = list.querySelector(".search-select-option");
      if (first && !list.classList.contains("hidden")) {
        event.preventDefault();
        first.click();
      }
    }
  });
  toggle.addEventListener("click", () => {
    if (list.classList.contains("hidden")) {
      input.focus();
      open("");
    } else close();
  });
  select.addEventListener("change", () => {
    input.value = selectedLabel(select);
    input.title = input.value;
    input.disabled = select.disabled;
    toggle.disabled = select.disabled;
    updateSelectedSpeciesArt(select, selectedArt);
  });
  document.addEventListener("click", event => {
    if (!wrapper.contains(event.target)) close();
  });
  refreshSearchableSelect(select);
}

function selectedLabel(select) {
  return select.selectedOptions?.[0]?.value ? select.selectedOptions[0].textContent : "";
}

function setSpriteImage(img, filename, onMissing = null, onLoad = null) {
  const candidates = spriteCandidates(filename);
  if (!img || !candidates.length) {
    if (img) {
      img.classList.add("hidden");
      delete img.dataset.spriteFilename;
      delete img._retrySprite;
    }
    if (onMissing) onMissing();
    return;
  }
  let index = 0;
  img.dataset.spriteFilename = filename;
  img._retrySprite = () => {
    index = 0;
    img.classList.remove("hidden");
    img.src = candidates[0];
  };
  img.classList.remove("hidden");
  img.onerror = () => {
    index += 1;
    if (index < candidates.length) img.src = candidates[index];
    else {
      img.classList.add("hidden");
      if (onMissing) onMissing();
    }
  };
  img.onload = () => {
    img.classList.remove("hidden");
    if (onLoad) onLoad();
  };
  img.src = candidates[0];
}

function updateSelectedSpeciesArt(select, image) {
  const option = select?.selectedOptions?.[0];
  const fallback = image?.parentElement?.querySelector(".search-select-selected-art-fallback");
  if (!image || !option?.value) {
    image?.classList.add("hidden");
    if (image) {
      image.removeAttribute("src");
      delete image.dataset.spriteFilename;
      delete image._retrySprite;
    }
    fallback?.classList.add("hidden");
    return;
  }
  if (!option.dataset.sprite) {
    image.classList.add("hidden");
    image.removeAttribute("src");
    delete image.dataset.spriteFilename;
    delete image._retrySprite;
    fallback?.classList.remove("hidden");
    return;
  }
  setSpriteImage(
    image,
    option.dataset.sprite,
    () => fallback?.classList.remove("hidden"),
    () => fallback?.classList.add("hidden")
  );
}

function retryMissingSpriteImages() {
  document.querySelectorAll("img[data-sprite-filename]").forEach(image => {
    if (image.classList.contains("hidden") || image.naturalWidth === 0) {
      if (typeof image._retrySprite === "function") image._retrySprite();
    }
  });
}

function appendCatalogOnlyMatches(select, list, normalized) {
  const empty = document.createElement("div");
  empty.className = "search-select-empty";
  const allMatches = normalized ? speciesData.filter(item => {
    if (/^Alpha\s/i.test(String(item.species || ""))) return false;
    const search = `${item.species || ""} ${item.label_en || ""} ${item.species_zh || ""} ${item.label || ""}`.toLocaleLowerCase();
    return search.includes(normalized);
  }) : [];
  const eligibleHashes = new Set([...select.options].map(option => String(option.value)));
  const uniqueMatches = new Map();
  allMatches.forEach(item => {
    if (!eligibleHashes.has(String(item.hash)) && !uniqueMatches.has(String(item.species || item.hash))) {
      uniqueMatches.set(String(item.species || item.hash), item);
    }
  });
  const otherStageMatches = [...uniqueMatches.values()].slice(0, 6);
  if (!otherStageMatches.length) {
    empty.textContent = "没有匹配的宝可梦";
    list.appendChild(empty);
    return;
  }
  empty.textContent = select.id === "frpokemon"
    ? "在本地候选数据中找到了相关宝可梦，但它不属于当前模式的第一轮可选列表。它可能只出现在特定奖励轮或形态组合中。"
    : "找到了相关宝可梦，但它不属于当前第一轮对应的奖励轮候选。请确认第一轮宝可梦与遭遇类型。";
  list.appendChild(empty);
  otherStageMatches.forEach(item => {
    const row = document.createElement("div");
    row.className = "search-select-ineligible";
    row.setAttribute("aria-disabled", "true");
    const artWrap = document.createElement("span");
    artWrap.className = "search-select-option-art-wrap";
    const art = document.createElement("img");
    art.className = "search-select-option-art hidden";
    art.alt = "";
    art.setAttribute("aria-hidden", "true");
    const fallback = document.createElement("span");
    fallback.className = "search-select-option-art-fallback";
    fallback.textContent = "✦";
    fallback.setAttribute("aria-hidden", "true");
    artWrap.append(art, fallback);
    const copy = document.createElement("span");
    copy.className = "search-select-ineligible-copy";
    const title = document.createElement("strong");
    title.textContent = item.label || item.species_zh || item.species;
    const note = document.createElement("small");
    note.textContent = `${item.label_en || item.species} · 当前轮次不可选`;
    copy.append(title, note);
    row.append(artWrap, copy);
    if (item.sprite) setSpriteImage(art, item.sprite, () => fallback.classList.remove("hidden"), () => fallback.classList.add("hidden"));
    else fallback.classList.remove("hidden");
    list.appendChild(row);
  });
}

function renderSearchableOptions(select, input, list, query) {
  list.innerHTML = "";
  const normalized = String(query || "").trim().toLocaleLowerCase();
  const options = [...select.options].slice(1).filter(option => {
    if (!normalized) return true;
    const search = option.dataset.search || `${option.textContent} ${option.dataset.species || ""}`.toLocaleLowerCase();
    return search.includes(normalized);
  }).slice(0, 80);
  if (!options.length) {
    appendCatalogOnlyMatches(select, list, normalized);
    return;
  }
  options.forEach(option => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-select-option";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(option.value === select.value));
    const artWrap = document.createElement("span");
    artWrap.className = "search-select-option-art-wrap";
    const image = document.createElement("img");
    image.className = "search-select-option-art hidden";
    image.alt = "";
    image.setAttribute("aria-hidden", "true");
    const artFallback = document.createElement("span");
    artFallback.className = "search-select-option-art-fallback";
    artFallback.textContent = "✦";
    artFallback.setAttribute("aria-hidden", "true");
    artWrap.append(image, artFallback);
    const copy = document.createElement("span");
    copy.className = "search-select-option-copy";
    const main = document.createElement("span");
    main.className = "search-select-option-name";
    main.textContent = option.textContent;
    const english = document.createElement("small");
    english.className = "search-select-option-en";
    english.textContent = option.dataset.species || "";
    copy.append(main, english);
    button.append(artWrap, copy);
    if (option.dataset.sprite) {
      setSpriteImage(image, option.dataset.sprite, () => artFallback.classList.remove("hidden"), () => artFallback.classList.add("hidden"));
    } else {
      artFallback.classList.remove("hidden");
    }
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", () => {
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      input.value = option.textContent;
      input.title = option.textContent;
      closeSearchableList(input);
    });
    list.appendChild(button);
  });
}

function closeSearchableList(input) {
  const wrapper = input.closest(".search-select");
  const list = wrapper?.querySelector(".search-select-list");
  input.setAttribute("aria-expanded", "false");
  if (!list || list.classList.contains("hidden") || list.classList.contains("is-closing")) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    list.classList.add("hidden");
    list.classList.remove("is-opening", "is-closing");
    return;
  }
  list.classList.remove("is-opening");
  list.classList.add("is-closing");
  if (list._closeTimer) window.clearTimeout(list._closeTimer);
  list._closeTimer = window.setTimeout(() => {
    if (list.classList.contains("is-closing")) {
      list.classList.add("hidden");
      list.classList.remove("is-closing");
    }
    list._closeTimer = null;
  }, 150);
}

function refreshSearchableSelect(select) {
  if (!select || select.dataset.searchableReady !== "true") return;
  const wrapper = select.parentElement;
  const input = wrapper.querySelector(".search-select-input");
  const toggle = wrapper.querySelector(".search-select-toggle");
  input.value = selectedLabel(select);
  input.title = input.value;
  input.disabled = select.disabled;
  updateSelectedSpeciesArt(select, wrapper.querySelector(".search-select-selected-art"));
  toggle.disabled = select.disabled;
  const list = wrapper.querySelector(".search-select-list");
  if (!list.classList.contains("hidden")) {
    renderSearchableOptions(select, input, list, input.value === selectedLabel(select) ? "" : input.value);
  }
}

function updateFirstSpecies() {
  fillSelect($("frpokemon"), getNormalSpecies(), speciesData.length ? "选择第一轮宝可梦" : "候选数据未加载");
  updateBonusSpecies();
}

function updateBonusSpecies() {
  const firstHash = $("frpokemon").value;
  let candidates = speciesData.filter(item => String(item.parent_id) === String(firstHash));
  if (!candidates.length && !speciesMappingComplete && firstHash) {
    const seen = new Set();
    candidates = speciesData.filter(item => {
      if (seen.has(String(item.hash))) return false;
      seen.add(String(item.hash));
      return true;
    });
  }
  fillSelect($("brpokemon"), candidates, firstHash ? (candidates.length ? "选择奖励轮宝可梦" : "该群体没有奖励轮候选") : "请先选择第一轮宝可梦");
  if (!$("isbonus").checked) $("brpokemon").disabled = true;
  else $("brpokemon").disabled = false;
  refreshSearchableSelect($("brpokemon"));
}

function syncAppearanceMode(refreshOptions = true) {
  const mode = $("appearance").value || "mmo_bonus";
  $("isnormal").checked = mode === "normal";
  $("isbonus").checked = mode === "mmo_bonus";

  const hint = $("mode-hint");
  if (mode === "normal") {
    hint.textContent = "普通大量出现：仅使用第一轮参数，第一轮数量选项为 10–15 只。";
  } else if (mode === "mmo") {
    hint.textContent = "大大量出现：只计算第一轮；第一轮数量选项为 8–10 只。";
  } else {
    hint.textContent = "大大量出现两波：自动启用第二轮，并填写第二轮数量与宝可梦。";
  }
  $("bonus-fields").classList.toggle("hidden", !$("isbonus").checked);
  if ($("brpokemon")) $("brpokemon").disabled = !$("isbonus").checked;
  if (refreshOptions) updateSpawnOptions();
  else refreshSearchableSelect($("brpokemon"));
}

function updateSpawnOptions() {
  const select = $("frspawns");
  const previous = select.value;
  const values = $("isnormal").checked ? [10, 11, 12, 13, 14, 15] : [8, 9, 10];
  select.innerHTML = "";
  values.forEach(value => {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = `${value} 只`;
    select.appendChild(option);
  });
  if (values.map(String).includes(previous)) select.value = previous;
  else select.value = String(values[0]);
  updateFirstSpecies();
}

function showSpeciesLoadError(message) {
  const warning = $("species-warning");
  warning.replaceChildren();
  warning.appendChild(document.createTextNode(
    `本地宝可梦候选数据不可用：${message}。请确认本地引擎已安装；也可以直接重试。`
  ));
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "btn btn-secondary species-retry-button";
  retry.textContent = "重试加载候选列表";
  retry.addEventListener("click", () => { loadSpecies(); });
  warning.appendChild(document.createTextNode(" "));
  warning.appendChild(retry);
  warning.classList.remove("hidden");
}

async function loadSpecies() {
  const warning = $("species-warning");
  try {
    const data = await api("/api/species", { timeoutMs: 12000 });
    const loadedSpecies = Array.isArray(data.species) ? data.species : [];
    if (!loadedSpecies.length) throw new Error(data.error || "候选列表为空或接口未返回 species 数组。");
    speciesData = loadedSpecies;
    speciesNameMap = data.name_map || {};
    speciesMappingComplete = data.mapping_complete !== false;
    updateSpawnOptions();
    if (typeof refreshSpawnSpeciesMetadata === "function") refreshSpawnSpeciesMetadata();
    if (typeof updateSpawnRollSummary === "function") updateSpawnRollSummary();
    if (typeof renderSpawnMap === "function") renderSpawnMap();
    if (data.warning) {
      warning.textContent = data.warning;
      warning.classList.remove("hidden");
    } else {
      warning.classList.add("hidden");
      warning.textContent = "";
    }
  } catch (error) {
    speciesData = [];
    updateFirstSpecies();
    showSpeciesLoadError(error?.message || "未知错误");
  }
}

function pokemonLevelDisplayLabel(value) {
  const labels = {
    base: "基础等级",
    level10: "研究等级 10",
    perfect: "完美研究"
  };
  return labels[String(value || "").trim()] || "研究等级 10";
}

function effectiveResearchLevel(species) {
  const key = String(species || "").trim().replace(/^Alpha\s+/i, "");
  if (!key) return defaultResearchLevel;
  if (Object.prototype.hasOwnProperty.call(pokemonResearchLevels, key)) {
    return pokemonResearchLevels[key];
  }
  const lookupKeys = [key];
  const formMatch = key.match(/^(.+)-\d+$/);
  if (formMatch) lookupKeys.push(formMatch[1]);
  for (const lookupKey of lookupKeys) {
    const folded = lookupKey.toLocaleLowerCase();
    const matching = Object.entries(pokemonResearchLevels).find(([name]) => String(name).trim().toLocaleLowerCase() === folded);
    if (matching) return matching[1];
  }
  return defaultResearchLevel;
}

function researchOverrideCount() {
  return Object.keys(pokemonResearchLevels).length;
}

function spawnResearchLevel(species) {
  return effectiveResearchLevel(String(species || "").replace(/^Alpha\s*/i, ""));
}

function spawnRollCount(species) {
  const level = spawnResearchLevel(species);
  const bonus = { base: 0, level10: 1, perfect: 3 }[level] ?? 1;
  const charm = Boolean($("pokemon-shiny-charm")?.checked);
  return 1 + bonus + (charm ? 3 : 0);
}

function updateSpawnRollSummary() {
  const summary = $("spawn-roll-summary");
  if (!summary) return;
  const species = String($("spawn-species")?.value || "").replace(/^Alpha\s*/i, "");
  if (!species) {
    summary.textContent = "闪光判定：使用设置中心的闪耀护符与研究等级。";
    return;
  }
  const level = spawnResearchLevel(species);
  const levelLabel = { base: "基础研究", level10: "研究等级 10", perfect: "完美研究" }[level] || level;
  const charm = Boolean($("pokemon-shiny-charm")?.checked);
  summary.textContent = `闪光判定：${charm ? "闪符有" : "闪符无"} · ${levelLabel} · ${spawnRollCount(species)} 次（全局设置）`;
}

function updateResearchCount(visibleCount = null) {
  const count = $("pokemon-research-count");
  if (!count || !researchCatalog.length) return;
  const query = String($("pokemon-research-search")?.value || "").trim();
  const visible = visibleCount == null
    ? document.querySelectorAll(".pokemon-research-row").length
    : visibleCount;
  const scope = query ? `显示 ${visible} / ${researchCatalog.length} 只` : `共 ${researchCatalog.length} 只`;
  count.textContent = `${scope} · ${researchOverrideCount()} 个单独设置`;
}

function updatePokemonBulkSummary() {
  const label = $("pokemon-default-level-label");
  if (label) label.textContent = pokemonLevelDisplayLabel(defaultResearchLevel);
  const count = $("pokemon-override-count");
  const overrides = researchOverrideCount();
  if (count) count.textContent = overrides ? `${overrides} 只宝可梦有单独设置` : "尚无单独设置";
  document.querySelectorAll("[data-research-bulk]").forEach(button => {
    button.disabled = !settingsLoaded;
    button.setAttribute("aria-pressed", String(button.dataset.researchBulk === defaultResearchLevel && overrides === 0));
  });
}

function renderResearchCatalog() {
  const list = $("pokemon-research-list");
  if (!list) return;
  if (!researchCatalog.length) {
    list.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "pokemon-research-empty";
    empty.textContent = "洗翠图鉴暂时不可用。请检查本地程序文件后重启。";
    list.appendChild(empty);
    $("pokemon-research-count").textContent = "图鉴加载失败";
    return;
  }

  const query = String($("pokemon-research-search")?.value || "").trim().toLocaleLowerCase();
  const filtered = researchCatalog.filter(entry => {
    if (!query) return true;
    const haystack = `${entry.label || ""} ${entry.label_en || ""} ${entry.species || ""} ${entry.dex_number || ""}`.toLocaleLowerCase();
    return haystack.includes(query);
  });
  list.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "pokemon-research-empty";
    empty.textContent = "没有找到匹配的宝可梦。";
    list.appendChild(empty);
  }

  filtered.forEach(entry => {
    const row = document.createElement("div");
    row.className = "pokemon-research-row";
    row.dataset.speciesKey = entry.species;

    const identity = document.createElement("div");
    identity.className = "pokemon-research-identity";
    const art = document.createElement("span");
    art.className = "pokemon-research-art-wrap";
    const image = document.createElement("img");
    image.className = "pokemon-research-art hidden";
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.setAttribute("aria-hidden", "true");
    const fallback = document.createElement("span");
    fallback.className = "pokemon-research-art-fallback";
    fallback.textContent = "✦";
    fallback.setAttribute("aria-hidden", "true");
    art.append(image, fallback);
    setSpriteImage(image, entry.sprite, () => fallback.classList.remove("hidden"), () => fallback.classList.add("hidden"));

    const copy = document.createElement("span");
    copy.className = "pokemon-research-copy";
    const name = document.createElement("strong");
    name.textContent = entry.label || localizePokemonName(entry.species);
    const english = document.createElement("small");
    english.textContent = `#${String(entry.dex_number).padStart(3, "0")} · ${entry.label_en || entry.species}`;
    copy.append(name, english);
    identity.append(art, copy);

    const levels = document.createElement("div");
    levels.className = "pokemon-research-options";
    const selectedLevel = effectiveResearchLevel(entry.species);
    const choices = [
      ["base", "基础"],
      ["level10", "等级 10"],
      ["perfect", "完美"]
    ];
    choices.forEach(([value, label]) => {
      const optionLabel = document.createElement("label");
      optionLabel.className = "pokemon-research-option";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `pokemon-research-${entry.dex_number}`;
      radio.value = value;
      radio.checked = selectedLevel === value;
      radio.disabled = !settingsLoaded;
      radio.dataset.speciesKey = entry.species;
      radio.dataset.researchLevel = value;
      radio.setAttribute("aria-label", `${entry.label}：${label}`);
      const text = document.createElement("span");
      text.textContent = label;
      optionLabel.append(radio, text);
      levels.appendChild(optionLabel);
    });

    const overrideBadge = document.createElement("span");
    overrideBadge.className = "pokemon-research-override-badge";
    overrideBadge.textContent = Object.prototype.hasOwnProperty.call(pokemonResearchLevels, entry.species) ? "单独设置" : "";
    overrideBadge.classList.toggle("hidden", !overrideBadge.textContent);
    row.append(identity, levels, overrideBadge);
    list.appendChild(row);
  });

  updateResearchCount(filtered.length);
  updatePokemonBulkSummary();
}

async function loadResearchCatalog() {
  try {
    const data = await api("/api/pokemon-catalog", { timeoutMs: 12000 });
    researchCatalog = Array.isArray(data.species) ? data.species : [];
    researchCatalogNameMap = Object.fromEntries(researchCatalog.map(entry => [entry.species, entry.label]));
    renderResearchCatalog();
  } catch (error) {
    researchCatalog = [];
    renderResearchCatalog();
    showToast(`宝可梦研究等级列表加载失败：${error.message}`);
  }
}

function localizePokemonName(value) {
  const raw = String(value ?? "").trim();
  if (speciesNameMap[raw]) return speciesNameMap[raw];
  if (researchCatalogNameMap[raw]) return researchCatalogNameMap[raw];
  if (raw.startsWith("Alpha ")) return `头目${localizePokemonName(raw.slice(6))}`;
  if (raw.startsWith("Hisuian ")) return `洗翠${localizePokemonName(raw.slice(8))}`;
  if (raw.endsWith(" (Hisuian)")) return speciesNameMap[raw] || `洗翠${localizePokemonName(raw.slice(0, -10))}`;
  // The local RNG engine uses internal form IDs such as Growlithe-1 and Basculin-2.
  // Convert known Hisui form IDs to the same localized keys used by the species table.
  const formMatch = raw.match(/^(.+)-(\d+)$/);
  if (formMatch) {
    const base = formMatch[1];
    const formId = formMatch[2];
    if (formId === "1") {
      const mapped = speciesNameMap[`${base} (Hisuian)`] || speciesNameMap[`Hisuian ${base}`];
      if (mapped) return mapped;
    }
    if (formId === "2") {
      const mapped = speciesNameMap[`${base} (White-Striped)`] || speciesNameMap[`White-Striped ${base}`];
      if (mapped) return mapped;
    }
    return `${localizePokemonName(base)}（特殊形态）`;
  }
  return raw;
}

// 地点中文化：Serebii 点位的 area 字段是英文短语（at/in/on/along/upon + the + 地名）。
// 全部采用《传说 阿尔宙斯》官方简体中文译名（大区 + 具体景点，共 51 条，已逐条对照 52poke 百科）。
// 未收录的条目保留原文，避免误译造成误导。
const AREA_ZH = {
  // 大区域（原有的 6 条）
  "Obsidian Fieldlands": "黑曜原野",
  "Crimson Mirelands": "红莲湿地",
  "Cobalt Coastlands": "群青海岸",
  "Coronet Highlands": "天冠山麓",
  "Alabaster Icelands": "纯白冻土",
  "Jubilife Village": "祝庆村",
  "From Seed": "根据 Seed 计算",
  // 具体景点（去掉英文介词后的裸地名）
  "Cloudcap Pass": "笠云锥道",
  "Tombolo Walk": "沙洲道",
  "Arena's Approach": "往战场的路",
  "Avalugg's Legacy": "冰岩块",
  "Bathers' Lagoon": "戏水潟湖",
  "Deadwood Haunt": "鬼枯原",
  "Gapejaw Bog": "大嘴沼泽",
  "Ginkgo Landing": "银杏沙滩",
  "Heart's Crag": "心形岩山",
  "Lake Acuity": "睿智湖",
  "Lake Valor": "立志湖",
  "Lake Verity": "心齐湖",
  "Seagrass Haven": "海草乐园",
  "Stonetooth Rows": "列石山道",
  "Tidewater Dam": "河口堤堰",
  "Ursa's Ring": "熊的比武场",
  "Veilstone Cape": "帷幕海角",
  "Avalanche Slopes": "雪崩坡",
  "Fabled Spring": "妖精之泉",
  "Holm of Trials": "试炼沙洲",
  "Icebound Falls": "冰鬼瀑",
  "Sacred Plaza": "祈祷广场",
  "Scarlet Bog": "绯红沼",
  "Shrouded Ruins": "云雾遗迹",
  "Bolderoll Ravine": "隆隆山地",
  "Floaro Gardens": "荒园开垦地",
  "Grueling Grove": "险林",
  "Nature's Pantry": "森林膳房",
  "Sandgem Flats": "真砂平原",
  "Tranquility Cove": "宁静湾",
  "Bonechill Wastes": "酷寒荒地",
  "Droning Meadow": "羽音原野",
  "Horseshoe Plains": "蹄铁草原",
  "Ice Column Chamber": "冰柱窟",
  "Wayward Wood": "迷失山林",
  "Castaway Shore": "离散石滩",
  "Celestica Trail": "神阖山道",
  "Cloudpool Ridge": "云海山道",
  "Firespit Island": "吹火岛",
  "Ramanas Island": "玫瑰岛",
  "Spring Path": "隐泉之路",
  "Windswept Run": "驰风道",
  "Diamond Heath": "金刚后山",
  "Deertrack Heights": "角鹿高岗"
};

function localizeAreaName(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return raw;
  if (AREA_ZH[raw]) return AREA_ZH[raw];
  // area 常带英文介词前缀，如 "at Lake Verity"；去掉后查裸地名。
  // 注意原文用的是弯引号 ’，这里统一转成直引号再比对。
  const normalized = raw.replace(/[’]/g, "'");
  // 先去介词、再去定冠词 the，例如 "in the Crimson Mirelands" → "Crimson Mirelands"。
  const stripped = normalized.replace(/^(at|in|on|along|upon)\s+/i, "").replace(/^the\s+/i, "");
  return AREA_ZH[stripped] || raw;
}

function selectedSpeciesName(selectId) {
  const select = $(selectId);
  const option = select.options[select.selectedIndex];
  return option?.dataset?.species || option?.textContent || "";
}

function setBusy(busy) {
  $("calculate-button").disabled = busy;
  $("calculate-button").textContent = busy ? "正在计算…" : "计算路径";
  // 计算中给结果区一个轻量状态条：证明点击已生效，无需骨架屏（计算很快）。
  const msg = $("calculation-message");
  if (!msg) return;
  if (busy) {
    msg.textContent = "正在计算路径…";
    msg.className = "message message-calculating";
    msg.classList.remove("hidden");
  } else if (msg.classList.contains("message-calculating")) {
    // 成功后会被 showMessage 覆盖；这里只清理"卡在计算中"的残留。
    msg.classList.add("hidden");
  }
}

function isTruthyField(value) {
  if (value === true || value === 1) return true;
  if (typeof value === "string") return ["true", "yes", "1", "shiny", "alpha", "square", "square shiny", "square_shiny", "方块闪", "头目"].includes(value.toLowerCase());
  return false;
}

function firstValue(item, aliases) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const keys = Object.keys(item);
  for (const alias of aliases) {
    const key = keys.find(k => k.toLowerCase() === alias.toLowerCase());
    if (key !== undefined) return item[key];
  }
  return undefined;
}

function stringifyValue(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

function normalizeResults(results) {
  if (Array.isArray(results)) return results;
  if (results && typeof results === "object") {
    const nested = firstValue(results, ["results", "items", "encounters", "paths"]);
    if (Array.isArray(nested)) return nested;
    return Object.entries(results).map(([key, value]) => {
      if (value && typeof value === "object" && !Array.isArray(value)) return { key, ...value };
      return { key, value };
    });
  }
  return [];
}

function formatResultPath(value) {
  if (Array.isArray(value)) return value.map(part => typeof part === "string" ? part : stringifyValue(part)).join(" / ");
  return stringifyValue(value);
}

function appendTextElement(parent, tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  parent.appendChild(element);
  return element;
}

function resultList(value) {
  return PLAResultView.listify(value);
}

function displaySpeciesTitle(species, isAlpha) {
  const localized = localizePokemonName(stringifyValue(species));
  if (isAlpha && localized && !localized.startsWith("头目")) return `头目${localized}`;
  return localized;
}

function extractIVValues(value) {
  if (Array.isArray(value)) return value.slice(0, 6);
  if (value === null || value === undefined || value === "") return [];
  const trimmed = String(value).trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.slice(0, 6);
    } catch { /* fall through to delimiter parsing */ }
  }
  return trimmed.split(/[\s,/|]+/).filter(Boolean).map(part => part.replace(/^\[|\]$/g, "")).slice(0, 6);
}

function getIVTier(value) {
  const values = extractIVValues(value).map(Number).filter(Number.isFinite);
  if (values.length !== 6) return "";
  const perfectCount = values.filter(number => number === 31).length;
  if (perfectCount === 6) return "6V";
  if (perfectCount === 5) return "5V";
  if (perfectCount === 4) return "4V";
  return "";
}

function renderIVValues(parent, value) {
  const values = extractIVValues(value);
  if (!values.length) {
    appendTextElement(parent, "span", "result-extra-value", value == null ? "—" : stringifyValue(value));
    return;
  }
  const ivRow = appendTextElement(parent, "div", "result-iv-row");
  const statNames = ["HP", "攻击", "防御", "特攻", "特防", "速度"];
  values.forEach((raw, index) => {
    const number = Number(raw);
    const chip = appendTextElement(ivRow, "span", `iv-chip${number === 31 ? " iv-perfect" : ""}`, raw);
    chip.title = statNames[index] || `个体值 ${index + 1}`;
    chip.setAttribute("aria-label", `${chip.title}：${raw}`);
  });
}

function appendRouteStepChips(parent, steps) {
  if (Array.isArray(steps) && steps.length) {
    steps.forEach(step => appendTextElement(parent, "span", "result-route-chip", `D${step}`));
  } else {
    appendTextElement(parent, "span", "result-route-empty", "—");
  }
}

function appendMetric(parent, label, value, kind = "text") {
  const metric = appendTextElement(parent, "div", "summary-metric");
  appendTextElement(metric, "div", "summary-label", label);
  const valueNode = appendTextElement(metric, "div", `summary-value${kind === "chips" ? " summary-value-chips" : ""}`);
  if (kind === "chips" && Array.isArray(value) && value.length) {
    value.forEach(step => appendTextElement(valueNode, "span", "result-route-chip", `D${step}`));
  } else {
    appendTextElement(valueNode, "span", kind === "number" ? "summary-number" : "summary-text", String(value ?? "—"));
  }
  return metric;
}

function renderRouteSummary(parent, routeSummary) {
  const path = routeSummary.path;
  const grid = appendTextElement(parent, "div", "result-summary-grid");
  if (path.hasBonus) {
    appendMetric(grid, "第一轮路径", path.firstRound, "chips");
    appendMetric(
      grid,
      path.revisit.length ? "重新访问 · 剩余数量" : "轮次切换",
      path.revisit.length ? `[ ${path.revisit.join(", ")} ]` : (path.clearRound ? "清空后进入第二轮" : "进入第二轮"),
      "text"
    );
    if (path.bonusInitialSpawn) {
      appendMetric(grid, "第二轮目标位置", `第 ${path.bonusInitialSpawn} 只`, "number");
    } else {
      appendMetric(grid, "第二轮路径", path.bonus, "chips");
    }
  } else if (path.isInitialSpawn) {
    appendMetric(grid, "目标生成位置", `第 ${path.initialSpawn} 只`, "number");
    appendMetric(grid, "目标出现时机", "初始生成", "text");
    appendMetric(grid, "额外清除步骤", "无需执行", "text");
  } else {
    appendMetric(grid, "第一轮路径", path.ordinary, "chips");
    appendMetric(grid, "目标出现时机", "完成最后一步后", "text");
    appendMetric(grid, "路径操作数", `${path.ordinary.length} 步`, "text");
  }

  if (routeSummary.chains.length) {
    const simultaneous = appendTextElement(parent, "div", "result-simultaneous has-simultaneous");
    appendTextElement(simultaneous, "strong", "result-simultaneous-label", "同时闪光路线");
    const list = appendTextElement(simultaneous, "ul", "result-path-chip-list");
    [...new Set(routeSummary.chains)].forEach(pathText => appendTextElement(list, "li", "result-path-chip", pathText));
  }
  return grid;
}

function renderOperationStepList(parent, steps, options = {}) {
  if (!Array.isArray(steps) || !steps.length) return;
  const list = appendTextElement(parent, "ol", "operation-step-list");
  steps.forEach(step => {
    const li = appendTextElement(list, "li", "operation-step");
    appendTextElement(li, "span", "operation-step-number", String(step.number));
    const content = appendTextElement(li, "div", "operation-step-content");
    const mainLine = appendTextElement(content, "div", "operation-step-mainline");
    appendTextElement(mainLine, "span", "operation-count", step.pathStep || `D${step.count}`);
    appendTextElement(mainLine, "strong", "operation-step-title", step.title || (step.count === 1 ? "清除 1 只" : `一次清除 ${step.count} 只`));
    appendTextElement(content, "span", "operation-cumulative", `本段累计 ${step.cumulative} 只`);
  });
}

function renderOperationDetails(item, routeSummary) {
  const details = document.createElement("div");
  details.className = "result-details operation-details operation-details-content";
  const operations = PLAResultView.buildOperationSections(item);
  if (!operations.sections.length) {
    appendTextElement(details, "p", "operation-empty", "引擎没有返回可解析的路径步骤。可展开原始数据核对路径字段；不会用演示路线替代计算结果。");
  }

  const timeline = appendTextElement(details, "div", "operation-timeline");
  let phaseNumber = 0;
  operations.sections.forEach(section => {
    phaseNumber += 1;
    const sectionClass = section.targetEvent ? " operation-target-event" : (section.targetWarning ? " operation-target-warning" : "");
    const sectionEl = appendTextElement(timeline, "section", `operation-section${sectionClass}`);
    const sectionHead = appendTextElement(sectionEl, "div", "operation-section-head");
    const phaseMarker = section.targetEvent ? "✦" : (section.targetWarning ? "!" : String(phaseNumber));
    appendTextElement(sectionHead, "span", `operation-phase-number${section.targetEvent ? " is-target" : ""}`, phaseMarker);
    const titleWrap = appendTextElement(sectionHead, "div", "operation-section-title-wrap");
    appendTextElement(titleWrap, "h4", "operation-section-title", section.title);
    if (section.note) appendTextElement(titleWrap, "p", "operation-section-note", section.note);

    if (section.revisitMarkers?.length) {
      const revisitOrder = appendTextElement(sectionEl, "div", "revisit-instruction-list");
      section.revisitMarkers.forEach((marker, index) => {
        const item = appendTextElement(revisitOrder, "div", "revisit-instruction");
        appendTextElement(item, "span", "revisit-instruction-number", String(index + 1));
        const copy = appendTextElement(item, "div", "revisit-instruction-copy");
        appendTextElement(copy, "strong", "revisit-instruction-title", marker.title || `群聚剩余 ${marker.marker} 只时`);
        appendTextElement(copy, "span", "revisit-instruction-description", marker.description || "离开群聚点至少 120 米，再返回群聚点。");
        if (index < section.revisitMarkers.length - 1) {
          appendTextElement(revisitOrder, "div", "revisit-instruction-connector", "↓");
        }
      });
      if (section.methodNote) appendTextElement(sectionEl, "p", "operation-section-note revisit-method-note", section.methodNote);
    }
    renderOperationStepList(sectionEl, section.steps);
  });

  if (operations.chainOperations.length) {
    const simultaneousSection = appendTextElement(timeline, "section", "operation-section simultaneous-detail-section");
    const sectionHead = appendTextElement(simultaneousSection, "div", "operation-section-head");
    appendTextElement(sectionHead, "span", "operation-phase-number", "＋");
    const titleWrap = appendTextElement(sectionHead, "div", "operation-section-title-wrap");
    appendTextElement(titleWrap, "h4", "operation-section-title", "同时闪光路线");
    appendTextElement(titleWrap, "p", "operation-section-note", "这些是可能同时出现闪光的其他目标路线，不代表同一目标的替代路线。");
    operations.chainOperations.forEach(chain => {
      const chainBlock = appendTextElement(simultaneousSection, "div", "simultaneous-operation-block");
      appendTextElement(chainBlock, "h5", "simultaneous-operation-title", chain.label);
      renderOperationStepList(chainBlock, chain.steps);
      if (chain.revisit?.length) {
        appendTextElement(chainBlock, "p", "operation-section-note", `重访顺序 [${chain.revisit.join(", ")}] 表示群聚剩余数量阈值：依次等到剩余 ${chain.revisit.join("、")} 只时，离开群聚点至少 120 米再返回；数字不是要清除的数量。`);
      }
      if (chain.clearRound) {
        appendTextElement(chainBlock, "p", "operation-section-note", "完成第一轮后清空剩余宝可梦，再进入第二轮。");
      }
      if (chain.bonus.length) {
        appendTextElement(chainBlock, "h5", "simultaneous-operation-title", "第二轮操作");
        const bonusSteps = chain.bonus.map((count, index) => ({
          number: index + 1,
          count,
          pathStep: `D${count}`,
          title: count === 1 ? "清除 1 只" : `一次清除 ${count} 只`,
          cumulative: chain.bonus.slice(0, index + 1).reduce((sum, value) => sum + value, 0)
        }));
        renderOperationStepList(chainBlock, bonusSteps);
      }
      const targetNote = chain.initialSpawn
        ? `目标位于初始生成第 ${chain.initialSpawn} 只。`
        : chain.bonusInitialSpawn
          ? `目标位于第二轮初始生成第 ${chain.bonusInitialSpawn} 只。`
          : `目标时机：${chain.targetTiming}。`;
      appendTextElement(chainBlock, "p", "operation-target-note", targetNote);
    });
  }

  // Keep engine-provided `dupes` in the raw result data for diagnostics, but do not
  // show a non-standard "other reachable path" panel in the official-style UI.
  // Alternative path metadata is not an additional shiny target or a required step.

  const rawDetails = appendTextElement(details, "details", "result-raw-details");
  appendTextElement(rawDetails, "summary", "", "查看原始路径数据");
  appendTextElement(rawDetails, "pre", "result-raw-json", JSON.stringify(item, null, 2));
  return details;
}

function applyResultFilters() {
  const shinyOnly = $("show-only-shiny")?.checked || false;
  const alphaOnly = $("show-only-alpha")?.checked || false;
  const defaultOnly = $("show-default-path")?.checked || false;
  const multiOnly = $("show-multi-path")?.checked || false;
  const cards = [...document.querySelectorAll("#results-list .result-card")];
  cards.forEach(card => {
    let show = true;
    if (shinyOnly && card.dataset.shiny === "false") show = false;
    if (alphaOnly && card.dataset.alpha === "false") show = false;
    if (defaultOnly && card.dataset.defaultPath !== "true") show = false;
    if (multiOnly && card.dataset.multiPath !== "true") show = false;
    card.classList.toggle("filtered-out", !show);
  });
  const visibleCount = cards.filter(card => !card.classList.contains("filtered-out")).length;
  const count = $("result-count");
  if (count) {
    const nextText = (shinyOnly || alphaOnly || defaultOnly || multiOnly)
      ? `显示 ${visibleCount} / ${cards.length} 条`
      : `${cards.length} 条结果`;
    if (count.textContent !== nextText) {
      count.textContent = nextText;
      replayUiEntrance(count);
    }
  }
}

function spriteCandidates(rawSprite) {
  const filename = String(rawSprite || "").trim();
  // Form, sex and shiny suffixes are semantically meaningful. Never display a
  // different form or normal-color sprite as if it were the requested target.
  if (!/^(c_\d+(?:-\d+)?f?s?)\.png$/i.test(filename)) return [];
  return [`/user-assets/custom/${filename}`, `/user-assets/cache/${filename}`];
}

function researchLevelLabel(value) {
  const labels = {
    base: "基础研究",
    level10: "研究等级 10",
    perfect: "完美研究"
  };
  return labels[String(value || "").trim()] || "—";
}

function speciesIdentityValues(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  const withoutAlpha = raw.replace(/^Alpha\s+/i, "").trim();
  const localizedRaw = localizePokemonName(raw);
  const localizedBase = localizePokemonName(withoutAlpha);
  return [...new Set([raw, withoutAlpha, localizedRaw, localizedBase]
    .map(value => String(value || "").replace(/^头目\s*/, "").trim().toLocaleLowerCase())
    .filter(Boolean))];
}

function sameSpeciesIdentity(left, right) {
  const leftKeys = speciesIdentityValues(left);
  const rightKeys = new Set(speciesIdentityValues(right));
  return leftKeys.some(key => rightKeys.has(key));
}

function researchLevelForSpecies(params, species, round) {
  if (!species) return "";
  const explicit = params?.[`${round}_research_level`];
  if (explicit) return explicit;

  const levels = params?.research_levels;
  if (levels && typeof levels === "object") {
    if (levels[species]) return levels[species];
    const entry = Object.entries(levels).find(([key]) => sameSpeciesIdentity(key, species));
    if (entry) return entry[1];
  }

  // Older result payloads may omit the research-level map. Use the current form
  // only when the selected species is the same as the species being resolved.
  const speciesSelectId = round === "br" ? "brpokemon" : "frpokemon";
  const selectedSpecies = typeof selectedSpeciesName === "function"
    ? selectedSpeciesName(speciesSelectId)
    : "";
  if (selectedSpecies && sameSpeciesIdentity(selectedSpecies, species)) {
    return effectiveResearchLevel(selectedSpecies);
  }
  return "";
}

function resultResearchContext(item, params) {
  const resultSpecies = String(firstValue(item, ["species", "pokemon", "name", "encounter", "mon", "key"]) || "")
    .replace(/^Alpha\s+/i, "")
    .trim();
  const candidates = [
    {
      species: params.fr_species,
      level: researchLevelForSpecies(params, params.fr_species, "fr")
    },
    {
      species: params.br_species,
      level: researchLevelForSpecies(params, params.br_species, "br")
    }
  ].filter(entry => entry.species);

  const match = candidates.find(entry => sameSpeciesIdentity(entry.species, resultSpecies));
  if (match) {
    return {
      species: localizePokemonName(match.species),
      level: researchLevelLabel(match.level)
    };
  }

  // If the engine returns a variant/form label that does not exactly match its
  // encounter table key, a single-round result can still be unambiguously tied
  // to the only selected species. Never guess between two different rounds.
  if (candidates.length === 1) {
    return {
      species: localizePokemonName(candidates[0].species),
      level: researchLevelLabel(candidates[0].level)
    };
  }
  return null;
}

function renderCalculationSettingsSummary(params) {
  const node = $("result-settings-summary");
  if (!node) return;
  const candidates = [
    { species: params?.fr_species, level: researchLevelForSpecies(params, params?.fr_species, "fr") },
    { species: params?.br_species, level: researchLevelForSpecies(params, params?.br_species, "br") }
  ].filter(entry => String(entry.species || "").trim());
  const unique = [];
  candidates.forEach(entry => {
    if (unique.some(existing => sameSpeciesIdentity(existing.species, entry.species))) return;
    unique.push(entry);
  });
  const levelText = unique.map(entry => {
    const species = localizePokemonName(String(entry.species).replace(/^Alpha\s+/i, ""));
    return `${species} ${researchLevelLabel(entry.level)}`;
  });
  const charmText = params?.shiny_charm ? "有" : "无";
  // Keep the separators authored as plain text; no HTML is inserted from names.
  node.textContent = `本次计算参数：${levelText.join("，")}，闪耀护符：${charmText}`;
  node.classList.remove("hidden");
  replayUiEntrance(node);
}

function addPokemonArtwork(parent, item, title) {
  const frame = appendTextElement(parent, "div", "pokemon-art-frame");
  const fallback = appendTextElement(frame, "div", "pokemon-art-fallback", "✦");
  fallback.setAttribute("aria-hidden", "true");
  const rawSprite = firstValue(item, ["sprite", "sprite_file", "spritefile"]);
  const rawSpecies = String(firstValue(item, ["species", "pokemon", "name", "encounter", "mon", "key"]) || "")
    .replace(/^Alpha\s+/i, "").trim().toLocaleLowerCase();
  const candidate = speciesData.find(entry =>
    String(entry.species || "").trim().toLocaleLowerCase() === rawSpecies ||
    String(entry.label_en || "").replace(/^Alpha\s+/i, "").trim().toLocaleLowerCase() === rawSpecies
  );
  const sprite = rawSprite || candidate?.sprite || "";
  const candidates = spriteCandidates(sprite);
  if (!candidates.length) {
    appendTextElement(frame, "span", "pokemon-art-caption", "图片未安装");
    return frame;
  }
  const img = document.createElement("img");
  img.className = "pokemon-art-image";
  img.alt = `${title}宝可梦图片`;
  img.loading = "lazy";
  img.decoding = "async";
  let cursor = 0;
  img.addEventListener("load", () => {
    fallback.classList.add("hidden");
    frame.classList.add("has-image");
    frame.querySelectorAll(".pokemon-art-caption").forEach(node => node.remove());
  });
  img.addEventListener("error", () => {
    cursor += 1;
    if (cursor < candidates.length) img.src = candidates[cursor];
    else {
      img.classList.add("hidden");
      if (!frame.querySelector(".pokemon-art-caption")) {
        appendTextElement(frame, "span", "pokemon-art-caption", "图片未安装");
      }
    }
  });
  img.dataset.spriteFilename = sprite;
  img._retrySprite = () => { cursor = 0; img.classList.remove("hidden"); img.src = candidates[0]; };
  img.src = candidates[0];
  frame.appendChild(img);
  return frame;
}

function createEmptyStateNode() {
  const empty = document.createElement("div");
  empty.className = "empty-state panel result-empty-entering";
  empty.innerHTML = "<div class='empty-icon'>✦</div><h3>本次没有符合条件的结果</h3><p>计算已正常完成。可以调整计算筛选条件或群体参数后重新计算；研究等级可在设置中心的「宝可梦设置」中修改。不会用演示数据替代真实结果。</p>";
  empty.addEventListener("animationend", event => {
    if (event.target === empty && event.animationName === "plaResultCardEnter") {
      empty.classList.remove("result-empty-entering");
    }
  });
  return empty;
}

function renderResults(data) {
  lastCalculation = data;
  const list = $("results-list");
  list.innerHTML = "";
  const items = normalizeResults(data.results);
  list.classList.toggle("is-empty-state", items.length === 0);
  const params = data.params || {};
  // 定点头目模式：有真实结果时显示结果区，无结果时仍让地图独占。
  const resultsColumn = $("results-column");
  if (resultsColumn) resultsColumn.classList.toggle("is-map-empty", resultsColumn.classList.contains("is-map-mode") && items.length === 0);
  const appearance = params.isnormal ? "普通大量出现" : (params.isbonus ? "大大量出现两波" : "大大量出现");
  $("result-count").textContent = `${items.length} 条结果`;
  $("results-caption").textContent = `Seed ${data.seed} · ${appearance}`;
  replayUiEntrance($("result-count"));
  replayUiEntrance($("results-caption"));
  renderCalculationSettingsSummary(params);

  if (!items.length) {
    list.appendChild(createEmptyStateNode());
    return;
  }

  items.forEach((item, index) => {
    const card = document.createElement("article");
    card.className = "result-card result-card-editorial result-card-entering";
    card.style.setProperty("--result-enter-delay", `${Math.min(index * 36, 180)}ms`);

    const species = firstValue(item, ["species", "pokemon", "name", "encounter", "mon", "key"]);
    const area = firstValue(item, ["mapname", "map_name", "location", "area", "map"]);
    const shiny = firstValue(item, ["shiny", "is_shiny", "isshiny", "shiny_status"]);
    const square = firstValue(item, ["square", "is_square", "square_shiny", "is_square_shiny", "squares shiny"]);
    const alpha = firstValue(item, ["alpha", "is_alpha", "isalpha", "isAlpha"]);
    const defaultPath = firstValue(item, ["default_path", "defaultpath", "default_route", "defaultroute"]);
    const routeSummary = PLAResultView.buildRouteSummary(item);
    const isSquare = isTruthyField(square);
    const isShiny = isTruthyField(shiny) || isSquare;
    const isAlpha = alpha === undefined ? /^Alpha\s/i.test(String(species ?? "")) : isTruthyField(alpha);
    const multiPath = routeSummary.hasMultiple;
    const hasDefaultPath = isTruthyField(defaultPath);
    const ivs = firstValue(item, ["ivs", "individual_values", "individualvalues", "iv"]);
    const ivTier = getIVTier(ivs);
    const displayName = species !== undefined ? displaySpeciesTitle(species, isAlpha) : `结果 ${index + 1}`;

    card.dataset.shiny = shiny === undefined && square === undefined ? "unknown" : (isShiny ? "true" : "false");
    card.dataset.alpha = alpha === undefined ? "unknown" : (isAlpha ? "true" : "false");
    card.dataset.defaultPath = hasDefaultPath ? "true" : "false";
    card.dataset.multiPath = multiPath ? "true" : "false";
    card.dataset.routeKey = routeSummary.path.routeKey;

    const hero = appendTextElement(card, "div", "result-hero");
    addPokemonArtwork(hero, item, displayName);
    const heroCopy = appendTextElement(hero, "div", "result-hero-copy");
    const titleRow = appendTextElement(heroCopy, "div", "result-title-row");
    appendTextElement(titleRow, "h3", "result-title", `${displayName} #${index + 1}`);

    const statusLine = appendTextElement(heroCopy, "div", "result-status-line");
    if (isSquare) {
      appendTextElement(statusLine, "span", "result-status-tag status-square", "✦ 方块闪");
    } else {
      appendTextElement(statusLine, "span", `result-status-tag ${isShiny ? "status-shiny" : "status-not-shiny"}`, isShiny ? "✦ 闪光" : "未闪光");
    }
    appendTextElement(statusLine, "span", `result-status-tag ${isAlpha ? "status-alpha" : "status-normal"}`, isAlpha ? "头目（Alpha）" : "普通个体");
    if (ivTier) appendTextElement(statusLine, "span", `result-status-tag status-iv ${ivTier === "6V" ? "status-6v" : ivTier === "5V" ? "status-5v" : "status-4v"}`, ivTier);
    if (multiPath) {
      const multiCount = routeSummary.multiShinyCount;
      appendTextElement(statusLine, "span", "result-status-tag status-multi",
        multiCount ? `同路径多闪 ×${multiCount}` : "同路径多闪");
    }
    if (hasDefaultPath) appendTextElement(statusLine, "span", "result-status-tag status-default", "默认路径");

    const localizedArea = area === undefined ? "" : localizeAreaName(stringifyValue(area));
    const subtitle = localizedArea && !["根据 Seed 计算", "from seed", ""].includes(localizedArea)
      ? `出现区域 · ${localizedArea}`
      : (isShiny ? "已计算出闪光目标路线" : "已计算出目标路线");
    appendTextElement(heroCopy, "p", "result-subtitle", subtitle);

    const infoHeading = appendTextElement(card, "div", "result-section-heading result-info-heading");
    appendTextElement(infoHeading, "h4", "result-section-title", "宝可梦信息");
    const extra = appendTextElement(card, "div", "result-meta-strip");
    const nature = firstValue(item, ["nature", "personality"]);
    const gender = firstValue(item, ["gender", "sex"]);
    const rolls = firstValue(item, ["rolls", "shiny_attempts", "shiny_attempt_count", "shinyrolls", "shiny_checks"]);
    const metaField = (label, value) => {
      const field = appendTextElement(extra, "div", "result-meta-field");
      appendTextElement(field, "span", "result-meta-label", label);
      appendTextElement(field, "strong", "result-meta-value", value == null ? "—" : String(value));
      return field;
    };
    metaField("性格", PLAResultView.localizeNature(nature));
    metaField("性别", PLAResultView.localizeGender(gender));
    metaField("闪光判定", rolls === undefined ? "—" : `${stringifyValue(rolls)} 次`);
    const ivField = appendTextElement(extra, "div", "result-meta-field result-iv-field");
    appendTextElement(ivField, "span", "result-meta-label", "个体值");
    renderIVValues(ivField, ivs);

    const pathHeading = appendTextElement(card, "div", "result-section-heading result-path-heading");
    appendTextElement(pathHeading, "h4", "result-section-title", "路径概要");
    const summaryWrap = appendTextElement(card, "div", "result-route-overview");
    renderRouteSummary(summaryWrap, routeSummary);

    // Detail actions sit in the card's top-right corner; the detail view opens
    // in its own focused window so a route can stay on screen while grinding.
    const openDetailButton = document.createElement("button");
    openDetailButton.className = "route-detail-button";
    openDetailButton.type = "button";
    openDetailButton.textContent = "详细步骤";
    openDetailButton.addEventListener("click", () => {
      openResultDetailModal(`${displayName} #${index + 1}`, item, routeSummary, extra, summaryWrap);
    });
    titleRow.appendChild(openDetailButton);

    const copy = document.createElement("button");
    copy.className = "text-button copy-path";
    copy.type = "button";
    copy.textContent = "复制路径";
    copy.addEventListener("click", () => {
      const text = routeSummary.lines.map(line => `${line.label}：${line.value}`).join("\n")
        + (routeSummary.chains.length ? `\n同时闪光：\n${routeSummary.chains.join("\n")}` : "");
      copyText(text || routeSummary.path.raw || "");
    });
    titleRow.appendChild(copy);
    card.addEventListener("animationend", event => {
      if (event.target.classList?.contains("result-detail-heading") && event.animationName === "plaResultSectionEnter") {
        card.classList.remove("result-card-entering");
      }
    });
    list.appendChild(card);
  });

  applyResultFilters();
}

/* --------------------------------------------- focused result detail window */
function openResultDetailModal(title, item, routeSummary, metaNode, summaryNode) {
  const modal = $("result-detail-modal");
  const body = $("result-detail-body");
  if (!modal || !body) return;
  $("result-detail-title").textContent = title;
  body.innerHTML = "";
  if (metaNode) body.appendChild(metaNode.cloneNode(true));
  if (summaryNode) body.appendChild(summaryNode.cloneNode(true));
  const details = renderOperationDetails(item, routeSummary);
  details.classList.remove("hidden");
  details.inert = false;
  details.setAttribute("aria-hidden", "false");
  body.appendChild(details);
  modal.classList.remove("hidden", "is-exiting");
  document.body.classList.add("result-detail-open");
  body.scrollTop = 0;
  $("result-detail-close")?.focus();
}

function closeResultDetailModal() {
  const modal = $("result-detail-modal");
  if (!modal || modal.classList.contains("hidden")) return;
  closeModalWithExit(modal, () => {
    modal.classList.add("hidden");
    document.body.classList.remove("result-detail-open");
    $("result-detail-body").innerHTML = "";
  });
}

async function submitCalculation(event) {
  event.preventDefault();
  if ($("appearance") && $("appearance").value === "spawn_alpha") {
    return submitSpawn();
  }
  if ($("appearance") && $("appearance").value === "spawn_multi") {
    return submitMulti();
  }
  hideMessage();
  const firstSpecies = selectedSpeciesName("frpokemon");
  const secondSpecies = selectedSpeciesName("brpokemon");
  const payload = {
    isnormal: $("isnormal").checked,
    frspawns: Number($("frspawns").value),
    frencounter: $("frpokemon").value,
    fr_species: firstSpecies,
    isbonus: $("isbonus").checked,
    brspawns: Number($("brspawns").value),
    brencounter: $("brpokemon").value,
    br_species: secondSpecies,
    filter: $("filter").value
  };
  if (!$("current-seed").textContent || $("current-seed").textContent === "尚未读取") {
    showMessage("当前没有可用 Seed。请先在左上角手动输入 Seed，或使用「联机测 Seed」。", "error");
    return;
  }
  setBusy(true);
  try {
    const data = await api("/api/calculate", { method: "POST", body: JSON.stringify(payload) });
    renderResults(data);
    lastCalculationFailed = false;
    lastCalculationErrorMessage = "";
    updateDiagnosticsBanner();
    showMessage(`计算完成 · Seed ${data.seed}，结果已显示。`, "success");
  } catch (error) {
    lastCalculationFailed = true;
    lastCalculationErrorMessage = error.message;
    updateDiagnosticsBanner();
    showMessage(`${error.message}。没有使用假结果。请点击页面顶部「复制诊断报告」收集日志。`, "error");
  } finally {
    setBusy(false);
  }
}

async function loadSettings() {
  const settings = await api("/api/settings", { timeoutMs: 12000 });
  defaultResearchLevel = settings.default_research_level || "level10";
  pokemonResearchLevels = settings.pokemon_research_levels && typeof settings.pokemon_research_levels === "object"
    ? { ...settings.pokemon_research_levels }
    : {};
  const defaultCharm = settings.default_shiny_charm !== false;
  if ($("pokemon-shiny-charm")) {
    $("pokemon-shiny-charm").checked = defaultCharm;
    $("pokemon-shiny-charm").disabled = false;
  }
  if ($("pokemon-research-search")) $("pokemon-research-search").disabled = false;
  settingsLoaded = true;
  updateSpawnRollSummary();
  renderResearchCatalog();
}

function persistPokemonSettings() {
  const status = $("pokemon-settings-save-status");
  if (status) status.textContent = "保存中…";
  pokemonSettingsSaveQueue = pokemonSettingsSaveQueue.catch(() => {}).then(async () => {
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        default_research_level: defaultResearchLevel,
        default_shiny_charm: Boolean($("pokemon-shiny-charm")?.checked),
        pokemon_research_levels: { ...pokemonResearchLevels }
      })
    });
    if (status) status.textContent = "已自动保存";
    return true;
  }).catch(error => {
    if (status) status.textContent = "保存失败";
    showToast(`宝可梦设置保存失败：${error.message}`);
    return false;
  });
  return pokemonSettingsSaveQueue;
}

async function setAllResearchLevels(level) {
  if (!settingsLoaded || !["base", "level10", "perfect"].includes(level)) return;
  defaultResearchLevel = level;
  pokemonResearchLevels = {};
  updatePokemonBulkSummary();
  renderResearchCatalog();
  const saved = await persistPokemonSettings();
  if (saved) showToast(`已将全部宝可梦统一设为「${pokemonLevelDisplayLabel(level)}」，并保存设置。`);
}

async function changePokemonResearchLevel(species, level) {
  const key = String(species || "").trim();
  if (!settingsLoaded || !key || !["base", "level10", "perfect"].includes(level)) return;
  if (level === defaultResearchLevel) delete pokemonResearchLevels[key];
  else pokemonResearchLevels[key] = level;
  updateSpawnRollSummary();
  updatePokemonBulkSummary();
  const row = [...document.querySelectorAll(".pokemon-research-row")].find(node => node.dataset.speciesKey === key);
  const badge = row?.querySelector(".pokemon-research-override-badge");
  if (badge) {
    const hasOverride = Object.prototype.hasOwnProperty.call(pokemonResearchLevels, key);
    badge.textContent = hasOverride ? "单独设置" : "";
    badge.classList.toggle("hidden", !hasOverride);
  }
  updateResearchCount();
  await persistPokemonSettings();
}

async function applyManualSeedValue(seed, label = "手动 Seed") {
  try {
    const result = await api("/api/seed/manual", {
      method: "POST",
      body: JSON.stringify({ seed })
    });
    if (result.needs_confirmation) {
      const yes = await showSeedConfirmation(
        result,
        "应用手动 Seed",
        "你输入的 Seed 与当前 Seed 不同。确认后会应用新值。"
      );
      if (!yes) {
        const cancelled = await api("/api/seed/cancel-pending", {
          method: "POST",
          body: JSON.stringify({})
        }).catch(() => null);
        if (cancelled) renderSeedState(cancelled);
        else await loadSeedState();
        showToast("已保留当前 Seed。");
        return false;
      }
      const confirmed = await api("/api/seed/manual", {
        method: "POST",
        body: JSON.stringify({ seed, confirm: true })
      });
      renderSeedState(confirmed);
    } else {
      renderSeedState(result);
    }
    showToast(`${label} 已校验并应用。`);
    return true;
  } catch (error) {
    showToast(error.message);
    return false;
  }
}

async function loadEngineStatus() {
  const statusNode = $("local-engine-status");
  const detailNode = $("local-engine-details");
  try {
    const data = await api("/api/engine", { timeoutMs: 18000 });
    engineSnapshot = data;
    engineVerified = Boolean(data.verified);
    engineProblemMessage = data.verified ? "" : (data.message || (data.missing || []).join("、"));
    statusNode.textContent = data.verified ? "本地引擎已验证" : (data.installed ? "引擎尚未验证" : "尚未安装");
    statusNode.className = `status-pill ${data.verified ? "status-success" : "status-error"}`;
    const details = [
      data.message || "",
      data.version && data.version !== "未记录" ? `版本/安装时间：${data.version}` : "",
      `候选映射：${data.mapping_complete ? "完整" : "备用/未验证"}`,
      data.missing?.length ? `缺失：${data.missing.join("、")}` : ""
    ].filter(Boolean);
    detailNode.textContent = details.join(" · ");
    renderEngineMissing(data.missing);
    updateDiagnosticsBanner();
  } catch (error) {
    engineSnapshot = null;
    engineVerified = false;
    engineProblemMessage = error.message;
    statusNode.textContent = "检查失败";
    statusNode.className = "status-pill status-error";
    detailNode.textContent = error.message;
    renderEngineMissing([]);
    updateDiagnosticsBanner();
  }
  renderUnifiedResources();
}

/* ------------------------------------------------------- local engine setup */
let engineGuide = null;
let engineInstallTimer = null;

async function loadEngineGuide() {
  try {
    engineGuide = await api("/api/engine/guide");
  } catch {
    engineGuide = null;
    return;
  }
  const target = $("engine-target-path");
  if (target) target.textContent = engineGuide.engine_root || "—";
  const list = $("engine-required-files");
  if (list) {
    list.innerHTML = "";
    (engineGuide.entries || []).forEach((entry) => {
      const li = document.createElement("li");
      li.className = entry.exists ? "is-present" : "is-missing";
      li.textContent = `${entry.exists ? "✓" : "✗"} ${entry.label} · ${entry.path}`;
      list.appendChild(li);
    });
  }
  setEngineBusy(Boolean(engineInstallTimer));
}

function renderEngineMissing(missing) {
  const box = $("engine-missing-list");
  if (!box) return;
  const items = (Array.isArray(missing) ? missing : []).filter(Boolean);
  box.innerHTML = "";
  box.classList.toggle("hidden", items.length === 0);
  if (!items.length) return;
  const title = document.createElement("strong");
  title.textContent = "缺少以下内容：";
  box.appendChild(title);
  const list = document.createElement("ul");
  items.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    list.appendChild(li);
  });
  box.appendChild(list);
}

function setEngineBusy(busy) {
  const autoSupported = Boolean(engineGuide && engineGuide.auto_install_supported);
  ["engine-auto-install", "engine-pick-zip", "engine-install-zip", "engine-choose-zip", "refresh-engine-status"]
    .forEach((id) => {
      const node = $(id);
      if (!node) return;
      node.disabled = busy || (id === "engine-auto-install" && !autoSupported);
    });
  const auto = $("engine-auto-install");
  if (auto) {
    auto.title = autoSupported ? "从 GitHub 下载上游源码并在本机安装" : "当前版本不含安装脚本，请使用本地 ZIP 安装";
  }
}

function renderEngineProgress(snapshot) {
  const box = $("engine-progress");
  const log = $("engine-progress-log");
  const label = $("engine-progress-label");
  const time = $("engine-progress-time");
  if (!box || !log || !label || !time) return;
  const lines = snapshot.log || [];
  const visible = snapshot.state !== "idle" || lines.length > 0;
  box.classList.toggle("hidden", !visible);
  if (!visible) return;
  if (snapshot.running) label.textContent = "正在安装本地引擎…";
  else if (snapshot.state === "success") label.textContent = "安装脚本已完成，正在重新验证";
  else if (snapshot.state === "failed") label.textContent = `安装失败：${snapshot.error || "请查看日志"}`;
  else label.textContent = "安装日志";
  time.textContent = `${Math.round(snapshot.elapsed_seconds || 0)} 秒`;
  log.textContent = lines.slice(-60).join("\n");
  log.scrollTop = log.scrollHeight;
}

async function startEngineInstall(mode) {
  let zipPath = "";
  if (mode === "zip") {
    zipPath = ($("engine-zip-path")?.value || "").trim();
    if (!zipPath) {
      showToast("请先选择或粘贴上游源码 ZIP 的完整路径。");
      return;
    }
  }
  try {
    const data = await api("/api/engine/install", {
      method: "POST",
      body: JSON.stringify(mode === "zip" ? { mode: "zip", zip_path: zipPath } : { mode: "auto" })
    });
    renderEngineProgress(data);
    setEngineBusy(true);
    startEnginePoll();
  } catch (error) {
    showToast(`启动安装失败：${error.message}`);
  }
}

function startEnginePoll() {
  stopEnginePoll();
  engineInstallTimer = setInterval(pollEngineInstall, 1200);
  pollEngineInstall();
}

function stopEnginePoll() {
  if (engineInstallTimer) {
    clearInterval(engineInstallTimer);
    engineInstallTimer = null;
  }
}

async function pollEngineInstall() {
  let snapshot;
  try {
    snapshot = await api("/api/engine/install-status", { timeoutMs: 8000 });
  } catch (error) {
    stopEnginePoll();
    setEngineBusy(false);
    showToast(`读取安装状态失败：${error.message}`);
    return;
  }
  renderEngineProgress(snapshot);
  if (snapshot.running) return;
  stopEnginePoll();
  setEngineBusy(false);
  await loadEngineStatus();
  await loadEngineGuide();
  if (snapshot.state === "success") showToast("本地引擎安装完成，已重新验证。");
  else if (snapshot.state === "failed") showToast(`安装失败：${snapshot.error || "请查看安装日志"}`);
}

async function openEngineFolder() {
  try {
    const data = await api("/api/engine/open-folder", { method: "POST", body: "{}" });
    showToast(`已打开引擎文件夹：${data.path}`);
  } catch (error) {
    showToast(error.message);
  }
}

async function openEngineUpstream() {
  try {
    await api("/api/engine/open-upstream", { method: "POST", body: "{}" });
    showToast("已在浏览器中打开上游项目页，选 Code → Download ZIP 下载。");
  } catch (error) {
    showToast(error.message);
  }
}

async function chooseEngineZip() {
  try {
    const data = await api("/api/engine/choose-zip", { method: "POST", body: "{}", timeoutMs: 180000 });
    if (data.path) {
      $("engine-zip-path").value = data.path;
      showToast("已选择 ZIP。点「用这个 ZIP 安装」开始。");
    }
  } catch (error) {
    showToast(error.message);
  }
}

function toggleEngineZipRow() {
  const row = $("engine-zip-row");
  if (row) row.classList.toggle("hidden");
}

/* ------------------------------------------- single spawner (fixed alpha) */
let spawnCatalog = null;
let spawnMapCatalog = null;
let spawnMapPoint = null;
// 已确认的点：确认后仍高亮显示，且地图不过滤 species，方便改选其它点。
let confirmedSpawnPointId = null;

function spawnDisplayName(species) {
  const raw = String(species || "");
  const isAlpha = raw.startsWith("Alpha");
  const base = isAlpha ? raw.slice(5) : raw;
  const zh = typeof localizePokemonName === "function" ? localizePokemonName(base) : base;
  return (isAlpha ? "头目 " : "") + zh;
}

function spawnSpeciesInfo(species) {
  const base = String(species || "").replace(/^Alpha/i, "");
  const display = spawnDisplayName(species).replace(/^头目\s*/, "");
  return (speciesData || []).find((item) => {
    const names = [item.species, item.label_en, item.species_zh, item.label]
      .filter(Boolean)
      .map((value) => String(value).toLocaleLowerCase());
    return names.includes(base.toLocaleLowerCase()) || names.includes(display.toLocaleLowerCase());
  });
}

function applySpawnOptionMetadata(option) {
  const species = option.value;
  if (!species) return;
  const base = String(species || "").replace(/^Alpha/i, "");
  const display = spawnDisplayName(species).replace(/^头目\s*/, "");
  const info = spawnSpeciesInfo(species);
  option.dataset.species = base;
  option.dataset.speciesZh = display;
  option.dataset.sprite = info?.sprite || "";
  if (info?.species_zh) {
    option.textContent = `${/^Alpha/i.test(species) ? "头目 " : ""}${info.species_zh}`;
  }
  option.dataset.search = [species, base, display, info?.species, info?.species_zh, info?.label_en]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

function refreshSpawnSpeciesMetadata() {
  const select = $("spawn-species");
  if (!select || !speciesData.length) return;
  [...select.options].forEach(applySpawnOptionMetadata);
  if (typeof refreshSearchableSelect === "function") refreshSearchableSelect(select);
}

let multiCatalog = null;
let multiPoints = {};
const MULTI_GROUP_ZH = {
  25: "大牙狸",
  33: "小猫怪",
  35: "泳圈鼬",
  49: "大牙狸/伊布",
  50: "拉鲁拉丝/含羞苞/毒蔷薇",
  56: "熊宝宝/圈圈熊",
  85: "小拳石",
  91: "不良蛙",
  117: "沙河马/河马兽",
  129: "皮卡丘/皮丘/圆法师",
  161: "黑暗鸦（仅夜晚）",
  182: "派拉斯/派拉斯特",
  183: "卷卷耳/可达鸭",
  203: "毛头小鹰",
  234: "狩猎凤蝶/绅士蛾",
  245: "小山猪/长毛猪",
  246: "姆克儿/姆克鸟",
  247: "长尾怪手",
  253: "无壳海兔/海兔兽",
  267: "玛瑙水母/毒刺水母",
  273: "凯西/勇基拉",
  278: "伦琴猫",
  279: "姆克鹰",
  284: "鲤鱼王/暴鲤龙",
  344: "野蛮鲈鱼",
  356: "魅力喵/东施喵",
  362: "千针鱼",
  367: "百合根娃娃",
  382: "音箱蟀",
  390: "三蜜蜂",
  "362-3": "千针鱼（3-3）",
  "267-3": "玛瑙水母（3-3）",
};
const MULTI_GROUP_DEX = {
  25: 399, 33: 403, 35: 418, 49: 399, 85: 74, 129: 25, 183: 427,
  234: 267, 246: 396, 247: 190, 253: 422, 273: 63, 278: 405,
  279: 398, 284: 129,
};
const MULTI_GROUP_SPECIES = {
  25: [399], 33: [403], 35: [418], 49: [399, 133], 85: [74],
  129: [25, 172, 401], 183: [427, 54], 234: [267, 414],
  246: [396, 397], 247: [190], 253: [422, 423], 273: [63, 64],
  278: [405], 279: [398], 284: [129, 130],
  50: [280, 406, 315], 91: [453], 117: [449, 450], 161: [198],
  182: [46, 47], 203: [627], 245: [220, 221], 267: [72, 73],
  344: [550], 356: [431, 432], 362: [211], 367: [548],
  382: [402], 390: [415], 56: [216, 217],
  "362-3": [211], "267-3": [72, 73],
};

function multiGroupLabel(group) {
  return MULTI_GROUP_ZH[group.id] || MULTI_GROUP_ZH[Number(group.id)] || group.name || "";
}

function applyMultiGroupDefaults() {
  const group = (multiCatalog?.groups || []).find(
    (item) => String(item.id) === $("multi-group")?.value
  );
  const night = $("multi-night");
  const note = $("multi-note");
  if (!group) return;
  if (night) {
    night.disabled = !group.has_night || Boolean(group.night_only);
    night.checked = Boolean(group.night_only);
  }
  const maxalive = $("multi-maxalive");
  if (maxalive && group.maxalive) {
    maxalive.value = String(group.maxalive);
    const three = [...maxalive.options].find((option) => option.value === "3");
    if (three) three.disabled = Number(group.maxalive) !== 3;
  }
  if (note) {
    const nightText = group.night_only
      ? " · 仅夜晚"
      : group.has_night
        ? " · 有夜晚表"
        : "";
    note.textContent = `${group.map_label} · ${multiGroupLabel(group)}${nightText} · ${group.maxalive === 3 ? "3-3 点位固定 3 只" : "默认 2 只"}`;
  }
}

// 当前多只地图选中的大区 key（与定点头目共用 spawnMapCatalog 的 key/image）
let multiMapKey = "ObsidianFieldlands";
let multiOpenPoint = null;

const MULTI_SPECIES_ZH = {
  25: "皮卡丘", 46: "派拉斯", 47: "派拉斯特", 54: "可达鸭", 63: "凯西",
  64: "勇基拉", 72: "玛瑙水母", 73: "毒刺水母", 74: "小拳石", 129: "鲤鱼王",
  130: "暴鲤龙", 133: "伊布", 161: "黑暗鸦", 172: "皮丘", 190: "长尾怪手",
  198: "黑暗鸦", 211: "千针鱼", 216: "熊宝宝", 217: "圈圈熊", 220: "小山猪",
  221: "长毛猪", 267: "狩猎凤蝶", 280: "拉鲁拉丝", 315: "毒蔷薇", 396: "姆克儿",
  397: "姆克鸟", 398: "姆克鹰", 399: "大牙狸", 401: "圆法师", 402: "音箱蟀",
  403: "小猫怪", 405: "伦琴猫", 406: "含羞苞", 414: "绅士蛾", 415: "三蜜蜂",
  418: "泳圈鼬", 422: "无壳海兔", 423: "海兔兽", 427: "卷卷耳", 431: "魅力喵",
  432: "东施喵", 449: "沙河马", 450: "河马兽", 453: "不良蛙", 548: "百合根娃娃",
  550: "野蛮鲈鱼", 627: "毛头小鹰",
};

// 图鉴号 → 中文名：多只表使用全国图鉴号，不能按洗翠图鉴号查研究目录
function dexDisplayName(dex) {
  const national = MULTI_SPECIES_ZH[Number(dex)];
  if (national) return national;
  const entry = (researchCatalog || []).find((item) => Number(item.dex_number) === Number(dex));
  return entry?.label || entry?.species || String(dex);
}

function fillMultiMapSelect() {
  const select = $("multi-map-select");
  if (!select || !spawnMapCatalog) return;
  const previous = select.value || multiMapKey;
  select.innerHTML = "";
  (spawnMapCatalog.maps || []).forEach((entry) => {
    // 只列出已标注过多只点位的大区，避免切换到空白地图。
    const hasPoints = Object.values(multiPoints || {}).some((groupEntry) => {
      const meta = (multiCatalog?.groups || []).find(
        (item) => String(item.id) === String(groupEntry.ui_id || groupEntry.group_id)
      );
      return meta?.map === entry.key && (groupEntry.points || []).length > 0;
    });
    if (!hasPoints) return;
    const option = document.createElement("option");
    option.value = entry.key;
    option.textContent = entry.label;
    select.appendChild(option);
  });
  if ([...select.options].some((o) => o.value === previous)) select.value = previous;
  else if (select.options.length) {
    select.value = select.options[0].value;
    multiMapKey = select.value;
  }
}

function currentMultiMapEntry() {
  return (spawnMapCatalog?.maps || []).find((entry) => entry.key === multiMapKey) || null;
}

function renderMultiMap() {
  const box = $("multi-map-markers");
  const image = $("multi-map-image");
  const count = $("multi-map-count");
  const note = $("multi-map-note");
  const empty = $("multi-map-empty");
  if (!box) return;
  fillMultiMapSelect();
  const entry = currentMultiMapEntry();
  if (image) {
    const src = entry?.image || "";
    if (src && image.getAttribute("src") !== src) image.src = src;
    image.alt = `多只生成点地图：${entry?.label || ""}`;
  }
  hideMultiMapConfirm();
  box.innerHTML = "";
  const selected = String($("multi-group")?.value || "");
  let total = 0;
  Object.values(multiPoints || {}).forEach((groupEntry) => {
    const uiId = groupEntry.ui_id || groupEntry.group_id;
    const meta = (multiCatalog?.groups || []).find(
      (item) => String(item.id) === String(uiId)
    );
    if (!meta || meta.map !== multiMapKey) return; // 只显示当前大区
    const groupId = meta.id;
    const dexKey = String(groupId);
    const dex = MULTI_GROUP_DEX[dexKey] || 0;
    const species = MULTI_GROUP_SPECIES[dexKey] || (dex ? [dex] : []);
    const label = multiGroupLabel(meta);
    (groupEntry.points || []).forEach((point, index) => {
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = "spawn-map-marker";
      if (Number(point.y) < 0.12) marker.classList.add("flip-y");
      if (Number(point.x) < 0.04) marker.classList.add("flip-x-left");
      if (Number(point.x) > 0.96) marker.classList.add("flip-x-right");
      if (String(groupId) === selected) marker.classList.add("is-selected");
      marker.style.left = `${Math.max(0, Math.min(1, Number(point.x) || 0)) * 100}%`;
      marker.style.top = `${Math.max(0, Math.min(1, Number(point.y) || 0)) * 100}%`;
      const timeText = meta.night_only ? "仅夜晚" : meta.has_night ? "白天/夜晚" : "白天";
      marker.title = `${label} · ${timeText} · 生成 ${meta.maxalive || groupEntry.maxalive || 2} 只 · 点 ${index + 1}`;
      marker.setAttribute("aria-label", marker.title);
      const fallback = document.createElement("span");
      fallback.className = "spawn-map-marker-fallback";
      fallback.textContent = label || "?";
      const showFallback = () => {
        fallback.classList.remove("hidden");
        marker.classList.add("has-text");
      };
      const hideFallback = () => {
        fallback.classList.add("hidden");
        marker.classList.remove("has-text");
      };
      const art = document.createElement("img");
      art.alt = "";
      const primary = species[0] || dex;
      setSpriteImage(
        art,
        primary ? `c_${primary}.png` : "",
        showFallback,
        hideFallback
      );
      fallback.classList.toggle("hidden", Boolean(primary));
      const gender = document.createElement("span");
      gender.className = "spawn-map-marker-gender";
      gender.textContent = meta.night_only ? "🌙" : meta.has_night ? "☀🌙" : "☀";
      marker.append(fallback, art, gender);
      const extraSpecies = species.slice(1);
      if (extraSpecies.length) {
        const extraWrap = document.createElement("span");
        extraWrap.className = "multi-map-extra";
        extraSpecies.forEach((extraDex) => {
          const extraArt = document.createElement("img");
          extraArt.alt = "";
          setSpriteImage(extraArt, `c_${extraDex}.png`, () => extraArt.classList.add("hidden"));
          extraWrap.appendChild(extraArt);
        });
        marker.appendChild(extraWrap);
      }
      const badge = document.createElement("span");
      badge.className = "multi-map-count-badge";
      badge.textContent = String(meta.maxalive || groupEntry.maxalive || 2);
      marker.appendChild(badge);
      const pointData = { groupId, meta, species, label, point, index };
      marker.addEventListener("click", () => showMultiMapConfirm(pointData, marker));
      box.appendChild(marker);
      total += 1;
    });
  });
  if (count) count.textContent = `${total} 处`;
  if (empty) empty.classList.toggle("hidden", total > 0);
  if (note) {
    const regionEntries = Object.values(multiPoints || {}).filter((groupEntry) => {
      const meta = (multiCatalog?.groups || []).find(
        (item) => String(item.id) === String(groupEntry.ui_id || groupEntry.group_id)
      );
      return meta?.map === multiMapKey;
    }).length;
    note.textContent = total
      ? `${entry?.label || ""} · ${regionEntries} 个页面 · ${total} 个位置；点击头像查看并选择宝可梦。`
      : `${entry?.label || ""} · 暂无已标注点位。`;
  }
}

// 点击头像只做“待确认”，确认后才切换生成点，不自动计算。
function showMultiMapConfirm(pointData, marker) {
  const panel = $("multi-map-confirm");
  const title = $("multi-map-confirm-title");
  const metaLine = $("multi-map-confirm-meta");
  if (!panel) return;
  multiOpenPoint = pointData;
  const { meta, label, point, index } = pointData;
  const timeText = meta.night_only ? "仅夜晚" : meta.has_night ? "白天 / 夜晚" : "白天";
  if (title) title.textContent = `选择 ${label}`;
  if (metaLine) {
    metaLine.textContent = `点 ${index + 1} · ${timeText} · 同时生成 ${meta.maxalive || 2} 只 · 位置 ${(Number(point.x) * 100).toFixed(1)}%, ${(Number(point.y) * 100).toFixed(1)}%`;
  }
  const px = Math.max(0, Math.min(1, Number(point.x) || 0));
  const py = Math.max(0, Math.min(1, Number(point.y) || 0));
  panel.style.left = `${px * 100}%`;
  panel.style.top = `${py * 100}%`;
  panel.classList.toggle("flip-x", px > 0.62);
  panel.classList.toggle("flip-y", py > 0.6);
  panel.classList.remove("hidden");
  if (marker) marker.classList.add("is-selected");
}

function hideMultiMapConfirm() {
  const panel = $("multi-map-confirm");
  if (!panel) return;
  panel.classList.add("hidden");
  panel.classList.remove("flip-x", "flip-y");
  multiOpenPoint = null;
}

function renderMultiEmptyState(message) {
  const box = $("multi-results");
  if (!box) return;
  box.innerHTML = "";
  const frame = document.createElement("div");
  frame.className = "multi-empty-frame";
  const icon = document.createElement("div");
  icon.className = "empty-icon";
  icon.textContent = "✦";
  const title = document.createElement("h3");
  title.textContent = message || "点击地图头像选择生成点";
  const copy = document.createElement("p");
  copy.textContent = "确认生成点后，点击下方「计算多只路径」。结果会显示在这里。";
  frame.append(icon, title, copy);
  box.appendChild(frame);
}

function confirmMultiMapSelection() {
  if (!multiOpenPoint) return;
  const { groupId, meta, label } = multiOpenPoint;
  const select = $("multi-group");
  if (select) {
    select.value = String(groupId);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const night = $("multi-night");
  if (night && !night.disabled && meta.night_only) night.checked = true;
  hideMultiMapConfirm();
  const status = $("multi-status");
  if (status) status.textContent = `已选择 ${label}，请点击「计算多只路径」。`;
  renderMultiEmptyState(`已选择 ${label}`);
}

async function loadMultiCatalog() {
  const select = $("multi-group");
  if (!select) return;
  try {
    multiCatalog = await api("/api/multi/catalog", { timeoutMs: 20000 });
    multiPoints = multiCatalog.points || {};
  } catch (error) {
    select.innerHTML = `<option value="">读取多只生成点失败：${error.message}</option>`;
    return;
  }
  select.innerHTML = "";
  const byMap = new Map();
  (multiCatalog.groups || []).forEach((group) => {
    if (!byMap.has(group.map_label)) byMap.set(group.map_label, []);
    byMap.get(group.map_label).push(group);
  });
  byMap.forEach((groups, mapLabel) => {
    const optgroup = document.createElement("optgroup");
    optgroup.label = mapLabel;
    groups.forEach((group) => {
      const option = document.createElement("option");
      option.value = String(group.id);
      option.textContent = multiGroupLabel(group);
      option.dataset.groupId = String(group.id);
      optgroup.appendChild(option);
    });
    select.appendChild(optgroup);
  });
  if (select.options.length) select.value = select.options[0].value;
  applyMultiGroupDefaults();
  renderMultiMap();
}

function multiResultSprite(item) {
  const localized = typeof localizePokemonName === "function"
    ? localizePokemonName(item.species)
    : item.species;
  const reverse = Object.entries(MULTI_SPECIES_ZH).find(([, name]) => name === localized);
  let dex = reverse ? Number(reverse[0]) : 0;
  if (!dex) {
    const groupSpecies = MULTI_GROUP_SPECIES[String(item.group_id)] || [];
    dex = groupSpecies[0] || 0;
  }
  return dex ? `c_${dex}.png` : "";
}

function multiResultCard(item, index) {
  // 与大大量结果复用同一套 .result-card-editorial 视觉语言：
  // 头像 / 状态标签 / 信息表 / 路径概要。多只接口的 path 是 D 步序号数组，
  // 映射成 renderRouteSummary 可解析的结构，不新增平行样式体系。
  const card = document.createElement("article");
  card.className = "result-card result-card-editorial";

  const species = String(item.species || "");
  const speciesName = typeof localizePokemonName === "function" ? localizePokemonName(species) : species;
  const isShiny = Boolean(item.shiny);
  const isSquare = Boolean(item.square);
  const isAlpha = Boolean(item.alpha);
  const ivs = item.ivs || [];
  const ivTier = getIVTier(ivs);
  const displayName = speciesName ? `${isAlpha ? "头目" : ""}${speciesName}` : `结果 ${index + 1}`;

  const hero = appendTextElement(card, "div", "result-hero");
  addPokemonArtwork(hero, { ...item, species }, displayName);
  const heroCopy = appendTextElement(hero, "div", "result-hero-copy");
  const titleRow = appendTextElement(heroCopy, "div", "result-title-row");
  appendTextElement(titleRow, "h3", "result-title", `${displayName} #${index + 1}`);

  const statusLine = appendTextElement(heroCopy, "div", "result-status-line");
  if (isSquare) {
    appendTextElement(statusLine, "span", "result-status-tag status-square", "✦ 方块闪");
  } else {
    appendTextElement(statusLine, "span", `result-status-tag ${isShiny ? "status-shiny" : "status-not-shiny"}`, isShiny ? "✦ 闪光" : "未闪光");
  }
  appendTextElement(statusLine, "span", `result-status-tag ${isAlpha ? "status-alpha" : "status-normal"}`, isAlpha ? "头目（Alpha）" : "普通个体");
  if (ivTier) {
    appendTextElement(statusLine, "span", `result-status-tag status-iv ${ivTier === "6V" ? "status-6v" : ivTier === "5V" ? "status-5v" : "status-4v"}`, ivTier);
  }
  appendTextElement(heroCopy, "p", "result-subtitle", item.map_label ? `出现区域 · ${item.map_label}` : "已计算出闪光目标路线");

  const copy = document.createElement("button");
  copy.className = "text-button copy-path";
  copy.type = "button";
  copy.textContent = "复制路径";
  copy.addEventListener("click", () => copyText(item.path_label || ""));
  titleRow.appendChild(copy);

  const infoHeading = appendTextElement(card, "div", "result-section-heading result-info-heading");
  appendTextElement(infoHeading, "h4", "result-section-title", "宝可梦信息");
  const extra = appendTextElement(card, "div", "result-meta-strip");
  const metaField = (label, value) => {
    const field = appendTextElement(extra, "div", "result-meta-field");
    appendTextElement(field, "span", "result-meta-label", label);
    appendTextElement(field, "strong", "result-meta-value", value == null ? "—" : String(value));
  };
  metaField("性格", typeof PLAResultView?.localizeNature === "function" ? PLAResultView.localizeNature(item.nature) : (item.nature || "—"));
  metaField("性别", typeof PLAResultView?.localizeGender === "function" ? PLAResultView.localizeGender(item.gender) : (item.gender || "—"));
  metaField("闪光判定", item.rolls ? `${item.rolls} 次` : "—");
  const ivField = appendTextElement(extra, "div", "result-meta-field result-iv-field");
  appendTextElement(ivField, "span", "result-meta-label", "个体值");
  renderIVValues(ivField, ivs);

  const pathHeading = appendTextElement(card, "div", "result-section-heading result-path-heading");
  appendTextElement(pathHeading, "h4", "result-section-title", "路径概要");
  const summaryWrap = appendTextElement(card, "div", "result-route-overview");
  const pathSteps = Array.isArray(item.path) ? item.path.map(Number).filter(Number.isFinite) : [];
  renderRouteSummary(summaryWrap, {
    path: {
      hasBonus: false,
      isInitialSpawn: pathSteps.length === 0,
      initialSpawn: 1,
      ordinary: pathSteps,
      raw: item.path_label || "",
    },
    chains: [], lines: [], dupes: [], hasMultiple: false, multiShinyCount: null,
  });

  // 详细步骤：把 D 步序号展开成带序号、单次清除数与累计数的可执行清单，
  // 解决 chips 网格横排时看不出执行先后的问题。默认收起，不占结果区高度。
  if (pathSteps.length) {
    const details = document.createElement("details");
    details.className = "multi-steps-details";
    const summary = document.createElement("summary");
    summary.textContent = "详细步骤";
    details.appendChild(summary);
    let cumulative = 0;
    const steps = pathSteps.map((count, idx) => {
      cumulative += count;
      return {
        number: idx + 1,
        pathStep: `D${count}`,
        count,
        cumulative,
        title: `清除 ${count} 只`,
      };
    });
    renderOperationStepList(details, steps);
    card.appendChild(details);
  }
  return card;
}

function renderMultiResults(data) {
  const box = $("multi-results");
  if (!box) return;
  box.innerHTML = "";
  const groupMeta = data.group
    ? `${data.group.map_label} · ${multiGroupLabel(data.group)} · ${data.maxalive} 只 · 深度 ${data.maxdepth}${data.is_night ? " · 夜晚" : ""}`
    : "";
  if (!(data.results || []).length) {
    // 无命中时只渲染一个铺满整列的框：组信息并入框内，
    // 不再单独放一条 header + 一个框（中间留出大片无容器空白）。
    const empty = document.createElement("div");
    empty.className = "multi-empty-frame";
    const icon = document.createElement("div");
    icon.className = "empty-icon";
    icon.textContent = "✦";
    const title = document.createElement("h3");
    title.textContent = "没有命中路径";
    const copy = document.createElement("p");
    copy.textContent = `${groupMeta ? `${groupMeta} · ` : ""}共 ${data.total_results ?? 0} 条路径，均未命中。可放宽筛选或降低最大刷新次数后重算。`;
    empty.append(icon, title, copy);
    box.appendChild(empty);
    return;
  }
  if (data.group) {
    const head = document.createElement("div");
    head.className = "multi-results-head";
    const title = document.createElement("strong");
    title.textContent = `${data.group.map_label} · ${multiGroupLabel(data.group)}`;
    const meta = document.createElement("span");
    meta.textContent = `${data.maxalive} 只 · 深度 ${data.maxdepth}${data.is_night ? " · 夜晚" : ""} · 命中 ${data.total_matches} 条`;
    head.append(title, meta);
    box.appendChild(head);
  }
  (data.results || []).forEach((item, index) => box.appendChild(multiResultCard(item, index)));
}

async function submitMulti() {
  const button = $("calculate-button");
  const status = $("multi-status");
  const groupId = $("multi-group")?.value;
  if (!groupId) {
    if (status) status.textContent = "请先选择多只生成点。";
    return;
  }
  button.disabled = true;
  if (status) status.textContent = "正在计算多只路径…";
  try {
    const data = await api("/api/multi/check", {
      method: "POST",
      body: JSON.stringify({
        seed: ($("quick-seed").value || "").trim(),
        group_id: groupId,
        maxalive: Number($("multi-maxalive").value || 2),
        maxdepth: Number($("multi-depth").value || 9),
        is_night: $("multi-night").checked,
        filter: $("multi-filter").value,
      }),
      timeoutMs: 180000,
    });
    renderMultiResults(data);
    if (status) {
      status.textContent = data.total_matches
        ? `找到 ${data.total_matches} 条命中路径，显示 ${data.returned} 条${data.truncated ? "（已截断）" : ""}`
        : `没有命中路径（总路径 ${data.total_results} 条）`;
    }
    const note = $("multi-note");
    if (note) {
      note.textContent = `${data.group.map_label} · ${multiGroupLabel(data.group)} · ${data.maxalive} 只 · 深度 ${data.maxdepth}${data.is_night ? " · 夜晚" : ""}`;
    }
  } catch (error) {
    renderMultiResults({ results: [] });
    if (status) status.textContent = `计算失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function loadSpawnCatalog() {
  if (!$("spawn-map")) return;
  if (typeof setupSearchableSelect === "function") {
    setupSearchableSelect($("spawn-species"));
    const input = document.getElementById("spawn-species-search-input");
    if (input) {
      input.setAttribute("aria-label", "搜索并选择定点头目宝可梦");
      input.placeholder = "输入中文或英文搜索宝可梦…";
    }
  }
  try {
    spawnCatalog = await api("/api/spawns/catalog", { timeoutMs: 20000 });
  } catch (error) {
    $("spawn-status").textContent = `读取生成点数据失败：${error.message}`;
    return;
  }
  const mapSelect = $("spawn-map");
  mapSelect.innerHTML = "";
  (spawnCatalog.maps || []).forEach((entry) => {
    const option = document.createElement("option");
    option.value = entry.key;
    option.textContent = entry.label;
    mapSelect.appendChild(option);
  });
  const ratioSelect = $("spawn-gender-ratio");
  ratioSelect.innerHTML = "";
  (spawnCatalog.gender_ratios || []).forEach((entry) => {
    const option = document.createElement("option");
    option.value = entry.key;
    option.textContent = entry.label;
    ratioSelect.appendChild(option);
  });
  fillSpawnSpecies();
}

function fillSpawnSpecies() {
  if (!spawnCatalog || !$("spawn-map")) return;
  const entry = (spawnCatalog.maps || []).find((item) => item.key === $("spawn-map").value);
  const select = $("spawn-species");
  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "选择宝可梦（也可直接点地图）";
  select.appendChild(placeholder);
  (entry ? entry.species : []).forEach((species) => {
    const option = document.createElement("option");
    option.value = species;
    option.textContent = spawnDisplayName(species);
    applySpawnOptionMetadata(option);
    select.appendChild(option);
  });
  if (typeof refreshSearchableSelect === "function") refreshSearchableSelect(select);
  fillSpawnSpawners();
}

async function fillSpawnSpawners() {
  const select = $("spawn-spawner");
  if (!select) return;
  select.innerHTML = "";
  const map = $("spawn-map").value;
  const species = $("spawn-species").value;
  if (!map || !species) {
    updateSpawnerLocationNote();
    return;
  }
  try {
    const data = await api(
      `/api/spawns/spawners?map=${encodeURIComponent(map)}&species=${encodeURIComponent(species)}`,
      { timeoutMs: 15000 }
    );
    (data.spawners || []).forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    });
  } catch (error) {
    showToast(`读取生成点失败：${error.message}`);
  }
  updateSpawnerLocationNote();
  updateSpawnRollSummary();
  renderSpawnMap();
}

function updateSpawnerLocationNote() {
  const note = $("spawner-location-note");
  const id = $("spawn-spawner")?.value || "";
  if (!note) return;
  if (!id) {
    note.textContent = "";
    note.classList.add("hidden");
    return;
  }
  const parts = id.split("_");
  const kind = { lnd: "陆地", swm: "水面", sky: "空中" }[parts[0]] || "特殊";
  const rare = parts.includes("ra") ? "稀有" : "";
  const number = parts[parts.length - 1];
  note.textContent = `${id} · ${kind}${rare}生成点，编号 ${number}。资源数据只有内部 ID，没有坐标、方向或附近地标；请按地图区域寻找。`;
  note.classList.remove("hidden");
}

const SPAWN_GENDER_CODES = {
  31: "1:7",
  63: "1:3",
  127: "1:1",
  191: "3:1",
  0: "male",
  254: "female",
  255: "genderless",
};

function spawnGenderShort(code) {
  return {
    31: "♀1:7",
    63: "♀1:3",
    127: "♀1:1",
    191: "♀3:1",
    0: "仅♂",
    254: "仅♀",
    255: "无性别",
  }[Number(code)] || "";
}

function spawnGenderLong(code) {
  return {
    31: "♀ 12.5% / ♂ 87.5%",
    63: "♀ 25% / ♂ 75%",
    127: "♀ 50% / ♂ 50%",
    191: "♀ 75% / ♂ 25%",
    0: "仅 ♂（固定性别）",
    254: "仅 ♀（固定性别）",
    255: "无性别",
  }[Number(code)] || "性别比例未知";
}

function spawnPointBase(point) {
  return String(point?.species || "").replace(/^Alpha\s*/i, "").trim();
}

function spawnPointTitle(point) {
  const base = spawnPointBase(point);
  const zh = typeof localizePokemonName === "function" ? localizePokemonName(base) : base;
  return `头目 ${zh}`;
}

function spawnPointSprite(point) {
  const info = spawnSpeciesInfo(spawnPointBase(point));
  return info?.sprite || "";
}

function currentSpawnMapEntry() {
  const key = $("spawn-map")?.value || "ObsidianFieldlands";
  return (spawnMapCatalog?.maps || []).find((entry) => entry.key === key) || null;
}

function selectedSpawnType() {
  return $("appearance")?.value === "spawn_alpha";
}

let spawnInputMode = "auto";
let spawnSelectedArea = "";

function selectedSpawnGenderText() {
  const select = $("spawn-gender-ratio");
  const option = select?.selectedOptions?.[0];
  let value = option?.textContent || "";
  if ($("spawn-fixed-gender")?.checked) {
    const fixed = {
      "1:7": "固定性别", "1:3": "固定性别", "1:1": "固定性别", "3:1": "固定性别",
      male: "固定 ♂", female: "固定 ♀", genderless: "无性别",
    }[select?.value];
    if (fixed) value = fixed;
  }
  return value;
}

function invalidateAlphaResults(message = "选择已更新，请重新计算。") {
  if (!selectedSpawnType()) return;
  const results = $("spawn-results");
  const status = $("spawn-status");
  if (results) results.innerHTML = "";
  if (status) status.textContent = message;
  $("species-warning")?.classList.add("hidden");
}

function updateSpawnAutoSummary() {
  const species = $("spawn-species");
  const option = species?.selectedOptions?.[0];
  const name = option?.value ? option.textContent : "";
  const strong = $("spawn-auto-species");
  const meta = $("spawn-auto-meta");
  if (!strong || !meta) return;

  // 头像：优先用地图上已确认点的 sprite，其次回退到下拉项自带的 sprite。
  const card = $("spawn-auto-summary");
  const sprite = $("spawn-auto-sprite");
  const artFallback = $("spawn-auto-art-fallback");
  const confirmedPoint = confirmedSpawnPointId != null
    ? (spawnMapCatalog?.maps || []).flatMap((entry) => entry.points || [])
        .find((point) => point.id === confirmedSpawnPointId)
    : null;
  const spriteFile = (confirmedPoint && spawnPointSprite(confirmedPoint)) || option?.dataset?.sprite || "";
  const hasPick = Boolean(name);
  card?.classList.toggle("is-picked", hasPick);
  if (sprite && hasPick) {
    setSpriteImage(
      sprite,
      spriteFile,
      () => { sprite.classList.add("hidden"); artFallback?.classList.remove("hidden"); },
      () => { artFallback?.classList.add("hidden"); }
    );
  } else {
    sprite?.classList.add("hidden");
    artFallback?.classList.toggle("hidden", !hasPick);
  }

  if (!name) {
    strong.textContent = "点击地图头像选择宝可梦";
    meta.textContent = "选择位置后自动填入地图、spawner、性别比例和白天/夜晚。";
    return;
  }
  const mapLabel = currentSpawnMapEntry()?.label || "";
  const spawner = $("spawn-spawner")?.value || "";
  const gender = selectedSpawnGenderText();
  const night = $("spawn-night")?.checked ? "夜晚" : "";
  const parts = [spawner, mapLabel, gender, night, localizeAreaName(spawnSelectedArea)].filter(Boolean);
  strong.textContent = name;
  meta.textContent = parts.join(" · ") || "已选择位置";
}

function applySpawnInputMode() {
  const alphaMode = selectedSpawnType();
  const modeRow = $("spawn-input-mode");
  const summary = $("spawn-auto-summary");
  const fields = $("spawn-fields");
  const auto = alphaMode && spawnInputMode === "auto";
  if (modeRow) modeRow.classList.toggle("hidden", !alphaMode);
  if (summary) summary.classList.toggle("hidden", !auto);
  if (fields) {
    fields.classList.toggle("hidden", !alphaMode);
    fields.classList.toggle("is-auto", auto);
  }
  $("spawn-mode-auto")?.classList.toggle("active", spawnInputMode === "auto");
  $("spawn-mode-manual")?.classList.toggle("active", spawnInputMode === "manual");
  $("spawn-mode-auto")?.setAttribute("aria-pressed", String(spawnInputMode === "auto"));
  $("spawn-mode-manual")?.setAttribute("aria-pressed", String(spawnInputMode === "manual"));
  if (alphaMode) updateSpawnAutoSummary();
}

function setSpawnInputMode(mode) {
  spawnInputMode = mode === "manual" ? "manual" : "auto";
  applySpawnInputMode();
}

function fillSpawnMapTimeOptions(point) {
  const field = $("spawn-map-time-field");
  const select = $("spawn-map-time");
  if (!field || !select) return;
  select.innerHTML = "";
  const times = Array.isArray(point?.times) ? point.times : ["any"];
  const values = times.includes("day") || times.includes("night")
    ? times.filter((value) => value === "day" || value === "night")
    : [];
  field.classList.toggle("hidden", values.length < 2);
  if (!values.length) {
    select.value = "day";
    return;
  }
  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value === "night" ? "夜晚" : "白天";
    select.appendChild(option);
  });
  select.value = values.includes("night") ? "night" : values[0];
}

function showSpawnMapConfirm(point) {
  const panel = $("spawn-map-confirm");
  const title = $("spawn-map-confirm-title");
  const meta = $("spawn-map-confirm-meta");
  const candidateField = $("spawn-map-candidate-field");
  const candidate = $("spawn-map-candidate");
  const button = $("spawn-map-confirm-button");
  if (!panel || !title || !meta || !candidateField || !candidate || !button) return;

  spawnMapPoint = point;
  title.textContent = spawnPointTitle(point);
  const gender = spawnGenderLong(point.gender_ratio);
  const times = Array.isArray(point.times) ? point.times : ["any"];
  const timeText = times.includes("day") && times.includes("night")
    ? "白天 / 夜晚"
    : times.includes("night") ? "夜晚" : times.includes("day") ? "白天" : "任意时间";
  meta.textContent = `${gender} · ${timeText}${point.area ? ` · ${localizeAreaName(point.area)}` : ""}`;
  if (!Array.isArray(point.spawners) || !point.spawners.length) {
    meta.textContent += " · 该点位暂未收录 spawner，不能回填";
  }

  candidate.innerHTML = "";
  const spawners = Array.isArray(point.spawners) ? point.spawners : [];
  spawners.forEach((spawner) => {
    const option = document.createElement("option");
    option.value = spawner;
    option.textContent = spawner;
    candidate.appendChild(option);
  });
  candidateField.classList.toggle("hidden", spawners.length < 2);
  button.disabled = spawners.length === 0;
  button.textContent = spawners.length === 0 ? "未收录 spawner" : "确认这个位置";
  fillSpawnMapTimeOptions(point);

  // 把浮层锚定到选中的头像旁：坐标与 marker 同为 inner 内百分比。
  // 靠近右/下边缘时翻转方位，避免浮层被地图边界裁切。
  const px = Math.max(0, Math.min(1, Number(point.x) || 0));
  const py = Math.max(0, Math.min(1, Number(point.y) || 0));
  panel.style.left = `${px * 100}%`;
  panel.style.top = `${py * 100}%`;
  panel.classList.toggle("flip-x", px > 0.62);
  panel.classList.toggle("flip-y", py > 0.6);
  panel.classList.remove("hidden");
  renderSpawnMap();
}

function resetSpawnMapConfirm() {
  // 浮层只在选中头像时出现；未选中时隐藏浮层并重置状态。
  spawnMapPoint = null;
  const panel = $("spawn-map-confirm");
  const title = $("spawn-map-confirm-title");
  const meta = $("spawn-map-confirm-meta");
  const button = $("spawn-map-confirm-button");
  panel?.classList.add("hidden");
  panel?.classList.remove("flip-x", "flip-y");
  if (title) title.textContent = "选择一个位置";
  if (meta) meta.textContent = "";
  if (button) {
    button.disabled = false;
    button.textContent = "确认这个位置";
  }
  $("spawn-map-candidate-field")?.classList.add("hidden");
  $("spawn-map-time-field")?.classList.add("hidden");
}

function hideSpawnMapConfirm() {
  resetSpawnMapConfirm();
  renderSpawnMap();
}

async function confirmSpawnMapPoint() {
  const point = spawnMapPoint;
  if (!point) return;
  const spawners = Array.isArray(point.spawners) ? point.spawners : [];
  const spawner = $("spawn-map-candidate")?.value || spawners[0] || "";
  if (!spawner) return;
  const base = spawnPointBase(point);
  const speciesSelect = $("spawn-species");
  if (!speciesSelect) return;

  const alphaOption = [...speciesSelect.options].find(
    (option) => option.value.toLowerCase() === `alpha${base}`.toLowerCase()
  );
  const baseOption = [...speciesSelect.options].find(
    (option) => option.value.toLowerCase() === base.toLowerCase()
  );
  const option = alphaOption || baseOption;
  if (!option) {
    showToast(`地图上这个位置是「${spawnPointTitle(point)}」，但当前地图列表没有该宝可梦。`);
    return;
  }
  speciesSelect.value = option.value;
  speciesSelect.dataset.userChosen = "1";
  refreshSearchableSelect(speciesSelect);
  await fillSpawnSpawners();
  const spawnerSelect = $("spawn-spawner");
  if (spawnerSelect) {
    let spawnerOption = [...spawnerSelect.options].find((item) => item.value === spawner);
    if (!spawnerOption) {
      spawnerOption = document.createElement("option");
      spawnerOption.value = spawner;
      spawnerOption.textContent = spawner;
      spawnerSelect.appendChild(spawnerOption);
    }
    spawnerSelect.value = spawner;
  }
  $("spawn-spawner").dataset.userChosen = "1";
  updateSpawnerLocationNote();
  updateSpawnAutoSummary();

  const timeField = $("spawn-map-time-field");
  const timeValue = timeField && !timeField.classList.contains("hidden")
    ? $("spawn-map-time").value
    : null;
  if (timeValue === "night") $("spawn-night").checked = true;
  else if (timeValue === "day") $("spawn-night").checked = false;
  else if ((point.times || []).includes("night") && !(point.times || []).includes("day")) {
    $("spawn-night").checked = true;
  } else if ((point.times || []).includes("day") && !(point.times || []).includes("night")) {
    $("spawn-night").checked = false;
  }

  const ratioKey = SPAWN_GENDER_CODES[Number(point.gender_ratio)];
  if (ratioKey) {
    const ratioSelect = $("spawn-gender-ratio");
    if ([...ratioSelect.options].some((item) => item.value === ratioKey)) {
      ratioSelect.value = ratioKey;
    }
  }
  $("spawn-fixed-gender").checked = [0, 254, 255].includes(Number(point.gender_ratio));

  if (spawners.length > 1) {
    try {
      const saved = await api("/api/spawns/bind", {
        method: "POST",
        body: JSON.stringify({ point_id: point.id, spawner }),
        timeoutMs: 12000,
      });
      if (saved?.ok) {
        point.spawners = [spawner];
        point.bound = true;
      }
    } catch (error) {
      console.warn("保存地图点 spawner 映射失败", error);
    }
  }

  // 记录已确认点：渲染时给它的头像加醒目框，且不再按 species 隐藏其它点。
  confirmedSpawnPointId = point.id ?? null;
  spawnSelectedArea = String(point.area || "");
  hideSpawnMapConfirm();
  updateSpawnRollSummary();
  updateSpawnAutoSummary();
  invalidateAlphaResults();
  showToast(`已选择 ${spawnPointTitle(point)} · ${spawner}`);
}

function renderSpawnMap() {
  const card = $("spawn-map-card");
  if (!card) return;
  const alphaMode = selectedSpawnType();
  card.classList.toggle("hidden", !alphaMode);
  if (!alphaMode) return;

  const entry = currentSpawnMapEntry();
  const image = $("spawn-map-image");
  const markers = $("spawn-map-markers");
  const empty = $("spawn-map-empty");
  const count = $("spawn-map-count");
  const note = $("spawn-map-note");
  if (!entry || !image || !markers || !empty || !count || !note) {
    if (note) note.textContent = "地图数据未安装。请重新生成 cache/spawn-maps。";
    return;
  }

  const speciesValue = String($("spawn-species")?.value || "").replace(/^Alpha\s*/i, "").trim();
  const allPoints = Array.isArray(entry.points) ? entry.points : [];
  // 定点头目模式始终显示整张地图的所有点：确认后仍可点其它头像改选。
  // 只用 species 过滤做空状态提示，不隐藏头像；有 confirmed 点时用醒目框圈住。
  const points = allPoints;
  const speciesHasPoints = !speciesValue
    || allPoints.some((point) => spawnPointBase(point).toLowerCase() === speciesValue.toLowerCase());

  $("spawn-map-title").textContent = "头目位置";
  if (image.getAttribute("src") !== entry.image) image.src = entry.image;
  image.alt = `固定头目位置地图：${entry.label || ""}`;

  markers.innerHTML = "";
  points.forEach((point) => {
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "spawn-map-marker";
    if (!point.spawners?.length) marker.classList.add("is-unavailable");
    if (spawnMapPoint?.id === point.id) marker.classList.add("is-selected");
    if (confirmedSpawnPointId != null && point.id === confirmedSpawnPointId) {
      marker.classList.add("is-confirmed");
      marker.setAttribute("aria-current", "true");
    }
    marker.style.left = `${Math.max(0, Math.min(1, Number(point.x) || 0)) * 100}%`;
    marker.style.top = `${Math.max(0, Math.min(1, Number(point.y) || 0)) * 100}%`;
    marker.title = `${spawnPointTitle(point)} · ${spawnGenderShort(point.gender_ratio)}${point.area ? ` · ${localizeAreaName(point.area)}` : ""}`;
    marker.setAttribute("aria-label", marker.title);
    const fallback = document.createElement("span");
    fallback.className = "spawn-map-marker-fallback";
    const pointName = typeof localizePokemonName === "function"
      ? localizePokemonName(spawnPointBase(point))
      : spawnPointBase(point);
    fallback.textContent = pointName || "?";
    const showFallback = () => {
      fallback.classList.remove("hidden");
      marker.classList.add("has-text");
    };
    const hideFallback = () => {
      fallback.classList.add("hidden");
      marker.classList.remove("has-text");
    };
    const art = document.createElement("img");
    art.alt = "";
    setSpriteImage(art, spawnPointSprite(point), showFallback, hideFallback);
    fallback.classList.toggle("hidden", Boolean(spawnPointSprite(point)));
    const gender = document.createElement("span");
    gender.className = "spawn-map-marker-gender";
    gender.textContent = spawnGenderShort(point.gender_ratio);
    marker.append(fallback, art, gender);
    if (point.alpha) {
      const alpha = document.createElement("img");
      alpha.className = "spawn-map-marker-alpha";
      alpha.src = "/static/alpha.png";
      alpha.alt = "头目";
      marker.appendChild(alpha);
    }
    const times = Array.isArray(point.times) ? point.times : ["any"];
    if (times.includes("day") || times.includes("night")) {
      const time = document.createElement("span");
      time.className = "spawn-map-marker-time";
      time.textContent = times.includes("day") && times.includes("night")
        ? "☀🌙"
        : times.includes("night") ? "🌙" : "☀";
      marker.appendChild(time);
    }
    if (confirmedSpawnPointId != null && point.id === confirmedSpawnPointId) {
      // 独立的呼吸光环元素：不与 v0.9.5 的尖尖尾巴 ::after 抢同一伪元素
      const ring = document.createElement("span");
      ring.className = "spawn-map-marker-ring";
      ring.setAttribute("aria-hidden", "true");
      marker.appendChild(ring);
      const label = document.createElement("span");
      label.className = "spawn-map-marker-label";
      label.textContent = spawnPointTitle(point);
      marker.appendChild(label);
    }
    marker.addEventListener("click", () => showSpawnMapConfirm(point));
    markers.appendChild(marker);
  });

  const total = allPoints.length;
  const shown = points.length;
  count.textContent = `${total} 处`;
  empty.classList.toggle("hidden", shown > 0);
  if (!shown) {
    empty.textContent = speciesValue
      ? "Serebii 的固定头目表里没有这只宝可梦。普通随机头目点不在地图中。"
      : "这张地图暂时没有固定头目点。";
  }
  if (confirmedSpawnPointId != null) {
    const confirmed = allPoints.find((point) => point.id === confirmedSpawnPointId);
    note.textContent = confirmed
      ? `已选择 ${spawnPointTitle(confirmed)}（地图上的绿色光环）。点其它头像可随时改选。`
      : "点其它头像可随时改选。";
  } else if (speciesValue) {
    const title = spawnPointTitle({ species: speciesValue });
    note.textContent = speciesHasPoints
      ? `${title} · 本图 ${total} 个固定头目点（全部可见，绿环标出当前选择）。`
      : `${title}：固定头目表中没有位置记录。`;
  } else {
    note.textContent = `本图共 ${total} 个固定头目点。点击任意头像可直接选择宝可梦和位置。`;
  }
  // 确认条常驻显示，显隐交给按钮 disabled 与文案表达，不再增删 .hidden。
  // 触发地图内层尺寸重算（正方形图片在长方形容器里居中）
  window.dispatchEvent(new Event("resize"));
}

async function loadSpawnMaps() {
  try {
    spawnMapCatalog = await api("/api/spawns/maps", { timeoutMs: 20000 });
  } catch (error) {
    spawnMapCatalog = { maps: [], source: "" };
    console.warn("读取固定头目地图失败", error);
  }
  renderSpawnMap();
  // 地图目录就绪后再画一次多只地图（图片路径来自 spawnMapCatalog）
  if (selectedSpawnType() || $("appearance")?.value === "spawn_multi") renderMultiMap();
}

function renderSpawnResults(data) {
  const box = $("spawn-results");
  box.innerHTML = "";
  (data.results || []).forEach((item) => {
    const card = document.createElement("article");
    card.className = "spawn-card";

    const title = document.createElement("h3");
    // 复用项目已有的宝可梦中文映射（普通结果卡同样用它），避免定点卡残留英文名。
    title.textContent = (typeof localizePokemonName === "function"
      ? localizePokemonName(item.species || data.species)
      : (item.species || spawnDisplayName(data.species)));
    card.appendChild(title);

    const advance = document.createElement("p");
    advance.className = "spawn-advance";
    advance.textContent = `第 ${item.advance} 次刷新出闪`;
    card.appendChild(advance);

    const details = document.createElement("dl");
    details.className = "spawn-details";
    const appendDetail = (label, value) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      details.append(dt, dd);
    };
    // 复用 result_view.js 已有的性格中文化（25 种性格），普通结果卡早已使用。
    const natureZh = typeof PLAResultView?.localizeNature === "function"
      ? PLAResultView.localizeNature(item.nature)
      : item.nature;
    appendDetail("性格", natureZh || "—");
    appendDetail("性别", item.gender || "—");
    appendDetail("闪光判定", item.rolls ? `${item.rolls} 次` : "—");
    card.appendChild(details);

    const ivBlock = document.createElement("div");
    ivBlock.className = "spawn-iv-block";
    const ivHeading = document.createElement("span");
    ivHeading.className = "spawn-iv-heading";
    ivHeading.textContent = "个体值（IV）";
    const ivGrid = document.createElement("div");
    ivGrid.className = "spawn-iv-grid";
    const ivs = Array.isArray(item.ivs) ? item.ivs : [];
    ["HP", "攻击", "防御", "特攻", "特防", "速度"].forEach((label, index) => {
      const cell = document.createElement("span");
      cell.className = "spawn-iv-cell";
      const name = document.createElement("small");
      name.textContent = label;
      const value = document.createElement("strong");
      value.textContent = ivs[index] ?? "—";
      cell.append(name, value);
      ivGrid.appendChild(cell);
    });
    ivBlock.append(ivHeading, ivGrid);
    card.appendChild(ivBlock);

    const tags = document.createElement("div");
    tags.className = "spawn-tags";
    const addTag = (text, kind = "") => {
      const tag = document.createElement("span");
      tag.className = `spawn-tag ${kind}`.trim();
      tag.textContent = text;
      tags.appendChild(tag);
    };
    if (item.alpha) addTag("头目", "is-alpha");
    if (item.shiny) addTag("闪光", "is-shiny");
    if (item.square) addTag("方块闪", "is-square");
    if (tags.childElementCount) card.appendChild(tags);

    box.appendChild(card);
  });
}

/* 结果按模式分组：切换模式时把当前列表连同标题/计数/摘要缓存起来，
   切到定点头目时清空右侧列表只留地图，切回其它模式时恢复该模式自己的结果。 */
function captureActiveResultGroup(groupKey) {
  if (!groupKey || groupKey === "spawn_alpha") return;
  const list = $("results-list");
  if (!list) return;
  const nodes = document.createDocumentFragment();
  while (list.firstChild) nodes.appendChild(list.firstChild);
  const summary = $("result-settings-summary");
  const message = $("calculation-message");
  resultGroupCache.set(groupKey, {
    nodes,
    count: $("result-count")?.textContent || "",
    caption: $("results-caption")?.textContent || "",
    summaryHTML: summary?.innerHTML || "",
    summaryHidden: summary?.classList.contains("hidden") ?? true,
    messageHTML: message?.innerHTML || "",
    messageHidden: message?.classList.contains("hidden") ?? true,
  });
}

function restoreResultGroup(groupKey) {
  const list = $("results-list");
  if (!list) return;
  list.replaceChildren();
  const summary = $("result-settings-summary");
  const message = $("calculation-message");
  const cached = resultGroupCache.get(groupKey);
  if (cached && cached.nodes.childNodes.length) {
    const hasEmpty = [...cached.nodes.children].some(node => node.classList?.contains("empty-state"));
    list.appendChild(cached.nodes);
    list.classList.toggle("is-empty-state", hasEmpty);
    if ($("result-count")) $("result-count").textContent = cached.count;
    if ($("results-caption")) $("results-caption").textContent = cached.caption;
    if (summary) {
      summary.innerHTML = cached.summaryHTML;
      summary.classList.toggle("hidden", cached.summaryHidden);
    }
    if (message) {
      message.innerHTML = cached.messageHTML;
      message.classList.toggle("hidden", cached.messageHidden);
    }
    return;
  }
  list.appendChild(createEmptyStateNode());
  list.classList.add("is-empty-state");
  if ($("result-count")) $("result-count").textContent = "0 条结果";
  if ($("results-caption")) $("results-caption").textContent = "根据 Seed 与群体条件，计算闪光目标的可执行路径。";
  if (summary) { summary.innerHTML = ""; summary.classList.add("hidden"); }
  if (message) { message.innerHTML = ""; message.classList.add("hidden"); }
}

function hideVisibleResultsForMap() {
  const list = $("results-list");
  if (list) list.replaceChildren();
  $("result-settings-summary")?.classList.add("hidden");
  $("calculation-message")?.classList.add("hidden");
}

function applyCalculateMode() {
  const select = $("appearance");
  if (!select) return;
  const mode = select.value;
  const alphaMode = mode === "spawn_alpha";
  const multiMode = mode === "spawn_multi";
  // Hidden MMO selects keep their required attribute and would silently block
  // native form validation in fixed-alpha / multi mode.
  const firstSpecies = $("frpokemon");
  const firstSpawns = $("frspawns");
  if (firstSpecies) firstSpecies.required = !alphaMode && !multiMode;
  if (firstSpawns) firstSpawns.required = !alphaMode && !multiMode;
  document.querySelectorAll("#calculate-form .form-grid, #calculate-form .display-filter-panel")
    .forEach((node) => node.classList.toggle("hidden", alphaMode || multiMode));
  const fields = $("spawn-fields");
  if (fields) fields.classList.toggle("hidden", !alphaMode);
  const multiFields = $("multi-fields");
  if (multiFields) multiFields.classList.toggle("hidden", !multiMode);
  const multiMapCard = $("multi-map-card");
  if (multiMapCard) multiMapCard.classList.toggle("hidden", !multiMode);
  if (multiMode) renderMultiMap();
  const multiResults = $("multi-results");
  if (multiResults) multiResults.classList.toggle("hidden", !multiMode);
  const multiResultsColumn = $("results-column");
  if (multiResultsColumn) multiResultsColumn.classList.toggle("is-multi-mode", multiMode);
  const button = $("calculate-button");
  if (button) button.textContent = alphaMode ? "计算定点头目" : multiMode ? "计算多只路径" : "计算路径";
  if (alphaMode) {
    const hint = $("mode-hint");
    if (hint) hint.textContent = "定点头目：用同一个 Seed 查地图上固定生成点第几次刷新出闪。";
  } else if (multiMode) {
    const hint = $("mode-hint");
    if (hint) hint.textContent = "多只生成点：用同一个 Seed 查 2/3 只同时生成点的分支路径。";
  }
  const mapCard = $("spawn-map-card");
  if (mapCard) mapCard.classList.toggle("hidden", !alphaMode);
  // 结果按模式分组：切走时缓存当前结果，切到定点头目时清空右侧只留地图，
  // 切回其它模式时恢复该模式自己的结果。
  if (activeResultGroup !== null && activeResultGroup !== mode) {
    captureActiveResultGroup(activeResultGroup);
    if (alphaMode) hideVisibleResultsForMap();
    else restoreResultGroup(mode);
  } else if (alphaMode) {
    hideVisibleResultsForMap();
  }
  activeResultGroup = mode;
  const resultsColumn = $("results-column");
  if (resultsColumn) {
    resultsColumn.classList.toggle("is-map-mode", alphaMode);
    resultsColumn.classList.toggle("is-map-empty", alphaMode);
  }
  applySpawnInputMode();
  if (alphaMode) renderSpawnMap();
}

async function submitSpawn() {
  const button = $("calculate-button");
  const status = $("spawn-status");
  const payload = {
    seed: ($("quick-seed").value || "").trim(),
    map: $("spawn-map").value,
    species: $("spawn-species").value,
    spawner: $("spawn-spawner").value,
    is_night: $("spawn-night").checked,
    static_alpha: $("spawn-alpha").checked,
    fixed_gender: $("spawn-fixed-gender").checked,
    gender_ratio: $("spawn-gender-ratio").value,
  };
  if (!payload.spawner) {
    status.textContent = "请先选择生成点。";
    return;
  }
  button.disabled = true;
  status.textContent = "计算中…";
  try {
    const data = await api("/api/spawn", {
      method: "POST",
      body: JSON.stringify(payload),
      timeoutMs: 180000,
    });
    renderSpawnResults(data);
    status.textContent = data.result_count
      ? `找到 ${data.result_count} 个结果（Seed ${data.seed}）`
      : `50000 次刷新内没有闪光（Seed ${data.seed}）`;
  } catch (error) {
    $("spawn-results").innerHTML = "";
    status.textContent = `计算失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function safeText(value) {
  return value === undefined || value === null ? "—" : String(value);
}


async function applyQuickSeed() {
  const value = $("quick-seed").value.trim();
  if (!value) {
    showToast("请输入 Seed。");
    return;
  }
  await applyManualSeedValue(value);
}

let assetPollTimer = null;
let assetPromptShown = false;
let assetPromptContext = "startup";

function showPokemonAssetPrompt(context = "manual") {
  assetPromptContext = context;
  const modal = $("pokemon-assets-prompt");
  if (!modal) return;
  modal.classList.remove("hidden");
  assetPromptShown = true;
  const downloadButton = $("choose-download-pokemon-assets");
  if (downloadButton) downloadButton.focus();
}

function hidePokemonAssetPrompt() {
  $("pokemon-assets-prompt")?.classList.add("hidden");
  assetPromptShown = false;
}

function renderPokemonAssetStatus(data) {
  const statusNode = $("pokemon-assets-status");
  const summaryNode = $("pokemon-assets-summary");
  if (!data || !statusNode || !summaryNode) return;
  pokemonAssetSnapshot = data;
  const progress = data.progress || {};
  statusNode.className = "status-pill";
  if (data.manifest_ready === false || Number(data.total || 0) === 0) {
    statusNode.classList.add("status-error");
    statusNode.textContent = "清单不可用";
    summaryNode.textContent = "图片资源清单未找到。请先运行 prepare_offline_engine.bat 准备本地引擎资源；这不会影响已有计算功能。";
  } else if (data.complete) {
    statusNode.classList.add("status-success");
    statusNode.textContent = "资源已就绪";
    summaryNode.textContent = `已检查 ${data.total} 个图片文件，全部可用（本地缓存 ${data.cached || 0}，自定义图片 ${data.custom || 0}）。图片资源可离线使用。`;
  } else if (progress.status === "downloading") {
    statusNode.classList.add("status-pending");
    statusNode.textContent = "正在下载";
    summaryNode.textContent = `已准备 ${data.available || 0} / ${data.total || 0} 个图片文件。下载期间不影响 Seed 读取或 RNG 计算。`;
  } else if (progress.status === "partial") {
    statusNode.classList.add("status-pending");
    statusNode.textContent = "部分缺失";
    summaryNode.textContent = `已准备 ${data.available || 0} / ${data.total || 0} 个图片文件，仍缺少 ${data.missing || 0} 个。可重试下载，或将对应图片放入 custom 文件夹。`;
  } else {
    statusNode.classList.add("status-muted");
    statusNode.textContent = "可选资源";
    summaryNode.textContent = `已准备 ${data.available || 0} / ${data.total || 0} 个图片文件，缺少 ${data.missing || 0} 个。图片不是计算依赖；可稍后下载，也可手动添加。`;
  }

  const globalProgress = $("pokemon-assets-global-progress");
  if (globalProgress) {
    const isDownloading = progress.status === "downloading";
    globalProgress.classList.toggle("hidden", !isDownloading);
    if (isDownloading) {
      const percent = Number(progress.percent || 0);
      $("pokemon-assets-global-percent").textContent = `${percent}%`;
      $("pokemon-assets-global-bar").style.width = `${Math.max(0, Math.min(100, percent))}%`;
      const completed = Number(progress.completed || 0);
      const total = Number(progress.total || 0);
      $("pokemon-assets-global-detail").textContent = `${completed} / ${total} 个文件已处理。可继续使用计算器。`;
    }
  }

  const progressWrap = $("pokemon-assets-progress-wrap");
  if (progress.status === "downloading" || progress.status === "partial" || progress.status === "complete") {
    progressWrap?.classList.remove("hidden");
    const percent = Number(progress.percent || 0);
    $("pokemon-assets-progress-label").textContent = progress.status === "downloading"
      ? `正在处理：${progress.current || "图片资源"}`
      : progress.status === "complete" ? "图片资源准备完成" : "下载未完全完成";
    $("pokemon-assets-progress-percent").textContent = `${percent}%`;
    $("pokemon-assets-progress-bar").style.width = `${Math.max(0, Math.min(100, percent))}%`;
    const total = Number(progress.total || 0);
    const completed = Number(progress.completed || 0);
    const downloaded = Number(progress.downloaded || 0);
    const failed = Number(progress.failed || 0);
    $("pokemon-assets-progress-detail").textContent = progress.status === "complete"
      ? `资源已就绪。此次新增 ${downloaded} 个文件。`
      : `${completed} / ${total} 个文件已处理 · 成功 ${downloaded} · 缺失／失败 ${failed}${progress.errors?.length ? ` · 最近错误：${progress.errors[0]}` : ""}`;
  } else {
    progressWrap?.classList.add("hidden");
  }
  const downloadButton = $("download-pokemon-assets");
  if (downloadButton) {
    downloadButton.disabled = data.manifest_ready === false || Number(data.total || 0) === 0 || progress.status === "downloading" || data.complete;
    downloadButton.textContent = data.complete ? "图片资源已完整" : (progress.status === "downloading" ? "正在下载…" : "下载／补全图片");
  }
  renderUnifiedResources();
}

async function refreshPokemonAssetStatus(manualCheck = false) {
  try {
    const data = manualCheck
      ? await api("/api/pokemon-assets/check", { method: "POST", body: JSON.stringify({}), timeoutMs: 15000 })
      : await api("/api/pokemon-assets/status", { timeoutMs: 15000 });
    renderPokemonAssetStatus(data);
    const availableCount = Number(data.available || 0);
    if (availableCount > lastAssetAvailableCount) retryMissingSpriteImages();
    lastAssetAvailableCount = availableCount;
    if (manualCheck && data.missing > 0 && data.progress?.status !== "downloading") {
      showPokemonAssetPrompt("manual");
    } else if (!manualCheck && data.prompt_required && !assetPromptShown) {
      showPokemonAssetPrompt("startup");
    }
    if (data.progress?.status === "downloading") {
      if (assetPollTimer) clearTimeout(assetPollTimer);
      assetPollTimer = setTimeout(() => refreshPokemonAssetStatus(false), 1100);
    } else if (assetPollTimer) {
      clearTimeout(assetPollTimer);
      assetPollTimer = null;
    }
    return data;
  } catch (error) {
    const statusNode = $("pokemon-assets-status");
    if (statusNode) {
      statusNode.className = "status-pill status-error";
      statusNode.textContent = "检查失败";
    }
    if ($("pokemon-assets-summary")) $("pokemon-assets-summary").textContent = `图片资源状态读取失败：${error.message}。这不会影响计算功能。`;
    if (manualCheck) showToast(`检查图片资源失败：${error.message}`);
    return null;
  }
}

async function choosePokemonAssetAction(choice) {
  hidePokemonAssetPrompt();
  try {
    const data = await api("/api/pokemon-assets/choice", {
      method: "POST",
      body: JSON.stringify({ choice })
    });
    renderPokemonAssetStatus(data);
    if (choice === "skip") {
      showToast("已跳过图片下载。之后不会自动提醒；可在设置中手动检查。计算功能不受影响。");
      return;
    }
    showToast("图片资源已在后台开始准备。你可以继续使用计算器。");
    if (assetPollTimer) clearTimeout(assetPollTimer);
    assetPollTimer = setTimeout(() => refreshPokemonAssetStatus(false), 800);
  } catch (error) {
    showToast(`图片资源操作失败：${error.message}`);
  }
}

async function openPokemonAssetFolder() {
  try {
    const data = await api("/api/pokemon-assets/open-folder", { method: "POST", body: JSON.stringify({}) });
    showToast(data.opened ? "已打开自定义图片文件夹。" : `图片文件夹路径：${data.path}`);
  } catch (error) {
    showToast(`无法打开图片文件夹：${error.message}`);
  }
}

const APP_THEME_NAMES = {
  forest: "森林绿",
  ocean: "海洋蓝",
  snow: "纯净白",
  lavender: "薰衣草紫",
  amber: "暖阳琥珀"
};

function persistAppearance(key, value) {
  try { localStorage.setItem(key, value); } catch (_) { /* Server settings are the durable source. */ }
  const snapshot = {
    appearance_theme: document.body.dataset.theme || "forest",
    appearance_mode: document.body.classList.contains("dark-mode") ? "dark" : "light"
  };
  // Serialize writes so rapid theme/mode clicks cannot leave an older preference last.
  appearanceSaveQueue = appearanceSaveQueue
    .catch(() => {})
    .then(() => api("/api/settings", {
      method: "PUT",
      body: JSON.stringify(snapshot),
      timeoutMs: 8000
    }))
    .catch(error => console.warn("外观偏好保存失败：", error));
}

function syncAppearanceControls() {
  const dark = document.body.classList.contains("dark-mode");
  const modeButton = $("theme-toggle");
  if (modeButton) {
    modeButton.textContent = dark ? "☀" : "☾";
    modeButton.title = dark ? "切换日间模式" : "切换夜间模式";
    modeButton.setAttribute("aria-label", dark ? "切换日间模式" : "切换夜间模式");
    modeButton.setAttribute("aria-pressed", String(dark));
  }
  const modeCheckbox = $("appearance-dark-mode");
  if (modeCheckbox) modeCheckbox.checked = dark;
  document.querySelectorAll("[data-theme-choice]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === document.body.dataset.theme));
  });
}

function setAppearanceTheme(theme, persist = true) {
  if (!Object.prototype.hasOwnProperty.call(APP_THEME_NAMES, theme)) return;
  document.body.dataset.theme = theme;
  if (persist) persistAppearance("pla-mmo-theme", theme);
  syncAppearanceControls();
}

function setDarkMode(enabled, persist = true) {
  document.body.classList.toggle("dark-mode", Boolean(enabled));
  if (persist) persistAppearance("pla-mmo-mode", enabled ? "dark" : "light");
  syncAppearanceControls();
}

function initializeAppearance() {
  let theme = document.body.dataset.theme || "forest";
  let mode = document.body.classList.contains("dark-mode") ? "dark" : "light";
  let migratedPreference = false;
  // New versions persist appearance in settings.json. If this is the first
  // launch after upgrading from a localStorage-only release, migrate that choice.
  if (document.body.dataset.appearanceSaved !== "1") {
    try {
      const savedTheme = localStorage.getItem("pla-mmo-theme");
      const savedMode = localStorage.getItem("pla-mmo-mode");
      if (Object.prototype.hasOwnProperty.call(APP_THEME_NAMES, savedTheme)) {
        theme = savedTheme;
        migratedPreference = true;
      }
      if (savedMode === "dark" || savedMode === "light") {
        mode = savedMode;
        migratedPreference = true;
      }
    } catch (_) { /* Server-rendered defaults remain available. */ }
  }
  setAppearanceTheme(theme, false);
  setDarkMode(mode === "dark", false);
  // Persist defaults too, marking appearance preferences as initialized; when
  // migrating, this also transfers the previous WebView localStorage values.
  if (document.body.dataset.appearanceSaved !== "1") {
    persistAppearance("pla-mmo-theme", theme);
    if (!migratedPreference) {
      try { localStorage.setItem("pla-mmo-mode", mode); } catch (_) {}
    }
  }
}

function toggleTheme() {
  setDarkMode(!document.body.classList.contains("dark-mode"));
}

let linkSeedPollTimer = null;
let linkSeedLastLog = "";
let linkSeedTerminalSeen = "";
let linkSeedStarting = false;
let linkSeedRunning = false;
// 左上角联机按钮的四态：idle → starting → running → stopping → idle。
// 点击后立即切到过渡态（乐观反馈），不等后端响应；轮询期间不回写过渡态。
let linkQuickUiState = "idle";
// 后端 stop() 是异步的：返回时进程可能还活着（running=true, phase=stopping），
// 看门狗最多 5~30s 才强制结束。此门闩让按钮保持"正在结束…"直到轮询确认真的停下。
let linkQuickStopping = false;
let linkQuickStopTimer = null;
const LINK_QUICK_BTN_STATE = {
  idle:     { text: "点击启动",  busy: false, title: "开始采集" },
  starting: { text: "正在启动…", busy: true,  title: "正在启动采集" },
  running:  { text: "点击停止",  busy: false, title: "停止采集" },
  stopping: { text: "正在结束…", busy: true,  title: "正在结束采集" }
};
function setLinkQuickButtonState(state) {
  linkQuickUiState = state;
  const btn = $("link-quick-start");
  if (!btn) return;
  const cfg = LINK_QUICK_BTN_STATE[state] || LINK_QUICK_BTN_STATE.idle;
  btn.dataset.state = state;
  btn.textContent = cfg.text;
  btn.disabled = cfg.busy;
  btn.setAttribute("aria-busy", cfg.busy ? "true" : "false");
  btn.title = cfg.title;
}
const linkAutoSpeciesState = new Map();
let linkAutoSpeciesGraphCache = null;
let linkAutoSpeciesGraphSize = -1;

function resetLinkAutoSpecies() {
  const first = $("frpokemon");
  const state = linkAutoSpeciesState.get("frpokemon");
  if (first && state && first.value === state.value && first.dataset.userChosen !== "1") {
    first.value = "";
    updateBonusSpecies();
    refreshSearchableSelect(first);
  }
  linkAutoSpeciesState.clear();
  const bonus = $("brpokemon");
  if (bonus && $("isbonus")?.checked) {
    bonus.value = "";
    delete bonus.dataset.userChosen;
    refreshSearchableSelect(bonus);
  }
}

function normalizeAutoSpeciesName(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/^\s*\d{2,3}\s+/, "")
    .replace(/^(?:头目|Alpha|α)\s*/i, "")
    .replace(/\s*(?:Lv\.?\s*\d+|#\d+)\b.*$/i, "")
    .replace(/[♀♂]/g, "")
    .replace(/\s+/g, "")
    .toLocaleLowerCase();
}

function autoSpeciesNameOf(item) {
  return normalizeAutoSpeciesName(item?.species_zh || item?.label || item?.species || item?.label_en);
}

function autoSpeciesIsAlpha(item) {
  return /^Alpha/i.test(String(item?.species || ""))
    || /^(?:头目|Alpha)/i.test(String(item?.species_zh || item?.label || "").trim());
}

function getLinkAutoSpeciesGraph() {
  if (linkAutoSpeciesGraphCache && linkAutoSpeciesGraphSize === speciesData.length) {
    return linkAutoSpeciesGraphCache;
  }
  const nameByHash = new Map();
  speciesData.forEach(item => {
    const hash = String(item.hash ?? "").trim().toLocaleLowerCase();
    if (hash) nameByHash.set(hash, autoSpeciesNameOf(item));
  });
  const parents = new Map();
  speciesData.forEach(item => {
    const name = autoSpeciesNameOf(item);
    if (!name) return;
    const parentId = String(item.parent_id ?? "").trim().toLocaleLowerCase();
    if (!parentId || parentId === "0" || parentId === "-1") return;
    const parentName = nameByHash.get(parentId);
    if (!parentName || parentName === name) return;
    if (!parents.has(name)) parents.set(name, new Set());
    parents.get(name).add(parentName);
  });
  linkAutoSpeciesGraphCache = { parents };
  linkAutoSpeciesGraphSize = speciesData.length;
  return linkAutoSpeciesGraphCache;
}

function createAutoSpeciesStageResolver(graph) {
  const memo = new Map();
  const stack = new Set();
  const calc = name => {
    if (!name) return 0;
    if (memo.has(name)) return memo.get(name);
    if (stack.has(name)) return 0;
    stack.add(name);
    const parents = [...(graph.parents.get(name) || [])].filter(parent => parent !== name);
    let stage = 0;
    if (parents.length) stage = 1 + Math.min(...parents.map(calc));
    stack.delete(name);
    memo.set(name, stage);
    return stage;
  };
  return calc;
}

function findAutoSpeciesName(title, isAlpha) {
  const target = normalizeAutoSpeciesName(title);
  if (!target || !speciesData.length) return "";
  const matches = [];
  speciesData.forEach(item => {
    const names = [item.species, item.species_zh, item.label, item.label_en]
      .map(normalizeAutoSpeciesName)
      .filter(Boolean);
    if (!names.length) return;
    if (!names.some(name => name === target || name.includes(target) || target.includes(name))) return;
    const parentId = String(item.parent_id ?? "").trim().toLocaleLowerCase();
    const hasParent = Boolean(parentId && parentId !== "0" && parentId !== "-1");
    const itemAlpha = autoSpeciesIsAlpha(item);
    const name = autoSpeciesNameOf(item);
    if (!name) return;
    let score = names.includes(target) ? 20 : 10;
    if (hasParent) score += 4;
    if (isAlpha) score += itemAlpha ? 3 : 0;
    else score += itemAlpha ? 0 : 2;
    matches.push({ name, score });
  });
  if (!matches.length) return "";
  matches.sort((a, b) => b.score - a.score);
  return matches[0].name;
}

function chooseLowestCapturedSpecies(data, graph, stageOf) {
  const count = Math.max(0, Math.min(4, Number(data.count) || 0));
  const candidates = [];
  (Array.isArray(data.pokemon) ? data.pokemon : []).slice(0, count).forEach((entry, index) => {
    const title = linkSeedCleanTitle(entry?.title || "");
    if (!title) return;
    const alpha = /头目|Alpha/i.test(title)
      || (Array.isArray(entry.chips) && entry.chips.some(chip => String(chip?.label || "") === "头目"));
    const name = findAutoSpeciesName(title, alpha);
    if (!name) return;
    candidates.push({ name, alpha, stage: stageOf(name), index });
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.stage - b.stage || a.index - b.index);
  return candidates[0];
}

function autoSpeciesAncestors(name, graph, stageOf) {
  const result = [name];
  const seen = new Set([name]);
  let current = name;
  for (let depth = 0; depth < 8; depth += 1) {
    const parents = [...(graph.parents.get(current) || [])]
      .filter(parent => parent !== current && !seen.has(parent))
      .sort((a, b) => stageOf(a) - stageOf(b));
    if (!parents.length) break;
    current = parents[0];
    result.push(current);
    seen.add(current);
  }
  return result;
}

function findAutoSpeciesOption(select, name, preferAlpha) {
  if (!select || !name) return null;
  const target = normalizeAutoSpeciesName(name);
  if (!target) return null;
  let best = null;
  let bestScore = -1;
  [...select.options].forEach(option => {
    if (!option.value) return;
    const raw = String(option.dataset.species || option.value || "").trim();
    const rawName = normalizeAutoSpeciesName(raw);
    const textName = normalizeAutoSpeciesName(option.textContent || "");
    if (!rawName && !textName) return;
    const exact = textName === target || rawName === target;
    const contains = (textName && (textName.includes(target) || target.includes(textName)))
      || (rawName && (rawName.includes(target) || target.includes(rawName)));
    if (!exact && !contains) return;
    const alphaOption = /^(?:Alpha|头目)/i.test(raw)
      || /^(?:头目|Alpha)/i.test(String(option.textContent || "").trim());
    let score = exact ? 10 : 5;
    score += preferAlpha === alphaOption ? 4 : 0;
    if (score > bestScore) {
      bestScore = score;
      best = option;
    }
  });
  return best;
}

function autoFillFirstRoundSpecies(data) {
  const count = Math.max(0, Math.min(4, Number(data.count) || 0));
  if (count < 1 || !speciesData.length) return;
  const graph = getLinkAutoSpeciesGraph();
  const stageOf = createAutoSpeciesStageResolver(graph);
  const chosen = chooseLowestCapturedSpecies(data, graph, stageOf);
  if (!chosen) return;

  const mode = $("appearance")?.value || "mmo_bonus";
  const alphaMode = mode === "spawn_alpha";
  const select = alphaMode ? $("spawn-species") : $("frpokemon");
  if (!select || select.disabled || select.dataset.userChosen === "1") return;

  const state = linkAutoSpeciesState.get(select.id);
  if (state) {
    if (select.value !== state.value) return;
    if (chosen.stage >= state.stage) return;
  } else if (!alphaMode && select.value) {
    return;
  }

  const preferAlpha = alphaMode || chosen.alpha;
  let option = null;
  for (const name of autoSpeciesAncestors(chosen.name, graph, stageOf)) {
    option = findAutoSpeciesOption(select, name, preferAlpha);
    if (option) break;
  }
  if (!option) return;

  select.value = option.value;
  linkAutoSpeciesState.set(select.id, { value: option.value, stage: chosen.stage });
  if (alphaMode) {
    if (typeof fillSpawnSpawners === "function") fillSpawnSpawners();
  } else {
    const bonus = $("brpokemon");
    const previousBonus = bonus?.value || "";
    const bonusChosen = bonus?.dataset.userChosen === "1";
    updateBonusSpecies();
    if (bonus) {
      const keepBonus = bonusChosen && previousBonus
        && [...bonus.options].some(item => item.value === previousBonus);
      bonus.value = keepBonus ? previousBonus : "";
      refreshSearchableSelect(bonus);
    }
  }
  refreshSearchableSelect(select);
  showToast(`已按 Seed 内最低进化型自动选择「${option.textContent.trim()}」，可手动修改。`);
}

const LINK_SEED_PHASE_LABELS = {
  starting: "启动中",
  waiting: "等待连接",
  collecting: "采集中",
  solving: "反推中",
  stopping: "停止中",
  done: "已完成",
  stopped: "已停止",
  failed: "失败",
  idle: "待机"
};

function linkSeedClock(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function showLinkSeedError(message) {
  const node = $("link-seed-error");
  if (!node) return;
  if (!message) {
    node.textContent = "";
    node.classList.add("hidden");
    return;
  }
  node.textContent = message;
  node.classList.remove("hidden");
}

function setLinkSeedProbeItem(name, state, text, title = "") {
  const item = document.querySelector(`[data-link-probe="${name}"]`);
  if (!item) return;
  item.classList.remove("is-ok", "is-warn", "is-bad");
  if (state) item.classList.add(`is-${state}`);
  const small = item.querySelector("small");
  if (small) {
    small.textContent = text;
    small.title = title || text;
  }
}

function linkSeedProbePayload(data) {
  const probe = data?.probe || {};
  return { ...probe, environment: probe.environment || data?.environment || {} };
}

function renderLinkSeedProbe(payload) {
  const environment = payload?.environment || {};
  const board = payload?.board || null;
  if (board) {
    const firmware = board.version ? `固件 ${board.version}` : "固件已识别";
    setLinkSeedProbeItem("board", "ok", `${board.port} · ${board.chip || "ESP32"} · ${firmware}`, board.firmware || "");
  } else {
    setLinkSeedProbeItem("board", "bad", payload?.error || "未检测到无线板", payload?.error || "");
  }
  setLinkSeedProbeItem(
    "runtime",
    environment.runtime_ok ? "ok" : "bad",
    environment.runtime_ok ? "已内置" : "缺失",
    environment.runtime_dir || ""
  );
  setLinkSeedProbeItem(
    "keys",
    environment.keys_ok ? "ok" : "bad",
    environment.keys_ok ? (String(environment.keys_path || "").split(/[\\/]/).pop() || "已找到") : (environment.keys_error || "未找到"),
    environment.keys_path || environment.keys_error || ""
  );
  setLinkSeedProbeItem(
    "solver",
    environment.solver_ok ? "ok" : "warn",
    environment.solver_ok ? "已就绪" : "缺失（采满后无法反推）",
    environment.solver || environment.solver_dir || ""
  );
  updateLinkSeedEnvSummary(payload);
}

async function probeLinkSeed(force = true) {
  try {
    const data = await api("/api/link/probe", {
      method: "POST",
      body: JSON.stringify({ force: Boolean(force) }),
      timeoutMs: 60000
    });
    renderLinkSeedProbe(data);
    if (data.ready === false && data.error) showLinkSeedError(data.error);
    else showLinkSeedError("");
    if (data.ready === false) $("link-seed-advanced").open = true;
    return data;
  } catch (error) {
    showLinkSeedError(`检测失败：${error.message}`);
    $("link-seed-advanced").open = true;
    return null;
  }
}

async function loadLinkSeedSettings() {
  try {
    const settings = await api("/api/settings", { timeoutMs: 12000 });
    if (settings.link_channel) $("link-seed-channel").value = String(settings.link_channel);
    if (settings.link_seconds) $("link-seed-seconds").value = String(settings.link_seconds);
  } catch (_) {
    // Defaults in the markup remain usable.
  }
}

function linkSeedCleanTitle(title) {
  return String(title || "").replace(/^\s*\d{2}\s+/, "").trim();
}

function linkSeedImageUrl(index, image) {
  const version = image ? encodeURIComponent(String(image)) : "none";
  return `/api/link/pokemon-image/${index}?v=${version}`;
}

function setLinkSeedImage(image, fallback, url) {
  if (!image) return;
  if (!url) {
    image.hidden = true;
    image.removeAttribute("src");
    delete image.dataset.src;
    if (fallback) fallback.hidden = false;
    return;
  }
  if (image.dataset.src === url) return;
  image.dataset.src = url;
  image.onload = () => {
    image.hidden = false;
    if (fallback) fallback.hidden = true;
  };
  image.onerror = () => {
    image.hidden = true;
    if (fallback) fallback.hidden = false;
  };
  image.src = url;
}

function ensureLinkSeedCards() {
  const grid = $("link-seed-card-grid");
  if (!grid || grid.dataset.ready === "1") return;
  grid.textContent = "";
  for (let index = 0; index < 4; index += 1) {
    const card = document.createElement("article");
    card.className = "link-seed-mon-card is-empty";
    card.dataset.index = String(index);
    const head = document.createElement("div");
    head.className = "link-seed-mon-card-head";
    const art = document.createElement("div");
    art.className = "link-seed-mon-art";
    const image = document.createElement("img");
    image.alt = "";
    image.hidden = true;
    const fallback = document.createElement("span");
    fallback.className = "link-seed-mon-fallback";
    fallback.textContent = "?";
    fallback.setAttribute("aria-hidden", "true");
    art.append(image, fallback);
    const copy = document.createElement("div");
    copy.className = "link-seed-mon-copy";
    const title = document.createElement("p");
    title.className = "link-seed-mon-title";
    title.textContent = `第 ${index + 1} 只`;
    const sub = document.createElement("p");
    sub.className = "link-seed-mon-sub";
    sub.textContent = "等待收录";
    copy.append(title, sub);
    head.append(art, copy);
    const tags = document.createElement("div");
    tags.className = "link-seed-mon-tags";
    const lines = document.createElement("dl");
    lines.className = "link-seed-mon-lines";
    const emptyNote = document.createElement("p");
    emptyNote.className = "link-seed-mon-empty-note";
    emptyNote.textContent = "等待收录";
    card.append(head, tags, lines, emptyNote);
    grid.appendChild(card);
  }
  grid.dataset.ready = "1";
}

function renderLinkSeedCards(data) {
  ensureLinkSeedCards();
  const grid = $("link-seed-card-grid");
  if (!grid) return;
  const count = Math.max(0, Math.min(4, Number(data.count) || 0));
  const phase = String(data.phase || "idle");
  const entries = Array.isArray(data.pokemon) ? data.pokemon : [];
  const solvingIndex = phase === "solving"
    ? Math.max(0, Math.min(3, (Number(data.entity) || 1) - 1))
    : -1;

  grid.querySelectorAll(".link-seed-mon-card").forEach((card, index) => {
    const entry = entries[index] || {};
    const captured = index < count;
    const current = Boolean(data.running) && index === count && count < 4
      && (phase === "collecting" || Boolean(data.connected));
    const solving = solvingIndex === index;
    const signature = JSON.stringify({
      t: entry.title || "",
      l: entry.lines || [],
      c: entry.chips || [],
      i: entry.image || "",
      cap: captured,
      cur: current,
      sol: solving,
      n: count
    });
    if (card.dataset.signature === signature) return;
    card.dataset.signature = signature;
    card.classList.toggle("is-empty", !captured);
    card.classList.toggle("is-captured", captured);
    card.classList.toggle("is-current", current || solving);

    const image = card.querySelector(".link-seed-mon-art img");
    const fallback = card.querySelector(".link-seed-mon-fallback");
    setLinkSeedImage(
      image,
      fallback,
      captured && entry.image ? linkSeedImageUrl(index, entry.image) : ""
    );

    const title = card.querySelector(".link-seed-mon-title");
    const sub = card.querySelector(".link-seed-mon-sub");
    title.textContent = captured
      ? (linkSeedCleanTitle(entry.title) || `第 ${index + 1} 只`)
      : `第 ${index + 1} 只`;
    sub.textContent = captured
      ? "已收录"
      : current
        ? "进入确认页后按 B"
        : index === count
          ? "下一只"
          : "等待收录";

    const tags = card.querySelector(".link-seed-mon-tags");
    tags.textContent = "";
    const chipList = captured && Array.isArray(entry.chips) ? entry.chips : [];
    tags.hidden = chipList.length === 0;
    chipList.forEach(chip => {
      if (!chip || (!chip.label && !chip.value)) return;
      const tag = document.createElement("span");
      tag.className = "link-seed-mon-tag";
      if (["闪光", "头目"].includes(String(chip.label || ""))) tag.classList.add("is-accent");
      tag.textContent = `${chip.label || ""} ${chip.value || ""}`.trim();
      tags.appendChild(tag);
    });

    const lines = card.querySelector(".link-seed-mon-lines");
    lines.textContent = "";
    const detailLines = captured && Array.isArray(entry.lines) ? entry.lines : [];
    detailLines.forEach(line => {
      if (!line || (!line.label && !line.value)) return;
      const row = document.createElement("div");
      row.className = `link-seed-mon-line${line.label ? "" : " is-single"}`;
      if (line.label) {
        const label = document.createElement("dt");
        label.textContent = line.label;
        row.appendChild(label);
      }
      const value = document.createElement("dd");
      value.textContent = line.value || "—";
      row.appendChild(value);
      lines.appendChild(row);
    });
    lines.hidden = detailLines.length === 0;

    const emptyNote = card.querySelector(".link-seed-mon-empty-note");
    emptyNote.hidden = captured;
    if (!captured) {
      emptyNote.textContent = current
        ? "进入确认页后按 B 返回"
        : index === count
          ? "下一只从这里开始"
          : "等待收录";
    }
  });
}

function renderLinkSeedCurrent(data) {
  const phase = String(data.phase || "idle");
  const count = Math.max(0, Math.min(4, Number(data.count) || 0));
  const entries = Array.isArray(data.pokemon) ? data.pokemon : [];
  let index = count > 0 ? Math.min(3, count - 1) : -1;
  if (phase === "solving") {
    index = Math.max(0, Math.min(3, (Number(data.entity) || 1) - 1));
  }
  const entry = index >= 0 ? (entries[index] || {}) : {};
  const image = $("link-seed-current-image");
  const fallback = $("link-seed-current-fallback");
  const name = $("link-seed-current-name");
  const meta = $("link-seed-current-meta");

  let currentName = "";
  let currentMeta = "";
  if (entry.title && (count > 0 || phase === "solving" || phase === "done")) {
    currentName = linkSeedCleanTitle(entry.title) || `第 ${index + 1} 只`;
    if (phase === "solving") {
      currentMeta = `第 ${Number(data.entity) || index + 1}/4 只 · 正在反推`;
    } else {
      currentMeta = `第 ${index + 1}/4 只 · 已收录`;
    }
  } else {
    currentName = phase === "collecting"
      ? `等待第 ${Math.min(count + 1, 4)} 只`
      : phase === "waiting"
        ? "等待 Switch 连接"
        : phase === "starting"
          ? "正在启动采集…"
          : phase === "done"
            ? "四只已收齐"
            : phase === "failed"
              ? "采集失败"
              : phase === "stopped"
                ? "已停止采集"
                : "等待第一只";
    currentMeta = phase === "collecting"
      ? "请在 Switch 选中下一只，进入确认页后按 B 返回"
      : phase === "waiting"
        ? "在祝庆村找交换 NPC → 本地交换 → 输入本页相同密码。"
        : phase === "solving"
          ? "EtumrepMMO 正在检查四只记录"
          : "点「开始采集」后，在 Switch 选择最初捕获的宝可梦";
  }
  name.textContent = currentName;
  meta.textContent = currentMeta;
  const showImage = Boolean(entry.image) && (count > 0 || phase === "solving" || phase === "done");
  setLinkSeedImage(
    image,
    fallback,
    showImage ? linkSeedImageUrl(index, entry.image) : ""
  );
}

function renderLinkSeedProgress(data) {
  const phase = String(data.phase || "idle");
  const count = Math.max(0, Math.min(4, Number(data.count) || 0));
  const label = LINK_SEED_PHASE_LABELS[phase] || phase;
  const badge = $("link-seed-progress-badge");
  if (badge) {
    badge.textContent = label;
    badge.className = `link-seed-phase is-${phase}`;
  }
  const countBadge = $("link-seed-count-badge");
  if (countBadge) countBadge.textContent = `${count}/4`;

  let text = "点「开始采集」，按提示操作。";
  let detail = "连接后这里会显示当前该做什么。";
  if (phase === "starting") {
    text = "正在启动联机采集…";
    detail = "正在打开无线板并准备本地交换，请稍候。";
  } else if (phase === "waiting") {
    text = "等待 Switch 连接";
    detail = "在祝庆村找交换 NPC → 本地交换 → 输入本页相同的 8 位密码。";
  } else if (phase === "collecting") {
    text = count >= 4 ? "四只已收齐" : `请选择第 ${count + 1}/4 只`;
    detail = count >= 4
      ? "正在正常结束联机，随后开始反推 Seed。"
      : "选中最初捕获的宝可梦，进入确认页看到收录后按 B 返回；不要确认交换。";
  } else if (phase === "solving") {
    const entity = Math.max(1, Math.min(4, Number(data.entity) || 1));
    const percent = Math.round(Number(data.percent) || 0);
    text = `反推 Seed：第 ${entity}/4 只`;
    detail = percent > 0
      ? `EtumrepMMO 正在比对第 ${entity} 只的个体值/性格/招式，当前 ${percent}%。`
      : `四只已就绪，EtumrepMMO 正在检查第 ${entity} 只。`;
  } else if (phase === "stopping") {
    text = "正在停止并释放无线板…";
    detail = "关闭联机输入后，采集进程会正常离开交换。";
  } else if (phase === "done") {
    text = "Seed 已找到并填入左侧";
    detail = "可以点右侧「填入并计算」，或先核对四只卡片再计算。";
  } else if (phase === "failed") {
    text = "采集失败";
    detail = data.error || "请打开运行日志查看原因；修好后可用「用最近记录重算」。";
  } else if (phase === "stopped") {
    text = "已停止采集";
    detail = "已收录的记录仍保留；重新开始前请让 Switch 回到本地交换界面。";
  }
  const progressText = $("link-seed-progress-text");
  const progressDetail = $("link-seed-progress-detail");
  if (progressText) progressText.textContent = text;
  if (progressDetail) progressDetail.textContent = detail;
}

let linkQuickExpanded = false;
let linkQuickPollTimer = null;

function setLinkQuickExpanded(expanded) {  linkQuickExpanded = Boolean(expanded);
  const body = $("link-quick-body");
  const toggle = $("link-quick-toggle");
  if (body) body.classList.toggle("hidden", !linkQuickExpanded);
  if (toggle) toggle.setAttribute("aria-expanded", String(linkQuickExpanded));
  const summary = $("link-quick-summary");
  if (summary && !linkSeedRunning) {
    summary.textContent = linkQuickExpanded ? "按提示操作；点标题收起" : "点此展开，快捷采集 2–4 只";
  }
  if (linkQuickExpanded) {
    ensureLinkQuickPolling();
    pollLinkQuickStatus();
  }
}

function openLinkQuickPanel() {
  setLinkQuickExpanded(true);
  $("link-quick-panel")?.scrollIntoView({ block: "nearest" });
}

function renderLinkQuick(data) {
  if (!data) return;
  const phase = String(data.phase || "idle");
  const count = Math.max(0, Math.min(4, Number(data.count) || 0));
  const running = Boolean(data.running);
  const entries = Array.isArray(data.pokemon) ? data.pokemon : [];
  const label = LINK_SEED_PHASE_LABELS[phase] || phase;

  const summary = $("link-quick-summary");
  if (summary) {
    summary.textContent = phase === "done"
      ? "Seed 已找到，已填入左侧"
      : phase === "waiting"
        ? "等待 Switch 连接…"
        : phase === "starting"
          ? "正在启动采集…"
          : phase === "collecting"
          ? `已收录 ${count}/4 · 继续选择`
          : phase === "solving"
            ? `正在反推 Seed · ${count}/4`
            : phase === "failed"
              ? "采集失败，展开查看"
              : phase === "stopped"
                ? "已停止，可重新开始"
                : linkQuickExpanded
                  ? "按提示操作；点标题收起"
                  : "点此展开，快捷采集 2–4 只";
  }
  const badge = $("link-quick-badge");
  if (badge) {
    badge.textContent = `${count}/4`;
    badge.className = `status-pill ${phase === "done" ? "status-success" : phase === "failed" ? "status-error" : count ? "status-pending" : "status-muted"}`;
  }

  document.querySelectorAll("#link-quick-slots .link-quick-slot").forEach((slot, index) => {
    const entry = entries[index] || {};
    const captured = index < count;
    const current = running && index === count && count < 4
      && (phase === "collecting" || Boolean(data.connected));
    slot.classList.toggle("is-captured", captured);
    slot.classList.toggle("is-current", current);
    const image = slot.querySelector("img");
    const fallback = slot.querySelector(".link-quick-art span");
    setLinkSeedImage(image, fallback, captured && entry.image ? linkSeedImageUrl(index, entry.image) : "");
    const name = slot.querySelector("strong");
    name.textContent = captured ? (linkSeedCleanTitle(entry.title) || `第 ${index + 1} 只`) : current ? "当前" : "等待";
    name.title = name.textContent;
  });

  const status = $("link-quick-status");
  if (status) {
    status.textContent = phase === "waiting"
      ? "等待 Switch 连接"
      : phase === "starting"
        ? "正在启动…"
        : phase === "collecting"
        ? (count >= 4 ? "四只已收齐" : `请选择第 ${count + 1}/4 只`)
        : phase === "solving"
          ? `反推中 · 第 ${Math.max(1, Math.min(4, Number(data.entity) || 1))}/4 只`
          : phase === "done"
            ? "Seed 已找到"
            : phase === "stopped"
              ? "已停止"
              : phase === "failed"
                ? "采集失败"
                : "尚未开始";
  }
  const percent = $("link-quick-percent");
  if (percent) percent.textContent = count ? `${count}/4` : label;
  const fill = $("link-quick-bar-fill");
  const bar = $("link-quick-bar");
  const value = count >= 4 ? 100 : (count / 4) * 100;
  if (fill) fill.style.width = `${value}%`;
  if (bar) bar.setAttribute("aria-valuenow", String(count));
  const meta = $("link-quick-meta");
  if (meta) {
    meta.textContent = data.error
      ? data.error
      : data.elapsed_seconds
        ? `${!data.running || phase === "done" ? "总用时" : "已用"} ${linkSeedClock(data.elapsed_seconds)} · 串口 ${data.probe?.board?.port || data.environment?.configured_board_port || "自动"}`
        : "插好无线板后开始";
  }
  const error = $("link-quick-error");
  if (error) {
    if (data.error) {
      error.textContent = data.error;
      error.classList.remove("hidden");
    } else {
      error.classList.add("hidden");
      error.textContent = "";
    }
  }
  // 停止进行中：后端 stop() 返回时进程可能还活着，必须等轮询确认 running=false
  // 才算真正结束，否则按钮会被仍为 true 的旧快照刷回"点击停止"。
  if (linkQuickStopping) {
    if (!running) {
      linkQuickStopping = false;
      if (linkQuickStopTimer !== null) { window.clearTimeout(linkQuickStopTimer); linkQuickStopTimer = null; }
      setLinkQuickButtonState("idle");
    }
    return;
  }
  // 按钮只在稳态（idle/running）随后端状态更新；
  // 两个过渡态（starting/stopping）都不回写，否则点击瞬间的新文案会被旧快照刷回。
  if (linkQuickUiState !== "starting" && linkQuickUiState !== "stopping") {
    setLinkQuickButtonState(running ? "running" : "idle");
  }
}

async function pollLinkQuickStatus() {
  if (linkSeedPollTimer) return;
  try {
    const data = await api("/api/link/status", { timeoutMs: 15000 });
    renderLinkSeedStatus(data);
    renderLinkQuick(data);
  } catch (error) {
    showLinkSeedError(`读取联机状态失败：${error.message}`);
  }
}

function ensureLinkQuickPolling() {
  if (linkQuickPollTimer) return;
  linkQuickPollTimer = window.setInterval(pollLinkQuickStatus, 1000);
}

async function ensureLinkQuickProbeWarm() {
  if (!document.querySelector("#link-quick-panel")) return;
  try {
    // Discovery starts the bundled LDN runtime (~7 s). Do it once in the
    // background so the first quick Start click can reuse the cached board.
    await api("/api/link/probe", {
      method: "POST",
      body: JSON.stringify({ force: false }),
      timeoutMs: 30000
    });
  } catch (_) {
    // The Start path will surface the real error if the board is unavailable.
  }
}

async function startLinkQuick() {
  if (linkQuickUiState !== "idle") return;
  // 清理可能残留的停止门闩/兜底定时器
  linkQuickStopping = false;
  if (linkQuickStopTimer !== null) { window.clearTimeout(linkQuickStopTimer); linkQuickStopTimer = null; }
  // 立即给反馈，不等后端；失败时再回滚到 idle
  setLinkQuickButtonState("starting");
  const code = "11111111";
  try {
    const data = await api("/api/link/start", {
      method: "POST",
      body: JSON.stringify({ code, channel: 6, seconds: 1800 }),
      timeoutMs: 90000
    });
    resetLinkAutoSpecies();
    renderLinkSeedStatus(data);
    renderLinkQuick(data);
    setLinkQuickButtonState("running");
    ensureLinkQuickPolling();
    showToast("已开始联机采集，请按提示在 Switch 上操作。");
  } catch (error) {
    setLinkQuickButtonState("idle");
    const node = $("link-quick-error");
    if (node) {
      node.textContent = error.message;
      node.classList.remove("hidden");
    }
  }
}

async function stopLinkQuick() {
  if (linkQuickUiState !== "running") return;
  // 立即给反馈，不等后端；失败时再回滚到 running
  setLinkQuickButtonState("stopping");
  try {
    const data = await api("/api/link/stop", { method: "POST", body: JSON.stringify({}), timeoutMs: 30000 });
    // stop() 返回时进程可能还活着（running=true/phase=stopping），不能立刻落 idle。
    // 开启门闩，让按钮保持"正在结束…"直到轮询确认 running=false。
    linkQuickStopping = true;
    if (linkQuickStopTimer !== null) window.clearTimeout(linkQuickStopTimer);
    // 兜底：看门狗最长 30s，超过则强制回_idle，避免后端异常时按钮卡死。
    linkQuickStopTimer = window.setTimeout(() => {
      linkQuickStopping = false;
      linkQuickStopTimer = null;
      setLinkQuickButtonState("idle");
    }, 35000);
    renderLinkSeedStatus(data);
    renderLinkQuick(data);
  } catch (error) {
    setLinkQuickButtonState("running");
    const node = $("link-quick-error");
    if (node) {
      node.textContent = `停止失败：${error.message}`;
      node.classList.remove("hidden");
    }
  }
}

function openLinkQuickDetail() {
  setLinkQuickExpanded(false);
  openLinkSeedModal();
  setLinkSeedMode("detail");
}


function setLinkSeedMode(mode) {
  const modal = $("link-seed-modal");
  if (!modal) return;
  const compact = mode !== "detail";
  modal.classList.toggle("is-compact", compact);
  modal.classList.toggle("is-detail", !compact);
  const toggle = $("link-seed-detail-toggle");
  if (toggle) toggle.textContent = compact ? "详细页面" : "简洁模式";
}

function toggleLinkSeedDetail() {
  const modal = $("link-seed-modal");
  if (!modal) return;
  if (modal.classList.contains("is-compact")) {
    setLinkSeedMode("detail");
  } else {
    closeLinkSeedModal();
    openLinkQuickPanel();
  }
}

function renderLinkSeedCompactSlots(data) {
  const slots = document.querySelectorAll("#link-seed-compact-slots .link-seed-compact-slot");
  if (!slots.length) return;
  const phase = String(data.phase || "idle");
  const count = Math.max(0, Math.min(4, Number(data.count) || 0));
  const entries = Array.isArray(data.pokemon) ? data.pokemon : [];
  slots.forEach((slot, index) => {
    const entry = entries[index] || {};
    const captured = index < count;
    const current = Boolean(data.running) && index === count && count < 4
      && (phase === "collecting" || Boolean(data.connected));
    slot.classList.toggle("is-captured", captured);
    slot.classList.toggle("is-current", current);
    const image = slot.querySelector("img");
    const fallback = slot.querySelector(".link-seed-compact-art span");
    setLinkSeedImage(
      image,
      fallback,
      captured && entry.image ? linkSeedImageUrl(index, entry.image) : ""
    );
    const name = slot.querySelector("strong");
    name.textContent = captured
      ? (linkSeedCleanTitle(entry.title) || `第 ${index + 1} 只`)
      : current
        ? "当前"
        : "等待";
    name.title = name.textContent;
  });
}

function updateLinkSeedEnvSummary(payload) {  const environment = payload?.environment || {};
  const board = payload?.board || null;
  const bits = [];
  bits.push(board ? `板子 ${board.port}` : "板子未检测");
  bits.push(`keys ${environment.keys_ok ? "✓" : "✗"}`);
  bits.push(`求解器 ${environment.solver_ok ? "✓" : "✗"}`);
  const node = $("link-seed-env-summary");
  if (node) node.textContent = bits.join(" · ");
}

function toggleLinkSeedLog() {
  const log = $("link-seed-log");
  const button = $("link-seed-log-open");
  if (!log) return;
  const hidden = log.classList.toggle("hidden");
  if (button) button.textContent = hidden ? "查看日志" : "收起日志";
  if (!hidden) log.scrollTop = log.scrollHeight;
}

function copyLinkSeedLog() {
  const error = $("link-seed-error")?.textContent?.trim();
  const text = [linkSeedLastLog, error].filter(Boolean).join("\n");
  copyText(text || "暂无日志。");
  showToast("日志已复制。");
}

function renderLinkSeedStatus(data) {
  if (!data) return;
  if (data.probe?.checked_at) renderLinkSeedProbe(linkSeedProbePayload(data));
  const phase = String(data.phase || "idle");
  const running = Boolean(data.running);
  linkSeedRunning = running;
  const count = Math.max(0, Math.min(4, Number(data.count) || 0));
  const phaseLabel = LINK_SEED_PHASE_LABELS[phase] || phase;

  renderLinkSeedCards(data);
  renderLinkSeedCompactSlots(data);
  renderLinkQuick(data);
  renderLinkSeedCurrent(data);
  renderLinkSeedProgress(data);
  if (count > 0) autoFillFirstRoundSpecies(data);
  if (data.environment) updateLinkSeedEnvSummary(linkSeedProbePayload(data));

  let statusText = data.status || phaseLabel;
  if (phase === "starting") statusText = "正在启动采集…";
  if (phase === "waiting") statusText = "等待 Switch 连接…";
  $("link-seed-status").textContent = statusText;
  $("link-seed-phase").textContent = phaseLabel;
  $("link-seed-phase").className = `link-seed-phase is-${phase}`;

  document.querySelectorAll("#link-seed-steps .link-seed-step").forEach((step, index) => {
    step.classList.toggle("is-done", index < count);
    step.classList.toggle("is-current", running && index === count && count < 4);
  });
  const bar = $("link-seed-bar");
  const fill = $("link-seed-bar-fill");
  const percent = count >= 4 ? 100 : (count / 4) * 100;
  if (fill) fill.style.width = `${percent}%`;
  if (bar) bar.setAttribute("aria-valuenow", String(count));

  const meta = [];
  if (data.elapsed_seconds) meta.push(`${!data.running || phase === "done" ? "总用时" : "已用"} ${linkSeedClock(data.elapsed_seconds)}`);
  if (data.connected) meta.push("Switch 已连接");
  meta.push(`已收录 ${count}/4`);
  if (phase === "solving" && data.percent) meta.push(`反推 ${Math.round(Number(data.percent) || 0)}%`);
  const boardPort = data.probe?.board?.port || data.environment?.configured_board_port || "";
  if (boardPort && boardPort !== "auto") meta.push(`串口 ${boardPort}`);
  $("link-seed-meta").textContent = meta.join(" · ");

  const error = String(data.error || "").trim();
  showLinkSeedError(error);

  const result = $("link-seed-result");
  const resultPlaceholder = $("link-seed-result-placeholder");
  if (data.seed) {
    result.classList.remove("hidden");
    resultPlaceholder?.classList.add("hidden");
    $("link-seed-result-value").textContent = data.seed;
    const note = $("link-seed-result-note");
    if (note) {
      note.textContent = data.applied
        ? "已自动填入左侧 Seed；也可以直接点「填入并计算」。"
        : "已找到 Seed，但自动填入失败；请复制后手动填入。";
    }
  } else {
    result.classList.add("hidden");
    resultPlaceholder?.classList.remove("hidden");
  }

  $("link-seed-start").disabled = running || linkSeedStarting;
  $("link-seed-stop").disabled = !running || phase === "stopping" || linkSeedStarting;
  $("link-seed-stop").textContent = phase === "stopping" ? "正在结束…" : "停止";
  const solveCurrent = $("link-seed-solve-current");
  if (solveCurrent) {
    const canSolveCurrent = !running && count >= 2 && count < 4
      && !["done", "solving", "stopping"].includes(phase);
    solveCurrent.classList.toggle("hidden", !canSolveCurrent);
    if (canSolveCurrent) solveCurrent.textContent = `用已收录的 ${count} 只反推 Seed`;
  }
  $("link-seed-probe-btn").disabled = running;
  $("link-seed-choose-keys").disabled = running;
  $("link-seed-solve-last").disabled = running;
  $("link-seed-code").disabled = running;
  $("link-seed-channel").disabled = running;
  $("link-seed-seconds").disabled = running;
  $("link-seed-start").textContent = linkSeedStarting
    ? "正在启动…"
    : running
      ? (phase === "waiting" ? "等待连接…" : phase === "solving" ? "反推中…" : "采集中…")
      : "开始采集";

  const log = Array.isArray(data.log) ? data.log.join("\n") : "";
  const logNode = $("link-seed-log");
  if (log && log !== linkSeedLastLog) {
    linkSeedLastLog = log;
    const visible = !logNode.classList.contains("hidden");
    const nearBottom = logNode.scrollHeight - logNode.scrollTop - logNode.clientHeight < 60;
    logNode.textContent = log;
    if (visible && nearBottom) logNode.scrollTop = logNode.scrollHeight;
  }

  if (phase === "done" && data.seed && linkSeedTerminalSeen !== "done") {
    linkSeedTerminalSeen = "done";
    $("quick-seed").value = data.seed;
    loadSeedState().catch(() => {});
    showToast("联机采集完成，Seed 已自动填入。");
  } else if (["stopped", "failed"].includes(phase) && linkSeedTerminalSeen !== phase) {
    linkSeedTerminalSeen = phase;
    if (phase === "failed") showToast("联机采集失败，详情见运行日志。");
  }
  if (running) linkSeedTerminalSeen = "";
}

function ensureLinkSeedPolling() {
  if (linkSeedPollTimer) return;
  linkSeedPollTimer = window.setInterval(pollLinkSeedStatus, 1200);
}

async function pollLinkSeedStatus() {
  try {
    const data = await api("/api/link/status", { timeoutMs: 15000 });
    renderLinkSeedStatus(data);
    if (!data.running && ["done", "stopped", "failed"].includes(data.phase)) {
      window.setTimeout(() => {
        if (!linkSeedPollTimer) return;
        window.clearInterval(linkSeedPollTimer);
        linkSeedPollTimer = null;
      }, 1600);
    }
  } catch (error) {
    showLinkSeedError(`读取联机状态失败：${error.message}`);
  }
}

async function openLinkSeedModal() {
  const modal = $("link-seed-modal");
  if (!modal) return;
  modal.classList.remove("hidden", "is-exiting");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("link-seed-open");
  setLinkSeedMode("detail");
  linkSeedTerminalSeen = "";
  showLinkSeedError("");
  if (!$("link-seed-code").value.trim()) $("link-seed-code").value = "11111111";
  loadLinkSeedSettings();
  try {
    const data = await api("/api/link/status", { timeoutMs: 15000 });
    renderLinkSeedStatus(data);
    if (data.running) {
      if (data.probe?.checked_at) renderLinkSeedProbe(linkSeedProbePayload(data));
    } else {
      await probeLinkSeed(false);
    }
  } catch (_) {
    await probeLinkSeed(true);
  }
  ensureLinkSeedPolling();
}

function closeLinkSeedModal() {
  const modal = $("link-seed-modal");
  if (!modal || modal.classList.contains("hidden")) return;
  closeModalWithExit(modal, () => {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("link-seed-open");
    // A running collection keeps polling so the Seed is still applied when it
    // finishes; the interval stops itself on a terminal phase.
    if (!linkSeedRunning && linkSeedPollTimer) {
      window.clearInterval(linkSeedPollTimer);
      linkSeedPollTimer = null;
    }
  });
}

async function startLinkSeed() {
  const code = $("link-seed-code").value.trim();
  if (!/^\d{8}$/.test(code)) {
    showLinkSeedError("联机密码必须是 8 位数字（与 Switch 本地交换界面一致）。");
    $("link-seed-code").focus();
    return;
  }
  if (linkSeedStarting) return;
  linkSeedStarting = true;
  linkSeedTerminalSeen = "";
  linkSeedLastLog = "";
  $("link-seed-start").disabled = true;
  $("link-seed-start").textContent = "正在启动…";
  showLinkSeedError("");
  try {
    const data = await api("/api/link/start", {
      method: "POST",
      body: JSON.stringify({
        code,
        channel: Number($("link-seed-channel").value || 6),
        seconds: Number($("link-seed-seconds").value || 1800)
      }),
      timeoutMs: 90000
    });
    resetLinkAutoSpecies();
    renderLinkSeedProbe(linkSeedProbePayload(data));
    renderLinkSeedStatus(data);
    if (data.warning) showToast(data.warning);
    else showToast("已启动联机采集，请按步骤在 Switch 上操作。");
    ensureLinkSeedPolling();
  } catch (error) {
    showLinkSeedError(error.message);
    setLinkSeedMode("detail");
    $("link-seed-advanced").open = true;
    $("link-seed-start").disabled = false;
    $("link-seed-start").textContent = "开始采集";
  } finally {
    linkSeedStarting = false;
  }
}

async function stopLinkSeed() {
  try {
    const data = await api("/api/link/stop", { method: "POST", body: JSON.stringify({}), timeoutMs: 30000 });
    renderLinkSeedStatus(data);
    showToast("正在停止采集并释放无线板…");
  } catch (error) {
    showLinkSeedError(`停止失败：${error.message}`);
  }
}

async function solveLastLinkSeed() {
  try {
    linkSeedLastLog = "";
    linkSeedTerminalSeen = "";
    const data = await api("/api/link/solve-last", {
      method: "POST",
      body: JSON.stringify({}),
      timeoutMs: 90000
    });
    renderLinkSeedStatus(data);
    ensureLinkSeedPolling();
    showToast("正在用最近保存的四只记录重算 Seed…");
  } catch (error) {
    showLinkSeedError(`重算失败：${error.message}`);
  }
}

async function chooseLinkSeedKeys() {
  try {
    const data = await api("/api/link/choose-keys", {
      method: "POST",
      body: JSON.stringify({}),
      timeoutMs: 120000
    });
    if (data.cancelled) return;
    showToast(data.imported ? "prod.keys 已导入到工具内，可断网/移动原文件后继续使用。" : "prod.keys 路径已保存。");
    await probeLinkSeed(true);
  } catch (error) {
    showLinkSeedError(`选择密钥失败：${error.message}`);
  }
}

function calculateFromLinkSeed() {
  const seed = $("link-seed-result-value").textContent.trim();
  if (!/^\d+$/.test(seed)) {
    showLinkSeedError("还没有可用的 Seed。");
    return;
  }
  closeLinkSeedModal();
  const quick = $("quick-seed");
  quick.value = seed;
  showToast("Seed 已填入，正在计算路径…");
  $("calculate-button").click();
}

initializeAppearance();
document.querySelectorAll("[data-theme-choice]").forEach(button => {
  button.addEventListener("click", () => setAppearanceTheme(button.dataset.themeChoice));
});
$("appearance-dark-mode").addEventListener("change", event => setDarkMode(event.target.checked));

$("quick-seed").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    applyQuickSeed();
  }
});
$("apply-quick-seed").addEventListener("click", applyQuickSeed);
$("copy-seed").addEventListener("click", () => copyText($("current-seed").textContent === "尚未读取" ? "" : $("current-seed").textContent));
$("link-quick-toggle").addEventListener("click", () => setLinkQuickExpanded(!linkQuickExpanded));
$("link-quick-detail").addEventListener("click", openLinkQuickDetail);
// 单按钮四态循环：idle→start，running→stop；过渡态 disabled 不会触发。
$("link-quick-start").addEventListener("click", () => {
  if (linkQuickUiState === "idle") startLinkQuick();
  else if (linkQuickUiState === "running") stopLinkQuick();
});
$("link-seed-code").addEventListener("input", event => {
  event.target.value = event.target.value.replace(/\D+/g, "").slice(0, 8);
});
$("link-seed-close").addEventListener("click", closeLinkSeedModal);
["link-seed-close", "close-settings", "result-detail-close"].forEach(id => {
  const button = $(id);
  if (!button) return;
  button.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (id === "link-seed-close") closeLinkSeedModal();
    else if (id === "close-settings") closeSettingsModal();
    else closeResultDetailModal();
  });
});
$("link-seed-detail-toggle").addEventListener("click", toggleLinkSeedDetail);
$("link-seed-start").addEventListener("click", startLinkSeed);
$("link-seed-stop").addEventListener("click", stopLinkSeed);
$("link-seed-probe-btn").addEventListener("click", () => probeLinkSeed(true));
$("link-seed-choose-keys").addEventListener("click", chooseLinkSeedKeys);
$("link-seed-solve-last").addEventListener("click", solveLastLinkSeed);
$("link-seed-solve-current").addEventListener("click", solveLastLinkSeed);
$("link-seed-open-resources").addEventListener("click", openLinkSeedResources);
$("link-seed-copy").addEventListener("click", () => copyText($("link-seed-result-value").textContent.trim()));
$("link-seed-calculate").addEventListener("click", calculateFromLinkSeed);
$("link-seed-log-open").addEventListener("click", toggleLinkSeedLog);
$("link-seed-log-copy").addEventListener("click", copyLinkSeedLog);
$("link-seed-code").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    startLinkSeed();
  }
});
$("link-seed-modal").addEventListener("click", event => {
  if (event.target === $("link-seed-modal")) closeLinkSeedModal();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("link-seed-modal").classList.contains("hidden")) {
    closeLinkSeedModal();
  }
});
$("theme-toggle").addEventListener("click", toggleTheme);
["show-only-shiny", "show-only-alpha", "show-default-path", "show-multi-path"].forEach(id => {
  $(id).addEventListener("change", applyResultFilters);
});
$("calculate-form").addEventListener("submit", submitCalculation);
$("multi-group")?.addEventListener("change", applyMultiGroupDefaults);
$("calculate-form").addEventListener("change", event => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  const field = target.closest(".field");
  if (!field) return;
  if (field._selectionPulseTimer) window.clearTimeout(field._selectionPulseTimer);
  field.classList.remove("selection-updated");
  void field.offsetWidth;
  field.classList.add("selection-updated");
  field._selectionPulseTimer = window.setTimeout(() => {
    field.classList.remove("selection-updated");
    field._selectionPulseTimer = null;
  }, 300);
});
$("appearance").addEventListener("change", () => syncAppearanceMode(true));
$("frpokemon").addEventListener("change", () => {
  $("frpokemon").dataset.userChosen = "1";
  updateBonusSpecies();
});
$("brpokemon").addEventListener("change", () => {
  $("brpokemon").dataset.userChosen = "1";
});
document.querySelectorAll("[data-research-bulk]").forEach(button => {
  button.addEventListener("click", () => { setAllResearchLevels(button.dataset.researchBulk); });
});
$("pokemon-research-search").addEventListener("input", renderResearchCatalog);
$("pokemon-research-list").addEventListener("change", event => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.matches("input[data-species-key][data-research-level]")) {
    changePokemonResearchLevel(target.dataset.speciesKey, target.dataset.researchLevel);
  }
});
$("pokemon-shiny-charm").addEventListener("change", () => {
  persistPokemonSettings();
  updateSpawnRollSummary();
});
$("choose-download-pokemon-assets").addEventListener("click", () => choosePokemonAssetAction("download"));
$("choose-skip-pokemon-assets").addEventListener("click", () => choosePokemonAssetAction("skip"));
$("check-pokemon-assets").addEventListener("click", () => refreshPokemonAssetStatus(true));
$("download-pokemon-assets").addEventListener("click", () => {
  // Explicit consent is required even when retrying a partial or interrupted download.
  showPokemonAssetPrompt("manual");
});
$("open-pokemon-assets").addEventListener("click", openPokemonAssetFolder);

$("refresh-engine-status").addEventListener("click", loadEngineStatus);
$("refresh-resources").addEventListener("click", loadResources);
$("unified-refresh")?.addEventListener("click", refreshUnifiedResources);
$("unified-download-all")?.addEventListener("click", downloadAllAutoResources);
$("board-detect")?.addEventListener("click", () => refreshBoardStatus(true));
$("board-flash")?.addEventListener("click", startBoardFlash);
$("board-flash-now")?.addEventListener("click", startBoardFlash);
$("unified-open-cache")?.addEventListener("click", async () => {
  try {
    await api("/api/resources/open-cache", { method: "POST", body: JSON.stringify({}), timeoutMs: 15000 });
  } catch (error) {
    showToast(`无法打开缓存目录：${error.message}`);
  }
});
$("open-cache-folder").addEventListener("click", async () => {
  try {
    await api("/api/resources/open-cache", { method: "POST", body: JSON.stringify({}), timeoutMs: 15000 });
  } catch (error) {
    showToast(`无法打开缓存目录：${error.message}`);
  }
});
$("resource-prompt-download").addEventListener("click", downloadMissingResources);
$("resource-prompt-later").addEventListener("click", dismissResourcePrompt);$("copy-engine-log").addEventListener("click", copyDiagnosticsReport);
$("copy-diagnostics-banner").addEventListener("click", copyDiagnosticsReport);
$("copy-installer-log-path").addEventListener("click", () => copyText("offline_engine_setup.log"));

$("engine-auto-install").addEventListener("click", () => startEngineInstall("auto"));
$("engine-pick-zip").addEventListener("click", toggleEngineZipRow);
$("engine-choose-zip").addEventListener("click", chooseEngineZip);
$("engine-install-zip").addEventListener("click", () => startEngineInstall("zip"));
$("open-engine-folder").addEventListener("click", openEngineFolder);
$("open-upstream-repo").addEventListener("click", openEngineUpstream);
$("fix-engine-banner").addEventListener("click", () => {
  openSettingsModal();
  activateSettingsTab("resources");
  loadEngineGuide();
});
loadEngineGuide();

$("spawn-map").addEventListener("change", () => {
  confirmedSpawnPointId = null;
  spawnSelectedArea = "";
  resetSpawnMapConfirm();
  fillSpawnSpecies();
  updateSpawnAutoSummary();
  invalidateAlphaResults();
  renderSpawnMap();
});
$("spawn-spawner").addEventListener("change", () => {
  updateSpawnerLocationNote();
  updateSpawnAutoSummary();
  invalidateAlphaResults();
});
$("spawn-map-confirm-button").addEventListener("click", confirmSpawnMapPoint);
$("spawn-map-cancel").addEventListener("click", hideSpawnMapConfirm);
$("spawn-map-confirm-button").addEventListener("keydown", event => {
  if (event.key === "Enter") confirmSpawnMapPoint();
});
$("spawn-species").addEventListener("change", () => {
  $("spawn-species").dataset.userChosen = "1";
  confirmedSpawnPointId = null;
  spawnSelectedArea = "";
  resetSpawnMapConfirm();
  fillSpawnSpawners();
  updateSpawnRollSummary();
  updateSpawnAutoSummary();
  invalidateAlphaResults();
  renderSpawnMap();
});
$("spawn-mode-auto")?.addEventListener("click", () => setSpawnInputMode("auto"));
$("spawn-mode-manual")?.addEventListener("click", () => setSpawnInputMode("manual"));
$("spawn-map-title")?.addEventListener("click", () => {
  const select = $("spawn-map");
  if (!select) return;
  if (typeof select.showPicker === "function") {
    try { select.showPicker(); return; } catch {}
  }
  select.focus();
});
// 多只生成点地图：切换大区、标题伪下拉、关闭浮层
$("multi-map-select")?.addEventListener("change", () => {
  multiMapKey = $("multi-map-select").value || "ObsidianFieldlands";
  hideMultiMapConfirm();
  renderMultiMap();
});
$("multi-map-title")?.addEventListener("click", () => {
  const select = $("multi-map-select");
  if (!select) return;
  if (typeof select.showPicker === "function") {
    try { select.showPicker(); return; } catch {}
  }
  select.focus();
});
$("multi-map-cancel")?.addEventListener("click", hideMultiMapConfirm);
$("multi-map-confirm-select")?.addEventListener("click", confirmMultiMapSelection);
$("multi-group")?.addEventListener("change", () => {
  const group = (multiCatalog?.groups || []).find(
    (item) => String(item.id) === $("multi-group")?.value
  );
  if (group && $("multi-results")) renderMultiEmptyState(`已选择 ${multiGroupLabel(group)}`);
});
$("spawn-night")?.addEventListener("change", updateSpawnAutoSummary);
$("spawn-gender-ratio")?.addEventListener("change", updateSpawnAutoSummary);
$("spawn-fixed-gender")?.addEventListener("change", updateSpawnAutoSummary);
$("appearance").addEventListener("change", applyCalculateMode);
$("result-detail-close").addEventListener("click", closeResultDetailModal);
$("result-detail-modal").addEventListener("click", (event) => {
  if (event.target === $("result-detail-modal")) closeResultDetailModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeResultDetailModal();
});
// 多只结果卡片保留在左侧 #multi-fields 内（用户要求左侧栏下方展示刷闪路径），
// 多只结果放到右侧结果栏，与地图并排；不再挤在左侧参数栏。
const multiResultsBox = $("multi-results");
const multiResultsColumn = $("results-column");
if (multiResultsBox && multiResultsColumn && multiResultsBox.parentElement !== multiResultsColumn) {
  multiResultsColumn.appendChild(multiResultsBox);
}
multiResultsBox?.classList.add("multi-results-panel");

loadSpawnCatalog();
loadMultiCatalog();
applyCalculateMode();

/* ---------- 界面字号档位切换（只改 --fs-scale，不动布局） ---------- */
(function setupFontScale() {
  const KEY = "pla-mmo-fs-scale";
  const VALID = new Set(["auto", "compact", "standard", "comfort", "large", "xlarge"]);

  function applyScale(choice, save) {
    const value = VALID.has(choice) ? choice : "auto";
    document.body.dataset.fs = value;
    // 同步头部快捷菜单与设置面板两处选中态
    document.querySelectorAll("[data-fs-choice]").forEach(button => {
      const active = button.dataset.fsChoice === value;
      if (button.hasAttribute("aria-checked")) button.setAttribute("aria-checked", String(active));
      if (button.hasAttribute("aria-pressed")) button.setAttribute("aria-pressed", String(active));
    });
    const check = document.querySelector(".fs-menu-check");
    if (check) check.textContent = "✓";
    if (save) {
      try { localStorage.setItem(KEY, value); } catch (_) { /* 存储不可用时仅本次生效 */ }
    }
  }

  // 启动时读取偏好，默认 auto（2K 自动适应）
  let saved = "auto";
  try { saved = localStorage.getItem(KEY) || "auto"; } catch (_) {}
  applyScale(saved, false);

  // 快捷菜单开合
  const quickButton = $("fs-quick-button");
  const quickMenu = $("fs-quick-menu");
  function closeMenu() {
    if (!quickMenu) return;
    quickMenu.hidden = true;
    if (quickButton) quickButton.setAttribute("aria-expanded", "false");
  }
  if (quickButton && quickMenu) {
    quickButton.addEventListener("click", event => {
      event.stopPropagation();
      const willOpen = quickMenu.hidden;
      quickMenu.hidden = !willOpen;
      quickButton.setAttribute("aria-expanded", String(willOpen));
    });
    document.addEventListener("click", event => {
      if (quickMenu.hidden) return;
      if (!quickMenu.contains(event.target) && event.target !== quickButton) closeMenu();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") closeMenu();
    });
  }

  // 所有档位按钮（快捷菜单 + 设置面板）
  document.querySelectorAll("[data-fs-choice]").forEach(button => {
    button.addEventListener("click", () => {
      applyScale(button.dataset.fsChoice, true);
      closeMenu();
    });
  });
})();

/* ---------- 地图缩放与拖拽平移（图片与标记同步变换） ---------- */
function setupMapZoomPan(prefix) {
  const stage = $(`${prefix}-stage`);
  const world = $(`${prefix}-world`);
  const inner = $(`${prefix}-inner`);
  const image = $(`${prefix}-image`);
  const zoomValue = $(`${prefix}-zoom-value`);
  if (!stage || !world || !inner || !zoomValue) return;

  // 让正方形图片完整显示在长方形 stage 内：inner 取容器短边并居中。
  // 图片与标记都在 inner 内，标记百分比坐标因此始终与图片对齐。
  function layoutMapInner() {
    if (stage.classList.contains("hidden") || !stage.offsetWidth || !stage.offsetHeight) return;
    const size = Math.min(stage.clientWidth, stage.clientHeight);
    inner.style.width = `${size}px`;
    inner.style.height = `${size}px`;
    inner.style.left = `${(stage.clientWidth - size) / 2}px`;
    inner.style.top = `${(stage.clientHeight - size) / 2}px`;
  }

  // 图片加载与窗口变化时重算（图片尺寸变化会改变容器可用空间）
  if (image) image.addEventListener("load", layoutMapInner);
  window.addEventListener("resize", layoutMapInner);
  // 地图从隐藏变为显示时（定点模式开启）重算
  new MutationObserver(() => {
    if (!stage.classList.contains("hidden")) {
      requestAnimationFrame(layoutMapInner);
    }
  }).observe(stage, { attributes: true, attributeFilter: ["class"] });
  // 容器尺寸变化时重算：模式切换时结果区用 allow-discrete 过渡延迟隐藏，
  // stage 会经历中间态（约 360px）再到最终高度；renderSpawnMap 里同步 dispatch
  // 的 resize 只拿到中间态，会把 inner 算成小方块。ResizeObserver 在每次尺寸
  // 定格后补算一次，最终态一定正确，也覆盖字号切换/侧栏折叠等布局变化。
  if (typeof ResizeObserver !== "undefined") {
    // 回调已在布局定格后触发，且 inner 是 absolute 定位、改它不影响 stage 尺寸，
    // 不会形成观察循环；这里同步重算，避免 rAF 在后台标签页被节流导致地图残留小尺寸。
    new ResizeObserver(layoutMapInner).observe(stage);
  }
  // 初始主动布局一次（应对缓存图片不触发 load、或地图默认可见的情况）
  requestAnimationFrame(layoutMapInner);

  const MIN_SCALE = 1;
  const MAX_SCALE = 6;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startOffsetX = 0;
  let startOffsetY = 0;
  let moved = false;

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  function applyTransform() {
    world.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    zoomValue.textContent = `${Math.round(scale * 100)}%`;
  }

  function reset() {
    scale = 1;
    offsetX = 0;
    offsetY = 0;
    applyTransform();
  }

  // 以某个屏幕坐标为锚点缩放，保持该点在缩放前后位置不变
  function zoomAt(nextScale, anchorX, anchorY) {
    const rect = stage.getBoundingClientRect();
    const ax = anchorX - rect.left;
    const ay = anchorY - rect.top;
    const clamped = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    if (clamped === scale) return;
    const ratio = clamped / scale;
    offsetX = ax - (ax - offsetX) * ratio;
    offsetY = ay - (ay - offsetY) * ratio;
    scale = clamped;
    clampOffset();
    applyTransform();
  }

  // 限制平移范围：按 inner 实际位置与尺寸计算非对称区间（不能用对称 ±limit）。
  // 关键：图片尚未放大到覆盖可视区时，不能把 offset 强制归 0——否则缩放不跟鼠标。
  // 此时改用「保持可视区中心可见」的宽松边界，让以鼠标为锚点的缩放始终生效。
  function axisClamp(offset, innerStart, size, scale, viewSize) {
    const scaledSize = size * scale;
    const transformedStart = innerStart * scale + offset; // 变换后图片起点
    const transformedEnd = transformedStart + scaledSize;
    if (scaledSize >= viewSize) {
      // 图片足够大：要求完整覆盖可视区，不露白
      const min = viewSize - (innerStart + size) * scale;
      const max = -innerStart * scale;
      return clamp(offset, min, max);
    }
    // 图片不够大：允许平移以跟随鼠标缩放，但保证可视区中心始终落在图片内
    const center = viewSize / 2;
    if (transformedStart > center) return offset - (transformedStart - center);
    if (transformedEnd < center) return offset + (center - transformedEnd);
    return offset;
  }

  function clampOffset() {
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    if (!sw || !sh) return; // 元素不可见（未布局）时不做钳制
    const size = parseFloat(inner.style.width) || Math.min(sw, sh);
    const innerLeft = parseFloat(inner.style.left) || (sw - size) / 2;
    const innerTop = parseFloat(inner.style.top) || (sh - size) / 2;

    offsetX = axisClamp(offsetX, innerLeft, size, scale, sw);
    offsetY = axisClamp(offsetY, innerTop, size, scale, sh);
  }

  // 滚轮缩放
  stage.addEventListener("wheel", event => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoomAt(scale * factor, event.clientX, event.clientY);
  }, { passive: false });

  // 拖拽平移：标记上也可按下拖拽（用是否移动来区分点击，见下方 click 抑制）
  stage.addEventListener("pointerdown", event => {
    if (event.target.closest?.(".spawn-map-zoom, .spawn-map-confirm")) return; // 缩放控件与确认浮层不触发拖拽
    if (event.button !== 0 && event.pointerType === "mouse") return;
    dragging = true;
    moved = false;
    startX = event.clientX;
    startY = event.clientY;
    startOffsetX = offsetX;
    startOffsetY = offsetY;
    stage.classList.add("is-dragging");
    document.body.style.userSelect = "none"; // 防止拖拽时误选文字
    event.preventDefault();
  });
  // 在 document 上监听 move/up，鼠标移出地图区域也能继续拖拽
  document.addEventListener("pointermove", event => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
    offsetX = startOffsetX + dx;
    offsetY = startOffsetY + dy;
    clampOffset();
    applyTransform();
  });
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    stage.classList.remove("is-dragging");
    document.body.style.userSelect = "";
  }
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);

  // 阻止拖拽后误触发的点击
  stage.addEventListener("click", event => {
    if (moved) { event.stopPropagation(); event.preventDefault(); moved = false; }
  }, true);

  // 按钮控制
  const centerX = () => stage.getBoundingClientRect().left + stage.getBoundingClientRect().width / 2;
  const centerY = () => stage.getBoundingClientRect().top + stage.getBoundingClientRect().height / 2;
  $(`${prefix}-zoom-in`)?.addEventListener("click", () => zoomAt(scale * 1.25, centerX(), centerY()));
  $(`${prefix}-zoom-out`)?.addEventListener("click", () => zoomAt(scale / 1.25, centerX(), centerY()));
  $(`${prefix}-zoom-reset`)?.addEventListener("click", reset);

  // 切换地图/退出模式时复位，避免下次打开仍是放大的旧视图
  const observer = new MutationObserver(() => {
    if (stage.classList.contains("hidden")) reset();
  });
  observer.observe(stage, { attributes: true, attributeFilter: ["class"] });

  applyTransform();
}
setupMapZoomPan("spawn-map"); // 定点头目地图
setupMapZoomPan("multi-map"); // 多只生成点地图（同一套滚轮/拖拽/复位交互）

/* ---------- 统一弹窗无障碍：ESC / 焦点陷阱 / 焦点恢复 / aria-hidden ----------
   6 个弹窗沿用各自的开关函数，这里只做统一的键盘与焦点行为，避免改动业务逻辑。 */
(function setupModalAccessibility() {
  // dismiss 指定 ESC 时如何关闭：函数优先，否则点击兜底按钮。
  const MODALS = [
    { id: "settings-modal", dismiss: () => closeSettingsModal?.() },
    { id: "seed-confirm-modal", dismiss: () => closeSeedConfirmation?.(false) },
    { id: "link-seed-modal", dismiss: () => closeLinkSeedModal?.() },
    { id: "result-detail-modal", dismiss: () => closeResultDetailModal?.() },
    { id: "resource-prompt", dismiss: () => $("resource-prompt-later")?.click() },
    { id: "pokemon-assets-prompt", dismiss: () => $("choose-skip-pokemon-assets")?.click() }
  ];
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const state = new Map(); // id -> { prevFocus, wasOpen }

  function isOpen(el) {
    return el && !el.classList.contains("hidden");
  }
  function topOpen() {
    for (let i = MODALS.length - 1; i >= 0; i--) {
      const el = $(MODALS[i].id);
      if (isOpen(el)) return MODALS[i];
    }
    return null;
  }
  function onOpened(cfg, el) {
    const prev = document.activeElement;
    state.set(cfg.id, { prevFocus: prev && prev !== document.body ? prev : null });
    el.setAttribute("aria-hidden", "false");
    if (cfg.id === "pokemon-assets-prompt") document.body.classList.add("asset-prompt-open");
    // 让弹窗自身可聚焦，作为焦点陷阱的兜底容器。
    if (el.tabIndex < 0) el.tabIndex = -1;
    requestAnimationFrame(() => {
      if (!isOpen(el)) return;
      const first = el.querySelector(FOCUSABLE);
      if (first) first.focus();
      else el.focus();
    });
  }
  function onClosed(cfg, el) {
    const s = state.get(cfg.id);
    state.delete(cfg.id);
    if (cfg.id === "pokemon-assets-prompt") document.body.classList.remove("asset-prompt-open");
    if (el.hasAttribute("aria-hidden")) el.setAttribute("aria-hidden", "true");
    if (s?.prevFocus && document.contains(s.prevFocus) && typeof s.prevFocus.focus === "function") {
      requestAnimationFrame(() => s.prevFocus.focus());
    }
  }

  MODALS.forEach(cfg => {
    const el = $(cfg.id);
    if (!el) return;
    state.set(cfg.id, { wasOpen: isOpen(el) });
    new MutationObserver(() => {
      const open = isOpen(el);
      const prev = state.get(cfg.id)?.wasOpen;
      if (open !== prev) {
        state.set(cfg.id, { ...(state.get(cfg.id) || {}), wasOpen: open });
        if (open) onOpened(cfg, el);
        else onClosed(cfg, el);
      }
    }).observe(el, { attributes: true, attributeFilter: ["class"] });
  });

  document.addEventListener("keydown", event => {
    const top = topOpen();
    if (!top) return;
    const el = $(top.id);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      top.dismiss();
      return;
    }
    if (event.key === "Tab") {
      const nodes = [...el.querySelectorAll(FOCUSABLE)].filter(n => n.offsetParent !== null || n === document.activeElement);
      if (!nodes.length) { event.preventDefault(); el.focus(); return; }
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !el.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
  }, true); // 捕获阶段，优先于各弹窗自己的 ESC 处理
})();

/* -------------------------------------------------------------------------
 * Update centre: GitHub release check, download/manual package, cleanup.
 * All requests return JSON even for expected failures, so they intentionally
 * bypass the global api() helper which throws away hint/detail fields.
 * ---------------------------------------------------------------------- */
let updateSnapshot = null;
let updateCheckData = null;
let updateDownloadState = null;
let updateInstallToken = "";
let updateInstallKind = "";
let updateManualToken = "";
let updateManualKind = "";
let updateManualVersion = "";
let updatePollTimer = null;
let cleanupTargets = [];
let updateBannerDismissed = false;

async function updateRequest(url, options = {}) {
  const { timeoutMs = 30000, ...requestOptions } = options;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...requestOptions, signal: controller.signal });
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`服务器响应不是 JSON（HTTP ${response.status}）`); }
    if (!data || typeof data !== "object") throw new Error("服务器返回了无效响应。");
    return data;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`请求超时（${Math.ceil(timeoutMs / 1000)} 秒）`);
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function updateErrorMarkup(data) {
  const message = data?.error || "操作失败。";
  const hint = data?.hint || "";
  return `${escapeUpdateText(message)}${hint ? `<span class="update-error-hint">${escapeUpdateText(hint)}</span>` : ""}`;
}

function escapeUpdateText(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

function setUpdateError(message, hint = "") {
  const node = $("update-error");
  if (!node) return;
  if (!message) {
    node.classList.add("hidden");
    node.textContent = "";
    return;
  }
  node.innerHTML = `<strong>${escapeUpdateText(message)}</strong>${hint ? `<span class="update-error-hint">${escapeUpdateText(hint)}</span>` : ""}`;
  node.classList.remove("hidden");
}

function updateModeLabel(mode) {
  return mode === "installed" ? "安装版 · Setup" : "便携版 · ZIP";
}

function updateCheckedLabel(value) {
  if (!value) return "尚未检查";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "最近检查时间未知";
  return `最近检查：${date.toLocaleString("zh-CN", { hour12: false })}`;
}

function setUpdateBannerVisible(visible, version = "") {
  const banner = $("update-banner");
  if (!banner) return;
  banner.classList.toggle("hidden", !visible);
  if (visible && $("update-banner-version")) {
    $("update-banner-version").textContent = version ? `v${String(version).replace(/^v/i, "")}` : "发现新版本";
  }
}

function renderUpdateCheck(data) {
  updateCheckData = data;
  if (!data) return;
  const mode = data.mode || "portable";
  if ($("update-mode-pill")) $("update-mode-pill").textContent = updateModeLabel(mode);
  if ($("update-current-version")) $("update-current-version").textContent = `v${data.current_version || ""}`;
  if ($("update-last-checked")) $("update-last-checked").textContent = updateCheckedLabel(data.checked_at);

  const status = $("update-status");
  if (status) {
    status.classList.remove("success", "error");
    if (!data.ok) {
      status.textContent = "检查更新失败。";
      status.classList.add("error");
    } else if (data.update_available) {
      const asset = data.asset || {};
      const size = asset.size ? ` · ${formatResourceSize(asset.size)}` : "";
      status.textContent = data.skipped
        ? `发现 v${data.latest_version}，但你已跳过此版本。`
        : `发现新版本 v${data.latest_version}${size}。`;
      status.classList.add("success");
    } else {
      status.textContent = "当前已经是最新版本。";
      status.classList.add("success");
    }
  }

  const available = $("update-available");
  const hasUpdate = Boolean(data.ok && data.update_available);
  if (available) available.classList.toggle("hidden", !hasUpdate);
  if (hasUpdate) {
    if ($("update-latest-version")) $("update-latest-version").textContent = `v${data.latest_version}`;
    if ($("update-notes")) $("update-notes").textContent = data.notes || "该版本没有提供额外更新说明。";
    const skip = $("update-skip");
    if (skip) skip.textContent = data.skipped ? "恢复更新提示" : "跳过此版本";
    const download = $("update-download");
    if (download) download.classList.toggle("hidden", Boolean(data.skipped));
    if (data.skipped) {
      setUpdateBannerVisible(false);
    } else {
      let dismissed = "";
      try { dismissed = sessionStorage.getItem("pla-update-banner-dismissed") || ""; } catch (_) {}
      updateBannerDismissed = dismissed === String(data.latest_version);
      setUpdateBannerVisible(!updateBannerDismissed, data.latest_version);
    }
  } else {
    setUpdateBannerVisible(false);
  }

  if (!data.ok) {
    setUpdateError(data.error || "检查更新失败。", data.hint || "");
  } else {
    setUpdateError("");
  }
}

function renderUpdateDownload(download) {
  updateDownloadState = download || null;
  const box = $("update-progress");
  const button = $("update-download");
  const install = $("update-install");
  if (!box) return;
  if (!download || download.state === "idle") {
    box.classList.add("hidden");
    if (button) { button.disabled = false; button.textContent = "下载更新包"; }
    return;
  }
  const state = String(download.state || "");
  const active = state === "starting" || state === "downloading" || state === "verifying";
  const percent = Math.max(0, Math.min(100, Number(download.percent) || 0));
  box.classList.remove("hidden");
  if ($("update-progress-label")) $("update-progress-label").textContent = download.message || "准备下载…";
  if ($("update-progress-percent")) $("update-progress-percent").textContent = `${percent}%`;
  if ($("update-progress-bar")) $("update-progress-bar").style.width = `${percent}%`;
  if ($("update-progress-detail")) {
    const total = Number(download.total) || 0;
    const got = Number(download.downloaded) || 0;
    $("update-progress-detail").textContent = total
      ? `${formatResourceSize(got)} / ${formatResourceSize(total)}${download.error ? ` · ${download.error}` : ""}`
      : (download.error || "更新包会下载到 cache/updates，校验后才会启用。");
  }
  if (button) {
    button.disabled = active;
    button.textContent = active ? "正在下载…" : (state === "success" ? "重新下载" : "下载更新包");
  }
  if (install) {
    const ready = state === "success" && download.path;
    install.classList.toggle("hidden", !ready);
    if (ready) {
      updateInstallToken = String(download.path).split(/[\\/]/).pop() || "";
      updateInstallKind = download.kind || (updateCheckData?.mode === "installed" ? "setup" : "portable");
    }
  }
  if (state === "failed") {
    setUpdateError(download.error || "下载失败。", download.hint || "");
  }
}

async function checkForUpdates(force = false, auto = false) {
  const button = $("update-check");
  if (button) { button.disabled = true; button.textContent = "检查中…"; }
  try {
    const data = await updateRequest(`/api/update/check?force=${force ? 1 : 0}&auto=${auto ? 1 : 0}`, { timeoutMs: 30000 });
    renderUpdateCheck(data);
    if (!auto && data.ok) {
      showToast(data.update_available ? `发现新版本 v${data.latest_version}` : "当前已是最新版本。");
    }
  } catch (error) {
    if (!auto) {
      setUpdateError(`检查更新失败：${error.message}`, "请检查网络或代理后重试；也可以直接打开发布页手动下载。");
      showToast(`检查更新失败：${error.message}`);
    }
  } finally {
    if (button) { button.disabled = false; button.textContent = "检查更新"; }
  }
}

async function startUpdateDownload() {
  setUpdateError("");
  try {
    const data = await updateRequest("/api/update/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      timeoutMs: 30000,
    });
    if (!data.ok) {
      setUpdateError(data.error || "无法开始下载。", data.hint || "");
      return;
    }
    renderUpdateDownload(data.download || { state: "starting", message: "准备下载更新…", percent: 0 });
    pollUpdateDownload();
  } catch (error) {
    setUpdateError(`无法开始下载：${error.message}`, "请检查网络或代理，也可以手动下载更新包。");
  }
}

function pollUpdateDownload() {
  if (updatePollTimer !== null) window.clearTimeout(updatePollTimer);
  const tick = async () => {
    updatePollTimer = null;
    try {
      const data = await updateRequest("/api/update/download/status", { timeoutMs: 15000 });
      if (!data.ok) throw new Error(data.error || "读取下载进度失败。");
      renderUpdateDownload(data.download);
      const state = String(data.download?.state || "");
      if (state === "success") {
        showToast("更新包已下载并通过校验。");
        return;
      }
      if (state === "failed") return;
      updatePollTimer = window.setTimeout(tick, 700);
    } catch (error) {
      setUpdateError(`读取下载进度失败：${error.message}`, "");
    }
  };
  updatePollTimer = window.setTimeout(tick, 300);
}

async function installDownloadedUpdate() {
  const token = updateInstallToken;
  if (!token) {
    setUpdateError("没有可安装的更新包，请先下载或选择文件。", "");
    return;
  }
  if (!window.confirm("安装更新会关闭当前程序，完成后自动重新启动。cache、设置和地图标注会保留。继续吗？")) return;
  const install = $("update-install");
  if (install) { install.disabled = true; install.textContent = "正在准备退出…"; }
  try {
    const data = await updateRequest("/api/update/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, kind: updateInstallKind }),
      timeoutMs: 20000,
    });
    if (!data.ok) throw new Error(data.error || "无法安装更新。");
    if ($("update-status")) $("update-status").textContent = "程序即将退出，更新完成后会自动重新启动…";
    showToast("程序即将退出并完成更新。", "ok");
  } catch (error) {
    setUpdateError(`无法安装更新：${error.message}`, "请关闭占用程序文件的窗口后重试；也可以手动运行下载的 Setup 或解压 portable ZIP。");
    if (install) { install.disabled = false; install.textContent = "退出并安装"; }
  }
}

async function skipUpdateVersion() {
  if (!updateCheckData?.latest_version) return;
  const restoring = Boolean(updateCheckData.skipped);
  try {
    const data = await updateRequest("/api/update/skip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: restoring ? "" : updateCheckData.latest_version }),
      timeoutMs: 15000,
    });
    if (!data.ok) throw new Error(data.error || "无法保存跳过记录。");
    updateCheckData = { ...updateCheckData, skipped: !restoring };
    renderUpdateCheck(updateCheckData);
    showToast(restoring ? "已恢复该版本的更新提示。" : "已跳过此版本，可在更新页恢复。", "ok");
  } catch (error) {
    setUpdateError(`保存跳过记录失败：${error.message}`, "");
  }
}

function setManualUpdateFilename(name) {
  const label = $("update-manual-filename");
  if (!label) return;
  const text = String(name || "").trim();
  label.textContent = text || "未选择文件";
  label.title = text;
}

function resetManualUpdateSelection() {
  updateManualToken = "";
  updateManualKind = "";
  updateManualVersion = "";
  const install = $("update-manual-install");
  if (install) install.disabled = true;
  const info = $("update-manual-info");
  if (info) { info.textContent = ""; info.className = "update-manual-info"; }
}

async function validateManualUpdate() {
  const input = $("update-manual-file");
  const file = input?.files?.[0];
  if (!file) {
    setUpdateError("请先选择一个 portable ZIP 或 Setup.exe。", "");
    return;
  }
  resetManualUpdateSelection();
  const button = $("update-manual-validate");
  if (button) { button.disabled = true; button.textContent = "校验中…"; }
  try {
    const form = new FormData();
    form.append("file", file, file.name);
    const response = await fetch("/api/update/manual", { method: "POST", body: form });
    let data;
    try { data = await response.json(); } catch { throw new Error(`服务器响应不是 JSON（HTTP ${response.status}）`); }
    if (!data.ok) {
      const info = $("update-manual-info");
      if (info) {
        info.className = "update-manual-info bad";
        info.textContent = `${data.error || "校验失败。"}${data.hint ? ` ${data.hint}` : ""}`;
      }
      setUpdateError(data.error || "更新包校验失败。", data.hint || "");
      return;
    }
    updateManualToken = data.token || "";
    updateManualKind = data.kind || (file.name.toLowerCase().endsWith(".exe") ? "setup" : "portable");
    updateManualVersion = data.version || "";
    const install = $("update-manual-install");
    if (install) install.disabled = !updateManualToken;
    const info = $("update-manual-info");
    if (info) {
      info.className = "update-manual-info ok";
      info.textContent = data.version
        ? `${data.message || "校验通过。"} 版本：${data.version}`
        : (data.message || "已选择安装包。");
    }
    setUpdateError("");
    showToast("更新包校验通过。", "ok");
  } catch (error) {
    setUpdateError(`更新包上传失败：${error.message}`, "请确认文件不超过 512 MB，且磁盘空间充足。");
  } finally {
    if (button) { button.disabled = false; button.textContent = "校验所选文件"; }
  }
}

async function installManualUpdate() {
  if (!updateManualToken) {
    setUpdateError("请先选择并校验更新包。", "");
    return;
  }
  const label = updateManualVersion ? `v${updateManualVersion}` : "所选安装包";
  if (!window.confirm(`将使用${label}覆盖当前程序，完成后自动重新启动。cache、设置和地图标注会保留。继续吗？`)) return;
  const install = $("update-manual-install");
  if (install) { install.disabled = true; install.textContent = "正在准备退出…"; }
  try {
    const data = await updateRequest("/api/update/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: updateManualToken, kind: updateManualKind }),
      timeoutMs: 20000,
    });
    if (!data.ok) throw new Error(data.error || "无法安装更新。");
    showToast("程序即将退出并完成更新。", "ok");
  } catch (error) {
    setUpdateError(`无法安装更新：${error.message}`, "请关闭占用程序文件的窗口后重试。");
    if (install) { install.disabled = false; install.textContent = "退出并安装"; }
  }
}

function renderCleanupTargets() {
  const list = $("cleanup-list");
  if (!list) return;
  list.textContent = "";
  for (const item of cleanupTargets) {
    const label = document.createElement("label");
    label.className = `cleanup-item${item.exists ? "" : " missing"}`;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.cleanupKey = item.key;
    checkbox.checked = Boolean(item.default && item.exists);
    const copy = document.createElement("span");
    copy.className = "cleanup-item-copy";
    const title = document.createElement("strong");
    title.textContent = item.label;
    const description = document.createElement("p");
    description.textContent = item.description || "";
    const path = document.createElement("code");
    path.textContent = item.path || "";
    copy.append(title, description, path);
    const size = document.createElement("span");
    size.className = "cleanup-item-size";
    size.textContent = item.exists ? formatResourceSize(item.size || 0) : "不存在";
    label.append(checkbox, copy, size);
    list.appendChild(label);
  }
  updateCleanupSelectAll();
}

function updateCleanupSelectAll() {
  const boxes = [...document.querySelectorAll("[data-cleanup-key]")];
  const all = $("cleanup-select-all");
  if (all) all.checked = boxes.length > 0 && boxes.every(box => box.checked);
}

async function loadCleanupTargets() {
  try {
    const data = await updateRequest("/api/update/cleanup", { timeoutMs: 20000 });
    if (!data.ok) throw new Error(data.error || "无法读取清理列表。");
    cleanupTargets = Array.isArray(data.targets) ? data.targets : [];
    renderCleanupTargets();
  } catch (error) {
    const list = $("cleanup-list");
    if (list) list.textContent = `读取清理列表失败：${error.message}`;
  }
}

async function runCleanup() {
  const keys = [...document.querySelectorAll("[data-cleanup-key]:checked")].map(box => box.dataset.cleanupKey);
  if (!keys.length) {
    showToast("请至少勾选一项要清理的数据。", "error");
    return;
  }
  const risky = keys.filter(key => ["cache_all", "custom_images", "map_annotations", "settings"].includes(key));
  const message = risky.length
    ? "你选择了会删除资源、地图标注或设置的项目，删除后可能无法恢复。确定继续吗？"
    : "将删除勾选的临时文件、更新包和日志。确定继续吗？";
  if (!window.confirm(message)) return;
  const button = $("cleanup-run");
  if (button) { button.disabled = true; button.textContent = "清理中…"; }
  const result = $("cleanup-result");
  try {
    const data = await updateRequest("/api/update/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys }),
      timeoutMs: 60000,
    });
    if (result) {
      result.className = `cleanup-result ${data.ok ? "ok" : "bad"}`;
      result.textContent = data.ok
        ? `已清理 ${keys.length} 项，释放 ${formatResourceSize(data.freed_bytes || 0)}。`
        : `部分项目未能删除：${(data.errors || []).join("；") || "未知错误"}`;
    }
    if (data.ok) showToast(`清理完成，释放 ${formatResourceSize(data.freed_bytes || 0)}。`, "ok");
    await loadCleanupTargets();
  } catch (error) {
    if (result) { result.className = "cleanup-result bad"; result.textContent = `清理失败：${error.message}`; }
    showToast(`清理失败：${error.message}`);
  } finally {
    if (button) { button.disabled = false; button.textContent = "清理所选数据"; }
  }
}

async function loadUpdatePanel() {
  try {
    const snapshot = await updateRequest("/api/update/status", { timeoutMs: 15000 });
    if (snapshot?.ok) {
      updateSnapshot = snapshot;
      if (snapshot.check) renderUpdateCheck(snapshot.check);
      renderUpdateDownload(snapshot.download);
      if (snapshot.manual?.token) {
        updateManualToken = snapshot.manual.token;
        updateManualKind = snapshot.manual.kind || "portable";
        updateManualVersion = snapshot.manual.version || "";
        const install = $("update-manual-install");
        if (install) install.disabled = false;
      }
    }
  } catch (_) {}
  await loadCleanupTargets();
}

function openUpdateSettings() {
  openSettingsModal();
  activateSettingsTab("updates");
  loadUpdatePanel();
}

function initUpdateUI() {
  $("update-check")?.addEventListener("click", () => checkForUpdates(true, false));
  $("update-download")?.addEventListener("click", startUpdateDownload);
  $("update-install")?.addEventListener("click", installDownloadedUpdate);
  $("update-skip")?.addEventListener("click", skipUpdateVersion);
  $("update-open-release")?.addEventListener("click", async () => {
    try { await updateRequest("/api/update/open-release", { method: "POST", timeoutMs: 10000 }); }
    catch (_) { window.open("https://github.com/Yuutalin/PLA-MMO-Seed-Path/releases/latest", "_blank", "noopener"); }
  });
  $("update-open-folder")?.addEventListener("click", async () => {
    try { await updateRequest("/api/update/open-folder", { method: "POST", timeoutMs: 15000 }); }
    catch (error) { setUpdateError(`无法打开更新目录：${error.message}`, ""); }
  });
  $("update-banner-open")?.addEventListener("click", openUpdateSettings);
  $("update-banner-later")?.addEventListener("click", () => {
    updateBannerDismissed = true;
    try { sessionStorage.setItem("pla-update-banner-dismissed", String(updateCheckData?.latest_version || "")); } catch (_) {}
    setUpdateBannerVisible(false);
  });
  $("update-manual-pick")?.addEventListener("click", () => $("update-manual-file")?.click());
  $("update-manual-file")?.addEventListener("change", event => {
    resetManualUpdateSelection();
    setManualUpdateFilename(event.target?.files?.[0]?.name || "");
  });
  $("update-manual-validate")?.addEventListener("click", validateManualUpdate);
  $("update-manual-install")?.addEventListener("click", installManualUpdate);
  $("cleanup-refresh")?.addEventListener("click", loadCleanupTargets);
  $("cleanup-run")?.addEventListener("click", runCleanup);
  $("cleanup-select-all")?.addEventListener("change", event => {
    document.querySelectorAll("[data-cleanup-key]").forEach(box => { box.checked = event.target.checked; });
  });
  $("cleanup-list")?.addEventListener("change", event => {
    if (event.target?.dataset?.cleanupKey) updateCleanupSelectAll();
  });
  checkForUpdates(false, true).catch(() => {});
}

(async function init() {
  // A setup error must not prevent the independent data requests from running.
  try {
    setupSearchableSelect($("frpokemon"));
    setupSearchableSelect($("brpokemon"));
  } catch (error) {
    console.error("宝可梦搜索框初始化失败", error);
    showToast(`宝可梦搜索框初始化失败：${error.message}`);
  }
  try {
    syncAppearanceMode(false);
  } catch (error) {
    console.error("群体类型初始化失败", error);
    showToast(`群体类型初始化失败：${error.message}`);
  }
  try {
    initUpdateUI();
  } catch (error) {
    console.error("更新中心初始化失败", error);
  }

  // Run startup requests independently. A slow settings/engine endpoint must
  // not prevent candidates from loading or leave a permanent loading label.
  const startupTasks = [
    loadSettings().catch(error => showToast(`设置读取失败：${error.message}`)),
    loadSeedState().catch(error => {
      const status = $("seed-status");
      status.textContent = "读取失败";
      status.className = "status-pill status-error";
      $("seed-error").textContent = error.message;
      $("seed-error").classList.remove("hidden");
      showToast(`Seed 状态读取失败：${error.message}`);
    }),
    loadEngineStatus(),
    loadResources(),
    loadSpecies(),
    loadResearchCatalog(),
    loadSpawnMaps(),
    refreshPokemonAssetStatus(false)
  ];
  await Promise.allSettled(startupTasks);
  try { syncAppearanceMode(false); } catch (error) { console.error("群体类型刷新失败", error); }
  refreshSearchableSelect($("frpokemon"));
  refreshSearchableSelect($("brpokemon"));
  ensureLinkQuickPolling();
  pollLinkQuickStatus();
  ensureLinkQuickProbeWarm();
  // Direct link used by the tutorial and by headless UI checks.
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("link") === "1") {
      window.setTimeout(() => openLinkSeedModal(), 250);
    }
    if (params.get("quick") === "1") {
      window.setTimeout(() => openLinkQuickPanel(), 350);
    }
    if (params.get("settings") === "resources" || params.get("settings") === "updates") {
      window.setTimeout(() => {
        openSettingsModal();
        activateSettingsTab(params.get("settings"));
      }, 250);
    }
  } catch (_) {}
})();
