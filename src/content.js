(function () {
  const ROOT_ID = "claude-usage-meter-root";
  const STORAGE_KEY = "claudeUsageMeterStateV2";
  const LEGACY_STORAGE_KEY = "claudeUsageMeterStateV1";
  const SETTINGS_URL = "https://claude.ai/settings/usage";
  const MESSAGE_REFRESH_USAGE = "CUM_REFRESH_USAGE";
  const MESSAGE_ORG_ID_DETECTED = "CUM_ORG_ID_DETECTED";

  const RENDER_NEUTRAL_PLACEHOLDERS = true;
  const UPDATE_DEBOUNCE_MS = 350;
  const DOM_POLL_MS = 3000;
  const ORG_SCAN_INTERVAL_MS = 3000;
  const BACKGROUND_REFRESH_MIN_MS = 30000;
  const STORAGE_PULL_MS = 90000;
  const USAGE_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

  const ICONS = {
    message:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/><path d="M8 9h8M8 13h5"/></svg>',
    external:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>'
  };

  const fallbackStorage = {
    async get(key) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw ? { [key]: JSON.parse(raw) } : {};
      } catch (_error) {
        return {};
      }
    },
    async set(value) {
      try {
        Object.entries(value).forEach(([key, item]) => {
          window.localStorage.setItem(key, JSON.stringify(item));
        });
      } catch (_error) {
        // Local persistence is best-effort.
      }
    }
  };

  const extensionStorage =
    typeof browser !== "undefined" && browser.storage && browser.storage.local
      ? browser.storage.local
      : typeof chrome !== "undefined" && chrome.storage && chrome.storage.local
        ? {
            get(key) {
              return new Promise((resolve) => chrome.storage.local.get(key, resolve));
            },
            set(value) {
              return new Promise((resolve) => chrome.storage.local.set(value, resolve));
            }
          }
        : fallbackStorage;

  let state = createDefaultState();
  let bar = null;
  let cachedComposer = null;
  let lastPath = window.location.pathname;
  let lastRenderedHtml = "";
  let saveTimer = 0;
  let updateTimer = 0;
  let domPollTimer = 0;
  let storagePullTimer = 0;
  let nextOrgScanAt = 0;
  let lastBackgroundRefreshRequestAt = 0;

  init();

  async function init() {
    state = await loadState();
    installStoragePolling();
    detectAndPersistOrgId(true);
    requestBackgroundUsageRefresh("content-open", true);
    installDomPoller();
    installRouteAndViewportListeners();
    await update({ forceComposerScan: true });
  }

  function createDefaultState() {
    return {
      day: getDayKey(),
      usage: {
        windowLabel: "5h",
        plan: "",
        usagePercent: null,
        resetText: "",
        resetAt: null,
        updatedAt: 0
      },
      usageByOrg: {},
      usageFetch: null
    };
  }

  async function loadState() {
    const base = createDefaultState();
    let stored = null;
    let legacy = null;

    try {
      const result = await extensionStorage.get([STORAGE_KEY, LEGACY_STORAGE_KEY]);
      stored = result && result[STORAGE_KEY];
      legacy = result && result[LEGACY_STORAGE_KEY];
    } catch (_error) {
      stored = null;
    }

    const merged = migrateState(Object.assign(base, legacy || {}, stored || {}));
    rollDayIfNeeded(merged, false);
    return merged;
  }

  function migrateState(input) {
    const base = createDefaultState();
    const output = base;
    const legacyUsage = (input && input.usage) || {};

    if (input && typeof input.day === "string") {
      output.day = input.day;
    }
    if (input && input.organizationId) {
      output.organizationId = input.organizationId;
    }
    if (input && input.usageFetch && typeof input.usageFetch === "object") {
      output.usageFetch = input.usageFetch;
    }

    output.usage = Object.assign(base.usage, legacyUsage, {
      usagePercent: coercePercent(legacyUsage.usagePercent ?? legacyUsage.sessionPercent),
      resetText: legacyUsage.resetText || legacyUsage.sessionReset || "",
      plan: legacyUsage.plan || "",
      resetAt: Number.isFinite(legacyUsage.resetAt) ? legacyUsage.resetAt : null
    });
    output.usageByOrg = input && input.usageByOrg && typeof input.usageByOrg === "object"
      ? input.usageByOrg
      : {};

    return output;
  }

  function scheduleSave() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
      try {
        await mergeLatestStoredStateBeforeSave();
        await extensionStorage.set({ [STORAGE_KEY]: state });
      } catch (_error) {
        // Do not let storage failures affect Claude.
      }
    }, 250);
  }

  function installStoragePolling() {
    scheduleStoragePull();
  }

  function scheduleStoragePull() {
    window.clearTimeout(storagePullTimer);
    storagePullTimer = window.setTimeout(async () => {
      await pullStoredState();
      scheduleStoragePull();
    }, STORAGE_PULL_MS);
  }

  async function pullStoredState() {
    let stored = null;
    try {
      const result = await extensionStorage.get([STORAGE_KEY]);
      stored = result && result[STORAGE_KEY];
    } catch (_error) {
      stored = null;
    }

    if (!stored) {
      return;
    }

    const beforeVersion = getUsageVersion(state);
    const beforeOrgId = state.organizationId || "";
    mergeStoredUsageState(stored);
    if (beforeVersion !== getUsageVersion(state) || beforeOrgId !== (state.organizationId || "")) {
      scheduleUpdate({});
    }
  }

  function mergeStoredUsageState(stored) {
    const incoming = migrateState(stored);
    mergeUsageByOrg(incoming.usageByOrg);
    const incomingOrgId = incoming.organizationId || "";
    const activeOrgId = state.organizationId || incomingOrgId;
    const incomingUsageOrgId = (incoming.usage && incoming.usage.organizationId) || incomingOrgId;
    const usageMatchesActiveOrg = !incomingUsageOrgId || !activeOrgId || incomingUsageOrgId === activeOrgId;

    if (usageMatchesActiveOrg && getUsageVersion(incoming) >= getUsageVersion(state)) {
      state.usage = Object.assign({}, state.usage, incoming.usage || {});
      if (incoming.usageFetch) {
        state.usageFetch = incoming.usageFetch;
      }
    }

    if (incoming.organizationId && !state.organizationId) {
      state.organizationId = incoming.organizationId;
    }
  }

  async function mergeLatestStoredStateBeforeSave() {
    let stored = null;
    try {
      const result = await extensionStorage.get([STORAGE_KEY]);
      stored = result && result[STORAGE_KEY];
    } catch (_error) {
      stored = null;
    }

    if (!stored) {
      return;
    }

    const incoming = migrateState(stored);
    mergeUsageByOrg(incoming.usageByOrg);
    const incomingOrgId = incoming.organizationId || "";
    const activeOrgId = state.organizationId || incomingOrgId;
    const incomingUsageOrgId = (incoming.usage && incoming.usage.organizationId) || incomingOrgId;
    const usageMatchesActiveOrg = !incomingUsageOrgId || !activeOrgId || incomingUsageOrgId === activeOrgId;

    if (usageMatchesActiveOrg && getUsageVersion(incoming) > getUsageVersion(state)) {
      state.usage = Object.assign({}, state.usage, incoming.usage || {});
      if (incoming.usageFetch) {
        state.usageFetch = incoming.usageFetch;
      }
    }
    if (incoming.organizationId && !state.organizationId) {
      state.organizationId = incoming.organizationId;
    }
  }

  function mergeUsageByOrg(incoming) {
    if (!incoming || typeof incoming !== "object") {
      return;
    }

    state.usageByOrg = state.usageByOrg && typeof state.usageByOrg === "object"
      ? state.usageByOrg
      : {};

    Object.entries(incoming).forEach(([orgId, usage]) => {
      const normalized = normalizeOrgId(orgId);
      if (!normalized || !usage || typeof usage !== "object") {
        return;
      }

      const existing = state.usageByOrg[normalized];
      if (!existing || getUsageVersion({ usage }) >= getUsageVersion({ usage: existing })) {
        state.usageByOrg[normalized] = Object.assign({}, usage, {
          organizationId: normalized
        });
      }
    });
  }

  function getUsageVersion(value) {
    const usage = (value && value.usage) || {};
    const usageFetch = (value && value.usageFetch) || {};
    return Math.max(
      Number(usage.updatedAt) || 0,
      Number(usage.lastErrorAt) || 0,
      Number(usageFetch.lastAttemptAt) || 0,
      Number(usageFetch.lastSuccessAt) || 0
    );
  }

  function requestBackgroundUsageRefresh(reason, force = false, knownOrgId = null) {
    const now = Date.now();
    if (!force && now - lastBackgroundRefreshRequestAt < BACKGROUND_REFRESH_MIN_MS) {
      return;
    }

    lastBackgroundRefreshRequestAt = now;
    const orgId = normalizeOrgId(knownOrgId) || detectAndPersistOrgId(force);
    sendRuntimeMessage({
      type: MESSAGE_REFRESH_USAGE,
      force,
      orgId,
      reason
    })
      .then((response) => {
        if (response && response.state) {
          mergeStoredUsageState(response.state);
          scheduleUpdate({});
        }
      })
      .catch(() => {
        // The content script still works without the optional background cache.
      });
  }

  function sendRuntimeMessage(message) {
    if (typeof browser !== "undefined" && browser.runtime && browser.runtime.sendMessage) {
      return browser.runtime.sendMessage(message);
    }
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(error);
            return;
          }
          resolve(response);
        });
      });
    }
    return Promise.resolve(null);
  }

  function detectAndPersistOrgId(force = false) {
    const now = Date.now();
    if (!force && now < nextOrgScanAt) {
      return state.organizationId || null;
    }

    nextOrgScanAt = now + ORG_SCAN_INTERVAL_MS;
    const orgId = detectOrganizationId(force) || state.organizationId || null;
    applyDetectedOrgId(orgId);

    return orgId;
  }

  function applyDetectedOrgId(orgId) {
    const normalized = normalizeOrgId(orgId);
    if (!normalized || normalized === state.organizationId) {
      return false;
    }

    const now = Date.now();
    state.organizationId = normalized;
    state.usage = getUsageForOrg(normalized) || createStaleUsageForOrg(normalized, now);
    scheduleSave();
    scheduleUpdate({});

    sendRuntimeMessage({
      type: MESSAGE_ORG_ID_DETECTED,
      orgId: normalized
    })
      .then((response) => {
        if (response && response.state) {
          mergeStoredUsageState(response.state);
          scheduleUpdate({});
        }
      })
      .catch(() => {
        // The local state was already updated and will be persisted locally.
      });

    return true;
  }

  function getUsageForOrg(orgId) {
    const normalized = normalizeOrgId(orgId);
    if (!normalized || !state.usageByOrg || !state.usageByOrg[normalized]) {
      return null;
    }

    return Object.assign({}, state.usageByOrg[normalized]);
  }

  function storeUsageForOrg(orgId, usage) {
    const normalized = normalizeOrgId(orgId);
    if (!normalized || !usage || typeof usage !== "object") {
      return;
    }

    state.usageByOrg = state.usageByOrg && typeof state.usageByOrg === "object"
      ? state.usageByOrg
      : {};
    state.usageByOrg[normalized] = Object.assign({}, usage, {
      organizationId: normalized
    });
  }

  function createStaleUsageForOrg(orgId, now) {
    return {
      organizationId: orgId,
      windowLabel: "5h",
      plan: "",
      usagePercent: null,
      resetText: "",
      resetAt: null,
      stale: true,
      updatedAt: now
    };
  }

  function detectOrganizationId(deep = false) {
    const fromLocation = findOrgIdInText(window.location.href);
    if (fromLocation) {
      return fromLocation;
    }

    const fromPerformance = findOrgIdInPerformance();
    if (fromPerformance) {
      return fromPerformance;
    }

    if (!deep) {
      return "";
    }

    const sessionStorageRef = getWebStorage("sessionStorage");
    const fromSessionStorage = findOrgIdInWebStorage(sessionStorageRef);
    if (fromSessionStorage) {
      return fromSessionStorage;
    }

    const localStorageRef = getWebStorage("localStorage");
    const fromLocalStorage = findOrgIdInWebStorage(localStorageRef);
    if (fromLocalStorage) {
      return fromLocalStorage;
    }

    const scripts = Array.from(document.scripts || [])
      .filter((script) => !script.src || /json|javascript/i.test(script.type || ""))
      .slice(-30);

    for (const script of scripts) {
      const orgId = findOrgIdInText((script.textContent || "").slice(0, 250000));
      if (orgId) {
        return orgId;
      }
    }

    return "";
  }

  function findOrgIdInPerformance() {
    if (typeof performance === "undefined" || !performance.getEntriesByType) {
      return "";
    }

    try {
      const entries = performance.getEntriesByType("resource");
      const firstIndex = Math.max(0, entries.length - 80);

      for (let index = entries.length - 1; index >= firstIndex; index -= 1) {
        const entry = entries[index];
        const orgId = findOrgIdInText(entry && entry.name);
        if (orgId) {
          return orgId;
        }
      }
    } catch (_error) {
      return "";
    }

    return "";
  }

  function getWebStorage(name) {
    try {
      return window[name];
    } catch (_error) {
      return null;
    }
  }

  function findOrgIdInWebStorage(storage) {
    if (!storage) {
      return "";
    }

    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        const raw = storage.getItem(key) || "";
        const structured = findOrgIdInStructuredText(raw);
        if (structured) {
          return structured;
        }

        const orgId = findOrgIdInText(`${key}:${raw.slice(0, 60000)}`);
        if (orgId) {
          return orgId;
        }
      }
    } catch (_error) {
      return "";
    }

    return "";
  }

  function findOrgIdInStructuredText(text) {
    if (!text || !/[\[{]/.test(text)) {
      return "";
    }

    try {
      return findOrgIdInValue(JSON.parse(text));
    } catch (_error) {
      return "";
    }
  }

  function findOrgIdInValue(value, path = [], depth = 0) {
    if (depth > 8 || value == null) {
      return "";
    }

    const pathText = path.join(".").toLowerCase();
    if (typeof value === "string") {
      const orgId = normalizeOrgId(value);
      return orgId && /organization|org/.test(pathText) ? orgId : "";
    }

    if (Array.isArray(value)) {
      for (const item of value.slice(0, 80)) {
        const orgId = findOrgIdInValue(item, path, depth + 1);
        if (orgId) {
          return orgId;
        }
      }
      return "";
    }

    if (typeof value === "object") {
      for (const [key, item] of Object.entries(value).slice(0, 250)) {
        const orgId = findOrgIdInValue(item, path.concat(key), depth + 1);
        if (orgId) {
          return orgId;
        }
      }
    }

    return "";
  }

  function findOrgIdInText(text) {
    const value = String(text || "");
    const endpointMatch = value.match(/\/api\/organizations\/([^/?#"'\\\s]+)/i);
    if (endpointMatch) {
      return normalizeOrgId(endpointMatch[1]);
    }

    const keyedMatch = value.match(
      /(?:organization_id|organizationId|org_id|orgId|currentOrganizationId|activeOrganizationId|active_org_id|organizationUUID)[^A-Za-z0-9_-]{0,40}([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|org_[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{20,})/i
    );
    if (keyedMatch) {
      return normalizeOrgId(keyedMatch[1]);
    }

    const nestedOrgMatch = value.match(
      /(?:organization|org)[\s\S]{0,160}?(?:uuid|id)[^A-Za-z0-9_-]{0,40}([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|org_[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{20,})/i
    );
    return nestedOrgMatch ? normalizeOrgId(nestedOrgMatch[1]) : "";
  }

  function normalizeOrgId(value) {
    const text = String(value || "").trim();
    const match =
      text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i) ||
      text.match(/\borg_[A-Za-z0-9_-]{8,}\b/) ||
      text.match(/\b[A-Za-z0-9_-]{20,}\b/);
    return match ? match[0] : "";
  }

  function installDomPoller() {
    window.clearTimeout(domPollTimer);
    domPollTimer = window.setTimeout(() => {
      const previousOrgId = state.organizationId || "";
      if (lastPath !== window.location.pathname) {
        lastPath = window.location.pathname;
        cachedComposer = null;
        detectAndPersistOrgId(true);
      }

      const orgId = detectAndPersistOrgId();
      if (orgId && orgId !== previousOrgId) {
        requestBackgroundUsageRefresh("org-detected", true, orgId);
      }

      if (!bar || !bar.isConnected || !cachedComposer || !cachedComposer.isConnected) {
        scheduleUpdate({ forceComposerScan: true });
      }

      installDomPoller();
    }, DOM_POLL_MS);
  }

  function installRouteAndViewportListeners() {
    window.addEventListener("resize", () => scheduleUpdate({ forceComposerScan: true }), {
      passive: true
    });
    window.addEventListener("focus", () => {
      scheduleUpdate({ forceComposerScan: true });
      detectAndPersistOrgId(true);
    }, {
      passive: true
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        scheduleUpdate({ forceComposerScan: true });
        detectAndPersistOrgId(true);
      }
    });
  }

  function scheduleUpdate(options = {}) {
    window.clearTimeout(updateTimer);
    updateTimer = window.setTimeout(() => update(options), UPDATE_DEBOUNCE_MS);
  }

  async function update(options = {}) {
    rollDayIfNeeded(state);
    await refreshUsageCacheFromPage();

    const composer = findComposerContainer(Boolean(options.forceComposerScan));

    if (!composer || isUsageSettingsPage()) {
      removeBar();
      return;
    }

    const usageState = buildUsageState();
    if (!usageState) {
      removeBar();
      return;
    }

    injectBarAfterComposer(composer, Boolean(options.forceComposerScan));
    renderBar(usageState);
  }

  function buildUsageState() {
    const usageData = getClaudeUsageData();
    if (!usageData && !RENDER_NEUTRAL_PLACEHOLDERS) {
      return null;
    }

    return {
      windowLabel: usageData ? usageData.windowLabel : "5h",
      plan: usageData ? usageData.plan : "Pro",
      usagePercent: usageData ? usageData.usagePercent : null,
      resetText: usageData ? usageData.resetText : "open usage to sync",
      chatMessages: null,
      todayMessages: null,
      tokensToday: null,
      tokensApproximate: true
    };
  }

  function getClaudeUsageData() {
    // TODO: replace this adapter if Claude exposes a stable first-party usage API.
    const usage = state.usage;
    if (usage.stale || (state.organizationId && usage.organizationId && usage.organizationId !== state.organizationId)) {
      return null;
    }
    if (!Number.isFinite(usage.usagePercent)) {
      return null;
    }

    const resetText = getCurrentResetText(usage);
    const hasFreshReset = Number.isFinite(usage.resetAt)
      ? usage.resetAt > Date.now() - 60 * 1000
      : Date.now() - usage.updatedAt < USAGE_CACHE_MAX_AGE_MS;

    if (!hasFreshReset) {
      requestBackgroundUsageRefresh("usage-window-expired", true, state.organizationId);
      return null;
    }

    return {
      windowLabel: usage.windowLabel || "5h",
      plan: usage.plan,
      usagePercent: usage.usagePercent,
      resetText,
      source: usage.source || "settings-cache"
    };
  }

  async function refreshUsageCacheFromPage() {
    if (!isUsageSettingsPage() || !document.body) {
      return;
    }

    detectAndPersistOrgId(true);
    const extracted = extractUsageFromSettingsPage();
    if (!extracted) {
      return;
    }

    const resetDelta = Math.abs((extracted.resetAt || 0) - (state.usage.resetAt || 0));
    const usageChanged =
      extracted.windowLabel !== state.usage.windowLabel ||
      extracted.plan !== state.usage.plan ||
      extracted.usagePercent !== state.usage.usagePercent ||
      extracted.resetText !== state.usage.resetText ||
      resetDelta > 60000;

    if (usageChanged || state.usage.stale) {
      state.usage = Object.assign({}, state.usage, extracted, {
        organizationId: state.organizationId || state.usage.organizationId || null,
        source: "settings-page",
        stale: false,
        updatedAt: Date.now()
      });
      storeUsageForOrg(state.usage.organizationId, state.usage);
      scheduleSave();
    }
  }

  function extractUsageFromSettingsPage() {
    const text = normalizeLines(document.body.innerText || "");
    if (!/usage|current session|5-hour|5 hour|resets/i.test(text)) {
      return null;
    }

    const currentBlock =
      blockBetween(text, /Current session/i, /Weekly|Today|Updated|Settings|Quit/i) ||
      blockBetween(text, /5[-\s]?Hour Window/i, /Weekly|Today|Updated|Settings|Quit/i) ||
      text;

    const usagePercent = pickPercent(currentBlock);
    if (!Number.isFinite(usagePercent)) {
      return null;
    }

    const rawReset = pickResetText(currentBlock);
    const plan = pickPlan(text);

    return {
      windowLabel: "5h",
      plan,
      usagePercent,
      resetText: normalizeResetText(rawReset),
      resetAt: parseResetAt(rawReset)
    };
  }

  function getUsageTone(percent) {
    if (!Number.isFinite(percent)) {
      return "neutral";
    }
    if (percent < 50) {
      return "low";
    }
    if (percent < 85) {
      return "medium";
    }
    return "high";
  }

  function renderBar(usageState) {
    if (!bar) {
      return;
    }

    const percent = coercePercent(usageState.usagePercent);
    const tone = getUsageTone(percent);
    const percentText = Number.isFinite(percent) ? `${percent}%` : "--";
    const progress = Number.isFinite(percent) ? `${percent}%` : "0%";
    const messageText = `${formatCountOrUnknown(usageState.chatMessages)} • ${formatCountOrUnknown(usageState.todayMessages)}`;
    const tokenText = formatTokenLabel(usageState.tokensToday, usageState.tokensApproximate);

    bar.dataset.usageTone = tone;
    bar.style.setProperty("--cum-progress", progress);
    bar.setAttribute("aria-label", "Open Claude usage settings");

    const html = `
      <span class="cum-section cum-window">
        <span class="cum-status-dot"></span>
        <span class="cum-window-label">${escapeHtml(usageState.windowLabel)}</span>
        <span class="cum-plan-badge">${escapeHtml(usageState.plan || "Pro")}</span>
      </span>
      <span class="cum-section cum-usage">
        <span class="cum-percent">${percentText}</span>
        <span class="cum-progress-track"><span class="cum-progress-fill"></span></span>
      </span>
      <span class="cum-section cum-reset">${escapeHtml(usageState.resetText || "open usage to sync")}</span>
      <span class="cum-section cum-messages">
        <span class="cum-icon">${ICONS.message}</span>
        <span>${messageText}</span>
      </span>
      <span class="cum-section cum-tokens">${escapeHtml(tokenText)}</span>
      <span class="cum-section cum-open">
        <span class="cum-icon">${ICONS.external}</span>
      </span>
    `;

    if (html !== lastRenderedHtml) {
      bar.innerHTML = html;
      lastRenderedHtml = html;
    }
  }

  function injectBarAfterComposer(composer, syncLayout = false) {
    let didInsert = false;

    if (!bar) {
      bar = document.createElement("button");
      bar.id = ROOT_ID;
      bar.type = "button";
      bar.className = "claude-usage-meter";
      bar.addEventListener("click", () => window.location.assign(SETTINGS_URL));
      didInsert = true;
    }

    if (composer.nextSibling !== bar) {
      composer.parentNode.insertBefore(bar, composer.nextSibling);
      didInsert = true;
    }

    if (syncLayout || didInsert) {
      syncBarLayoutWithComposer(composer);
    }
  }

  function syncBarLayoutWithComposer(composer) {
    const rect = composer.getBoundingClientRect();
    const computed = window.getComputedStyle(composer);

    bar.style.width = `${Math.round(rect.width)}px`;
    bar.style.maxWidth = computed.maxWidth && computed.maxWidth !== "none" ? computed.maxWidth : "100%";
    bar.style.marginLeft = computed.marginLeft;
    bar.style.marginRight = computed.marginRight;
  }

  function removeBar() {
    if (bar && bar.parentNode) {
      bar.parentNode.removeChild(bar);
    }
    lastRenderedHtml = "";
  }

  function findComposerContainer(force = false) {
    if (!force && cachedComposer && cachedComposer.isConnected) {
      return cachedComposer;
    }

    const candidates = Array.from(
      document.querySelectorAll("textarea,[contenteditable='true']")
    )
      .filter((node) => !node.closest(`#${ROOT_ID}`))
      .slice(-30)
      .reverse();

    for (const candidate of candidates) {
      const composer = findComposerAncestor(candidate);
      if (composer) {
        cachedComposer = composer;
        return composer;
      }
    }

    cachedComposer = null;
    return null;
  }

  function findComposerAncestor(node) {
    let current = node;

    for (let depth = 0; current && depth < 12; depth += 1) {
      if (current.id === ROOT_ID) {
        return null;
      }

      const rect = current.getBoundingClientRect ? current.getBoundingClientRect() : null;
      if (rect && isComposerLikeBox(current, rect)) {
        return current;
      }

      current = current.parentElement;
    }

    return null;
  }

  function isComposerLikeBox(node, rect) {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const hasInput = node.querySelector && node.querySelector("textarea,[contenteditable='true']");
    const hasButton = node.querySelector && node.querySelector("button,[role='button']");

    return (
      hasInput &&
      hasButton &&
      rect.width >= 300 &&
      rect.height >= 56 &&
      rect.height <= 360 &&
      rect.bottom > viewportHeight * 0.35 &&
      rect.top < viewportHeight
    );
  }

  function isUsageSettingsPage() {
    return /\/settings\/usage\/?$/i.test(window.location.pathname);
  }

  function rollDayIfNeeded(targetState, shouldSave = true) {
    if (targetState.day === getDayKey()) {
      return;
    }

    targetState.day = getDayKey();
    if (shouldSave) {
      scheduleSave();
    }
  }

  function normalizeLines(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n");
  }

  function blockBetween(text, startRe, endRe) {
    const start = text.search(startRe);
    if (start < 0) {
      return "";
    }

    const rest = text.slice(start);
    const end = rest.slice(1).search(endRe);
    return end >= 0 ? rest.slice(0, end + 1) : rest;
  }

  function pickPlan(text) {
    const match = text.match(/Plan usage limits\s+([A-Za-z][\w -]{1,24})/i);
    return match ? match[1].trim() : "";
  }

  function pickPercent(text) {
    const matches = Array.from(String(text || "").matchAll(/(\d{1,3})(?:\.\d+)?\s*%/g));
    if (!matches.length) {
      return null;
    }

    return coercePercent(Number(matches[matches.length - 1][1]));
  }

  function pickResetText(text) {
    const match = String(text || "").match(/Resets?\s+(?:in\s+)?([^\n]+)/i);
    return match ? match[1].replace(/\s+/g, " ").trim() : "";
  }

  function parseResetAt(text) {
    const duration = parseDurationMs(text);
    return duration > 0 ? Math.round((Date.now() + duration) / 60000) * 60000 : null;
  }

  function parseDurationMs(text) {
    let total = 0;
    const pattern = /(\d+(?:\.\d+)?)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/gi;
    let match;

    while ((match = pattern.exec(String(text || "")))) {
      const value = Number(match[1]);
      const unit = match[2].toLowerCase();
      if (unit.startsWith("d")) {
        total += value * 24 * 60 * 60 * 1000;
      } else if (unit.startsWith("h")) {
        total += value * 60 * 60 * 1000;
      } else {
        total += value * 60 * 1000;
      }
    }

    return total;
  }

  function getCurrentResetText(usage) {
    if (Number.isFinite(usage.resetAt)) {
      return `reset ${formatDuration(usage.resetAt - Date.now())}`;
    }

    const normalized = normalizeResetText(usage.resetText);
    return normalized ? `reset ${normalized}` : "";
  }

  function normalizeResetText(text) {
    return String(text || "")
      .trim()
      .replace(/^in\s+/i, "")
      .replace(/\bhours?\b|\bhrs?\b/gi, "h")
      .replace(/\bminutes?\b|\bmins?\b/gi, "m")
      .replace(/\s+/g, " ");
  }

  function formatDuration(milliseconds) {
    const minutesTotal = Math.max(0, Math.round(milliseconds / 60000));
    const hours = Math.floor(minutesTotal / 60);
    const minutes = minutesTotal % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }

  function coercePercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return null;
    }
    return Math.max(0, Math.min(100, Math.round(number)));
  }

  function formatTokens(value) {
    const number = Math.max(0, Math.round(Number(value) || 0));
    if (number >= 1000000) {
      return `${trimDecimal(number / 1000000)}M`;
    }
    if (number >= 1000) {
      return `${trimDecimal(number / 1000)}K`;
    }
    return String(number);
  }

  function formatTokenLabel(value, approximate) {
    if (value === null || value === undefined || value === "") {
      return "tokens today --";
    }
    const raw = Number(value);
    if (!Number.isFinite(raw)) {
      return "tokens today --";
    }
    const number = Math.max(0, Math.round(raw));
    return `tokens today ${approximate ? "~" : ""}${formatTokens(number)}`;
  }

  function trimDecimal(value) {
    return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  }

  function formatCount(value) {
    return String(Math.max(0, Math.round(Number(value) || 0)));
  }

  function formatCountOrUnknown(value) {
    if (value === null || value === undefined || value === "") {
      return "--";
    }
    return Number.isFinite(Number(value)) ? formatCount(value) : "--";
  }

  function getDayKey() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
