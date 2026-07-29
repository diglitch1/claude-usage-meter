(function () {
  const shared = globalThis.CUM_SHARED;
  if (!shared) {
    return;
  }

  const {
    asObject,
    coercePercent,
    createStaleUsageForOrg,
    createStorageArea,
    createUsage,
    firstPlanName,
    formatDuration,
    getDayKey,
    getErrorMessage,
    getUsageForOrg,
    normalizeConversationId,
    normalizeOrgId,
    normalizePlanName,
    storeUsageForOrg
  } = shared;

  const STORAGE_KEY = "claudeUsageMeterStateV2";
  const USAGE_HISTORY_KEY = "claudeUsageMeterHistoryV1";
  const CONV_TOKENS_KEY = "conversationTokens";
  const CONVERSATION_TOKENS_UI_KEY = "conversationTokensUI";
  const ALARM_NAME = "refresh-usage";
  const NORMAL_PERIOD_MINUTES = 1.5;
  const BACKOFF_PERIOD_MINUTES = 5;
  const FAILURE_BACKOFF_THRESHOLD = 2;
  const MESSAGE_REFRESH_USAGE = "CUM_REFRESH_USAGE";
  const MESSAGE_ORG_ID_DETECTED = "CUM_ORG_ID_DETECTED";
  const MESSAGE_UPDATE_CONV_TOKENS = "CUM_UPDATE_CONV_TOKENS";
  const MAX_USAGE_SAMPLES = 48;
  const MIN_SAMPLE_INTERVAL_MS = 60 * 1000;
  const MIN_FORECAST_SAMPLES = 3;
  const MIN_FORECAST_SPAN_MS = 10 * 60 * 1000;
  const API_HEADERS = {
    "anthropic-client-platform": "web_claude_ai",
    "content-type": "application/json"
  };

  const extensionApi =
    typeof browser !== "undefined"
      ? browser
      : typeof chrome !== "undefined"
        ? chrome
        : null;
  const usesPromiseRuntime = typeof browser !== "undefined" && extensionApi === browser;
  const storage = createStorageArea(extensionApi);

  let refreshInFlight = null;

  if (!storage) {
    return;
  }

  installListeners();
  initialize();

  function installListeners() {
    if (extensionApi.alarms && extensionApi.alarms.onAlarm) {
      extensionApi.alarms.onAlarm.addListener((alarm) => {
        if (alarm && alarm.name === ALARM_NAME) {
          refreshUsage({ reason: "alarm" }).catch(() => {});
        }
      });
    }

    const runtime = extensionApi.runtime;
    if (!runtime) {
      return;
    }

    ["onInstalled", "onStartup"].forEach((eventName) => {
      if (runtime[eventName]) {
        runtime[eventName].addListener(() => {
          ensureAlarm(NORMAL_PERIOD_MINUTES).catch(() => {});
          refreshUsage({ reason: eventName === "onInstalled" ? "installed" : "startup" }).catch(() => {});
        });
      }
    });

    if (runtime.onMessage) {
      runtime.onMessage.addListener((message, _sender, sendResponse) => {
        const response = handleMessage(message);
        if (!response) {
          return false;
        }

        if (usesPromiseRuntime) {
          return response;
        }

        response.then(
          (value) => sendResponse(value),
          (error) => sendResponse({ ok: false, error: getErrorMessage(error) })
        );
        return true;
      });
    }
  }

  function initialize() {
    ensureAlarm(NORMAL_PERIOD_MINUTES).catch(() => {});
    refreshUsage({ reason: "background-start" }).catch(() => {});
  }

  function handleMessage(message) {
    if (!message || typeof message !== "object") {
      return null;
    }

    if (message.type === MESSAGE_ORG_ID_DETECTED) {
      const orgId = normalizeOrgId(message.orgId);
      return orgId ? saveDetectedOrgId(orgId) : Promise.resolve({ ok: false, error: "missing-org-id" });
    }

    if (message.type === MESSAGE_REFRESH_USAGE) {
      return refreshUsage({
        force: Boolean(message.force),
        orgId: message.orgId,
        reason: message.reason || "message"
      });
    }

    if (message.type === MESSAGE_UPDATE_CONV_TOKENS) {
      return updateConversationTokens(message.orgId, message.conversationId).then((uiState) => ({
        ok: Boolean(uiState),
        conversationTokensUI: uiState
      }));
    }

    return null;
  }

  function refreshUsage(options = {}) {
    if (refreshInFlight) {
      if (options.force || normalizeOrgId(options.orgId)) {
        return refreshInFlight.then(() => refreshUsage(options));
      }
      return refreshInFlight;
    }

    refreshInFlight = refreshUsageNow(options).finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  async function refreshUsageNow(options) {
    const now = Date.now();
    const state = await loadState();
    const orgId = normalizeOrgId(options.orgId) || normalizeOrgId(state.organizationId);

    if (!orgId) {
      return markUsageFailure({
        error: "missing-org-id",
        failureKind: "missing-org",
        reason: options.reason,
        shouldCountFailure: false,
        status: null
      });
    }

    if (shouldSkipForBackoff(state, now, options.force)) {
      return {
        ok: false,
        skipped: true,
        stale: true,
        nextAttemptAt: state.usageFetch.nextAttemptAt || null
      };
    }

    try {
      const res = await apiFetch(
        `/api/organizations/${encodeURIComponent(orgId)}/usage`
      );

      if (!res.ok) {
        return markUsageFailure({
          error: `HTTP ${res.status}`,
          failureKind: res.status === 403 ? "cloudflare-challenge" : "http",
          orgId,
          reason: options.reason,
          status: res.status
        });
      }

      const data = await res.json();
      const previousUsage = getUsageForOrg(state, orgId) || state.usage || {};
      const detectedPlan =
        extractPlanFromUsageResponse(data) ||
        normalizePlanName(previousUsage.plan) ||
        await fetchOrganizationPlan(orgId);
      return markUsageSuccess({
        data,
        detectedPlan,
        orgId,
        reason: options.reason
      });
    } catch (error) {
      return markUsageFailure({
        error: getErrorMessage(error),
        failureKind: "network",
        orgId,
        reason: options.reason,
        status: null
      });
    }
  }

  async function markUsageSuccess({ data, detectedPlan, orgId, reason }) {
    const now = Date.now();
    const state = await loadState();
    state.day = getDayKey(now);

    const normalized = normalizeUsageResponse(
      data,
      getUsageForOrg(state, orgId) || state.usage || {},
      now,
      detectedPlan
    );
    state.organizationId = orgId;
    state.usageFetch = {
      status: normalized ? "ok" : "ok-unparsed",
      stale: !normalized,
      failureCount: 0,
      httpStatus: 200,
      lastAttemptAt: now,
      lastSuccessAt: now,
      nextAttemptAt: now + NORMAL_PERIOD_MINUTES * 60 * 1000,
      periodMinutes: NORMAL_PERIOD_MINUTES,
      reason: reason || ""
    };

    if (normalized) {
      const historyByOrg = await loadUsageHistory();
      const currentSample = normalizeUsageSample({
        timestamp: now,
        percent: getRawFiveHourPercent(data, normalized.fiveHourPercent),
        resetAt: normalized.fiveHourResetAt
      });
      const samples = appendUsageSample(historyByOrg[orgId], currentSample);
      historyByOrg[orgId] = samples;
      normalized.burnForecast = currentSample
        ? calculateBurnForecast(samples, now, normalized.fiveHourResetAt)
        : null;
      state.usage = Object.assign({}, state.usage || {}, normalized, {
        organizationId: orgId,
        source: "usage-api",
        stale: false,
        updatedAt: now
      });
      await storageSet({ [USAGE_HISTORY_KEY]: historyByOrg });
    } else {
      state.usage = Object.assign(createStaleUsageForOrg(orgId, now), {
        lastError: "unparsed-usage-response",
        lastErrorAt: now,
        source: "usage-api",
        stale: true
      });
    }

    storeUsageForOrg(state, orgId, state.usage);
    await saveState(state);
    await ensureAlarm(NORMAL_PERIOD_MINUTES);
    return {
      ok: true,
      parsed: Boolean(normalized),
      state
    };
  }

  async function markUsageFailure(details) {
    const now = Date.now();
    const state = await loadState();
    const previousFetch = state.usageFetch || {};
    const previousUsage = state.usage || {};
    const isDifferentOrg = details.orgId && previousUsage.organizationId && details.orgId !== previousUsage.organizationId;
    const failureCount = details.shouldCountFailure === false
      ? Number(previousFetch.failureCount) || 0
      : (Number(previousFetch.failureCount) || 0) + 1;
    const shouldBackOff =
      details.failureKind === "cloudflare-challenge" ||
      failureCount >= FAILURE_BACKOFF_THRESHOLD;
    const periodMinutes = shouldBackOff ? BACKOFF_PERIOD_MINUTES : NORMAL_PERIOD_MINUTES;

    if (details.orgId) {
      state.organizationId = details.orgId;
    }

    state.usage = Object.assign({}, previousUsage, {
      organizationId: details.orgId || previousUsage.organizationId || null,
      lastError: details.error,
      lastErrorAt: now,
      resetAt: isDifferentOrg ? null : previousUsage.resetAt,
      resetText: isDifferentOrg ? "" : previousUsage.resetText,
      stale: true
    });
    if (isDifferentOrg) {
      state.usage.usagePercent = null;
    }
    if (details.orgId) {
      storeUsageForOrg(state, details.orgId, state.usage);
    }
    state.usageFetch = {
      status: details.failureKind || "failed",
      stale: true,
      failureCount,
      httpStatus: Number.isFinite(details.status) ? details.status : null,
      error: details.error,
      lastAttemptAt: now,
      lastSuccessAt: previousFetch.lastSuccessAt || null,
      nextAttemptAt: now + periodMinutes * 60 * 1000,
      periodMinutes,
      reason: details.reason || ""
    };

    await saveState(state);
    await ensureAlarm(periodMinutes);
    return {
      ok: false,
      error: details.error,
      failureCount,
      status: details.status || null,
      stale: true,
      state
    };
  }

  async function saveDetectedOrgId(orgId) {
    const state = await loadState();
    if (state.organizationId !== orgId) {
      state.organizationId = orgId;
      state.usage = getUsageForOrg(state, orgId) || createStaleUsageForOrg(orgId, Date.now());
      await saveState(state);
    }
    return { ok: true, orgId, state };
  }

  function shouldSkipForBackoff(state, now, force) {
    const usageFetch = state && state.usageFetch;
    if (
      !usageFetch ||
      !usageFetch.stale ||
      !Number.isFinite(usageFetch.nextAttemptAt) ||
      usageFetch.nextAttemptAt <= now
    ) {
      return false;
    }

    if (!force) {
      return true;
    }

    return (
      usageFetch.status === "cloudflare-challenge" ||
      (Number(usageFetch.failureCount) || 0) >= FAILURE_BACKOFF_THRESHOLD
    );
  }

  async function loadState() {
    const stored = (await storageGet([STORAGE_KEY]))[STORAGE_KEY];
    const state = createDefaultState();

    if (stored && typeof stored.day === "string") {
      state.day = stored.day;
    }
    if (stored && stored.organizationId) {
      state.organizationId = stored.organizationId;
    }
    if (stored && stored.usageFetch && typeof stored.usageFetch === "object") {
      state.usageFetch = stored.usageFetch;
    }
    state.usage = Object.assign(state.usage, (stored && stored.usage) || {});
    state.usageByOrg = Object.assign({}, asObject(stored && stored.usageByOrg));
    return state;
  }

  function createDefaultState() {
    return {
      day: getDayKey(),
      usage: createUsage(),
      usageByOrg: {},
      usageFetch: null
    };
  }

  function saveState(state) {
    return storageSet({ [STORAGE_KEY]: state });
  }

  async function loadUsageHistory() {
    return Object.assign({}, asObject((await storageGet([USAGE_HISTORY_KEY]))[USAGE_HISTORY_KEY]));
  }

  function appendUsageSample(existingSamples, sample) {
    const normalizedSample = normalizeUsageSample(sample);
    if (!normalizedSample) {
      return sanitizeUsageSamples(existingSamples).slice(-MAX_USAGE_SAMPLES);
    }

    const samples = sanitizeUsageSamples(existingSamples)
      .filter((item) => item.resetAt === normalizedSample.resetAt)
      .slice(-MAX_USAGE_SAMPLES);
    const previous = samples[samples.length - 1];

    if (previous && normalizedSample.timestamp <= previous.timestamp) {
      return samples;
    }
    if (previous && normalizedSample.timestamp - previous.timestamp < MIN_SAMPLE_INTERVAL_MS) {
      samples[samples.length - 1] = normalizedSample;
      return samples;
    }

    samples.push(normalizedSample);
    return samples.slice(-MAX_USAGE_SAMPLES);
  }

  function sanitizeUsageSamples(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map(normalizeUsageSample)
      .filter(Boolean)
      .sort((left, right) => left.timestamp - right.timestamp);
  }

  function normalizeUsageSample(value) {
    const timestamp = Number(value && value.timestamp);
    const percent = Number(value && value.percent);
    const resetAt = Number(value && value.resetAt);
    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(percent) ||
      !Number.isFinite(resetAt) ||
      timestamp <= 0 ||
      resetAt <= timestamp ||
      percent < 0 ||
      percent > 100
    ) {
      return null;
    }

    return { timestamp, percent, resetAt };
  }

  function getRawFiveHourPercent(data, fallback) {
    const raw = Number(data && data.five_hour && data.five_hour.utilization);
    return Number.isFinite(raw) ? raw : fallback;
  }

  function calculateBurnForecast(existingSamples, now = Date.now(), expectedResetAt = null) {
    const resetAt = Number(expectedResetAt);
    const samples = sanitizeUsageSamples(existingSamples).filter((sample) =>
      (!Number.isFinite(resetAt) || sample.resetAt === resetAt) && sample.timestamp <= now
    );
    if (samples.length < MIN_FORECAST_SAMPLES) {
      return null;
    }

    const recent = samples.slice(-MAX_USAGE_SAMPLES);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const spanMs = last.timestamp - first.timestamp;
    const percentDelta = last.percent - first.percent;
    const hasDecrease = recent.some((sample, index) =>
      index > 0 && sample.percent < recent[index - 1].percent
    );
    if (spanMs < MIN_FORECAST_SPAN_MS || percentDelta < 0.5 || hasDecrease) {
      return null;
    }

    const percentPerMs = percentDelta / spanMs;
    const estimatedLimitAt = last.percent >= 100
      ? last.timestamp
      : last.timestamp + (100 - last.percent) / percentPerMs;
    const activeResetAt = Number.isFinite(resetAt) ? resetAt : last.resetAt;

    return {
      calculatedAt: now,
      estimatedLimitAt: Math.round(estimatedLimitAt),
      observedMinutes: Math.round(spanMs / 60000),
      percentPerHour: Math.round(percentPerMs * 60 * 60 * 1000 * 10) / 10,
      resetAt: activeResetAt,
      sampleCount: recent.length,
      willHitBeforeReset: estimatedLimitAt <= activeResetAt
    };
  }

  async function ensureAlarm(periodMinutes) {
    if (!extensionApi.alarms || !extensionApi.alarms.create) {
      return;
    }

    const alarm = await alarmGet(ALARM_NAME);
    if (alarm && Math.abs((alarm.periodInMinutes || 0) - periodMinutes) < 0.01) {
      return;
    }

    extensionApi.alarms.create(ALARM_NAME, {
      delayInMinutes: periodMinutes,
      periodInMinutes: periodMinutes
    });
  }

  function apiFetch(path) {
    return fetch(`https://claude.ai${path}`, {
      credentials: "include",
      headers: API_HEADERS
    });
  }

  async function apiFetchJson(path) {
    try {
      const response = await apiFetch(path);
      return response && response.ok ? await response.json() : null;
    } catch (_error) {
      return null;
    }
  }

  async function fetchConversationTokens(orgId, conversationId) {
    const normalizedOrgId = normalizeOrgId(orgId);
    const normalizedConversationId = normalizeConversationId(conversationId);
    const countTokens = getTokenizerCounter();
    if (!normalizedOrgId || !normalizedConversationId || !countTokens) {
      return null;
    }

    const data = await apiFetchJson(
      `/api/organizations/${encodeURIComponent(normalizedOrgId)}` +
      `/chat_conversations/${encodeURIComponent(normalizedConversationId)}` +
      "?tree=true&rendering_mode=messages&render_all_tools=true"
    );
    if (!data) {
      return null;
    }

    try {
      return countConversationTokens(data, countTokens);
    } catch (_error) {
      return null;
    }
  }

  async function updateConversationTokens(orgId, conversationId) {
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (!normalizeOrgId(orgId) || !normalizedConversationId) {
      return null;
    }

    const tokenCount = await fetchConversationTokens(orgId, normalizedConversationId);
    if (tokenCount === null) {
      return null;
    }

    const convState = asObject((await storageGet([CONV_TOKENS_KEY]))[CONV_TOKENS_KEY]);
    convState[normalizedConversationId] = tokenCount;

    const uiState = {
      conversationId: normalizedConversationId,
      conversationTokens: tokenCount,
      updatedAt: Date.now()
    };

    await storageSet({
      [CONV_TOKENS_KEY]: convState,
      [CONVERSATION_TOKENS_UI_KEY]: uiState
    });

    return uiState;
  }

  function extractConversationText(data) {
    const messages = data && Array.isArray(data.chat_messages) ? data.chat_messages : [];
    const parts = [];

    for (const message of messages) {
      if (!message || typeof message !== "object") {
        continue;
      }

      appendContentText(parts, message.content, 0);
      if (typeof message.text === "string") {
        parts.push(message.text);
      }
    }

    return parts.length ? `${parts.join("\n")}\n` : "";
  }

  function countConversationTokens(data, countTextTokens) {
    return countTextTokens(extractConversationText(data));
  }

  function appendContentText(parts, value, depth) {
    if (value == null || depth > 4) {
      return;
    }

    if (typeof value === "string") {
      parts.push(value);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => appendContentText(parts, item, depth + 1));
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    if (typeof value.text === "string") {
      parts.push(value.text);
    }
    if (typeof value.content === "string" || Array.isArray(value.content)) {
      appendContentText(parts, value.content, depth + 1);
    }
  }

  function getTokenizerCounter() {
    const tokenizer = globalThis.GPTTokenizer_o200k_base;
    if (typeof globalThis.__gptTokenizerCount === "function") {
      return globalThis.__gptTokenizerCount;
    }
    if (tokenizer && typeof tokenizer.countTokens === "function") {
      return tokenizer.countTokens.bind(tokenizer);
    }

    const encode = typeof globalThis.__gptTokenizerEncode === "function"
      ? globalThis.__gptTokenizerEncode
      : tokenizer && typeof tokenizer.encode === "function"
        ? tokenizer.encode
        : null;
    return encode ? (text) => encode(text).length : null;
  }

  function readWindow(source) {
    const resetAt = source && source.resets_at ? Date.parse(source.resets_at) : null;
    return {
      percent: source && Number.isFinite(source.utilization)
        ? coercePercent(source.utilization)
        : null,
      resetAt: Number.isFinite(resetAt) ? resetAt : null
    };
  }

  function normalizeUsageResponse(data, previousUsage, now, detectedPlan = "") {
    if (!data || typeof data !== "object") {
      return null;
    }

    const fiveHour = readWindow(data.five_hour);
    const sevenDay = readWindow(data.seven_day);
    const extra = readWindow(data.extra_usage);
    const extraUsage = data.extra_usage || {};

    if (fiveHour.percent === null && sevenDay.percent === null && extra.percent === null) {
      return null;
    }

    return {
      windowLabel: "5h",
      plan:
        normalizePlanName(detectedPlan) ||
        extractPlanFromUsageResponse(data) ||
        normalizePlanName(previousUsage.plan),
      usagePercent: fiveHour.percent,
      resetText: fiveHour.resetAt ? formatDuration(fiveHour.resetAt - now) : "",
      resetAt: fiveHour.resetAt,
      fiveHourPercent: fiveHour.percent,
      fiveHourResetAt: fiveHour.resetAt,
      sevenDayPercent: sevenDay.percent,
      sevenDayResetAt: sevenDay.resetAt,
      extraUsagePercent: extra.percent,
      extraUsageUsedCredits: Number.isFinite(extraUsage.used_credits)
        ? extraUsage.used_credits
        : null,
      extraUsageMonthlyLimit: Number.isFinite(extraUsage.monthly_limit)
        ? extraUsage.monthly_limit
        : null,
      extraUsageCurrency: typeof extraUsage.currency === "string"
        ? extraUsage.currency
        : null
    };
  }

  function extractPlanFromUsageResponse(data) {
    return firstPlanName([
      data.plan,
      data.plan_type,
      data.subscription_type,
      data.billing_type,
      data.account_type,
      data.subscription && data.subscription.plan,
      data.organization && data.organization.plan,
      data.account && data.account.plan
    ]);
  }

  async function fetchOrganizationPlan(orgId) {
    const data = await apiFetchJson("/api/organizations");
    const records = Array.isArray(data)
      ? data
      : (data && Array.isArray(data.organizations) ? data.organizations : []);
    const record = records.find((item) => {
      if (!item || typeof item !== "object") {
        return false;
      }
      const recordId = item.uuid || item.id || item.organization_id || item.organizationId;
      return String(recordId || "") === orgId;
    });

    return extractPlanFromOrganizationRecord(record);
  }

  function extractPlanFromOrganizationRecord(record) {
    if (!record || typeof record !== "object") {
      return "";
    }

    return firstPlanName([
      record.plan,
      record.plan_type,
      record.subscription_type,
      record.rate_limit_tier,
      record.billing_plan,
      record.billing_type,
      record.account_type,
      record.subscription && record.subscription.plan,
      record.subscription && record.subscription.type,
      ...(Array.isArray(record.capabilities) ? record.capabilities : [])
    ]);
  }

  function storageGet(keys) {
    return storage.get(keys).then((result) => result || {});
  }

  function storageSet(value) {
    return storage.set(value);
  }

  function alarmGet(name) {
    if (!extensionApi.alarms.get) {
      return Promise.resolve(null);
    }
    if (usesPromiseRuntime) {
      return extensionApi.alarms.get(name).catch(() => null);
    }
    return new Promise((resolve) => extensionApi.alarms.get(name, (alarm) => resolve(alarm || null)));
  }

  if (globalThis.__CUM_TEST__) {
    globalThis.__CUM_TEST_HOOKS__ = {
      fetchConversationTokens,
      updateConversationTokens,
      extractConversationText,
      countConversationTokens,
      normalizePlanName,
      extractPlanFromOrganizationRecord,
      normalizeConversationId,
      appendUsageSample,
      calculateBurnForecast
    };
  }
})();
