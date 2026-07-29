(function () {
  const ROOT_ID = "claude-usage-meter-root";
  const DETAILS_ID = "claude-usage-meter-details";
  const STORAGE_KEY = "claudeUsageMeterStateV2";
  const LEGACY_STORAGE_KEY = "claudeUsageMeterStateV1";
  const CONVERSATION_TOKENS_UI_KEY = "conversationTokensUI";
  const THEME_KEY = "claudeUsageMeterTheme";
  const SETTINGS_URL = "https://claude.ai/settings/usage";
  const MESSAGE_REFRESH_USAGE = "CUM_REFRESH_USAGE";
  const MESSAGE_ORG_ID_DETECTED = "CUM_ORG_ID_DETECTED";
  const MESSAGE_UPDATE_CONV_TOKENS = "CUM_UPDATE_CONV_TOKENS";

  const RENDER_NEUTRAL_PLACEHOLDERS = true;
  const UPDATE_DEBOUNCE_MS = 350;
  const DOM_POLL_MS = 3000;
  const ORG_SCAN_INTERVAL_MS = 3000;
  const PLAN_SCAN_INTERVAL_MS = 30000;
  const BACKGROUND_REFRESH_MIN_MS = 30000;
  const CONV_FETCH_INTERVAL_MS = 15000;
  const STORAGE_PULL_MS = 90000;
  const USAGE_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
  const COMPACT_LAYOUT_MAX_WIDTH = 820;
  const COMPACT_METER_RESERVE_PX = 48;

  const ICONS = {
    clock:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    refresh:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
    token:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg>'
  };

  const fallbackStorage = {
    async get(keys) {
      try {
        if (Array.isArray(keys)) {
          return keys.reduce((result, key) => {
            const raw = window.localStorage.getItem(key);
            if (raw) {
              result[key] = JSON.parse(raw);
            }
            return result;
          }, {});
        }

        const raw = window.localStorage.getItem(keys);
        return raw ? { [keys]: JSON.parse(raw) } : {};
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
  let nextPlanScanAt = 0;
  let lastBackgroundRefreshRequestAt = 0;
  let lastConvTokenFetchTime = 0;
  let lastConvTokenFetchId = null;
  let compactComposer = null;
  let didScanInlinePlan = false;
  let usageRefreshPending = false;
  let detailsOpen = false;
  let themePreference = "auto";

  const contentTestMode =
    typeof globalThis !== "undefined" && Boolean(globalThis.__CUM_CONTENT_TEST__);

  if (contentTestMode) {
    globalThis.__CUM_CONTENT_TEST_HOOKS__ = {
      isComposerLikeBox,
      reconcileBarElement,
      isCompactLayout,
      normalizePlanName,
      pickPlan,
      findPlanInValue,
      selectConversationTokenState,
      formatEstimatedTokenCount,
      formatLastUpdatedAt,
      buildUsageDetails,
      formatDuration,
      buildBurnForecastPresentation,
      normalizeThemePreference,
      resolveThemePreference
    };
  } else {
    init();
  }

  async function init() {
    state = await loadState();
    installStoragePolling();
    detectAndPersistOrgId(true);
    detectAndPersistPlan(true);
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
      usageFetch: null,
      conversationTokensUI: null
    };
  }

  async function loadState() {
    const base = createDefaultState();
    let stored = null;
    let legacy = null;
    let conversationTokensUI = null;

    try {
      const result = await extensionStorage.get([
        STORAGE_KEY,
        LEGACY_STORAGE_KEY,
        CONVERSATION_TOKENS_UI_KEY,
        THEME_KEY
      ]);
      stored = result && result[STORAGE_KEY];
      legacy = result && result[LEGACY_STORAGE_KEY];
      conversationTokensUI = normalizeConversationTokensUI(result && result[CONVERSATION_TOKENS_UI_KEY]);
      themePreference = normalizeThemePreference(result && result[THEME_KEY]);
    } catch (_error) {
      stored = null;
    }

    const merged = migrateState(Object.assign(base, legacy || {}, stored || {}));
    merged.conversationTokensUI = conversationTokensUI;
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
      plan: normalizePlanName(legacyUsage.plan),
      resetAt: Number.isFinite(legacyUsage.resetAt) ? legacyUsage.resetAt : null
    });
    output.usageByOrg = input && input.usageByOrg && typeof input.usageByOrg === "object"
      ? input.usageByOrg
      : {};
    output.conversationTokensUI = normalizeConversationTokensUI(input && input.conversationTokensUI);

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
    let conversationTokensUI = null;
    try {
      const result = await extensionStorage.get([STORAGE_KEY, CONVERSATION_TOKENS_UI_KEY, THEME_KEY]);
      stored = result && result[STORAGE_KEY];
      conversationTokensUI = normalizeConversationTokensUI(result && result[CONVERSATION_TOKENS_UI_KEY]);
      const incomingTheme = normalizeThemePreference(result && result[THEME_KEY]);
      if (incomingTheme !== themePreference) {
        themePreference = incomingTheme;
        scheduleUpdate({});
      }
    } catch (_error) {
      stored = null;
    }

    const beforeVersion = getUsageVersion(state);
    const beforeOrgId = state.organizationId || "";
    const beforeTokenText = getCurrentTokenEstimateText();
    if (stored) {
      mergeStoredUsageState(stored);
    }
    state.conversationTokensUI = selectConversationTokenState(
      conversationTokensUI,
      state.conversationTokensUI,
      getConversationIdFromUrl()
    );
    if (
      beforeVersion !== getUsageVersion(state) ||
      beforeOrgId !== (state.organizationId || "") ||
      beforeTokenText !== getCurrentTokenEstimateText()
    ) {
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
      return Promise.resolve(null);
    }

    lastBackgroundRefreshRequestAt = now;
    const orgId = normalizeOrgId(knownOrgId) || detectAndPersistOrgId(force);
    usageRefreshPending = true;
    scheduleUpdate({});
    return sendRuntimeMessage({
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
        return null;
      })
      .finally(() => {
        usageRefreshPending = false;
        scheduleUpdate({});
      });
  }

  function maybeRequestTokenUpdate() {
    const conversationId = getConversationIdFromUrl();
    const now = Date.now();

    if (
      !conversationId ||
      !state.organizationId ||
      (
        conversationId === lastConvTokenFetchId &&
        now - lastConvTokenFetchTime < CONV_FETCH_INTERVAL_MS
      )
    ) {
      return;
    }

    lastConvTokenFetchId = conversationId;
    lastConvTokenFetchTime = now;

    sendRuntimeMessage({
      type: MESSAGE_UPDATE_CONV_TOKENS,
      orgId: state.organizationId,
      conversationId
    })
      .then((response) => {
        const incoming = normalizeConversationTokensUI(response && response.conversationTokensUI);
        if (incoming) {
          const beforeTokenText = getCurrentTokenEstimateText();
          state.conversationTokensUI = incoming;
          if (beforeTokenText !== getCurrentTokenEstimateText()) {
            scheduleUpdate({});
          }
        }
      })
      .catch(() => {
        // Conversation token counting is best-effort.
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

  function detectAndPersistPlan(force = false) {
    const now = Date.now();
    const currentPlan = normalizePlanName(state.usage && state.usage.plan);
    if (currentPlan && !force) {
      return currentPlan;
    }
    if (!force && now < nextPlanScanAt) {
      return currentPlan;
    }

    nextPlanScanAt = now + PLAN_SCAN_INTERVAL_MS;
    const detectedPlan =
      detectPlanFromSettingsPage() ||
      findPlanInWebStorage(window.localStorage) ||
      findPlanInWebStorage(window.sessionStorage) ||
      findPlanInInlineState();
    const plan = normalizePlanName(detectedPlan);
    if (!plan || plan === currentPlan) {
      return plan;
    }

    state.usage = Object.assign({}, state.usage, { plan });
    if (state.organizationId) {
      storeUsageForOrg(state.organizationId, state.usage);
    }
    scheduleSave();
    scheduleUpdate({});
    return plan;
  }

  function detectPlanFromSettingsPage() {
    if (!/^\/settings(?:\/|$)/i.test(window.location.pathname) || !document.body) {
      return "";
    }
    return pickPlan(normalizeLines(document.body.innerText || ""));
  }

  function findPlanInWebStorage(storage) {
    if (!storage) {
      return "";
    }

    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        const raw = storage.getItem(key) || "";
        if (!raw || !/plan|subscription|billing|tier|capabilit/i.test(raw)) {
          continue;
        }

        try {
          const plan = findPlanInValue(JSON.parse(raw));
          if (plan) {
            return plan;
          }
        } catch (_error) {
          if (/plan|subscription|billing|tier/i.test(String(key || ""))) {
            const plan = normalizePlanName(raw);
            if (plan) {
              return plan;
            }
          }
        }
      }
    } catch (_error) {
      return "";
    }

    return "";
  }

  function findPlanInValue(value, path = [], depth = 0) {
    if (value == null || depth > 7) {
      return "";
    }

    if (typeof value === "string") {
      const hasPlanMetadataPath = path.some((key) =>
        /plan|subscription|billing|tier|capabilit/i.test(String(key || ""))
      );
      return hasPlanMetadataPath ? normalizePlanName(value) : "";
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const plan = findPlanInValue(item, path, depth + 1);
        if (plan) {
          return plan;
        }
      }
      return "";
    }

    if (typeof value !== "object") {
      return "";
    }

    for (const [key, item] of Object.entries(value)) {
      const plan = findPlanInValue(item, path.concat(key), depth + 1);
      if (plan) {
        return plan;
      }
    }
    return "";
  }

  function findPlanInInlineState() {
    if (didScanInlinePlan) {
      return "";
    }
    didScanInlinePlan = true;

    const scripts = Array.from(document.querySelectorAll("script")).slice(0, 40);
    const pattern = /(?:plan_type|planType|subscription_type|subscriptionType|rate_limit_tier|rateLimitTier|billing_plan|billingPlan)["']?\s*[:=]\s*["']([^"']+)["']/i;

    for (const script of scripts) {
      const text = script.textContent || "";
      if (!/plan|subscription|billing|tier/i.test(text)) {
        continue;
      }
      const match = text.match(pattern);
      const plan = normalizePlanName(match && match[1]);
      if (plan) {
        return plan;
      }
    }
    return "";
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
      detectAndPersistPlan();
      if (orgId && orgId !== previousOrgId) {
        requestBackgroundUsageRefresh("org-detected", true, orgId);
      }
      maybeRequestTokenUpdate();

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
      detectAndPersistPlan(true);
    }, {
      passive: true
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        scheduleUpdate({ forceComposerScan: true });
        detectAndPersistOrgId(true);
        detectAndPersistPlan(true);
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

    injectBarBesideComposer(composer, Boolean(options.forceComposerScan));
    renderBar(usageState);
  }

  function buildUsageState() {
    const usageData = getClaudeUsageData();
    if (!usageData && !RENDER_NEUTRAL_PLACEHOLDERS) {
      return null;
    }

    const convUI = normalizeConversationTokensUI(state.conversationTokensUI);
    const currentConvId = getConversationIdFromUrl();
    const conversationTokens =
      convUI && convUI.conversationId === currentConvId
        ? convUI.conversationTokens
        : null;
    const sync = getUsageSyncPresentation(Boolean(usageData));

    return {
      windowLabel: usageData ? usageData.windowLabel : "5h",
      plan: normalizePlanName(
        (usageData && usageData.plan) || (state.usage && state.usage.plan)
      ),
      usagePercent: usageData ? usageData.usagePercent : null,
      resetText: usageData ? usageData.resetText : sync.fallbackText,
      conversationTokens,
      syncState: sync.state,
      syncTitle: sync.title,
      details: buildUsageDetails(state.usage),
      forecast: buildBurnForecastPresentation(state.usage && state.usage.burnForecast)
    };
  }

  function buildUsageDetails(usageValue) {
    const usage = usageValue && typeof usageValue === "object" ? usageValue : {};
    const fiveHourPercent = coerceOptionalPercent(usage.fiveHourPercent ?? usage.usagePercent);
    const sevenDayPercent = coerceOptionalPercent(usage.sevenDayPercent);
    const extraUsagePercent = coerceOptionalPercent(usage.extraUsagePercent);
    const rows = [];

    if (fiveHourPercent !== null) {
      rows.push({
        key: "five-hour",
        label: "5-hour",
        percent: fiveHourPercent,
        detail: formatDetailReset(usage.fiveHourResetAt ?? usage.resetAt)
      });
    }
    if (sevenDayPercent !== null) {
      rows.push({
        key: "weekly",
        label: "Weekly",
        percent: sevenDayPercent,
        detail: formatDetailReset(usage.sevenDayResetAt)
      });
    }
    if (extraUsagePercent !== null) {
      rows.push({
        key: "extra",
        label: "Extra usage",
        percent: extraUsagePercent,
        detail: formatExtraUsageAmount(
          usage.extraUsageUsedCredits,
          usage.extraUsageMonthlyLimit,
          usage.extraUsageCurrency
        )
      });
    }

    return rows;
  }

  function coerceOptionalPercent(value) {
    return value === null || value === undefined || value === ""
      ? null
      : coercePercent(value);
  }

  function formatDetailReset(resetAt) {
    const timestamp = Number(resetAt);
    return Number.isFinite(timestamp) && timestamp > 0
      ? `resets in ${formatDuration(timestamp - Date.now())}`
      : "";
  }

  function formatExtraUsageAmount(usedCredits, monthlyLimit, currency) {
    const used = Number(usedCredits);
    const limit = Number(monthlyLimit);
    const currencyCode = String(currency || "").trim().toUpperCase();
    if (!Number.isFinite(used) || !Number.isFinite(limit) || !currencyCode) {
      return "";
    }

    try {
      const formatter = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currencyCode
      });
      return `${formatter.format(used / 100)} of ${formatter.format(limit / 100)}`;
    } catch (_error) {
      return `${currencyCode} ${(used / 100).toFixed(2)} of ${(limit / 100).toFixed(2)}`;
    }
  }

  function buildBurnForecastPresentation(value, now = Date.now()) {
    const explanation = "Forecasts whether your current 5-hour usage pace will reach Claude's limit before it resets.";
    const forecast = value && typeof value === "object" ? value : null;
    const calculatedAt = Number(forecast && forecast.calculatedAt);
    const sampleCount = Number(forecast && forecast.sampleCount);
    const observedMinutes = Number(forecast && forecast.observedMinutes);
    const percentPerHour = Number(forecast && forecast.percentPerHour);
    const estimatedLimitAt = Number(forecast && forecast.estimatedLimitAt);
    const isRecent = Number.isFinite(calculatedAt) && now - calculatedAt <= 20 * 60 * 1000;

    if (
      !isRecent ||
      !Number.isFinite(sampleCount) || sampleCount < 3 ||
      !Number.isFinite(observedMinutes) || observedMinutes < 10 ||
      !Number.isFinite(percentPerHour) || percentPerHour <= 0
    ) {
      return {
        tone: "waiting",
        message: "—",
        title: `${explanation} A dash means there has not been enough usage change over at least 10 minutes in this reset window. This is only an estimate.`
      };
    }

    const title = `${explanation} Based on ${sampleCount} samples over ${observedMinutes}m at ${percentPerHour}% per hour. Actual usage can vary.`;
    if (forecast.willHitBeforeReset === true && Number.isFinite(estimatedLimitAt)) {
      return {
        tone: "risk",
        message: estimatedLimitAt <= now
          ? "limit around now"
          : `limit in about ${formatDuration(estimatedLimitAt - now)}`,
        title
      };
    }

    return {
      tone: "safe",
      message: "likely below the limit until reset",
      title
    };
  }

  function normalizeThemePreference(value) {
    const theme = String(value || "").trim().toLowerCase();
    return theme === "light" || theme === "dark" ? theme : "auto";
  }

  function resolveThemePreference(value, detectedTheme) {
    const preference = normalizeThemePreference(value);
    if (preference !== "auto") {
      return preference;
    }

    const pageTheme = normalizeThemePreference(detectedTheme || detectClaudeTheme());
    return pageTheme === "auto" ? "dark" : pageTheme;
  }

  function detectClaudeTheme() {
    const html = document.documentElement;
    const body = document.body;
    const hints = [html, body]
      .filter(Boolean)
      .map((node) => `${node.getAttribute && node.getAttribute("data-theme") || ""} ${node.className || ""}`)
      .join(" ");
    if (/(?:^|[\s_-])dark(?:$|[\s_-])/i.test(hints)) {
      return "dark";
    }
    if (/(?:^|[\s_-])light(?:$|[\s_-])/i.test(hints)) {
      return "light";
    }

    if (window.getComputedStyle) {
      for (const node of [body, html]) {
        if (!node) {
          continue;
        }
        const color = parseCssColor(window.getComputedStyle(node).backgroundColor);
        if (color && color.alpha > 0.1) {
          const luminance = color.red * 0.2126 + color.green * 0.7152 + color.blue * 0.0722;
          return luminance >= 150 ? "light" : "dark";
        }
      }
    }

    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }

  function parseCssColor(value) {
    const match = String(value || "").match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/i);
    if (!match) {
      return null;
    }
    return {
      red: Number(match[1]),
      green: Number(match[2]),
      blue: Number(match[3]),
      alpha: match[4] === undefined ? 1 : Number(match[4])
    };
  }

  function setThemePreference(value) {
    const nextTheme = normalizeThemePreference(value);
    if (nextTheme === themePreference) {
      return;
    }

    themePreference = nextTheme;
    extensionStorage.set({ [THEME_KEY]: nextTheme }).catch(() => {});
    renderBar(buildUsageState());
  }

  function getClaudeUsageData() {
    // TODO: replace this adapter if Claude exposes a stable first-party usage API.
    const usage = state.usage;
    if (state.organizationId && usage.organizationId && usage.organizationId !== state.organizationId) {
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
      if (!usageRefreshPending) {
        requestBackgroundUsageRefresh("usage-window-expired", true, state.organizationId);
      }
      return null;
    }

    return {
      windowLabel: usage.windowLabel || "5h",
      plan: normalizePlanName(usage.plan),
      usagePercent: usage.usagePercent,
      resetText,
      stale: Boolean(usage.stale),
      source: usage.source || "settings-cache"
    };
  }

  function getUsageSyncPresentation(hasUsageData) {
    const usage = state.usage || {};
    const usageFetch = state.usageFetch || {};
    const updatedAt = Number(usage.updatedAt) || Number(usageFetch.lastSuccessAt) || 0;
    const updatedText = formatLastUpdatedAt(updatedAt);

    if (usageRefreshPending) {
      return {
        state: "loading",
        fallbackText: "syncing…",
        title: `${updatedText}. Refreshing Claude usage…`
      };
    }

    if (usage.stale || usageFetch.stale) {
      const hasCachedValue = hasUsageData && Number.isFinite(usage.usagePercent);
      return {
        state: hasCachedValue ? "stale" : "error",
        fallbackText: hasCachedValue ? "cached usage" : "sync failed",
        title: hasCachedValue
          ? `${updatedText}. Showing cached usage; click to retry.`
          : `${updatedText}. Usage sync failed; click to retry.`
      };
    }

    if (!updatedAt) {
      return {
        state: "stale",
        fallbackText: "open usage to sync",
        title: "Usage has not synced yet; click to refresh."
      };
    }

    return {
      state: "ok",
      fallbackText: "open usage to sync",
      title: `${updatedText}. Click to refresh.`
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
    if (!bar || !bar.isConnected) {
      return;
    }

    const percent = coercePercent(usageState.usagePercent);
    const tone = getUsageTone(percent);
    const percentText = Number.isFinite(percent) ? `${percent}%` : "--";
    const progress = Number.isFinite(percent) ? `${percent}%` : "0%";
    const planText = usageState.plan || "Plan unavailable";
    const planTooltip = usageState.plan
      ? `Claude plan: ${usageState.plan}`
      : "Claude plan could not be detected";
    const usageTooltip = Number.isFinite(percent)
      ? `${usageState.windowLabel} usage: ${percent}% used`
      : `${usageState.windowLabel} usage has not synced yet`;
    const resetTooltip = usageState.resetText
      ? `${usageState.windowLabel} usage window; ${usageState.resetText}`
      : `${usageState.windowLabel} usage window reset time has not synced yet`;
    const tokenText = formatEstimatedTokenCount(usageState.conversationTokens);
    const tokenSection = tokenText
      ? `
        <span class="cum-section cum-tokens" title="Estimated tokens in this chat from sent messages only. Not daily usage. The current draft and hidden context are not included; Claude's tokenizer may differ.">
          <span class="cum-icon">${ICONS.token}</span>
          <span>${escapeHtml(tokenText)}</span>
        </span>`
      : "";
    const detailsHtml = renderUsageDetails(usageState.details);
    const forecastHtml = renderBurnForecast(usageState.forecast);
    const themePickerHtml = renderThemePicker(themePreference);

    bar.dataset.usageTone = tone;
    bar.dataset.theme = resolveThemePreference(themePreference);
    bar.dataset.hasTokens = tokenText ? "true" : "false";
    bar.dataset.syncState = usageState.syncState;
    bar.dataset.detailsOpen = detailsOpen ? "true" : "false";
    bar.style.setProperty("--cum-progress", progress);
    bar.setAttribute("aria-label", "Claude usage meter");

    const html = `
      <button class="cum-main" type="button" aria-expanded="${detailsOpen ? "true" : "false"}" aria-controls="${DETAILS_ID}" aria-label="Toggle Claude usage details">
        <span class="cum-section cum-window" title="${escapeHtml(planTooltip)}">
          <span class="cum-status-dot"></span>
          <span class="cum-plan-name">${escapeHtml(planText)}</span>
        </span>
        <span class="cum-section cum-usage" title="${escapeHtml(usageTooltip)}">
          <span class="cum-percent">${percentText}</span>
          <span class="cum-progress-track"><span class="cum-progress-fill"></span></span>
        </span>
        <span class="cum-section cum-reset" title="${escapeHtml(resetTooltip)}">
          <span class="cum-icon">${ICONS.clock}</span>
          <span class="cum-limit-label">(${escapeHtml(usageState.windowLabel)})</span>
          <span>${escapeHtml(usageState.resetText || "open usage to sync")}</span>
        </span>
        ${tokenSection}
      </button>
      <button class="cum-refresh" type="button" title="${escapeHtml(usageState.syncTitle)}" aria-label="${escapeHtml(usageState.syncTitle)}"${usageState.syncState === "loading" ? " disabled" : ""}>
        <span class="cum-icon">${ICONS.refresh}</span>
      </button>
      <div class="cum-details" id="${DETAILS_ID}"${detailsOpen ? "" : " hidden"}>
        <div class="cum-details-header">
          <span>Usage details</span>
          <a href="${SETTINGS_URL}">Claude settings</a>
        </div>
        ${detailsHtml}
        ${forecastHtml}
        ${themePickerHtml}
      </div>
    `;

    if (html !== lastRenderedHtml) {
      bar.innerHTML = html;
      lastRenderedHtml = html;
    }
  }

  function renderUsageDetails(rows) {
    if (!Array.isArray(rows) || !rows.length) {
      return '<div class="cum-details-empty">Usage details are not available yet.</div>';
    }

    return rows.map((row) => `
      <div class="cum-detail-row" data-detail-key="${escapeHtml(row.key)}">
        <span class="cum-detail-label">${escapeHtml(row.label)}</span>
        <span class="cum-detail-track"><span style="width:${coercePercent(row.percent)}%"></span></span>
        <span class="cum-detail-percent">${coercePercent(row.percent)}%</span>
        <span class="cum-detail-meta">${escapeHtml(row.detail)}</span>
      </div>
    `).join("");
  }

  function renderBurnForecast(forecast) {
    if (!forecast) {
      return "";
    }

    return `
      <div class="cum-forecast" data-forecast-tone="${escapeHtml(forecast.tone)}">
        <span class="cum-forecast-label" title="${escapeHtml(forecast.title)}">At this pace</span>
        <strong>${escapeHtml(forecast.message)}</strong>
      </div>
    `;
  }

  function renderThemePicker(preference) {
    const selected = normalizeThemePreference(preference);
    return `
      <div class="cum-theme-row">
        <span>Theme</span>
        <div class="cum-theme-picker" role="group" aria-label="Meter theme">
          ${["auto", "light", "dark"].map((theme) => `
            <button type="button" data-cum-theme-choice="${theme}" aria-pressed="${selected === theme ? "true" : "false"}" title="Use ${theme} meter theme">${theme[0].toUpperCase()}${theme.slice(1)}</button>
          `).join("")}
        </div>
      </div>
    `;
  }

  function injectBarBesideComposer(composer, syncLayout = false) {
    if (!composer || !composer.parentNode) {
      return;
    }

    let didInsert = false;
    reconcileBarElement();

    if (bar && bar.tagName && bar.tagName.toLowerCase() !== "div") {
      bar.remove();
      bar = null;
    }

    if (!bar) {
      bar = document.createElement("div");
      bar.id = ROOT_ID;
      bar.className = "claude-usage-meter";
      bar.setAttribute("role", "group");
      didInsert = true;
    }

    // Assignment is intentional: a bar adopted after a content-script reload must
    // not accumulate handlers from multiple script instances.
    bar.onclick = handleBarClick;

    const compact = isCompactLayout();
    const targetParent = compact && document.body ? document.body : composer.parentNode;
    const isInResponsivePosition = compact
      ? bar.parentNode === targetParent
      : composer.nextSibling === bar;

    if (!isInResponsivePosition) {
      if (compact) {
        targetParent.appendChild(bar);
      } else {
        composer.parentNode.insertBefore(bar, composer.nextSibling);
      }
      didInsert = true;
    }

    if (syncLayout || didInsert) {
      syncBarLayoutWithComposer(composer);
    }
  }

  function handleBarClick(event) {
    const themeButton = event.target && event.target.closest
      ? event.target.closest("[data-cum-theme-choice]")
      : null;
    if (themeButton) {
      event.preventDefault();
      event.stopPropagation();
      setThemePreference(themeButton.getAttribute("data-cum-theme-choice"));
      return;
    }

    const refreshButton = event.target && event.target.closest
      ? event.target.closest(".cum-refresh")
      : null;
    if (!refreshButton || usageRefreshPending) {
      const main = event.target && event.target.closest
        ? event.target.closest(".cum-main")
        : null;
      if (main || event.target === bar) {
        event.preventDefault();
        detailsOpen = !detailsOpen;
        renderBar(buildUsageState());
      }
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    requestBackgroundUsageRefresh("manual-refresh", true, state.organizationId);
  }

  function isCompactLayout() {
    const viewportWidth =
      window.innerWidth || document.documentElement.clientWidth || Number.POSITIVE_INFINITY;
    return viewportWidth <= COMPACT_LAYOUT_MAX_WIDTH;
  }

  function reconcileBarElement() {
    const mountedBars = Array.from(
      document.querySelectorAll(`[id="${ROOT_ID}"]`)
    );
    const connectedCurrent =
      bar && bar.isConnected && mountedBars.includes(bar) ? bar : null;
    const canonicalBar = connectedCurrent || mountedBars[0] || null;

    mountedBars.forEach((mountedBar) => {
      if (mountedBar !== canonicalBar) {
        mountedBar.remove();
      }
    });

    bar = canonicalBar;
    return bar;
  }

  function syncBarLayoutWithComposer(composer) {
    const rect = composer.getBoundingClientRect();
    const computed = window.getComputedStyle(composer);
    const compact = isCompactLayout();

    bar.style.width = `${Math.round(rect.width)}px`;
    bar.style.maxWidth = computed.maxWidth && computed.maxWidth !== "none" ? computed.maxWidth : "100%";
    bar.dataset.layout = compact ? "compact" : "wide";

    const composerRadius = computed.borderRadius || computed.borderTopLeftRadius || "";
    if (composerRadius && !/^0(?:px)?(?:\s+0(?:px)?)*$/.test(composerRadius)) {
      bar.style.setProperty("--cum-composer-radius", composerRadius);
    } else {
      bar.style.removeProperty("--cum-composer-radius");
    }

    if (compact) {
      reserveCompactMeterSpace(composer);
      bar.style.left = `${Math.round(rect.left)}px`;
      bar.style.marginLeft = "0px";
      bar.style.marginRight = "0px";
      return;
    }

    releaseCompactMeterSpace();
    bar.style.removeProperty("left");
    bar.style.marginLeft = computed.marginLeft;
    bar.style.marginRight = computed.marginRight;
  }

  function reserveCompactMeterSpace(composer) {
    if (compactComposer && compactComposer !== composer) {
      releaseCompactMeterSpace();
    }

    compactComposer = composer;
    if (!composer.hasAttribute("data-cum-meter-compact-host")) {
      composer.style.setProperty("--cum-meter-reserve", `${COMPACT_METER_RESERVE_PX}px`);
      composer.setAttribute("data-cum-meter-compact-host", "true");
    }
  }

  function releaseCompactMeterSpace() {
    if (!compactComposer) {
      return;
    }

    compactComposer.removeAttribute("data-cum-meter-compact-host");
    compactComposer.style.removeProperty("--cum-meter-reserve");
    compactComposer = null;
  }

  function removeBar() {
    releaseCompactMeterSpace();
    detailsOpen = false;
    Array.from(document.querySelectorAll(`[id="${ROOT_ID}"]`)).forEach((mountedBar) => {
      mountedBar.remove();
    });
    bar = null;
    lastRenderedHtml = "";
  }

  function findComposerContainer(force = false) {
    if (!force && isUsableComposer(cachedComposer)) {
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

  function isUsableComposer(composer) {
    if (!composer || !composer.isConnected || !composer.parentNode || !composer.querySelector) {
      return false;
    }

    return Boolean(composer.querySelector("textarea,[contenteditable='true']"));
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
      rect.bottom > viewportHeight * 0.35 &&
      rect.top < viewportHeight
    );
  }

  function isUsageSettingsPage() {
    return /\/settings\/usage\/?$/i.test(window.location.pathname);
  }

  function getConversationIdFromUrl() {
    const match = window.location.pathname.match(/\/chat\/([a-f0-9-]+)/i);
    return match ? match[1] : null;
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
    const patterns = [
      /Plan usage limits\s+([^\n]+)/i,
      /(?:Current|Subscription) plan\s*:?\s*([^\n]+)/i
    ];

    for (const pattern of patterns) {
      const match = String(text || "").match(pattern);
      const plan = normalizePlanName(match && match[1]);
      if (plan) {
        return plan;
      }
    }

    return "";
  }

  function normalizePlanName(value) {
    const text = String(value || "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) {
      return "";
    }

    const maxMatch = text.match(/\bmax(?:\s+plan)?(?:\s+(5x|20x))?\b/i);
    if (maxMatch) {
      return maxMatch[1] ? `Max ${maxMatch[1].toLowerCase()}` : "Max";
    }
    if (/\benterprise\b/i.test(text)) {
      return "Enterprise";
    }
    if (/\beducation\b|\bedu\b/i.test(text)) {
      return "Education";
    }
    if (/\bteam\b/i.test(text)) {
      return "Team";
    }
    if (/\bpro\b/i.test(text)) {
      return "Pro";
    }
    if (/\bfree\b/i.test(text)) {
      return "Free";
    }
    return "";
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

    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      const remainingHours = hours % 24;
      return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
    }
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

  function normalizeConversationTokensUI(value) {
    if (!value || typeof value !== "object") {
      return null;
    }

    const conversationTokens = Number(value.conversationTokens);
    const updatedAt = Number(value.updatedAt);
    if (
      typeof value.conversationId !== "string" ||
      !value.conversationId ||
      !Number.isFinite(conversationTokens)
    ) {
      return null;
    }

    return {
      conversationId: value.conversationId,
      conversationTokens: Math.max(0, Math.round(conversationTokens)),
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0
    };
  }

  function selectConversationTokenState(incomingValue, currentValue, conversationId) {
    const incoming = normalizeConversationTokensUI(incomingValue);
    const current = normalizeConversationTokensUI(currentValue);

    if (incoming && incoming.conversationId === conversationId) {
      return incoming;
    }
    if (current && current.conversationId === conversationId) {
      return current;
    }
    return null;
  }

  function getCurrentTokenEstimateText() {
    const convUI = normalizeConversationTokensUI(state.conversationTokensUI);
    const currentConvId = getConversationIdFromUrl();
    const conversationTokens = convUI && convUI.conversationId === currentConvId
      ? convUI.conversationTokens
      : null;
    return formatEstimatedTokenCount(conversationTokens);
  }

  function formatEstimatedTokenCount(value) {
    return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
      ? `~${Math.max(0, Math.round(Number(value))).toLocaleString()} tokens`
      : "";
  }

  function formatLastUpdatedAt(timestamp, now = Date.now()) {
    const updatedAt = Number(timestamp);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
      return "Never synced";
    }

    const elapsedMs = Math.max(0, Number(now) - updatedAt);
    const elapsedMinutes = Math.floor(elapsedMs / 60000);
    if (elapsedMinutes < 1) {
      return "Updated just now";
    }
    if (elapsedMinutes < 60) {
      return `Updated ${elapsedMinutes}m ago`;
    }

    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) {
      return `Updated ${elapsedHours}h ago`;
    }

    return `Updated ${Math.floor(elapsedHours / 24)}d ago`;
  }

  function getDayKey(timestamp = Date.now()) {
    const now = new Date(timestamp);
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
