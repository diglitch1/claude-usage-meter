(function () {
  const STORAGE_KEY = "claudeUsageMeterStateV2";
  const ALARM_NAME = "refresh-usage";
  const NORMAL_PERIOD_MINUTES = 1.5;
  const BACKOFF_PERIOD_MINUTES = 5;
  const FAILURE_BACKOFF_THRESHOLD = 2;
  const MESSAGE_REFRESH_USAGE = "CUM_REFRESH_USAGE";
  const MESSAGE_ORG_ID_DETECTED = "CUM_ORG_ID_DETECTED";

  const extensionApi =
    typeof browser !== "undefined"
      ? browser
      : typeof chrome !== "undefined"
        ? chrome
        : null;
  const usesPromiseRuntime = typeof browser !== "undefined" && extensionApi === browser;

  let refreshInFlight = null;

  if (!extensionApi || !extensionApi.storage || !extensionApi.storage.local) {
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

    if (extensionApi.runtime && extensionApi.runtime.onInstalled) {
      extensionApi.runtime.onInstalled.addListener(() => {
        ensureAlarm(NORMAL_PERIOD_MINUTES).catch(() => {});
        refreshUsage({ reason: "installed" }).catch(() => {});
      });
    }

    if (extensionApi.runtime && extensionApi.runtime.onStartup) {
      extensionApi.runtime.onStartup.addListener(() => {
        ensureAlarm(NORMAL_PERIOD_MINUTES).catch(() => {});
        refreshUsage({ reason: "startup" }).catch(() => {});
      });
    }

    if (extensionApi.runtime && extensionApi.runtime.onMessage) {
      extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
      const res = await fetch(
        `https://claude.ai/api/organizations/${encodeURIComponent(orgId)}/usage`,
        {
          credentials: "include",
          headers: {
            "anthropic-client-platform": "web_claude_ai",
            "content-type": "application/json"
          }
        }
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
      return markUsageSuccess({
        data,
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

  async function markUsageSuccess({ data, orgId, reason }) {
    const now = Date.now();
    const state = await loadState();
    rollDayIfNeeded(state, now);

    const normalized = normalizeUsageResponse(data, getUsageForOrg(state, orgId) || state.usage || {}, now);
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
      state.usage = Object.assign({}, state.usage || {}, normalized, {
        organizationId: orgId,
        source: "usage-api",
        stale: false,
        updatedAt: now
      });
      storeUsageForOrg(state, orgId, state.usage);
    } else {
      state.usage = Object.assign(createStaleUsageForOrg(orgId, now), {
        lastError: "unparsed-usage-response",
        lastErrorAt: now,
        source: "usage-api",
        stale: true
      });
      storeUsageForOrg(state, orgId, state.usage);
    }

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
      const now = Date.now();
      state.organizationId = orgId;
      state.usage = getUsageForOrg(state, orgId) || createStaleUsageForOrg(orgId, now);
      await saveState(state);
    }
    return { ok: true, orgId, state };
  }

  function shouldSkipForBackoff(state, now, force) {
    if (
      !state ||
      !state.usageFetch ||
      !state.usageFetch.stale ||
      !Number.isFinite(state.usageFetch.nextAttemptAt) ||
      state.usageFetch.nextAttemptAt <= now
    ) {
      return false;
    }

    if (!force) {
      return true;
    }

    return (
      state.usageFetch.status === "cloudflare-challenge" ||
      (Number(state.usageFetch.failureCount) || 0) >= FAILURE_BACKOFF_THRESHOLD
    );
  }

  async function loadState() {
    const result = await storageGet([STORAGE_KEY]);
    const stored = result && result[STORAGE_KEY];
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
    state.usage = Object.assign({}, state.usage, (stored && stored.usage) || {});
    state.usageByOrg = stored && stored.usageByOrg && typeof stored.usageByOrg === "object"
      ? stored.usageByOrg
      : {};
    return state;
  }

  function createDefaultState() {
    return {
      day: getDayKey(Date.now()),
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

  async function saveState(state) {
    await storageSet({ [STORAGE_KEY]: state });
  }

  function getUsageForOrg(state, orgId) {
    const normalized = normalizeOrgId(orgId);
    if (!normalized || !state.usageByOrg || !state.usageByOrg[normalized]) {
      return null;
    }

    return Object.assign({}, state.usageByOrg[normalized]);
  }

  function storeUsageForOrg(state, orgId, usage) {
    const normalized = normalizeOrgId(orgId);
    if (!normalized) {
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

  async function ensureAlarm(periodMinutes) {
    if (!extensionApi.alarms) {
      return;
    }

    const alarm = await alarmGet(ALARM_NAME);
    if (alarm && Math.abs((alarm.periodInMinutes || 0) - periodMinutes) < 0.01) {
      return;
    }

    await alarmCreate(ALARM_NAME, {
      delayInMinutes: periodMinutes,
      periodInMinutes: periodMinutes
    });
  }

  function normalizeUsageResponse(data, previousUsage, now) {
    if (!data || typeof data !== "object") {
      return null;
    }

    const fiveHour = data.five_hour || null;
    const sevenDay = data.seven_day || null;
    const extraUsage = data.extra_usage || null;

    const fiveHourPercent = fiveHour && Number.isFinite(fiveHour.utilization)
      ? coercePercent(fiveHour.utilization)
      : null;
    const fiveHourResetAt = fiveHour && fiveHour.resets_at
      ? Date.parse(fiveHour.resets_at)
      : null;

    const sevenDayPercent = sevenDay && Number.isFinite(sevenDay.utilization)
      ? coercePercent(sevenDay.utilization)
      : null;
    const sevenDayResetAt = sevenDay && sevenDay.resets_at
      ? Date.parse(sevenDay.resets_at)
      : null;

    const extraUsagePercent = extraUsage && Number.isFinite(extraUsage.utilization)
      ? coercePercent(extraUsage.utilization)
      : null;

    if (
      fiveHourPercent === null &&
      sevenDayPercent === null &&
      extraUsagePercent === null
    ) {
      return null;
    }

    const usagePercent = fiveHourPercent;
    const resetAt = Number.isFinite(fiveHourResetAt) ? fiveHourResetAt : null;
    const resetText = resetAt ? formatDuration(resetAt - now) : "";

    return {
      windowLabel: "5h",
      plan: previousUsage.plan || "",
      usagePercent,
      resetText,
      resetAt,
      fiveHourPercent,
      fiveHourResetAt,
      sevenDayPercent,
      sevenDayResetAt,
      extraUsagePercent,
      extraUsageUsedCredits: extraUsage && Number.isFinite(extraUsage.used_credits)
        ? extraUsage.used_credits
        : null,
      extraUsageMonthlyLimit: extraUsage && Number.isFinite(extraUsage.monthly_limit)
        ? extraUsage.monthly_limit
        : null,
      extraUsageCurrency: extraUsage && typeof extraUsage.currency === "string"
        ? extraUsage.currency
        : null
    };
  }

  function normalizeOrgId(value) {
    const text = String(value || "").trim();
    const match =
      text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i) ||
      text.match(/\borg_[A-Za-z0-9_-]{8,}\b/) ||
      text.match(/\b[A-Za-z0-9_-]{20,}\b/);
    return match ? match[0] : "";
  }

  function rollDayIfNeeded(state, now) {
    const day = getDayKey(now);
    if (state.day === day) {
      return;
    }

    state.day = day;
  }

  function normalizeResetText(text) {
    return String(text || "")
      .trim()
      .replace(/^resets?\s+/i, "")
      .replace(/^in\s+/i, "")
      .replace(/\bhours?\b|\bhrs?\b/gi, "h")
      .replace(/\bminutes?\b|\bmins?\b/gi, "m")
      .replace(/\s+/g, " ");
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

  function getDayKey(timestamp) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function getErrorMessage(error) {
    return error && error.message ? error.message : String(error || "unknown-error");
  }

  function storageGet(keys) {
    if (usesPromiseRuntime) {
      return extensionApi.storage.local.get(keys);
    }
    return new Promise((resolve) => extensionApi.storage.local.get(keys, resolve));
  }

  function storageSet(value) {
    if (usesPromiseRuntime) {
      return extensionApi.storage.local.set(value);
    }
    return new Promise((resolve) => extensionApi.storage.local.set(value, resolve));
  }

  function alarmGet(name) {
    if (!extensionApi.alarms || !extensionApi.alarms.get) {
      return Promise.resolve(null);
    }
    if (usesPromiseRuntime) {
      return extensionApi.alarms.get(name).catch(() => null);
    }
    return new Promise((resolve) => extensionApi.alarms.get(name, (alarm) => resolve(alarm || null)));
  }

  function alarmCreate(name, options) {
    if (!extensionApi.alarms || !extensionApi.alarms.create) {
      return Promise.resolve();
    }
    extensionApi.alarms.create(name, options);
    return Promise.resolve();
  }
})();
