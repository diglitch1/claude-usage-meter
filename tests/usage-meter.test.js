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

  vm.runInNewContext(
    fs.readFileSync(path.join(ROOT, "src/content.js"), "utf8"),
    context,
    { filename: "src/content.js" }
  );

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
  assert.match(source, /Estimated conversation tokens/);
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
});
