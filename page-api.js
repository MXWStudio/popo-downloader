(function installPopoPageApiBridge() {
  "use strict";

  const REQUEST_SOURCE = "popo-stable-downloader-isolated";
  const RESPONSE_SOURCE = "popo-stable-downloader-page";
  const ALLOWED_PATH = "/api/bs-team-space/web/v1/page/download";

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.data?.source !== REQUEST_SOURCE) return;
    const { requestId, path } = event.data;
    if (typeof requestId !== "string" || typeof path !== "string" || !path.startsWith(ALLOWED_PATH)) return;

    try {
      const response = await window.fetch(path, {
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
