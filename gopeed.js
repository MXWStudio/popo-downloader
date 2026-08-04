(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PopoGopeed = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_ENDPOINT = "http://127.0.0.1:9999";
  const ACTIVE_STATUSES = new Set(["ready", "running", "wait"]);

  class GopeedApiError extends Error {
    constructor(message, options = {}) {
      super(message);
      this.name = "GopeedApiError";
      this.code = options.code ?? null;
      this.httpStatus = options.httpStatus ?? null;
      this.cause = options.cause;
    }
  }

  function normalizeEndpoint(value) {
    const input = String(value || DEFAULT_ENDPOINT).trim();
    let url;
    try {
      url = new URL(input);
    } catch {
      throw new GopeedApiError("Gopeed API 地址格式不正确");
    }
    if (url.protocol !== "http:") {
      throw new GopeedApiError("Gopeed API 只允许使用本机 HTTP 地址");
    }
    const hostname = url.hostname.toLowerCase();
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) {
      throw new GopeedApiError("为保护下载地址，Gopeed API 必须绑定到本机");
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.href.replace(/\/+$/, "");
  }

  function normalizeDownloadDirectory(value) {
    const input = String(value || "").trim();
    if (!input) return "";
    const normalized = input.replace(/\//g, "\\");
    const drivePath = /^[a-z]:\\/i.test(normalized);
    const uncPath = /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(normalized);
    if (!drivePath && !uncPath) {
      throw new GopeedApiError("自定义保存目录必须是 Windows 绝对路径，例如 D:\\POPO素材");
    }
    if (/(^|\\)\.\.?($|\\)/.test(normalized)) {
      throw new GopeedApiError("自定义保存目录不能包含 . 或 .. 路径片段");
    }
    const tail = drivePath
      ? normalized.slice(3)
      : normalized.replace(/^\\\\[^\\]+\\[^\\]+\\?/, "");
    if (/[<>:\"|?*\u0000-\u001f]/.test(tail)) {
      throw new GopeedApiError("自定义保存目录包含 Windows 不允许的字符");
    }
    if (/^[a-z]:\\$/i.test(normalized)) return normalized;
    return normalized.replace(/\\+$/, "");
  }

  function requestHeaders(token, hasBody) {
    const headers = {};
    if (hasBody) headers["Content-Type"] = "application/json";
    const value = String(token || "").trim();
    if (value) headers["X-Api-Token"] = value;
    return headers;
  }

  async function request(settings, path, options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new GopeedApiError("当前环境不支持连接 Gopeed");
    }
    const endpoint = normalizeEndpoint(settings?.gopeedEndpoint);
    const controller = new AbortController();
    const timeoutMs = Number(options.timeoutMs || 8000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${endpoint}${path}`, {
        method: options.method || "GET",
        headers: requestHeaders(settings?.gopeedToken, options.body !== undefined),
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal
      });
    } catch (error) {
      const message = error?.name === "AbortError"
        ? `连接 Gopeed 超时（${timeoutMs}ms）`
        : "无法连接 Gopeed，请确认程序已启动且 TCP API 已开启";
      throw new GopeedApiError(message, { cause: error });
    } finally {
      clearTimeout(timer);
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new GopeedApiError(`Gopeed 返回了无法识别的响应（HTTP ${response.status}）`, {
        httpStatus: response.status,
        cause: error
      });
    }
    if (!response.ok || payload?.code !== 0) {
      const unauthorized = response.status === 401 || payload?.code === 1001;
      throw new GopeedApiError(
        unauthorized
          ? "Gopeed API Token 不正确"
          : payload?.msg || `Gopeed 请求失败（HTTP ${response.status}）`,
        { code: payload?.code, httpStatus: response.status }
      );
    }
    return payload.data;
  }

  function buildCreateTaskBody({ url, name, path, connections = 1 }) {
    const safeConnections = Math.max(1, Math.min(16, Number(connections) || 1));
    return {
      req: {
        url,
        labels: {
          source: "popo-stable-downloader"
        }
      },
      opts: {
        name,
        path,
        extra: {
          connections: safeConnections
        }
      }
    };
  }

  function splitDownloadTarget(downloadDir, relativeFilename) {
    const base = String(downloadDir || "").trim().replace(/[\\/]+$/, "");
    if (!base) throw new GopeedApiError("Gopeed 没有配置默认下载目录");
    const parts = String(relativeFilename || "")
      .split(/[\\/]+/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (!parts.length) throw new GopeedApiError("文件保存路径为空");
    const name = parts.pop();
    const separator = base.includes("\\") ? "\\" : "/";
    return {
      name,
      path: [base, ...parts].join(separator)
    };
  }

  function classifyTaskStatus(status) {
    const value = String(status || "").toLowerCase();
    if (value === "done") return "success";
    if (value === "error") return "failed";
    if (value === "pause") return "paused";
    if (ACTIVE_STATUSES.has(value)) return "active";
    return "unknown";
  }

  function getConfig(settings, options) {
    return request(settings, "/api/v1/config", options);
  }

  function getTask(settings, taskId, options) {
    return request(settings, `/api/v1/tasks/${encodeURIComponent(taskId)}`, options);
  }

  function createTask(settings, task, options = {}) {
    return request(settings, "/api/v1/tasks", {
      ...options,
      method: "POST",
      body: buildCreateTaskBody(task)
    });
  }

  function patchTask(settings, taskId, task, options = {}) {
    return request(settings, `/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      ...options,
      method: "PATCH",
      body: buildCreateTaskBody(task)
    });
  }

  function pauseTask(settings, taskId, options = {}) {
    return request(settings, `/api/v1/tasks/${encodeURIComponent(taskId)}/pause`, {
      ...options,
      method: "PUT"
    });
  }

  function continueTask(settings, taskId, options = {}) {
    return request(settings, `/api/v1/tasks/${encodeURIComponent(taskId)}/continue`, {
      ...options,
      method: "PUT"
    });
  }

  async function startOrReplaceTask(settings, existingTaskId, task, options = {}) {
    if (existingTaskId) {
      try {
        await patchTask(settings, existingTaskId, task, options);
        await continueTask(settings, existingTaskId, options);
        return { taskId: existingTaskId, replacedMissingTask: false };
      } catch (error) {
        if (error?.code !== 2001) throw error;
      }
    }
    const taskId = await createTask(settings, task, options);
    return { taskId, replacedMissingTask: Boolean(existingTaskId) };
  }

  function deleteTask(settings, taskId, options = {}) {
    return request(settings, `/api/v1/tasks/${encodeURIComponent(taskId)}?force=true`, {
      ...options,
      method: "DELETE"
    });
  }

  return {
    DEFAULT_ENDPOINT,
    GopeedApiError,
    buildCreateTaskBody,
    classifyTaskStatus,
    continueTask,
    createTask,
    deleteTask,
    getConfig,
    getTask,
    normalizeDownloadDirectory,
    normalizeEndpoint,
    patchTask,
    pauseTask,
    request,
    requestHeaders,
    startOrReplaceTask,
    splitDownloadTarget
  };
});
