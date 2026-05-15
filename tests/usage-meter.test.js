const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const STORAGE_KEY = "claudeUsageMeterStateV2";
const CONV_TOKENS_KEY = "conversationTokens";
const DAILY_TOKENS_KEY = "dailyTokens";
const CONVERSATION_TOKENS_UI_KEY = "conversationTokensUI";
const ORG_A = "org_account_AAAAAAAAAAAA";
const ORG_B = "org_account_BBBBBBBBBBBB";
const CONV_A = "11111111-1111-4111-8111-111111111111";
const CONV_B = "22222222-2222-4222-8222-222222222222";

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

function conversationResponse(textBlocks) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        chat_messages: textBlocks.map((text) => ({
          content: [
            { text }
          ]
        }))
      };
    }
  };
}

function wordTokenizer(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean);
}

function tokenWords(count) {
  return Array.from({ length: count }, (_, index) => `t${index}`).join(" ");
}

function createBackgroundHarness(fetchImpl, options = {}) {
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
    __CUM_TEST__: true,
    browser,
    console,
    Date,
    fetch: fetchImpl,
    Promise,
    setTimeout,
    __gptTokenizerEncode: options.tokenizer || wordTokenizer
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
    },
    getStorage(key) {
      return Object.prototype.hasOwnProperty.call(storage, key) ? clone(storage[key]) : undefined;
    },
    setStorage(key, value) {
      storage[key] = clone(value);
    },
    hooks: context.__CUM_TEST_HOOKS__,
    listeners
  };
}

function getUtcDayKey() {
  return new Date().toISOString().slice(0, 10);
}

test("updateConversationAndDailyTokens accumulates same-conversation deltas", async () => {
  const bodies = [
    ["alpha beta gamma"],
    ["alpha beta gamma delta epsilon"]
  ];
  let callIndex = 0;
  const harness = createBackgroundHarness(async (url) => {
    assert.match(url, new RegExp(`/chat_conversations/${CONV_A}\\?`));
    return conversationResponse(bodies[callIndex++]);
  });

  const first = await harness.hooks.updateConversationAndDailyTokens(ORG_A, CONV_A);
  assert.equal(first.conversationTokens, 3);
  assert.equal(first.dailyTotal, 3);

  const second = await harness.hooks.updateConversationAndDailyTokens(ORG_A, CONV_A);
  assert.equal(second.conversationTokens, 5);
  assert.equal(second.dailyTotal, 5);
  assert.equal(harness.getStorage(CONV_TOKENS_KEY)[CONV_A], 5);
  assert.deepEqual(harness.getStorage(DAILY_TOKENS_KEY), {
    date: getUtcDayKey(),
    total: 5,
    seen: {
      [CONV_A]: 5
    }
  });
  assert.equal(harness.getStorage(CONVERSATION_TOKENS_UI_KEY).dailyTotal, 5);
});

test("daily conversation token accumulator rolls over when the date changes", async () => {
  const harness = createBackgroundHarness(async () => conversationResponse([
    tokenWords(104)
  ]));
  harness.setStorage(CONV_TOKENS_KEY, {
    [CONV_A]: 99
  });
  harness.setStorage(DAILY_TOKENS_KEY, {
    date: "2000-01-01",
    total: 99,
    seen: {
      [CONV_A]: 99
    }
  });

  const uiState = await harness.hooks.updateConversationAndDailyTokens(ORG_A, CONV_A);
  assert.equal(uiState.conversationTokens, 104);
  assert.equal(uiState.dailyTotal, 5);
  assert.deepEqual(harness.getStorage(DAILY_TOKENS_KEY), {
    date: getUtcDayKey(),
    total: 5,
    seen: {
      [CONV_A]: 104
    }
  });
});

test("switching conversations calculates daily deltas independently", async () => {
  const responses = {
    [CONV_A]: [
      ["a b"],
      ["a b c d"]
    ],
    [CONV_B]: [
      ["one two three"]
    ]
  };
  const calls = {
    [CONV_A]: 0,
    [CONV_B]: 0
  };
  const harness = createBackgroundHarness(async (url) => {
    const conversationId = url.includes(CONV_A) ? CONV_A : CONV_B;
    return conversationResponse(responses[conversationId][calls[conversationId]++]);
  });

  await harness.hooks.updateConversationAndDailyTokens(ORG_A, CONV_A);
  await harness.hooks.updateConversationAndDailyTokens(ORG_A, CONV_B);
  const uiState = await harness.hooks.updateConversationAndDailyTokens(ORG_A, CONV_A);

  assert.equal(uiState.conversationId, CONV_A);
  assert.equal(uiState.conversationTokens, 4);
  assert.equal(uiState.dailyTotal, 7);
  assert.deepEqual(harness.getStorage(CONV_TOKENS_KEY), {
    [CONV_A]: 4,
    [CONV_B]: 3
  });
  assert.deepEqual(harness.getStorage(DAILY_TOKENS_KEY).seen, {
    [CONV_A]: 4,
    [CONV_B]: 3
  });
});

test("background updates conversation tokens from content script message", async () => {
  const harness = createBackgroundHarness(async () => conversationResponse([
    "red blue green"
  ]));

  const response = await harness.send({
    type: "CUM_UPDATE_CONV_TOKENS",
    orgId: ORG_A,
    conversationId: CONV_A
  });

  assert.equal(response.ok, true);
  assert.equal(response.conversationTokensUI.conversationId, CONV_A);
  assert.equal(response.conversationTokensUI.conversationTokens, 3);
  assert.equal(response.conversationTokensUI.dailyTotal, 3);
  assert.equal(harness.getStorage(CONVERSATION_TOKENS_UI_KEY).conversationTokens, 3);
});

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
  assert.doesNotMatch(source, /tokensToday/);
  assert.doesNotMatch(source, /tokensApproximate/);
  assert.match(source, /\bconversationTokens,\n/);
  assert.match(source, /dailyTotalTokens:\s*dailyTotal/);
  assert.match(source, /formatTokenLine/);
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
