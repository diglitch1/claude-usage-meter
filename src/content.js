(function () {
  const ROOT_ID = "claude-usage-meter-root";
  const STORAGE_KEY = "claudeUsageMeterStateV2";
  const LEGACY_STORAGE_KEY = "claudeUsageMeterStateV1";
  const SETTINGS_URL = "https://claude.ai/settings/usage";

  const RENDER_NEUTRAL_PLACEHOLDERS = true;
  const UPDATE_DEBOUNCE_MS = 350;
  const ROUTE_POLL_MS = 2500;
  const COMPOSER_CACHE_MS = 8000;
  const CHAT_SCAN_MS = 10000;
  const USAGE_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
  const RECENT_SEND_WINDOW_MS = 9000;

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
  let nextComposerScanAt = 0;
  let lastChatScanAt = 0;
  let lastPath = window.location.pathname;
  let lastRenderedHtml = "";
  let saveTimer = 0;
  let updateTimer = 0;
  let observer = null;

  init();

  async function init() {
    state = await loadState();
    installSendListeners();
    installMutationObserver();
    installRouteAndViewportListeners();
    await update({ forceComposerScan: true, scanChat: true });
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
      chats: {},
      todayMessages: 0,
      todayTokens: 0,
      tokensExact: false,
      recentSends: []
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
    const output = Object.assign(base, input || {});
    const legacyUsage = (input && input.usage) || {};

    output.usage = Object.assign(base.usage, legacyUsage, {
      usagePercent: coercePercent(legacyUsage.usagePercent ?? legacyUsage.sessionPercent),
      resetText: legacyUsage.resetText || legacyUsage.sessionReset || "",
      plan: legacyUsage.plan || "",
      resetAt: Number.isFinite(legacyUsage.resetAt) ? legacyUsage.resetAt : null
    });
    output.chats = input && input.chats && typeof input.chats === "object" ? input.chats : {};
    Object.keys(output.chats).forEach((key) => {
      if (!key.startsWith("chat:")) {
        delete output.chats[key];
      }
    });
    output.recentSends = Array.isArray(input && input.recentSends) ? input.recentSends : [];
    output.todayMessages = Number(input && input.todayMessages) || 0;
    output.todayTokens = Number(input && input.todayTokens) || 0;
    output.tokensExact = Boolean(input && (input.tokensExact || input.tokenSource === "exact"));

    return output;
  }

  function scheduleSave() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
      try {
        await extensionStorage.set({ [STORAGE_KEY]: state });
      } catch (_error) {
        // Do not let storage failures affect Claude.
      }
    }, 250);
  }

  function installSendListeners() {
    document.addEventListener("keydown", handleComposerEnter, true);
    document.addEventListener("click", handlePossibleSendClick, true);
    document.addEventListener("submit", handlePossibleFormSubmit, true);
  }

  function handleComposerEnter(event) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.isComposing
    ) {
      return;
    }

    if (isComposerInput(event.target)) {
      capturePotentialSend(event.target);
    }
  }

  function handlePossibleSendClick(event) {
    const button = event.target && event.target.closest
      ? event.target.closest("button,[role='button']")
      : null;
    if (!button || button.closest(`#${ROOT_ID}`) || !looksLikeSendButton(button)) {
      return;
    }

    capturePotentialSend(button);
  }

  function handlePossibleFormSubmit(event) {
    if (!event.target || !event.target.querySelector) {
      return;
    }

    const input = event.target.querySelector("textarea,[contenteditable='true']");
    if (input && isComposerInput(input)) {
      capturePotentialSend(input);
    }
  }

  function installMutationObserver() {
    const target = document.body || document.documentElement;
    if (!target) {
      return;
    }

    observer = new MutationObserver((mutations) => {
      if (bar && mutations.every((mutation) => bar.contains(mutation.target))) {
        return;
      }
      scheduleUpdate({
        forceComposerScan: !isUsableComposer(cachedComposer),
        scanChat: Date.now() - lastChatScanAt > CHAT_SCAN_MS
      });
    });

    observer.observe(target, {
      childList: true,
      subtree: true
    });
  }

  function installRouteAndViewportListeners() {
    window.setInterval(() => {
      if (lastPath !== window.location.pathname) {
        lastPath = window.location.pathname;
        cachedComposer = null;
        nextComposerScanAt = 0;
        lastChatScanAt = 0;
      }
      scheduleUpdate({});
    }, ROUTE_POLL_MS);

    window.addEventListener("resize", () => scheduleUpdate({ forceComposerScan: true }), {
      passive: true
    });
    window.addEventListener("focus", () => scheduleUpdate({ forceComposerScan: true }), {
      passive: true
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        scheduleUpdate({ forceComposerScan: true });
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

    if (options.scanChat || Date.now() - lastChatScanAt > CHAT_SCAN_MS) {
      updateChatCountFromVisibleMessages();
    }

    const usageState = buildUsageState();
    if (!usageState) {
      removeBar();
      return;
    }

    injectBarAfterComposer(composer);
    renderBar(usageState);
  }

  function buildUsageState() {
    const usageData = getClaudeUsageData();
    if (!usageData && !RENDER_NEUTRAL_PLACEHOLDERS) {
      return null;
    }

    const chat = ensureChat(getChatKey());
    return {
      windowLabel: usageData ? usageData.windowLabel : "5h",
      plan: usageData ? usageData.plan : "Pro",
      usagePercent: usageData ? usageData.usagePercent : null,
      resetText: usageData ? usageData.resetText : "open usage to sync",
      chatMessages: isRealChatRoute() ? chat.count : 0,
      todayMessages: state.todayMessages,
      tokensToday: state.todayTokens,
      tokensApproximate: !state.tokensExact
    };
  }

  function getClaudeUsageData() {
    // TODO: replace this adapter if Claude exposes a stable first-party usage API.
    const usage = state.usage;
    if (!Number.isFinite(usage.usagePercent) || !usage.plan) {
      return null;
    }

    const resetText = getCurrentResetText(usage);
    const hasFreshReset = Number.isFinite(usage.resetAt)
      ? usage.resetAt > Date.now() - 60 * 1000
      : Date.now() - usage.updatedAt < USAGE_CACHE_MAX_AGE_MS;

    if (!hasFreshReset) {
      return null;
    }

    return {
      windowLabel: usage.windowLabel || "5h",
      plan: usage.plan,
      usagePercent: usage.usagePercent,
      resetText,
      source: "settings-cache"
    };
  }

  async function refreshUsageCacheFromPage() {
    if (!isUsageSettingsPage() || !document.body) {
      return;
    }

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

    if (usageChanged) {
      state.usage = Object.assign({}, state.usage, extracted, {
        updatedAt: Date.now()
      });
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
    const todayBlock = blockBetween(text, /Today/i, /Updated|Settings|Quit/i) || "";
    const plan = pickPlan(text);
    const messages = pickMetric(todayBlock, /Messages/i);
    const tokens = pickMetric(todayBlock, /Tokens/i);
    let metricsChanged = false;

    if (Number.isFinite(messages) && messages > state.todayMessages) {
      state.todayMessages = messages;
      metricsChanged = true;
    }
    if (Number.isFinite(tokens) && tokens > state.todayTokens) {
      state.todayTokens = tokens;
      state.tokensExact = true;
      metricsChanged = true;
    }
    if (metricsChanged) {
      scheduleSave();
    }

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
    const messageText = `${formatCount(usageState.chatMessages)} • ${formatCount(usageState.todayMessages)}`;
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

  function injectBarAfterComposer(composer) {
    if (!bar) {
      bar = document.createElement("button");
      bar.id = ROOT_ID;
      bar.type = "button";
      bar.className = "claude-usage-meter";
      bar.addEventListener("click", () => window.location.assign(SETTINGS_URL));
    }

    if (composer.nextSibling !== bar) {
      composer.parentNode.insertBefore(bar, composer.nextSibling);
    }

    syncBarLayoutWithComposer(composer);
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
    const now = Date.now();
    if (!force && isUsableComposer(cachedComposer) && now < nextComposerScanAt) {
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
        nextComposerScanAt = Date.now() + COMPOSER_CACHE_MS;
        return composer;
      }
    }

    cachedComposer = null;
    nextComposerScanAt = Date.now() + 1000;
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

  function isUsableComposer(node) {
    return Boolean(node && node.isConnected && isComposerLikeBox(node, node.getBoundingClientRect()));
  }

  function isComposerInput(target) {
    const editable = target && target.closest
      ? target.closest("textarea,[contenteditable='true']")
      : null;
    if (!editable) {
      return false;
    }

    const composer = findComposerContainer();
    return Boolean(composer && composer.contains(editable));
  }

  function looksLikeSendButton(button) {
    if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") {
      return false;
    }

    const composer = findComposerContainer();
    if (!composer || !composer.contains(button)) {
      return false;
    }

    const label = [
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      button.textContent
    ]
      .filter(Boolean)
      .join(" ");

    if (/send|submit|arrow up|paper plane/i.test(label)) {
      return true;
    }

    const rect = button.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    return rect.width <= 64 && rect.height <= 64 && rect.right > composerRect.right - 120;
  }

  function capturePotentialSend(target) {
    const composer = findComposerContainer();
    if (!composer) {
      return;
    }

    const promptText = normalizePrompt(getPromptText(target, composer));
    if (!promptText) {
      return;
    }

    window.setTimeout(() => recordSentMessage(promptText, Date.now()), 80);
  }

  function getPromptText(target, composer) {
    const scope = composer || (target && target.closest && target.closest("form")) || document;
    const textarea = Array.from(scope.querySelectorAll("textarea")).find((item) => item.value.trim());
    if (textarea) {
      return textarea.value;
    }

    const editable = Array.from(scope.querySelectorAll("[contenteditable='true']")).find((item) =>
      (item.innerText || "").trim()
    );
    return editable ? editable.innerText : "";
  }

  function recordSentMessage(text, now) {
    rollDayIfNeeded(state);

    const hash = hashText(text);
    const duplicate = state.recentSends.some(
      (item) => item.hash === hash && now - item.at < RECENT_SEND_WINDOW_MS
    );
    if (duplicate) {
      return;
    }

    state.recentSends = state.recentSends
      .filter((item) => now - item.at < 60 * 60 * 1000)
      .concat({ hash, at: now });
    state.todayMessages += 1;
    state.todayTokens += estimateTokens(text);
    state.tokensExact = false;

    const chat = ensureChat(getChatKey());
    chat.count += 1;
    chat.updatedAt = now;

    scheduleSave();
    scheduleUpdate({});
  }

  function updateChatCountFromVisibleMessages() {
    lastChatScanAt = Date.now();
    if (!isRealChatRoute()) {
      return;
    }

    const selectors = [
      "[data-testid='user-message']",
      "[data-testid*='user-message' i]",
      "[data-message-author-role='user']",
      "[data-message-author-role='human']",
      "[data-author='user']",
      "[data-author='human']",
      "[data-role='user']",
      "[data-role='human']",
      "[aria-label='Your message']",
      "[aria-label*='user message' i]"
    ];
    const unique = new Set();
    let hasExplicitMessageMarkers = false;

    for (const selector of selectors) {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch (_error) {
        continue;
      }

      nodes.forEach((node) => {
        const text = normalizePrompt(node.innerText || node.textContent || "");
        const rect = node.getBoundingClientRect();
        if (text && rect.width > 120 && rect.height > 12 && !node.closest(`#${ROOT_ID}`)) {
          unique.add(hashText(text.slice(0, 400)));
          hasExplicitMessageMarkers = true;
        }
      });
    }

    if (unique.size === 0) {
      collectLikelyUserMessages().forEach((text) => unique.add(hashText(text.slice(0, 400))));
    }

    const chat = ensureChat(getChatKey());
    const shouldReplaceCount = hasExplicitMessageMarkers && unique.size > 0 && unique.size !== chat.count;
    const shouldIncreaseCount = !hasExplicitMessageMarkers && unique.size > chat.count;
    if (shouldReplaceCount || shouldIncreaseCount) {
      chat.count = unique.size;
      chat.updatedAt = Date.now();
      scheduleSave();
    }
  }

  function collectLikelyUserMessages() {
    const main = document.querySelector("main") || document.body;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const texts = [];
    const nodes = Array.from(
      main.querySelectorAll("article, [class*='message' i], [class*='bubble' i], [class*='justify-end' i], [class*='items-end' i]")
    ).slice(-200);

    nodes.forEach((node) => {
      if (node.closest(`#${ROOT_ID}`) || node.querySelector("textarea,[contenteditable='true']")) {
        return;
      }

      const rect = node.getBoundingClientRect();
      const text = normalizePrompt(node.innerText || node.textContent || "");
      const isRightSide = rect.left > viewportWidth * 0.28 || rect.right > viewportWidth * 0.72;

      if (
        isRightSide &&
        text.length > 0 &&
        text.length < 5000 &&
        rect.width > 120 &&
        rect.height > 18 &&
        rect.top < window.innerHeight + 600
      ) {
        texts.push(text);
      }
    });

    return Array.from(new Set(texts));
  }

  function ensureChat(chatKey) {
    if (!state.chats[chatKey]) {
      state.chats[chatKey] = {
        count: 0,
        updatedAt: Date.now()
      };
      scheduleSave();
    }
    return state.chats[chatKey];
  }

  function getChatKey() {
    const path = window.location.pathname.replace(/\/+$/, "") || "/";
    const match = path.match(/\/chat\/([^/?#]+)/i);
    return match ? `chat:${match[1]}` : `path:${path}`;
  }

  function isRealChatRoute() {
    return /^\/chat\/[^/?#]+/i.test(window.location.pathname);
  }

  function isUsageSettingsPage() {
    return /\/settings\/usage\/?$/i.test(window.location.pathname);
  }

  function rollDayIfNeeded(targetState, shouldSave = true) {
    if (targetState.day === getDayKey()) {
      return;
    }

    targetState.day = getDayKey();
    targetState.todayMessages = 0;
    targetState.todayTokens = 0;
    targetState.tokensExact = false;
    targetState.recentSends = [];
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

  function pickMetric(text, labelRe) {
    const lines = String(text || "").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!labelRe.test(lines[index])) {
        continue;
      }

      const sameLine = parseCompactNumber(lines[index]);
      if (Number.isFinite(sameLine)) {
        return sameLine;
      }

      const nextLine = parseCompactNumber(lines[index + 1] || "");
      if (Number.isFinite(nextLine)) {
        return nextLine;
      }
    }
    return null;
  }

  function parseCompactNumber(text) {
    const match = String(text || "").match(/([0-9]+(?:\.[0-9]+)?)\s*([KMB])?/i);
    if (!match) {
      return null;
    }

    const multiplier = match[2]
      ? { k: 1000, m: 1000000, b: 1000000000 }[match[2].toLowerCase()]
      : 1;
    return Math.round(Number(match[1]) * multiplier);
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

  function estimateTokens(text) {
    const normalized = String(text || "");
    const cjk = (normalized.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
    const nonCjk = normalized.length - cjk;
    return Math.max(1, Math.ceil(nonCjk / 4 + cjk));
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
    const number = Math.max(0, Math.round(Number(value) || 0));
    if (number === 0 && approximate) {
      return "tokens today --";
    }
    return `tokens today ${approximate ? "~" : ""}${formatTokens(number)}`;
  }

  function trimDecimal(value) {
    return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  }

  function formatCount(value) {
    return String(Math.max(0, Math.round(Number(value) || 0)));
  }

  function normalizePrompt(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function getDayKey() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function hashText(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
