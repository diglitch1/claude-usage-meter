(function () {
  const ROOT_ID = "claude-usage-meter-root";
  const STORAGE_KEY = "claudeUsageMeterStateV1";
  const BRIDGE_SOURCE = "claude-usage-meter-bridge";
  const SETTINGS_URL = "https://claude.ai/settings/usage";
  const UPDATE_INTERVAL_MS = 1500;
  const RECENT_SEND_WINDOW_MS = 9000;

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
        // Storage is best-effort only.
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

  let root = null;
  let state = getDefaultState();
  let lastPath = window.location.pathname;
  let lastChatKey = getChatKey();
  let saveTimer = 0;

  init();

  async function init() {
    state = normalizeState(await loadState());
    installBridge();
    installInputListeners();
    installMessageListener();
    installObservers();
    syncFromLocation();
    update();
    window.setInterval(update, UPDATE_INTERVAL_MS);
  }

  function getDefaultState() {
    return {
      day: getDayKey(),
      todayMessages: 0,
      todayTokens: 0,
      tokenSource: "estimated",
      chats: {},
      usage: {
        plan: "",
        sessionPercent: null,
        sessionReset: "",
        weeklyPercent: null,
        weeklyReset: "",
        updatedAt: 0,
        source: ""
      },
      recentSends: []
    };
  }

  async function loadState() {
    try {
      const result = await extensionStorage.get(STORAGE_KEY);
      return result && result[STORAGE_KEY] ? result[STORAGE_KEY] : getDefaultState();
    } catch (_error) {
      return getDefaultState();
    }
  }

  function normalizeState(input) {
    const base = getDefaultState();
    const next = Object.assign(base, input || {});
    next.usage = Object.assign(base.usage, input && input.usage ? input.usage : {});
    next.chats = input && input.chats && typeof input.chats === "object" ? input.chats : {};
    next.recentSends = Array.isArray(input && input.recentSends) ? input.recentSends : [];

    if (next.day !== getDayKey()) {
      next.day = getDayKey();
      next.todayMessages = 0;
      next.todayTokens = 0;
      next.tokenSource = "estimated";
      next.recentSends = [];
    }

    return next;
  }

  function scheduleSave() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
      try {
        await extensionStorage.set({ [STORAGE_KEY]: state });
      } catch (_error) {
        // Persistence failure should not break Claude.
      }
    }, 250);
  }

  function installBridge() {
    try {
      const script = document.createElement("script");
      script.src = getRuntimeUrl("src/page-bridge.js");
      script.async = false;
      script.onload = () => script.remove();
      (document.head || document.documentElement || document.body).appendChild(script);
    } catch (_error) {
      // DOM scraping and local counters still work without the bridge.
    }
  }

  function getRuntimeUrl(path) {
    if (typeof browser !== "undefined" && browser.runtime && browser.runtime.getURL) {
      return browser.runtime.getURL(path);
    }
    return chrome.runtime.getURL(path);
  }

  function installInputListeners() {
    document.addEventListener(
      "keydown",
      (event) => {
        if (
          event.key !== "Enter" ||
          event.shiftKey ||
          event.altKey ||
          event.ctrlKey ||
          event.isComposing
        ) {
          return;
        }
        if (!isComposerInput(event.target)) {
          return;
        }
        capturePotentialSend(event.target, "keyboard");
      },
      true
    );

    document.addEventListener(
      "click",
      (event) => {
        const button = event.target && event.target.closest
          ? event.target.closest("button,[role='button']")
          : null;
        if (!button || button.closest(`#${ROOT_ID}`)) {
          return;
        }
        if (!looksLikeSendButton(button)) {
          return;
        }
        capturePotentialSend(button, "button");
      },
      true
    );

    document.addEventListener(
      "submit",
      (event) => {
        if (!event.target || !event.target.querySelector) {
          return;
        }
        const input = event.target.querySelector("textarea,[contenteditable='true']");
        if (input && isComposerInput(input)) {
          capturePotentialSend(input, "submit");
        }
      },
      true
    );
  }

  function installMessageListener() {
    window.addEventListener("message", (event) => {
      if (event.source !== window || !event.data || event.data.source !== BRIDGE_SOURCE) {
        return;
      }
      const parsed = parseUsageFromText(event.data.body || "");
      if (parsed) {
        mergeUsage(parsed, "api");
      }
    });
  }

  function installObservers() {
    const observer = new MutationObserver(() => {
      if (lastPath !== window.location.pathname) {
        lastPath = window.location.pathname;
        syncFromLocation();
      }
      update();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });

    window.addEventListener("resize", placeRoot, { passive: true });
    window.addEventListener("scroll", placeRoot, { passive: true });
  }

  function syncFromLocation() {
    const chatKey = getChatKey();
    if (chatKey !== lastChatKey) {
      carryNewChatCount(lastChatKey, chatKey);
      lastChatKey = chatKey;
    }
    ensureChat(chatKey);
    if (isUsageSettingsPage()) {
      window.setTimeout(scrapeUsagePage, 600);
      window.setTimeout(scrapeUsagePage, 1800);
      window.setTimeout(scrapeUsagePage, 3600);
    }
  }

  function carryNewChatCount(previousKey, nextKey) {
    const previous = state.chats[previousKey];
    if (!previous) {
      return;
    }

    const next = ensureChat(nextKey);
    const isFreshNewChat =
      /^path:\/?(new)?$/i.test(previousKey) && Date.now() - previous.updatedAt < 30000;

    if (isFreshNewChat && next.count === 0 && previous.count > 0) {
      next.count = previous.count;
      next.updatedAt = Date.now();
      scheduleSave();
    }
  }

  function update() {
    rollDayIfNeeded();
    if (isUsageSettingsPage()) {
      scrapeUsagePage();
    }

    const composer = findComposer();
    const shouldShow = Boolean(composer) && !isUsageSettingsPage();
    if (!shouldShow) {
      if (root) {
        root.hidden = true;
      }
      return;
    }

    root = root || createRoot();
    root.hidden = false;
    placeRoot(composer);
    updateChatCount();
    render();
  }

  function rollDayIfNeeded() {
    if (state.day === getDayKey()) {
      return;
    }

    state.day = getDayKey();
    state.todayMessages = 0;
    state.todayTokens = 0;
    state.tokenSource = "estimated";
    state.recentSends = [];
    scheduleSave();
  }

  function createRoot() {
    const element = document.createElement("button");
    element.id = ROOT_ID;
    element.type = "button";
    element.className = "claude-usage-meter";
    element.setAttribute("aria-label", "Open Claude usage settings");
    element.addEventListener("click", () => {
      window.location.assign(SETTINGS_URL);
    });
    (document.body || document.documentElement).appendChild(element);
    return element;
  }

  function render() {
    if (!root) {
      return;
    }

    const chat = ensureChat(getChatKey());
    const sessionPercent = clampPercent(state.usage.sessionPercent);
    const sessionLabel = sessionPercent == null ? "--" : `${sessionPercent}%`;
    const progressWidth = sessionPercent == null ? 0 : sessionPercent;
    const resetLabel = compactReset(state.usage.sessionReset);
    const resetText = resetLabel ? `reset ${resetLabel}` : "open usage to sync";
    const planLabel = state.usage.plan ? escapeHtml(state.usage.plan) : "Claude";
    const messagesLabel = `${formatInt(chat.count)}:${formatInt(state.todayMessages)}`;
    const tokensLabel = formatTokenCount(state.todayTokens);
    const tokenPrefix = state.tokenSource === "exact" ? "" : "~";
    const updatedLabel = state.usage.updatedAt
      ? `updated ${formatAge(Date.now() - state.usage.updatedAt)} ago`
      : "not synced yet";

    root.innerHTML = `
      <span class="cum-main">
        <span class="cum-title">
          <span class="cum-mark" aria-hidden="true"></span>
          <span class="cum-name">5h Usage</span>
          <span class="cum-plan">${planLabel}</span>
        </span>
        <span class="cum-session">
          <span class="cum-session-number">${sessionLabel}</span>
          <span class="cum-progress" aria-hidden="true">
            <span class="cum-progress-fill" style="width: ${progressWidth}%"></span>
          </span>
          <span class="cum-reset">${escapeHtml(resetText)}</span>
        </span>
        <span class="cum-stat">
          <span class="cum-stat-label">chat:today</span>
          <span class="cum-stat-value">${messagesLabel}</span>
        </span>
        <span class="cum-stat">
          <span class="cum-stat-label">tokens today</span>
          <span class="cum-stat-value">${tokenPrefix}${tokensLabel}</span>
        </span>
        <span class="cum-refresh" title="${escapeHtml(updatedLabel)}" aria-hidden="true"></span>
      </span>
    `;
  }

  function placeRoot(composerArg) {
    if (!root || root.hidden) {
      return;
    }

    const composer = composerArg && composerArg.getBoundingClientRect ? composerArg : findComposer();
    if (!composer) {
      return;
    }

    const rect = composer.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const rootHeight = root.offsetHeight || 28;
    const width = Math.min(rect.width || viewportWidth - 32, viewportWidth - 32);
    const left = Math.max(16, Math.min(rect.left, viewportWidth - width - 16));
    const top = Math.min(window.innerHeight - rootHeight - 6, rect.bottom + 6);

    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(Math.max(4, top))}px`;
    root.style.width = `${Math.round(width)}px`;
  }

  function findComposer() {
    const candidateSelectors = [
      "form:has(textarea)",
      "form:has([contenteditable='true'])",
      "[data-testid*='composer' i]",
      "[data-testid*='prompt' i]",
      "textarea[placeholder*='message' i]",
      "textarea[aria-label*='message' i]",
      "[contenteditable='true'][aria-label*='message' i]",
      "[contenteditable='true']"
    ];

    for (const selector of candidateSelectors) {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch (_error) {
        continue;
      }

      for (const node of nodes.reverse()) {
        const rootCandidate = node.matches && node.matches("form,[data-testid*='composer' i],[data-testid*='prompt' i]")
          ? node
          : findComposerRoot(node);
        if (rootCandidate && isVisibleComposer(rootCandidate)) {
          return rootCandidate;
        }
      }
    }

    return null;
  }

  function findComposerRoot(node) {
    let current = node;
    for (let depth = 0; current && depth < 8; depth += 1) {
      if (current.matches && current.matches("form")) {
        return current;
      }

      const rect = current.getBoundingClientRect ? current.getBoundingClientRect() : null;
      const hasInput = current.querySelector && current.querySelector("textarea,[contenteditable='true']");
      const hasButton = current.querySelector && current.querySelector("button,[role='button']");
      if (rect && hasInput && hasButton && rect.width > 260 && rect.height >= 42 && rect.height < 260) {
        return current;
      }
      current = current.parentElement;
    }
    return node;
  }

  function isVisibleComposer(node) {
    if (!node || !node.getBoundingClientRect) {
      return false;
    }

    const rect = node.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const input = node.querySelector
      ? node.querySelector("textarea,[contenteditable='true']")
      : node.matches && node.matches("textarea,[contenteditable='true']")
        ? node
        : null;

    return (
      rect.width > 240 &&
      rect.height >= 36 &&
      rect.height < 280 &&
      rect.bottom > viewportHeight * 0.45 &&
      rect.top < viewportHeight &&
      Boolean(input)
    );
  }

  function isComposerInput(target) {
    if (!target || !target.closest) {
      return false;
    }

    const editable = target.closest("textarea,[contenteditable='true']");
    if (!editable) {
      return false;
    }

    const composer = findComposer();
    return Boolean(composer && composer.contains(editable));
  }

  function looksLikeSendButton(button) {
    if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") {
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

    const composer = findComposer();
    if (!composer || !composer.contains(button)) {
      return false;
    }

    const rect = button.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    return rect.width <= 56 && rect.height <= 56 && rect.right > composerRect.right - 90;
  }

  function capturePotentialSend(target, _source) {
    const composer = findComposer();
    if (!composer) {
      return;
    }

    const text = getPromptText(target, composer);
    const normalized = normalizePrompt(text);
    if (!normalized) {
      return;
    }

    window.setTimeout(() => recordSentMessage(normalized, Date.now()), 80);
  }

  function getPromptText(target, composer) {
    const scope = composer || (target && target.closest && target.closest("form")) || document;
    const textareas = scope.querySelectorAll ? Array.from(scope.querySelectorAll("textarea")) : [];
    const textarea = textareas.find((item) => item.value && item.value.trim()) || textareas[0];
    if (textarea && textarea.value) {
      return textarea.value;
    }

    const editables = scope.querySelectorAll
      ? Array.from(scope.querySelectorAll("[contenteditable='true']"))
      : [];
    const editable = editables.find((item) => item.innerText && item.innerText.trim());
    return editable ? editable.innerText : "";
  }

  function normalizePrompt(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function recordSentMessage(text, now) {
    rollDayIfNeeded();
    const hash = hashText(text);
    const duplicate = state.recentSends.some(
      (item) => item.hash === hash && now - item.at < RECENT_SEND_WINDOW_MS
    );
    if (duplicate) {
      return;
    }

    state.recentSends = state.recentSends
      .filter((item) => now - item.at < 1000 * 60 * 60)
      .concat({ hash, at: now });
    state.todayMessages += 1;
    state.todayTokens += estimateTokens(text);
    state.tokenSource = "estimated";

    const chat = ensureChat(getChatKey());
    chat.count += 1;
    chat.updatedAt = now;
    scheduleSave();
    update();
  }

  function updateChatCount() {
    const chat = ensureChat(getChatKey());
    const scanned = countVisibleUserMessages();
    if (scanned > chat.count) {
      chat.count = scanned;
      chat.updatedAt = Date.now();
      scheduleSave();
    }
  }

  function countVisibleUserMessages() {
    const selectors = [
      "[data-testid='user-message']",
      "[data-testid*='user-message' i]",
      "[data-message-author-role='user']",
      "[data-author='user']",
      "[data-role='user']",
      "[aria-label='Your message']",
      "[aria-label*='user message' i]"
    ];

    const unique = new Set();
    for (const selector of selectors) {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch (_error) {
        continue;
      }

      nodes.forEach((node) => {
        if (isLikelyMessageNode(node)) {
          unique.add(getStableNodeKey(node));
        }
      });
    }

    return unique.size;
  }

  function isLikelyMessageNode(node) {
    if (!node || !node.getBoundingClientRect) {
      return false;
    }
    const rect = node.getBoundingClientRect();
    const text = normalizePrompt(node.innerText || node.textContent || "");
    return rect.width > 120 && rect.height > 12 && text.length > 0 && !node.closest(`#${ROOT_ID}`);
  }

  function getStableNodeKey(node) {
    const text = normalizePrompt(node.innerText || node.textContent || "");
    const rect = node.getBoundingClientRect();
    return `${Math.round(rect.top)}:${hashText(text.slice(0, 200))}`;
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
    if (match) {
      return `chat:${match[1]}`;
    }
    return `path:${path}`;
  }

  function isUsageSettingsPage() {
    return /\/settings\/usage\/?$/i.test(window.location.pathname);
  }

  function scrapeUsagePage() {
    if (!document.body) {
      return;
    }
    const parsed = parseUsageFromDom(document.body.innerText || "");
    if (parsed) {
      mergeUsage(parsed, "page");
    }
  }

  function mergeUsage(parsed, source) {
    let changed = false;

    if (parsed.plan && parsed.plan !== state.usage.plan) {
      state.usage.plan = parsed.plan;
      changed = true;
    }
    if (Number.isFinite(parsed.sessionPercent) && parsed.sessionPercent !== state.usage.sessionPercent) {
      state.usage.sessionPercent = parsed.sessionPercent;
      changed = true;
    }
    if (parsed.sessionReset && parsed.sessionReset !== state.usage.sessionReset) {
      state.usage.sessionReset = parsed.sessionReset;
      changed = true;
    }
    if (Number.isFinite(parsed.weeklyPercent) && parsed.weeklyPercent !== state.usage.weeklyPercent) {
      state.usage.weeklyPercent = parsed.weeklyPercent;
      changed = true;
    }
    if (parsed.weeklyReset && parsed.weeklyReset !== state.usage.weeklyReset) {
      state.usage.weeklyReset = parsed.weeklyReset;
      changed = true;
    }
    if (Number.isFinite(parsed.todayMessages) && parsed.todayMessages > state.todayMessages) {
      state.todayMessages = parsed.todayMessages;
      changed = true;
    }
    if (Number.isFinite(parsed.todayTokens) && parsed.todayTokens > state.todayTokens) {
      state.todayTokens = parsed.todayTokens;
      state.tokenSource = "exact";
      changed = true;
    }

    if (changed) {
      state.usage.updatedAt = Date.now();
      state.usage.source = source;
      scheduleSave();
      render();
    }
  }

  function parseUsageFromDom(text) {
    const clean = normalizeLines(text);
    if (!/usage|current session|weekly|resets/i.test(clean)) {
      return null;
    }

    const currentBlock = blockBetween(clean, /Current session/i, /Weekly/i) || clean;
    const weeklyBlock = blockBetween(clean, /Weekly/i, /Today|Updated|Settings|Quit/i) || "";
    const planMatch = clean.match(/Plan usage limits\s+([A-Za-z][\w -]{1,24})/i);
    const todayBlock = blockBetween(clean, /Today/i, /Updated|Settings|Quit/i) || "";

    return compactParsed({
      plan: planMatch ? planMatch[1].trim() : "",
      sessionPercent: pickPercent(currentBlock),
      sessionReset: pickReset(currentBlock),
      weeklyPercent: pickPercent(weeklyBlock),
      weeklyReset: pickReset(weeklyBlock),
      todayMessages: pickMetric(todayBlock, /Messages/i),
      todayTokens: pickMetric(todayBlock, /Tokens/i)
    });
  }

  function parseUsageFromText(text) {
    if (!text) {
      return null;
    }

    const fromJson = parseUsageFromJson(text);
    if (fromJson) {
      return fromJson;
    }

    return parseUsageFromDom(text);
  }

  function parseUsageFromJson(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (_error) {
      return null;
    }

    const found = {
      plan: "",
      sessionPercent: null,
      sessionReset: "",
      weeklyPercent: null,
      weeklyReset: "",
      todayMessages: null,
      todayTokens: null
    };

    walk(data, [], (value, path) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return;
      }

      const pathText = path.join("_").toLowerCase();
      const keysText = Object.keys(value).join("_").toLowerCase();
      const bag = `${pathText}_${keysText}`;

      if (!found.plan && /plan|tier|subscription/.test(bag)) {
        const plan = pickString(value, /plan|tier|subscription/);
        if (plan && /^[a-z][\w -]{1,24}$/i.test(plan)) {
          found.plan = titleCase(plan);
        }
      }

      if (/current|session|five|5|hour|window/.test(bag)) {
        found.sessionPercent = coalesceNumber(found.sessionPercent, pickObjectPercent(value));
        found.sessionReset = found.sessionReset || pickObjectReset(value);
      }

      if (/week|weekly/.test(bag)) {
        found.weeklyPercent = coalesceNumber(found.weeklyPercent, pickObjectPercent(value));
        found.weeklyReset = found.weeklyReset || pickObjectReset(value);
      }

      if (/today|daily/.test(bag)) {
        found.todayMessages = coalesceNumber(found.todayMessages, pickObjectMetric(value, /message|request|prompt/));
        found.todayTokens = coalesceNumber(found.todayTokens, pickObjectMetric(value, /token/));
      }
    });

    return compactParsed(found);
  }

  function compactParsed(parsed) {
    const hasValue = Object.values(parsed).some(
      (value) => value !== null && value !== undefined && value !== ""
    );
    return hasValue ? parsed : null;
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

  function pickPercent(text) {
    const matches = Array.from(String(text || "").matchAll(/(\d{1,3})(?:\.\d+)?\s*%/g));
    if (!matches.length) {
      return null;
    }
    const value = Number(matches[matches.length - 1][1]);
    return value >= 0 && value <= 100 ? value : null;
  }

  function pickReset(text) {
    const match = String(text || "").match(/Resets?\s+(?:in\s+)?([^\n]+)/i);
    if (!match) {
      return "";
    }
    return match[1].replace(/\s+/g, " ").trim();
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

  function walk(value, path, visitor) {
    visitor(value, path);
    if (!value || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, path.concat(String(index)), visitor));
      return;
    }
    Object.keys(value).forEach((key) => walk(value[key], path.concat(key), visitor));
  }

  function pickString(object, keyRe) {
    for (const [key, value] of Object.entries(object)) {
      if (keyRe.test(key) && typeof value === "string") {
        return value;
      }
    }
    return "";
  }

  function pickObjectPercent(object) {
    const direct = pickObjectMetric(object, /percent|percentage|pct/);
    if (Number.isFinite(direct) && direct >= 0 && direct <= 100) {
      return Math.round(direct);
    }

    const used = pickObjectMetric(object, /^used$|used_count|messages_used|tokens_used|usage/);
    const limit = pickObjectMetric(object, /^limit$|max|quota|allowed|total/);
    if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
      return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
    }
    return null;
  }

  function pickObjectMetric(object, keyRe) {
    for (const [key, value] of Object.entries(object)) {
      if (!keyRe.test(key)) {
        continue;
      }
      if (typeof value === "number") {
        return value;
      }
      if (typeof value === "string") {
        const parsed = parseCompactNumber(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
    return null;
  }

  function pickObjectReset(object) {
    for (const [key, value] of Object.entries(object)) {
      if (!/reset|resets|renew|refresh|window_end|expires/i.test(key)) {
        continue;
      }
      if (typeof value === "number") {
        return formatResetTimestamp(value);
      }
      if (typeof value === "string") {
        if (/^\d+$/.test(value)) {
          return formatResetTimestamp(Number(value));
        }
        return formatResetString(value);
      }
    }
    return "";
  }

  function coalesceNumber(current, next) {
    return Number.isFinite(current) ? current : Number.isFinite(next) ? next : current;
  }

  function formatResetTimestamp(value) {
    const milliseconds = value > 100000000000 ? value : value * 1000;
    if (!Number.isFinite(milliseconds)) {
      return "";
    }
    return formatResetString(new Date(milliseconds).toISOString());
  }

  function formatResetString(value) {
    const text = String(value || "").trim();
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) {
      const diff = date.getTime() - Date.now();
      if (diff > -60000) {
        return `in ${formatDuration(diff)}`;
      }
    }
    return text.replace(/^in\s+/i, "");
  }

  function compactReset(value) {
    const text = String(value || "").trim();
    if (!text) {
      return "";
    }
    return text
      .replace(/^in\s+/i, "")
      .replace(/\bhours?\b/gi, "h")
      .replace(/\bhrs?\b/gi, "h")
      .replace(/\bminutes?\b/gi, "m")
      .replace(/\bmins?\b/gi, "m")
      .replace(/\s+/g, " ");
  }

  function formatDuration(milliseconds) {
    const totalMinutes = Math.max(0, Math.round(milliseconds / 60000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) {
      return `${days}d ${hours}h`;
    }
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }

  function formatAge(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `${minutes}m`;
    }
    return `${Math.floor(minutes / 60)}h`;
  }

  function estimateTokens(text) {
    const normalized = String(text || "");
    const cjk = (normalized.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
    const nonCjk = normalized.length - cjk;
    return Math.max(1, Math.ceil(nonCjk / 4 + cjk));
  }

  function formatTokenCount(value) {
    const number = Math.max(0, Math.round(Number(value) || 0));
    if (number >= 1000000) {
      return `${trimDecimal(number / 1000000)}M`;
    }
    if (number >= 1000) {
      return `${trimDecimal(number / 1000)}K`;
    }
    return String(number);
  }

  function formatInt(value) {
    return String(Math.max(0, Math.round(Number(value) || 0)));
  }

  function trimDecimal(value) {
    return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  }

  function clampPercent(value) {
    if (!Number.isFinite(value)) {
      return null;
    }
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  function titleCase(value) {
    return String(value || "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (char) => char.toUpperCase());
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
