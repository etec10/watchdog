(function () {
  const endpoint = "https://cdn.drv.pro/log/log.php";
  const sessionId = Date.now() + "-" + Math.random().toString(36).slice(2, 6);
  const batch = [];
  const fetchSuccessSummary = new Map();
  let userLocation = {};
  let sendTimeout = null;
  let internalLog = false;
  const throttleMap = new Map();

  // GeolocalizaÃ§Ã£o via IP
  fetch("https://ipinfo.io/json")//?token=a246cc2bd47856
    .then(res => res.json())
    .then(data => {
      userLocation = {
        ip: data.ip,
        city: data.city,
        region: data.region,
        country: data.country,
        loc: data.loc,
        org: data.org,
      };
    })
    .catch(() => {
      userLocation = { error: "location-unavailable" };
    });

  function log(type, data) {
    if (internalLog) return;

    const now = Date.now();

    // Throttle logs repetidos
    if (throttleMap.has(type) && now - throttleMap.get(type) < 1000) return;
    throttleMap.set(type, now);

    internalLog = true;
    try {
      if (type === "fetch-success") {
        const key = data.url;
        const existing = fetchSuccessSummary.get(key) || { count: 0, totalDuration: 0 };
        existing.count += 1;
        existing.totalDuration += data.duration;
        fetchSuccessSummary.set(key, existing);
        return;
      }

      batch.push({
        type,
        data,
        sessionId,
        url: location.href,
        userAgent: navigator.userAgent,
        timestamp: now,
      });

      if (batch.length >= 10) {
        sendLogs();
      } else if (!sendTimeout) {
        sendTimeout = setTimeout(sendLogs, 2000);
      }
    } finally {
      internalLog = false;
    }
  }

function sendLogs() {
  clearTimeout(sendTimeout);
  sendTimeout = null;

  if (batch.length === 0 && fetchSuccessSummary.size === 0) return;

  const now = Date.now();
  const summarizedSuccesses = [];

  for (const [url, stats] of fetchSuccessSummary.entries()) {
    summarizedSuccesses.push({
      type: "fetch-success-summary",
      data: {
        url,
        count: stats.count,
        avgDuration: Math.round(stats.totalDuration / stats.count),
      },
      sessionId,
      url: location.href,
      userAgent: navigator.userAgent,
      timestamp: now,
      location: userLocation,
    });
  }

  fetchSuccessSummary.clear();

  const payload = [
    ...batch.map(entry => ({
      ...entry,
      location: userLocation,
    })),
    ...summarizedSuccesses,
  ];

  console.log(`Enviando lote de logs: ${payload.length}`); // DEBUG

  fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});

  batch.length = 0;
}

  window.onerror = function (msg, url, line, col, error) {
    log("js-error", { msg, url, line, col, stack: error?.stack });
  };

  window.onunhandledrejection = function (event) {
    log("promise-rejection", {
      reason: event.reason?.message || event.reason,
      stack: event.reason?.stack,
    });
  };

  ["error", "warn", "info"].forEach(level => {
    const original = console[level];
    console[level] = function (...args) {
      try {
        log("console-" + level, args);
      } catch (_) {}
      original.apply(console, args);
    };
  });

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
    if (url?.startsWith(endpoint)) return originalFetch(...args);

    const start = performance.now();
    return originalFetch(...args)
      .then(res => {
        const duration = performance.now() - start;
        log("fetch-success", { url, status: res.status, duration });
        return res;
      })
      .catch(err => {
        const duration = performance.now() - start;
        log("fetch-error", { url, error: err.message, duration });
        throw err;
      });
  };

  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    const ws = new OriginalWebSocket(url, protocols);
    const socketId = `${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    const wsTimers = new Map();

    log("ws-init", { socketId, url });

    ws.addEventListener("open", () => log("ws-open", { socketId }));
    ws.addEventListener("message", e => {
      const now = performance.now();
      const msgId = e.data.slice(0, 20);
      if (wsTimers.has(msgId)) {
        const start = wsTimers.get(msgId);
        const duration = now - start;
        wsTimers.delete(msgId);
        log("ws-message", { socketId, data: e.data, duration });
      } else {
        //log("ws-message", { socketId, data: e.data });
      }
    });
    ws.addEventListener("error", e => {
      log("ws-error", { socketId, error: e.message || "unknown" });
    });
    ws.addEventListener("close", e => {
      log("ws-close", {
        socketId,
        code: e.code,
        reason: e.reason,
        wasClean: e.wasClean,
      });
    });

    const originalSend = ws.send;
    ws.send = function (data) {
      const msgId = data.slice(0, 20);
      wsTimers.set(msgId, performance.now());
      //log("ws-send", { socketId, data });
      return originalSend.call(ws, data);
    };

    return ws;
  };

  const pushState = history.pushState;
  history.pushState = function (...args) {
    log("navigation", { type: "pushState", url: location.href });
    return pushState.apply(history, args);
  };
  window.addEventListener("popstate", () => {
    log("navigation", { type: "popstate", url: location.href });
  });

  window.myTrack = {
    track: (type, data) => log(type, data),
  };

  window.addEventListener("beforeunload", sendLogs);
})();
