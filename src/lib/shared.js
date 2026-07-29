// Helpers used by both the background and the content script. Each entry point
// loads this file first and reads the namespace off globalThis.
(function () {
  const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const UUID_PATTERN = new RegExp(UUID_SOURCE, "i");
  const ORG_ID_SOURCE = `${UUID_SOURCE}|org_[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{20,}`;
  const ORG_ID_PATTERNS = [
    UUID_PATTERN,
    /\borg_[A-Za-z0-9_-]{8,}\b/,
    /\b[A-Za-z0-9_-]{20,}\b/
  ];
  const CONVERSATION_ID_PATTERNS = [UUID_PATTERN, /\b[A-Za-z0-9_-]{12,}\b/];
  const PLAN_LABELS = [
    [/\benterprise\b/i, "Enterprise"],
    [/\beducation\b|\bedu\b/i, "Education"],
    [/\bteam\b/i, "Team"],
    [/\bpro\b/i, "Pro"],
    [/\bfree\b/i, "Free"]
  ];

  function findFirst(items, select) {
    for (const item of items) {
      const found = select(item);
      if (found) {
        return found;
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

    const label = PLAN_LABELS.find(([pattern]) => pattern.test(text));
    return label ? label[1] : "";
  }

  function firstPlanName(candidates) {
    return findFirst(candidates, normalizePlanName);
  }

  function matchFirstPattern(value, patterns) {
    const text = String(value || "").trim();
    return findFirst(patterns, (pattern) => {
      const match = text.match(pattern);
      return match ? match[0] : "";
    });
  }

  function normalizeOrgId(value) {
    return matchFirstPattern(value, ORG_ID_PATTERNS);
  }

  function normalizeConversationId(value) {
    return matchFirstPattern(value, CONVERSATION_ID_PATTERNS);
  }

  function asObject(value) {
    return value && typeof value === "object" ? value : {};
  }

  function createUsage(extra) {
    return Object.assign(
      {
        windowLabel: "5h",
        plan: "",
        usagePercent: null,
        resetText: "",
        resetAt: null,
        updatedAt: 0
      },
      extra || {}
    );
  }

  function createStaleUsageForOrg(orgId, now) {
    return createUsage({ organizationId: orgId, stale: true, updatedAt: now });
  }

  function getUsageForOrg(state, orgId) {
    const normalized = normalizeOrgId(orgId);
    const usage = normalized ? asObject(state && state.usageByOrg)[normalized] : null;
    return usage ? Object.assign({}, usage) : null;
  }

  function storeUsageForOrg(state, orgId, usage) {
    const normalized = normalizeOrgId(orgId);
    if (!normalized || !usage || typeof usage !== "object") {
      return;
    }

    state.usageByOrg = asObject(state.usageByOrg);
    state.usageByOrg[normalized] = Object.assign({}, usage, {
      organizationId: normalized
    });
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

  function getDayKey(timestamp = Date.now()) {
    const date = new Date(timestamp);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function getErrorMessage(error) {
    return error && error.message ? error.message : String(error || "unknown-error");
  }

  // Firefox resolves extension APIs with promises; Chrome needs the callback form.
  function createStorageArea(extensionApi) {
    const area = extensionApi && extensionApi.storage && extensionApi.storage.local;
    if (!area) {
      return null;
    }

    const usesPromises = typeof browser !== "undefined" && extensionApi === browser;
    return {
      get(keys) {
        return usesPromises ? area.get(keys) : new Promise((resolve) => area.get(keys, resolve));
      },
      set(value) {
        return usesPromises ? area.set(value) : new Promise((resolve) => area.set(value, resolve));
      }
    };
  }

  globalThis.CUM_SHARED = {
    ORG_ID_SOURCE,
    asObject,
    coercePercent,
    createStaleUsageForOrg,
    createStorageArea,
    createUsage,
    findFirst,
    firstPlanName,
    formatDuration,
    getDayKey,
    getErrorMessage,
    getUsageForOrg,
    normalizeConversationId,
    normalizeOrgId,
    normalizePlanName,
    storeUsageForOrg
  };
})();
