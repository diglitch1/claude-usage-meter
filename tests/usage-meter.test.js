const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const STORAGE_KEY = "claudeUsageMeterStateV2";
const ORG_A = "org_account_AAAAAAAAAAAA";
const ORG_B = "org_account_BBBBBBBBBBBB";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeUsageResponse({ utilization, resetsAt, sevenDay = 9, extra = 61.625 }) {
  return {
    five_hour: {
      utilization,
      resets_at: resetsAt
    },
    seven_day: {
      utilization: sevenDay,
      resets_at: "2026-05-20T01:00:00.095693+00:00"
    },
    seven_day_opus: null,
    seven_day_sonnet: null,
    extra_usage: {
      is_enabled: true,
      monthly_limit: 800,
      used_credits: 493,
      utilization: extra,
      currency: "EUR",
      disabled_reason: null
    }
  };
}

function createBackgroundHarness(fetchImpl) {
  const storage = {};
  const alarms = {};
  const listeners = {
    message: null
  };
  const event = () => ({
    addListener(listener) {
      listeners.message = listeners.message || listener;
    }
  });

  const browser = {
    storage: {
      local: {
        async get(keys) {
          if (Array.isArray(keys)) {
            return keys.reduce((result, key) => {
              if (Object.prototype.hasOwnProperty.call(storage, key)) {
                result[key] = clone(storage[key]);
              }
              return result;
            }, {});
          }
          if (typeof keys === "string") {
            return Object.prototype.hasOwnProperty.call(storage, keys)
              ? { [keys]: clone(storage[keys]) }
              : {};
          }
          return clone(storage);
        },
        async set(value) {
          Object.assign(storage, clone(value));
        }
      }
    },
    alarms: {
      onAlarm: event(),
      async get(name) {
        return alarms[name] || null;
      },
      create(name, options) {
        alarms[name] = Object.assign({ name }, options);
      }
    },
    runtime: {
      onInstalled: event(),
      onStartup: event(),
      onMessage: {
        addListener(listener) {
          listeners.message = listener;
        }
      }
    }
  };

  const context = {
    browser,
    console,
    Date,
    fetch: fetchImpl,
    Promise,
    setTimeout
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(ROOT, "src/background.js"), "utf8"),
    context,
    { filename: "src/background.js" }
  );

  return {
    async send(message) {
      assert.equal(typeof listeners.message, "function");
      return listeners.message(message, {}, () => {});
    },
    getState() {
      return clone(storage[STORAGE_KEY]);
    }
  };
}

test("background stores known usage response fields per organization", async () => {
  const responses = {
    [ORG_A]: makeUsageResponse({
      utilization: 91,
      resetsAt: "2026-05-14T18:30:01.095671+00:00"
    }),
    [ORG_B]: makeUsageResponse({
      utilization: 12,
      resetsAt: "2026-05-14T20:00:00.000000+00:00",
      sevenDay: 4,
      extra: 25
    })
  };
  const harness = createBackgroundHarness(async (url) => {
    const orgId = Object.keys(responses).find((item) => url.includes(item));
    assert.ok(orgId, `unexpected URL ${url}`);
    return {
      ok: true,
      status: 200,
      async json() {
        return responses[orgId];
      }
    };
  });

  await harness.send({ type: "CUM_REFRESH_USAGE", force: true, orgId: ORG_A });
  let state = harness.getState();
  assert.equal(state.organizationId, ORG_A);
  assert.equal(state.usage.organizationId, ORG_A);
  assert.equal(state.usage.usagePercent, 91);
  assert.equal(state.usage.resetAt, Date.parse("2026-05-14T18:30:01.095671+00:00"));
  assert.equal(state.usage.fiveHourPercent, 91);
  assert.equal(state.usage.sevenDayPercent, 9);
  assert.equal(state.usage.extraUsagePercent, 62);
  assert.equal(state.usage.extraUsageUsedCredits, 493);
  assert.equal(state.usage.extraUsageMonthlyLimit, 800);
  assert.equal(state.usage.extraUsageCurrency, "EUR");
  assert.equal(state.usageByOrg[ORG_A].usagePercent, 91);

  await harness.send({ type: "CUM_ORG_ID_DETECTED", orgId: ORG_B });
  state = harness.getState();
  assert.equal(state.organizationId, ORG_B);
  assert.equal(state.usage.organizationId, ORG_B);
  assert.equal(state.usage.usagePercent, null);
  assert.equal(state.usage.stale, true);

  await harness.send({ type: "CUM_REFRESH_USAGE", force: true, orgId: ORG_B });
  state = harness.getState();
  assert.equal(state.organizationId, ORG_B);
  assert.equal(state.usage.usagePercent, 12);
  assert.equal(state.usageByOrg[ORG_A].usagePercent, 91);
  assert.equal(state.usageByOrg[ORG_B].usagePercent, 12);

  await harness.send({ type: "CUM_ORG_ID_DETECTED", orgId: ORG_A });
  state = harness.getState();
  assert.equal(state.organizationId, ORG_A);
  assert.equal(state.usage.organizationId, ORG_A);
  assert.equal(state.usage.usagePercent, 91);
});

test("background clears old active usage when a 200 response cannot be parsed", async () => {
  let response = makeUsageResponse({
    utilization: 45,
    resetsAt: "2026-05-14T18:30:01.095671+00:00"
  });
  const harness = createBackgroundHarness(async () => ({
    ok: true,
    status: 200,
    async json() {
      return response;
    }
  }));

  await harness.send({ type: "CUM_REFRESH_USAGE", force: true, orgId: ORG_A });
  let state = harness.getState();
  assert.equal(state.usage.usagePercent, 45);
  assert.equal(state.usage.stale, false);

  response = { five_hour: null, seven_day: null, extra_usage: null };
  await harness.send({ type: "CUM_REFRESH_USAGE", force: true, orgId: ORG_A });
  state = harness.getState();
  assert.equal(state.usage.organizationId, ORG_A);
  assert.equal(state.usage.usagePercent, null);
  assert.equal(state.usage.stale, true);
  assert.equal(state.usageFetch.status, "ok-unparsed");
  assert.equal(state.usageFetch.stale, true);
});

test("content no longer wires local fake chat or token counters into the meter", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/content.js"), "utf8");

  assert.doesNotMatch(source, /installSendListeners/);
  assert.doesNotMatch(source, /recordSentMessage/);
  assert.doesNotMatch(source, /estimateTokens/);
  assert.doesNotMatch(source, /updateChatCountFromVisibleMessages/);
  assert.match(source, /chatMessages:\s*null/);
  assert.match(source, /todayMessages:\s*null/);
  assert.match(source, /tokensToday:\s*null/);
  assert.match(source, /tokens today --/);
});

test("content script avoids hot observers and push-style storage updates", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/content.js"), "utf8");

  assert.doesNotMatch(source, /MutationObserver/);
  assert.doesNotMatch(source, /PerformanceObserver/);
  assert.doesNotMatch(source, /storage\.onChanged/);
  assert.doesNotMatch(source, /runtime\.onMessage/);
  assert.doesNotMatch(source, /setInterval/);
  assert.doesNotMatch(source, /XMLHttpRequest/);
  assert.match(source, /STORAGE_PULL_MS\s*=\s*90000/);
  assert.match(source, /DOM_POLL_MS\s*=\s*3000/);
});
