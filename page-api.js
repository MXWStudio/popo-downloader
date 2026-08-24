(function installPopoPageApiBridge() {
  "use strict";

  const REQUEST_SOURCE = "popo-stable-downloader-isolated";
  const RESPONSE_SOURCE = "popo-stable-downloader-page";
  const OBSERVED_DOWNLOAD_URL_EVENT = "popo-stable-download:observed-url";
  const REQUEST_OBSERVED_DOWNLOAD_URLS_EVENT = "popo-stable-download:request-observed-urls";
  const PAGE_ROUTE_CHANGE_EVENT = "popo-stable-download:page-route-change";
  const ALLOWED_PATHS = new Set([
    "/api/bs-team-space/web/v1/page/download",
    "/api/bs-team-space/web/v1/teamSpace/id"
  ]);

  const observedResources = new WeakSet();
  const observedUrls = [];
  const MAX_OBSERVED_URLS = 120;

  function reportPageRouteChange(previousUrl) {
    if (window.location.href === previousUrl) return;
    window.dispatchEvent(new CustomEvent(PAGE_ROUTE_CHANGE_EVENT, {
      detail: { url: window.location.href }
    }));
  }

  for (const method of ["pushState", "replaceState"]) {
    const original = window.history[method];
    if (typeof original !== "function") continue;
    window.history[method] = function (...args) {
      const previousUrl = window.location.href;
      const result = original.apply(this, args);
      reportPageRouteChange(previousUrl);
      return result;
    };
  }
  window.addEventListener("popstate", () => {
    window.dispatchEvent(new CustomEvent(PAGE_ROUTE_CHANGE_EVENT, {
      detail: { url: window.location.href }
    }));
  });

  function reportObservedUrl(value) {
    const candidate = String(value || "").trim();
    if (!/^https?:\/\//i.test(candidate)) return;
    const existingIndex = observedUrls.indexOf(candidate);
    if (existingIndex >= 0) observedUrls.splice(existingIndex, 1);
    observedUrls.push(candidate);
    if (observedUrls.length > MAX_OBSERVED_URLS) {
      observedUrls.splice(0, observedUrls.length - MAX_OBSERVED_URLS);
    }
    window.dispatchEvent(new CustomEvent(OBSERVED_DOWNLOAD_URL_EVENT, { detail: candidate }));
  }

  window.addEventListener(REQUEST_OBSERVED_DOWNLOAD_URLS_EVENT, () => {
    for (const url of observedUrls) {
      window.dispatchEvent(new CustomEvent(OBSERVED_DOWNLOAD_URL_EVENT, { detail: url }));
    }
  });

  function inspectResource(resource) {
    if (!resource || typeof resource !== "object" || observedResources.has(resource)) return;
    observedResources.add(resource);
    reportObservedUrl(resource.name);
  }

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) inspectResource(entry);
    });
    observer.observe({ type: "resource", buffered: true });
  } catch {}

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.data?.source !== REQUEST_SOURCE) return;
    const { requestId, path } = event.data;
    if (typeof requestId !== "string" || typeof path !== "string") return;
    let requestUrl;
    try {
      requestUrl = new URL(path, window.location.origin);
    } catch {
      return;
    }
    if (requestUrl.origin !== window.location.origin || !ALLOWED_PATHS.has(requestUrl.pathname)) return;

    try {
      const response = await window.fetch(`${requestUrl.pathname}${requestUrl.search}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        method: "GET"
      });
      reportObservedUrl(response.url);
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      window.postMessage({
        source: RESPONSE_SOURCE,
        requestId,
        ok: response.ok,
        status: response.status,
        body
      }, window.location.origin);
    } catch (error) {
      window.postMessage({
        source: RESPONSE_SOURCE,
        requestId,
        ok: false,
        status: 0,
        error: String(error)
      }, window.location.origin);
    }
  });
})();
