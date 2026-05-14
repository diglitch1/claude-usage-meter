(function () {
  if (window.__claudeUsageMeterBridgeInstalled) {
    return;
  }

  window.__claudeUsageMeterBridgeInstalled = true;

  const SOURCE = "claude-usage-meter-bridge";
  const URL_RE = /usage|quota|limit|limits|billing|subscription|member|organization|account/i;
  const BODY_RE = /"usage"|"quota"|"limit"|"remaining"|"reset|"resets|"tokens|"message_limit|"percent|"percentage/i;
  const MAX_CHARS = 180000;

  function shouldInspectUrl(input) {
    const url = typeof input === "string" ? input : input && input.url;
    return Boolean(url && URL_RE.test(url));
  }

  function emit(url, status, text) {
    if (!text || !BODY_RE.test(text)) {
      return;
    }

    window.postMessage(
      {
        source: SOURCE,
        type: "response",
        url: String(url || ""),
        status: Number(status || 0),
        body: text.slice(0, MAX_CHARS)
      },
      window.location.origin
    );
  }

  function inspectResponse(input, response) {
    if (!response || !shouldInspectUrl(input || response.url)) {
      return;
    }

    const contentType = response.headers && response.headers.get
      ? response.headers.get("content-type") || ""
      : "";
    if (contentType && !/json|text|javascript/i.test(contentType)) {
      return;
    }

    response
      .clone()
      .text()
      .then((text) => emit(response.url || input, response.status, text))
      .catch(() => {});
  }

  if (typeof window.fetch === "function") {
    const nativeFetch = window.fetch;
    window.fetch = function patchedFetch(input, init) {
      const result = nativeFetch.apply(this, arguments);
      result.then((response) => inspectResponse(input, response)).catch(() => {});
      return result;
    };
  }

  const NativeXHR = window.XMLHttpRequest;
  if (NativeXHR && NativeXHR.prototype) {
    const nativeOpen = NativeXHR.prototype.open;
    const nativeSend = NativeXHR.prototype.send;

    NativeXHR.prototype.open = function patchedOpen(method, url) {
      this.__claudeUsageMeterUrl = url;
      return nativeOpen.apply(this, arguments);
    };

    NativeXHR.prototype.send = function patchedSend() {
      if (shouldInspectUrl(this.__claudeUsageMeterUrl)) {
        this.addEventListener("load", () => {
          const contentType = this.getResponseHeader
            ? this.getResponseHeader("content-type") || ""
            : "";
          if (contentType && !/json|text|javascript/i.test(contentType)) {
            return;
          }
          if (typeof this.responseText === "string") {
            emit(this.__claudeUsageMeterUrl, this.status, this.responseText);
          }
        });
      }

      return nativeSend.apply(this, arguments);
    };
  }
})();
