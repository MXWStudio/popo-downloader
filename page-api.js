(function installPopoPageApiBridge() {
  "use strict";

  const REQUEST_SOURCE = "popo-stable-downloader-isolated";
  const RESPONSE_SOURCE = "popo-stable-downloader-page";
  const ALLOWED_PATHS = new Set([
    "/api/bs-team-space/web/v1/page/download",
    "/api/bs-team-space/web/v1/teamSpace/id"
  ]);

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
