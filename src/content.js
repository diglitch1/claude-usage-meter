(function () {
  const shared = globalThis.CUM_SHARED;
  if (!shared) {
    return;
  }

  const {
    ORG_ID_SOURCE,
    asObject,
    coercePercent,
    createStaleUsageForOrg,
    createStorageArea,
    createUsage,
    findFirst,
    formatDuration,
    getDayKey,
    getUsageForOrg,
    normalizeOrgId,
    normalizePlanName,
    storeUsageForOrg
  } = shared;

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
  const COMPOSER_MISS_LIMIT = 3;
  const COMPOSER_SELECTOR = "textarea,[contenteditable='true']";
  const PLAN_KEY_PATTERN = /plan|subscription|billing|tier|capabilit/i;

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
        return [].concat(keys).reduce((result, key) => {
          const raw = window.localStorage.getItem(key);
          if (raw) {
            result[key] = JSON.parse(raw);
          }
          return result;
        }, {});
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

  const extensionApi =
    typeof browser !== "undefined"
      ? browser
      : typeof chrome !== "undefined"
        ? chrome
        : null;
  const usesPromiseRuntime = typeof browser !== "undefined" && extensionApi === browser;
  const extensionStorage = createStorageArea(extensionApi) || fallbackStorage;

  let state = createDefaultState();
  let bar = null;
  let cachedComposer = null;
  let lastPath = window.location.pathname;
  let lastRenderedHtml = "";
  let saveTimer = 0;
  let updateTimer = 0;
  let updateRunning = false;
  let queuedUpdateOptions = null;
  let composerMissCount = 0;
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

  if (globalThis.__CUM_CONTENT_TEST__) {
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
    scheduleStoragePull();
    rescanPage(true);
    requestBackgroundUsageRefresh("content-open", true);
    installDomPoller();
    installRouteAndViewportListeners();
    await update({ forceComposerScan: true });
  }

  function createDefaultState() {
    return {
      day: getDayKey(),
      usage: createUsage(),
      usageByOrg: {},
      usageFetch: null,
      conversationTokensUI: null
    };
  }

  async function readStored(keys) {
    try {
      return (await extensionStorage.get(keys)) || {};
    } catch (_error) {
      return {};
    }
  }

  async function loadState() {
    const result = await readStored([
      STORAGE_KEY,
      LEGACY_STORAGE_KEY,
      CONVERSATION_TOKENS_UI_KEY,
      THEME_KEY
    ]);
    themePreference = normalizeThemePreference(result[THEME_KEY]);

    const merged = migrateState(
      Object.assign(createDefaultState(), result[LEGACY_STORAGE_KEY] || {}, result[STORAGE_KEY] || {})
    );
    merged.conversationTokensUI = normalizeConversationTokensUI(result[CONVERSATION_TOKENS_UI_KEY]);
    rollDayIfNeeded(merged, false);
    return merged;
  }

  function migrateState(input) {
    const output = createDefaultState();
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

    output.usage = Object.assign(output.usage, legacyUsage, {
      usagePercent: coercePercent(legacyUsage.usagePercent ?? legacyUsage.sessionPercent),
      resetText: legacyUsage.resetText || legacyUsage.sessionReset || "",
      plan: normalizePlanName(legacyUsage.plan),
      resetAt: Number.isFinite(legacyUsage.resetAt) ? legacyUsage.resetAt : null
    });
    output.usageByOrg = asObject(input && input.usageByOrg);
    output.conversationTokensUI = normalizeConversationTokensUI(input && input.conversationTokensUI);

    return output;
  }

  function scheduleSave() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
      try {
        const stored = await readStored([STORAGE_KEY]);
        if (stored[STORAGE_KEY]) {
          // Another tab may have synced newer usage while this save was queued.
          mergeStoredUsageState(stored[STORAGE_KEY], true);
        }
        await extensionStorage.set({ [STORAGE_KEY]: state });
      } catch (_error) {
        // Do not let storage failures affect Claude.
      }
    }, 250);
  }

  function scheduleStoragePull() {
    window.clearTimeout(storagePullTimer);
    storagePullTimer = window.setTimeout(async () => {
      await pullStoredState();
      scheduleStoragePull();
    }, STORAGE_PULL_MS);
  }

  async function pullStoredState() {
    const result = await readStored([STORAGE_KEY, CONVERSATION_TOKENS_UI_KEY, THEME_KEY]);
    const incomingTheme = normalizeThemePreference(result[THEME_KEY]);
    if (incomingTheme !== themePreference) {
      themePreference = incomingTheme;
      scheduleUpdate({});
    }

    const beforeVersion = getUsageVersion(state);
    const beforeOrgId = state.organizationId || "";
    const beforeTokenText = getCurrentTokenEstimateText();
    if (result[STORAGE_KEY]) {
      mergeStoredUsageState(result[STORAGE_KEY]);
    }
    state.conversationTokensUI = selectConversationTokenState(
      normalizeConversationTokensUI(result[CONVERSATION_TOKENS_UI_KEY]),
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

  function mergeStoredUsageState(stored, requireNewer = false) {
    const incoming = migrateState(stored);
    mergeUsageByOrg(incoming.usageByOrg);

    const incomingOrgId = incoming.organizationId || "";
    const activeOrgId = state.organizationId || incomingOrgId;
    const incomingUsageOrgId = (incoming.usage && incoming.usage.organizationId) || incomingOrgId;
    const usageMatchesActiveOrg = !incomingUsageOrgId || !activeOrgId || incomingUsageOrgId === activeOrgId;
    const versionDelta = getUsageVersion(incoming) - getUsageVersion(state);

    if (usageMatchesActiveOrg && (requireNewer ? versionDelta > 0 : versionDelta >= 0)) {
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
    state.usageByOrg = asObject(state.usageByOrg);

    Object.entries(asObject(incoming)).forEach(([orgId, usage]) => {
      const normalized = normalizeOrgId(orgId);
      if (!normalized || !usage || typeof usage !== "object") {
        return;
      }

      const existing = state.usageByOrg[normalized];
      if (!existing || getUsageVersion({ usage }) >= getUsageVersion({ usage: existing })) {
        storeUsageForOrg(state, normalized, usage);
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
      .then(adoptResponseState)
      .catch(() => {
        // The content script still works without the optional background cache.
        return null;
      })
      .finally(() => {
        usageRefreshPending = false;
        scheduleUpdate({});
      });
  }

  function adoptResponseState(response) {
    if (response && response.state) {
      mergeStoredUsageState(response.state);
      scheduleUpdate({});
    }
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
        if (!incoming) {
          return;
        }

        const beforeTokenText = getCurrentTokenEstimateText();
        state.conversationTokensUI = incoming;
        if (beforeTokenText !== getCurrentTokenEstimateText()) {
          scheduleUpdate({});
        }
      })
      .catch(() => {
        // Conversation token counting is best-effort.
      });
  }

  function sendRuntimeMessage(message) {
    const runtime = extensionApi && extensionApi.runtime;
    if (!runtime || !runtime.sendMessage) {
      return Promise.resolve(null);
    }
    if (usesPromiseRuntime) {
      return runtime.sendMessage(message);
    }
    return new Promise((resolve, reject) => {
      runtime.sendMessage(message, (response) => {
        const error = runtime.lastError;
        if (error) {
          reject(error);
          return;
        }
        resolve(response);
      });
    });
  }

  function rescanPage(force = false) {
    detectAndPersistOrgId(force);
    detectAndPersistPlan(force);
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

    state.organizationId = normalized;
    state.usage = getUsageForOrg(state, normalized) || createStaleUsageForOrg(normalized, Date.now());
    scheduleSave();
    scheduleUpdate({});

    sendRuntimeMessage({
      type: MESSAGE_ORG_ID_DETECTED,
      orgId: normalized
    })
      .then(adoptResponseState)
      .catch(() => {
        // The local state was already updated and will be persisted locally.
      });

    return true;
  }

  function detectAndPersistPlan(force = false) {
    const now = Date.now();
    const currentPlan = normalizePlanName(state.usage && state.usage.plan);
    if ((currentPlan && !force) || (!force && now < nextPlanScanAt)) {
      return currentPlan;
    }

    nextPlanScanAt = now + PLAN_SCAN_INTERVAL_MS;
    const plan = normalizePlanName(
      detectPlanFromSettingsPage() ||
      findPlanInWebStorage(getWebStorage("localStorage")) ||
      findPlanInWebStorage(getWebStorage("sessionStorage")) ||
      findPlanInInlineState()
    );
    if (!plan || plan === currentPlan) {
      return plan;
    }

    state.usage = Object.assign({}, state.usage, { plan });
    storeUsageForOrg(state, state.organizationId, state.usage);
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
    return eachStorageEntry(storage, (key, raw) => {
      if (!PLAN_KEY_PATTERN.test(raw)) {
        return "";
      }

      try {
        return findPlanInValue(JSON.parse(raw));
      } catch (_error) {
        return PLAN_KEY_PATTERN.test(String(key || "")) ? normalizePlanName(raw) : "";
      }
    });
  }

  function findPlanInValue(value) {
    return findInValue(
      value,
      (text, path) =>
        path.some((key) => PLAN_KEY_PATTERN.test(String(key || "")))
          ? normalizePlanName(text)
          : "",
      { maxDepth: 7 }
    );
  }

  function findPlanInInlineState() {
    if (didScanInlinePlan) {
      return "";
    }
    didScanInlinePlan = true;

    const pattern = /(?:plan_type|planType|subscription_type|subscriptionType|rate_limit_tier|rateLimitTier|billing_plan|billingPlan)["']?\s*[:=]\s*["']([^"']+)["']/i;
    return findFirst(Array.from(document.querySelectorAll("script")).slice(0, 40), (script) => {
      const text = script.textContent || "";
      if (!/plan|subscription|billing|tier/i.test(text)) {
        return "";
      }
      const match = text.match(pattern);
      return normalizePlanName(match && match[1]);
    });
  }

  // Walks nested storage/state values, remembering the key path so a match can
  // be accepted only when it sits under a meaningful key.
  function findInValue(value, matchText, limits, path = [], depth = 0) {
    if (value == null || depth > limits.maxDepth) {
      return "";
    }

    if (typeof value === "string") {
      return matchText(value, path);
    }

    const recurse = (item, itemPath) => findInValue(item, matchText, limits, itemPath, depth + 1);

    if (Array.isArray(value)) {
      return findFirst(sliceTo(value, limits.maxArrayItems), (item) => recurse(item, path));
    }
    if (typeof value !== "object") {
      return "";
    }

    return findFirst(sliceTo(Object.entries(value), limits.maxEntries), ([key, item]) =>
      recurse(item, path.concat(key))
    );
  }

  function sliceTo(items, limit) {
    return Number.isFinite(limit) ? items.slice(0, limit) : items;
  }

  function detectOrganizationId(deep = false) {
    const fromPage = findOrgIdInText(window.location.href) || findOrgIdInPerformance();
    if (fromPage || !deep) {
      return fromPage;
    }

    return (
      findOrgIdInWebStorage(getWebStorage("sessionStorage")) ||
      findOrgIdInWebStorage(getWebStorage("localStorage")) ||
      findOrgIdInScripts()
    );
  }

  function findOrgIdInScripts() {
    const scripts = Array.from(document.scripts || [])
      .filter((script) => !script.src || /json|javascript/i.test(script.type || ""))
      .slice(-30);

    return findFirst(scripts, (script) =>
      findOrgIdInText((script.textContent || "").slice(0, 250000))
    );
  }

  function findOrgIdInPerformance() {
    if (typeof performance === "undefined" || !performance.getEntriesByType) {
      return "";
    }

    try {
      const entries = performance.getEntriesByType("resource");
      return findFirst(entries.slice(-80).reverse(), (entry) =>
        findOrgIdInText(entry && entry.name)
      );
    } catch (_error) {
      return "";
    }
  }

  function getWebStorage(name) {
    try {
      return window[name];
    } catch (_error) {
      return null;
    }
  }

  function eachStorageEntry(storage, visit) {
    if (!storage) {
      return "";
    }

    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        const found = visit(key, storage.getItem(key) || "");
        if (found) {
          return found;
        }
      }
    } catch (_error) {
      return "";
    }

    return "";
  }

  function findOrgIdInWebStorage(storage) {
    return eachStorageEntry(storage, (key, raw) =>
      findOrgIdInStructuredText(raw) || findOrgIdInText(`${key}:${raw.slice(0, 60000)}`)
    );
  }

  function findOrgIdInStructuredText(text) {
    if (!text || !/[[{]/.test(text)) {
      return "";
    }

    try {
      return findOrgIdInValue(JSON.parse(text));
    } catch (_error) {
      return "";
    }
  }

  function findOrgIdInValue(value) {
    return findInValue(
      value,
      (text, path) => {
        const orgId = normalizeOrgId(text);
        return orgId && /organization|org/i.test(path.join(".")) ? orgId : "";
      },
      { maxDepth: 8, maxArrayItems: 80, maxEntries: 250 }
    );
  }

  const KEYED_ORG_ID_PATTERN = new RegExp(
    `(?:organization_id|organizationId|org_id|orgId|currentOrganizationId|activeOrganizationId|active_org_id|organizationUUID)[^A-Za-z0-9_-]{0,40}(${ORG_ID_SOURCE})`,
    "i"
  );
  const NESTED_ORG_ID_PATTERN = new RegExp(
    `(?:organization|org)[\\s\\S]{0,160}?(?:uuid|id)[^A-Za-z0-9_-]{0,40}(${ORG_ID_SOURCE})`,
    "i"
  );

  function findOrgIdInText(text) {
    const value = String(text || "");
    const endpointMatch = value.match(/\/api\/organizations\/([^/?#"'\\\s]+)/i);
    if (endpointMatch) {
      return normalizeOrgId(endpointMatch[1]);
    }

    const match = value.match(KEYED_ORG_ID_PATTERN) || value.match(NESTED_ORG_ID_PATTERN);
    return match ? normalizeOrgId(match[1]) : "";
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
    window.addEventListener("focus", handlePageActivated, { passive: true });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        handlePageActivated();
      }
    });
  }

  function handlePageActivated() {
    scheduleUpdate({ forceComposerScan: true });
    rescanPage(true);
  }

  function scheduleUpdate(options = {}) {
    window.clearTimeout(updateTimer);
    updateTimer = window.setTimeout(() => update(options), UPDATE_DEBOUNCE_MS);
  }

  // update() awaits storage, so two overlapping passes could each miss the other's
  // freshly created bar and mount a duplicate. Serialize them and fold anything
  // requested mid-flight into a single follow-up pass.
  async function update(options = {}) {
    if (updateRunning) {
      queuedUpdateOptions = {
        forceComposerScan:
          Boolean(queuedUpdateOptions && queuedUpdateOptions.forceComposerScan) ||
          Boolean(options.forceComposerScan)
      };
      return;
    }

    updateRunning = true;
    try {
      await runUpdate(options);
    } finally {
      updateRunning = false;
      const queued = queuedUpdateOptions;
      queuedUpdateOptions = null;
      if (queued) {
        scheduleUpdate(queued);
      }
    }
  }

  async function runUpdate(options) {
    rollDayIfNeeded(state);
    await refreshUsageCacheFromPage();

    if (isUsageSettingsPage()) {
      composerMissCount = 0;
      removeBar();
      return;
    }

    const composer = findComposerContainer(Boolean(options.forceComposerScan));
    if (!composer) {
      // Claude rebuilds the composer while a long prompt reflows, so it can measure
      // as missing for a frame. Tearing the bar down on the first miss is what made
      // it blink out mid-typing; wait for a run of misses instead.
      composerMissCount += 1;
      if (composerMissCount >= COMPOSER_MISS_LIMIT) {
        removeBar();
      }
      return;
    }

    composerMissCount = 0;
    injectBarBesideComposer(composer, Boolean(options.forceComposerScan));
    renderBar(buildUsageState());
  }

  function buildUsageState() {
    const usageData = getClaudeUsageData();
    const sync = getUsageSyncPresentation(Boolean(usageData));

    return {
      windowLabel: usageData ? usageData.windowLabel : "5h",
      plan: normalizePlanName(
        (usageData && usageData.plan) || (state.usage && state.usage.plan)
      ),
      usagePercent: usageData ? usageData.usagePercent : null,
      resetText: usageData ? usageData.resetText : sync.fallbackText,
      conversationTokens: getVisibleConversationTokens(),
      syncState: sync.state,
      syncTitle: sync.title,
      details: buildUsageDetails(state.usage),
      forecast: buildBurnForecastPresentation(state.usage && state.usage.burnForecast)
    };
  }

  function buildUsageDetails(usageValue) {
    const usage = asObject(usageValue);
    const rows = [
      {
        key: "five-hour",
        label: "5-hour",
        percent: coerceOptionalPercent(usage.fiveHourPercent ?? usage.usagePercent),
        detail: () => formatDetailReset(usage.fiveHourResetAt ?? usage.resetAt)
      },
      {
        key: "weekly",
        label: "Weekly",
        percent: coerceOptionalPercent(usage.sevenDayPercent),
        detail: () => formatDetailReset(usage.sevenDayResetAt)
      },
      {
        key: "extra",
        label: "Extra usage",
        percent: coerceOptionalPercent(usage.extraUsagePercent),
        detail: () => formatExtraUsageAmount(
          usage.extraUsageUsedCredits,
          usage.extraUsageMonthlyLimit,
          usage.extraUsageCurrency
        )
      }
    ];

    return rows
      .filter((row) => row.percent !== null)
      .map((row) => ({
        key: row.key,
        label: row.label,
        percent: row.percent,
        detail: row.detail()
      }));
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
    const forecast = asObject(value);
    const calculatedAt = Number(forecast.calculatedAt);
    const sampleCount = Number(forecast.sampleCount);
    const observedMinutes = Number(forecast.observedMinutes);
    const percentPerHour = Number(forecast.percentPerHour);
    const estimatedLimitAt = Number(forecast.estimatedLimitAt);
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
      resetText: getCurrentResetText(usage),
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
      storeUsageForOrg(state, state.usage.organizationId, state.usage);
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
    return {
      windowLabel: "5h",
      plan: pickPlan(text),
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
    const percentText = Number.isFinite(percent) ? `${percent}%` : "--";
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

    bar.dataset.usageTone = getUsageTone(percent);
    bar.dataset.theme = resolveThemePreference(themePreference);
    bar.dataset.hasTokens = tokenText ? "true" : "false";
    bar.dataset.syncState = usageState.syncState;
    bar.dataset.detailsOpen = detailsOpen ? "true" : "false";
    bar.style.setProperty("--cum-progress", Number.isFinite(percent) ? `${percent}%` : "0%");
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
        ${renderUsageDetails(usageState.details)}
        ${renderBurnForecast(usageState.forecast)}
        ${renderThemePicker(themePreference)}
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
    const target = event.target;
    const closestFrom = (selector) => (target && target.closest ? target.closest(selector) : null);

    const themeButton = closestFrom("[data-cum-theme-choice]");
    if (themeButton) {
      event.preventDefault();
      event.stopPropagation();
      setThemePreference(themeButton.getAttribute("data-cum-theme-choice"));
      return;
    }

    const refreshButton = closestFrom(".cum-refresh");
    if (!refreshButton || usageRefreshPending) {
      if (closestFrom(".cum-main") || target === bar) {
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

  function getMountedBars() {
    return Array.from(document.querySelectorAll(`[id="${ROOT_ID}"]`));
  }

  function reconcileBarElement() {
    const mountedBars = getMountedBars();
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
    getMountedBars().forEach((mountedBar) => mountedBar.remove());
    bar = null;
    lastRenderedHtml = "";
  }

  function findComposerContainer(force = false) {
    if (!force && isUsableComposer(cachedComposer)) {
      return cachedComposer;
    }

    const candidates = Array.from(document.querySelectorAll(COMPOSER_SELECTOR))
      .filter((node) => !node.closest(`#${ROOT_ID}`))
      .slice(-30)
      .reverse();

    cachedComposer = findFirst(candidates, findComposerAncestor) || null;
    return cachedComposer;
  }

  function isUsableComposer(composer) {
    if (!composer || !composer.isConnected || !composer.parentNode || !composer.querySelector) {
      return false;
    }

    return Boolean(composer.querySelector(COMPOSER_SELECTOR));
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
    const hasInput = node.querySelector && node.querySelector(COMPOSER_SELECTOR);
    const hasButton = node.querySelector && node.querySelector("button,[role='button']");

    return Boolean(
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

    return findFirst(patterns, (pattern) => {
      const match = String(text || "").match(pattern);
      return normalizePlanName(match && match[1]);
    });
  }

  function pickPercent(text) {
    const matches = Array.from(String(text || "").matchAll(/(\d{1,3})(?:\.\d+)?\s*%/g));
    return matches.length ? coercePercent(Number(matches[matches.length - 1][1])) : null;
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
    const pattern = /(\d+(?:\.\d+)?)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/gi;
    let total = 0;
    let match;

    while ((match = pattern.exec(String(text || "")))) {
      const value = Number(match[1]);
      const unit = match[2][0].toLowerCase();
      const scale = unit === "d" ? 24 * 60 : unit === "h" ? 60 : 1;
      total += value * scale * 60 * 1000;
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

  function normalizeConversationTokensUI(value) {
    const source = asObject(value);
    const conversationTokens = Number(source.conversationTokens);
    const updatedAt = Number(source.updatedAt);
    if (
      typeof source.conversationId !== "string" ||
      !source.conversationId ||
      !Number.isFinite(conversationTokens)
    ) {
      return null;
    }

    return {
      conversationId: source.conversationId,
      conversationTokens: Math.max(0, Math.round(conversationTokens)),
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0
    };
  }

  function selectConversationTokenState(incomingValue, currentValue, conversationId) {
    const incoming = normalizeConversationTokensUI(incomingValue);
    if (incoming && incoming.conversationId === conversationId) {
      return incoming;
    }

    const current = normalizeConversationTokensUI(currentValue);
    return current && current.conversationId === conversationId ? current : null;
  }

  function getVisibleConversationTokens() {
    const convUI = normalizeConversationTokensUI(state.conversationTokensUI);
    return convUI && convUI.conversationId === getConversationIdFromUrl()
      ? convUI.conversationTokens
      : null;
  }

  function getCurrentTokenEstimateText() {
    return formatEstimatedTokenCount(getVisibleConversationTokens());
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

    const elapsedMinutes = Math.floor(Math.max(0, Number(now) - updatedAt) / 60000);
    if (elapsedMinutes < 1) {
      return "Updated just now";
    }
    if (elapsedMinutes < 60) {
      return `Updated ${elapsedMinutes}m ago`;
    }

    const elapsedHours = Math.floor(elapsedMinutes / 60);
    return elapsedHours < 24
      ? `Updated ${elapsedHours}h ago`
      : `Updated ${Math.floor(elapsedHours / 24)}d ago`;
  }

  const HTML_ESCAPES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  };

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"]/g, (character) => HTML_ESCAPES[character]);
  }
})();
