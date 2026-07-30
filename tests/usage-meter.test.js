const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const STORAGE_KEY = "claudeUsageMeterStateV2";
const CONV_TOKENS_KEY = "conversationTokens";
const CONVERSATION_TOKENS_UI_KEY = "conversationTokensUI";
const ORG_A = "org_account_AAAAAAAAAAAA";
const ORG_B = "org_account_BBBBBBBBBBBB";
const CONV_A = "11111111-1111-4111-8111-111111111111";
const CONV_B = "22222222-2222-4222-8222-222222222222";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Both entry points are loaded after src/lib/shared.js by the manifest, so the
// harnesses evaluate it into the same context first.
function runInHarnessContext(entryPoint, context) {
  ["src/lib/shared.js", entryPoint].forEach((file) => {
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, file), "utf8"), context, { filename: file });
  });
}

function makeUsageResponse({ utilization, resetsAt, sevenDay = 9, extra = 61.625, planType }) {
  return {
    plan_type: planType,
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
  if (options.tokenCounter) {
    context.__gptTokenizerCount = options.tokenCounter;
  }
  runInHarnessContext("src/background.js", context);

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

function createContentLifecycleHarness(options = {}) {
  const mountedBars = [];
  const document = {
    documentElement: {
      clientHeight: 800,
      clientWidth: options.viewportWidth || 1200
    },
    querySelectorAll(selector) {
      assert.equal(selector, '[id="claude-usage-meter-root"]');
      return mountedBars.filter((element) => element.isConnected);
    }
  };
  const context = {
    __CUM_CONTENT_TEST__: true,
    console,
    document,
    window: {
      innerHeight: 800,
      innerWidth: options.viewportWidth || 1200,
      location: {
        pathname: "/chat/11111111-1111-4111-8111-111111111111"
      }
    }
  };

  runInHarnessContext("src/content.js", context);

  return {
    addBar(name) {
      const element = {
        isConnected: true,
        name,
        remove() {
          this.isConnected = false;
        }
      };
      mountedBars.push(element);
      return element;
    },
    hooks: context.__CUM_CONTENT_TEST_HOOKS__
  };
}

test("updateConversationTokens refreshes the current conversation estimate", async () => {
  const bodies = [
    ["alpha beta gamma"],
    ["alpha beta gamma delta epsilon"]
  ];
  let callIndex = 0;
  const harness = createBackgroundHarness(async (url) => {
    assert.match(url, new RegExp(`/chat_conversations/${CONV_A}\\?`));
    return conversationResponse(bodies[callIndex++]);
  });

  const first = await harness.hooks.updateConversationTokens(ORG_A, CONV_A);
  assert.equal(first.conversationTokens, 3);

  const second = await harness.hooks.updateConversationTokens(ORG_A, CONV_A);
  assert.equal(second.conversationTokens, 5);
  assert.equal(harness.getStorage(CONV_TOKENS_KEY)[CONV_A], 5);
  assert.deepEqual(harness.getStorage(CONVERSATION_TOKENS_UI_KEY), clone(second));
});

test("switching conversations stores estimates independently", async () => {
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

  await harness.hooks.updateConversationTokens(ORG_A, CONV_A);
  await harness.hooks.updateConversationTokens(ORG_A, CONV_B);
  const uiState = await harness.hooks.updateConversationTokens(ORG_A, CONV_A);

  assert.equal(uiState.conversationId, CONV_A);
  assert.equal(uiState.conversationTokens, 4);
  assert.deepEqual(harness.getStorage(CONV_TOKENS_KEY), {
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
  assert.equal(harness.getStorage(CONVERSATION_TOKENS_UI_KEY).conversationTokens, 3);
});

test("background uses tokenizer count API instead of allocating encoded token arrays", async () => {
  let encodeCalls = 0;
  const countedTexts = [];
  const harness = createBackgroundHarness(async () => conversationResponse([
    "alpha beta",
    "gamma"
  ]), {
    tokenizer() {
      encodeCalls += 1;
      throw new Error("encode fallback should not be used");
    },
    tokenCounter(text) {
      countedTexts.push(text);
      return wordTokenizer(text).length;
    }
  });

  const uiState = await harness.hooks.updateConversationTokens(ORG_A, CONV_A);

  assert.equal(uiState.conversationTokens, 3);
  assert.equal(encodeCalls, 0);
  assert.deepEqual(countedTexts, [
    "alpha beta\ngamma\n"
  ]);
});

test("background stores known usage response fields per organization", async () => {
  const responses = {
    [ORG_A]: makeUsageResponse({
      utilization: 91,
      resetsAt: "2026-05-14T18:30:01.095671+00:00",
      planType: "pro"
    }),
    [ORG_B]: makeUsageResponse({
      utilization: 12,
      resetsAt: "2026-05-14T20:00:00.000000+00:00",
      sevenDay: 4,
      extra: 25,
      planType: "max_20x"
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
  assert.equal(state.usage.plan, "Pro");
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
  assert.equal(state.usage.plan, "Max 20x");
  assert.equal(state.usageByOrg[ORG_A].usagePercent, 91);
  assert.equal(state.usageByOrg[ORG_B].usagePercent, 12);

  await harness.send({ type: "CUM_ORG_ID_DETECTED", orgId: ORG_A });
  state = harness.getState();
  assert.equal(state.organizationId, ORG_A);
  assert.equal(state.usage.organizationId, ORG_A);
  assert.equal(state.usage.usagePercent, 91);
});

test("background falls back to Claude organization metadata for the plan", async () => {
  const harness = createBackgroundHarness(async (url) => {
    if (url.endsWith("/api/organizations")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return [{
            uuid: ORG_A,
            rate_limit_tier: "claude_max_5x"
          }];
        }
      };
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return makeUsageResponse({
          utilization: 34,
          resetsAt: "2026-05-14T18:30:01.095671+00:00"
        });
      }
    };
  });

  await harness.send({ type: "CUM_REFRESH_USAGE", force: true, orgId: ORG_A });
  assert.equal(harness.getState().usage.plan, "Max 5x");
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

test("burn forecast requires a stable trend from the current reset window", () => {
  const harness = createBackgroundHarness(async () => ({ ok: false, status: 503 }));
  const now = Date.parse("2026-07-29T12:00:00Z");
  const resetAt = now + 2 * 60 * 60_000;
  const samples = [
    { timestamp: now - 20 * 60_000, percent: 10, resetAt },
    { timestamp: now - 10 * 60_000, percent: 20, resetAt },
    { timestamp: now, percent: 30, resetAt }
  ];

  const risk = harness.hooks.calculateBurnForecast(samples, now, resetAt);
  assert.equal(risk.willHitBeforeReset, true);
  assert.equal(risk.sampleCount, 3);
  assert.equal(risk.observedMinutes, 20);
  assert.equal(risk.percentPerHour, 60);
  assert.equal(risk.estimatedLimitAt, now + 70 * 60_000);

  const safe = harness.hooks.calculateBurnForecast(
    samples.map((sample, index) => ({ ...sample, percent: 10 + index })),
    now,
    resetAt
  );
  assert.equal(safe.willHitBeforeReset, false);

  assert.equal(harness.hooks.calculateBurnForecast(samples.slice(0, 2), now, resetAt), null);
  assert.equal(
    harness.hooks.calculateBurnForecast([
      samples[0],
      { ...samples[1], percent: 8 },
      samples[2]
    ], now, resetAt),
    null
  );

  const nextResetAt = resetAt + 5 * 60 * 60_000;
  const nextWindow = harness.hooks.appendUsageSample(samples, {
    timestamp: now + 60_000,
    percent: 1,
    resetAt: nextResetAt
  });
  assert.deepEqual(clone(Array.from(nextWindow)), [{
    timestamp: now + 60_000,
    percent: 1,
    resetAt: nextResetAt
  }]);
});

test("burn forecast survives rounding jitter and follows the recent pace", () => {
  const harness = createBackgroundHarness(async () => ({ ok: false, status: 503 }));
  const now = Date.parse("2026-07-29T12:00:00Z");
  const resetAt = now + 2 * 60 * 60_000;

  const jittery = harness.hooks.calculateBurnForecast([
    { timestamp: now - 20 * 60_000, percent: 10 },
    { timestamp: now - 10 * 60_000, percent: 19.6 },
    { timestamp: now, percent: 30 }
  ].map((sample) => ({ ...sample, resetAt })), now, resetAt);
  assert.equal(jittery.willHitBeforeReset, true);
  assert.equal(jittery.sampleCount, 3);

  const idled = harness.hooks.calculateBurnForecast([
    { timestamp: now - 200 * 60_000, percent: 10 },
    { timestamp: now - 190 * 60_000, percent: 40 },
    { timestamp: now - 20 * 60_000, percent: 41 },
    { timestamp: now - 10 * 60_000, percent: 41.4 },
    { timestamp: now, percent: 41.8 }
  ].map((sample) => ({ ...sample, resetAt })), now, resetAt);
  assert.equal(idled.observedMinutes, 20);
  assert.equal(idled.sampleCount, 3);
  assert.equal(idled.willHitBeforeReset, false);
});

test("content shows only an explicitly marked conversation token estimate", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/content.js"), "utf8");
  const backgroundSource = fs.readFileSync(path.join(ROOT, "src/background.js"), "utf8");

  assert.doesNotMatch(source, /installSendListeners/);
  assert.doesNotMatch(source, /recordSentMessage/);
  assert.doesNotMatch(source, /estimateTokens/);
  assert.doesNotMatch(source, /updateChatCountFromVisibleMessages/);
  assert.doesNotMatch(source, /chatMessages/);
  assert.doesNotMatch(source, /todayMessages/);
  assert.doesNotMatch(source, /dailyTotal/);
  assert.doesNotMatch(backgroundSource, /dailyTokens/);
  assert.match(source, /\bconversationTokens\n/);
  assert.match(source, /formatEstimatedTokenCount/);
  assert.match(source, /Estimated tokens in this chat/);
});

test("plan labels are normalized and never guessed", () => {
  const harness = createContentLifecycleHarness();
  const normalize = harness.hooks.normalizePlanName;

  assert.equal(normalize("free"), "Free");
  assert.equal(normalize("PRO"), "Pro");
  assert.equal(normalize("claude_max_5x"), "Max 5x");
  assert.equal(normalize("max-20x"), "Max 20x");
  assert.equal(normalize("team_premium"), "Team");
  assert.equal(normalize("enterprise"), "Enterprise");
  assert.equal(normalize("education plan"), "Education");
  assert.equal(normalize("unknown paid account"), "");
  assert.equal(
    harness.hooks.pickPlan("Settings\nPlan usage limits Free\nCurrent session\n8%"),
    "Free"
  );
  assert.equal(harness.hooks.findPlanInValue({
    account: {
      subscription: {
        plan_type: "team_premium"
      }
    }
  }), "Team");
  assert.equal(harness.hooks.formatEstimatedTokenCount(null), "");
  assert.match(harness.hooks.formatEstimatedTokenCount(44252), /^~44[,.]252 tokens$/);

  const source = fs.readFileSync(path.join(ROOT, "src/content.js"), "utf8");
  assert.doesNotMatch(source, /usageData \? usageData\.plan : "Pro"/);
  assert.doesNotMatch(source, /usageState\.plan \|\| "Pro"/);
  assert.doesNotMatch(source, /cum-open|ICONS\.external/);
});

test("meter leads with the plan and labels the five-hour reset with a clock", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/content.js"), "utf8");

  assert.match(source, /class="cum-plan-name"/);
  assert.match(source, /\$\{ICONS\.clock\}/);
  assert.match(source, /class="cum-limit-label">\(\$\{escapeHtml\(usageState\.windowLabel\)\}\)/);
});

test("meter explains its values with hover text", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/content.js"), "utf8");

  assert.match(source, /Claude plan:/);
  assert.match(source, /usage: \$\{percent\}% used/);
  assert.match(source, /usage window; \$\{usageState\.resetText\}/);
  assert.match(source, /Estimated tokens in this chat from sent messages only/);
  assert.match(source, /Not daily usage/);
  assert.match(source, /current draft and hidden context are not included/);
});

test("meter exposes freshness and a manual refresh control", () => {
  const harness = createContentLifecycleHarness();
  const now = Date.parse("2026-07-29T12:00:00Z");

  assert.equal(harness.hooks.formatLastUpdatedAt(0, now), "Never synced");
  assert.equal(harness.hooks.formatLastUpdatedAt(now - 20_000, now), "Updated just now");
  assert.equal(harness.hooks.formatLastUpdatedAt(now - 2 * 60_000, now), "Updated 2m ago");
  assert.equal(harness.hooks.formatLastUpdatedAt(now - 3 * 60 * 60_000, now), "Updated 3h ago");

  const source = fs.readFileSync(path.join(ROOT, "src/content.js"), "utf8");
  const styles = fs.readFileSync(path.join(ROOT, "src/styles.css"), "utf8");
  assert.match(source, /class="cum-refresh"/);
  assert.match(source, /requestBackgroundUsageRefresh\("manual-refresh", true/);
  assert.match(source, /dataset\.syncState/);
  assert.match(styles, /data-sync-state="error"/);
  assert.match(styles, /animation: cum-spin/);
});

test("meter builds expandable five-hour, weekly, and extra-usage details", () => {
  const harness = createContentLifecycleHarness();
  assert.equal(harness.hooks.formatDuration((158 * 60 + 5) * 60_000), "6d 14h");

  const rows = harness.hooks.buildUsageDetails({
    usagePercent: 8,
    fiveHourPercent: 8,
    fiveHourResetAt: Date.now() + 2 * 60 * 60_000,
    sevenDayPercent: 23,
    sevenDayResetAt: Date.now() + 3 * 24 * 60 * 60_000,
    extraUsagePercent: 62,
    extraUsageUsedCredits: 493,
    extraUsageMonthlyLimit: 800,
    extraUsageCurrency: "EUR"
  });

  assert.deepEqual(Array.from(rows, (row) => row.label), ["5-hour", "Weekly", "Extra usage"]);
  assert.deepEqual(Array.from(rows, (row) => row.percent), [8, 23, 62]);
  assert.match(rows[2].detail, /4[,.]93/);
  assert.match(rows[2].detail, /8[,.]00/);

  const source = fs.readFileSync(path.join(ROOT, "src/content.js"), "utf8");
  const styles = fs.readFileSync(path.join(ROOT, "src/styles.css"), "utf8");
  assert.match(source, /aria-expanded=/);
  assert.match(source, /class="cum-details"/);
  assert.match(source, />Claude settings<\/a>/);
  assert.match(styles, /\.cum-details\s*{/);
  assert.match(styles, /bottom:\s*calc\(100% \+ 6px\)/);
});

test("meter explains when a burn forecast is collecting data or predicts a limit", () => {
  const harness = createContentLifecycleHarness();
  const now = Date.parse("2026-07-29T12:00:00Z");
  const waiting = harness.hooks.buildBurnForecastPresentation(null, now);
  assert.equal(waiting.message, "—");
  assert.match(waiting.title, /whether your current 5-hour usage pace/);
  assert.match(waiting.title, /dash means there has not been enough usage change/);

  const risk = harness.hooks.buildBurnForecastPresentation({
    calculatedAt: now,
    estimatedLimitAt: now + 2 * 60 * 60_000,
    observedMinutes: 20,
    percentPerHour: 30,
    sampleCount: 8,
    willHitBeforeReset: true
  }, now);
  assert.equal(risk.tone, "risk");
  assert.match(risk.message, /limit in about 2h 0m/);
  assert.match(risk.title, /Based on 8 samples/);

  const safe = harness.hooks.buildBurnForecastPresentation({
    calculatedAt: now,
    estimatedLimitAt: now + 8 * 60 * 60_000,
    observedMinutes: 20,
    percentPerHour: 4,
    sampleCount: 8,
    willHitBeforeReset: false
  }, now);
  assert.equal(safe.tone, "safe");
  assert.match(safe.message, /below the limit until reset/);

  const source = fs.readFileSync(path.join(ROOT, "src/content.js"), "utf8");
  const styles = fs.readFileSync(path.join(ROOT, "src/styles.css"), "utf8");
  assert.match(source, /class="cum-forecast"/);
  assert.match(styles, /data-forecast-tone="risk"/);
  assert.match(styles, /\.cum-section\[title\][\s\S]*cursor:\s*help/);
});

test("meter offers persistent auto, light, and dark theme choices", () => {
  const harness = createContentLifecycleHarness();

  assert.equal(harness.hooks.normalizeThemePreference("LIGHT"), "light");
  assert.equal(harness.hooks.normalizeThemePreference("dark"), "dark");
  assert.equal(harness.hooks.normalizeThemePreference("unknown"), "auto");
  assert.equal(harness.hooks.resolveThemePreference("light", "dark"), "light");
  assert.equal(harness.hooks.resolveThemePreference("auto", "light"), "light");
  assert.equal(harness.hooks.resolveThemePreference("auto", "dark"), "dark");

  const source = fs.readFileSync(path.join(ROOT, "src/content.js"), "utf8");
  const styles = fs.readFileSync(path.join(ROOT, "src/styles.css"), "utf8");
  assert.match(source, /claudeUsageMeterTheme/);
  assert.match(source, /data-cum-theme-choice/);
  assert.match(source, /bar\.dataset\.theme/);
  assert.match(styles, /data-theme="light"/);
  assert.match(styles, /\.cum-theme-picker/);
});

test("another Claude tab cannot hide the current conversation token estimate", () => {
  const harness = createContentLifecycleHarness();
  const current = {
    conversationId: CONV_A,
    conversationTokens: 1125,
    updatedAt: 100
  };
  const otherTab = {
    conversationId: CONV_B,
    conversationTokens: 2400,
    updatedAt: 200
  };

  const selected = harness.hooks.selectConversationTokenState(otherTab, current, CONV_A);
  assert.equal(selected.conversationId, CONV_A);
  assert.equal(selected.conversationTokens, 1125);

  const styles = fs.readFileSync(path.join(ROOT, "src/styles.css"), "utf8");
  assert.doesNotMatch(styles, /\.cum-tokens\s*{[^}]*display:\s*none/s);
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

test("content script adopts one canonical meter and removes duplicate instances", () => {
  const harness = createContentLifecycleHarness();
  const first = harness.addBar("first");
  const duplicate = harness.addBar("duplicate");

  assert.equal(harness.hooks.reconcileBarElement(), first);
  assert.equal(first.isConnected, true);
  assert.equal(duplicate.isConnected, false);

  first.isConnected = false;
  const replacement = harness.addBar("replacement");
  assert.equal(harness.hooks.reconcileBarElement(), replacement);
  assert.equal(replacement.isConnected, true);
});

test("composer detection accepts a composer expanded by a long prompt", () => {
  const harness = createContentLifecycleHarness();
  const expandedComposer = {
    querySelector(selector) {
      if (selector === "textarea,[contenteditable='true']") {
        return {};
      }
      if (selector === "button,[role='button']") {
        return {};
      }
      return null;
    }
  };

  assert.equal(harness.hooks.isComposerLikeBox(expandedComposer, {
    width: 640,
    height: 900,
    top: -150,
    bottom: 750
  }), true);
});

test("content script selects a bottom-docked meter layout for compact viewports", () => {
  const compactHarness = createContentLifecycleHarness({ viewportWidth: 683 });
  const wideHarness = createContentLifecycleHarness({ viewportWidth: 1200 });

  assert.equal(compactHarness.hooks.isCompactLayout(), true);
  assert.equal(wideHarness.hooks.isCompactLayout(), false);

  const contentSource = fs.readFileSync(path.join(ROOT, "src/content.js"), "utf8");
  const stylesSource = fs.readFileSync(path.join(ROOT, "src/styles.css"), "utf8");
  assert.match(contentSource, /targetParent\.appendChild\(bar\)/);
  assert.match(contentSource, /document\.body \? document\.body : composer\.parentNode/);
  assert.match(stylesSource, /data-cum-meter-compact-host/);
  assert.match(stylesSource, /translate:\s*0 calc\(0px - var\(--cum-meter-reserve/);
  assert.match(stylesSource, /@media \(max-width: 820px\)[\s\S]*position: fixed/);
  assert.match(contentSource, /--cum-composer-radius/);
  assert.match(stylesSource, /border-radius:\s*var\(--cum-composer-radius/);
  assert.match(stylesSource, /min-height:\s*36px/);
  assert.doesNotMatch(stylesSource, /cum-status-pulse/);
});
