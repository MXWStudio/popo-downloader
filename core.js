(function initPopoCore(root) {
  "use strict";

  const FAILURE = Object.freeze({
    DIRECTORY_LOAD_FAILED: "目录加载失败",
    FILE_NOT_FOUND: "未找到文件",
    FILE_OPEN_FAILED: "文件打开失败",
    PREVIEW_LOAD_TIMEOUT: "预览加载超时",
    DOWNLOAD_BUTTON_NOT_FOUND: "未找到下载按钮",
    DOWNLOAD_NOT_ESTABLISHED: "下载未建立",
    TRANSFER_INTERRUPTED: "传输中断",
    CANCELLED: "已取消"
  });

  function splitTokens(value) {
    return String(value || "")
      .split(/[\n,，;；]+/)
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean);
  }

  function extensionOf(name) {
    const match = String(name || "").trim().match(/\.([^.\\/\s]+)$/);
    return match ? match[1].toLowerCase() : "";
  }

  const COMPOUND_DOWNLOAD_SUFFIXES = Object.freeze([
    ".tar.gz",
    ".tar.bz2",
    ".tar.xz",
    ".tar.zst",
    ".tar.lz",
    ".tar.lz4",
    ".tar.br"
  ]);

  function decodeDownloadFilename(value) {
    let decoded = String(value || "").trim();
    if (decoded.startsWith('"') && decoded.endsWith('"')) {
      decoded = decoded.slice(1, -1);
    }
    const encoded = decoded.match(/^[^']*'[^']*'(.*)$/s);
    if (encoded) decoded = encoded[1];
    for (let pass = 0; pass < 2; pass += 1) {
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      } catch {
        break;
      }
    }
    decoded = decoded.replace(/\\"/g, '"').trim();
    if (decoded.startsWith('"') && decoded.endsWith('"')) {
      decoded = decoded.slice(1, -1);
    }
    return decoded.trim();
  }

  function contentDispositionFilename(value) {
    const disposition = String(value || "");
    const encoded = disposition.match(/(?:^|;)\s*filename\*\s*=\s*("[^"]*"|[^;]*)/i);
    if (encoded?.[1]) return decodeDownloadFilename(encoded[1]);
    const plain = disposition.match(/(?:^|;)\s*filename\s*=\s*("[^"]*"|[^;]*)/i);
    return plain?.[1] ? decodeDownloadFilename(plain[1]) : "";
  }

  function downloadBasename(value) {
    const text = String(value || "").trim();
    if (!text || /[\u0000-\u001f]/.test(text)) return "";
    return text.replace(/\\/g, "/").split("/").pop()?.trim() || "";
  }

  function remoteDownloadFilename(sourceUrl) {
    try {
      const url = new URL(String(sourceUrl || ""));
      const candidates = [];
      for (const [key, value] of url.searchParams.entries()) {
        const lowerKey = key.toLowerCase();
        if (["response-content-disposition", "content-disposition"].includes(lowerKey)) {
          candidates.push(contentDispositionFilename(value));
        }
      }
      for (const [key, value] of url.searchParams.entries()) {
        if (["filename", "file_name", "download_filename"].includes(key.toLowerCase())) {
          candidates.push(decodeDownloadFilename(value));
        }
      }
      candidates.push(decodeDownloadFilename(url.pathname.split("/").pop() || ""));
      return candidates
        .map(downloadBasename)
        .find((candidate) => extensionOf(candidate)) || "";
    } catch {
      return "";
    }
  }

  function remoteDownloadSuffix(remoteName, displayName) {
    const remote = downloadBasename(remoteName);
    if (!remote) return "";
    const finalMatch = remote.match(/(\.[^.\\/\s<>:"|?*\u0000-\u001f]{1,32})$/);
    if (!finalMatch) return "";
    const finalSuffix = finalMatch[1];
    const lowerRemote = remote.toLowerCase();
    const compound = COMPOUND_DOWNLOAD_SUFFIXES.find((suffix) => lowerRemote.endsWith(suffix));
    const display = String(displayName || "").trim();
    if (display && lowerRemote.startsWith(`${display.toLowerCase()}.`)) {
      const remainder = remote.slice(display.length);
      if (/^\.[^.\\/\s<>:"|?*\u0000-\u001f]{1,32}$/.test(remainder)) return remainder;
      if (compound && remainder.toLowerCase() === compound) {
        return remote.slice(-compound.length);
      }
    }
    return compound ? remote.slice(-compound.length) : finalSuffix;
  }

  function resolveDownloadFilename(displayName, sourceUrl) {
    const display = String(displayName || "").trim();
    if (!display) return display;
    const remote = remoteDownloadFilename(sourceUrl);
    if (!remote) return display;
    const suffix = remoteDownloadSuffix(remote, display);
    if (!suffix || display.toLowerCase().endsWith(suffix.toLowerCase())) return display;

    const displayExtension = extensionOf(display);
    const displaySuffix = displayExtension ? `.${displayExtension}` : "";
    if (displaySuffix && suffix.toLowerCase().startsWith(`${displaySuffix}.`) &&
        display.toLowerCase().endsWith(displaySuffix)) {
      return `${display}${suffix.slice(displaySuffix.length)}`;
    }
    const remoteExtendsDisplay = remote.toLowerCase().startsWith(`${display.toLowerCase()}.`);
    if (displayExtension && !remoteExtendsDisplay) return display;
    return `${display}${suffix}`;
  }

  function normalizePreviewTitle(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function previewTitleMatchesFile(title, filename) {
    const candidate = normalizePreviewTitle(title);
    const expected = normalizePreviewTitle(filename);
    return Boolean(candidate && expected && (candidate === expected || candidate.includes(expected)));
  }

  function looksLikeFileTitle(value) {
    return /\.[a-z0-9]{1,10}(?=\s|$|[)\]】|·—–-])/i.test(normalizePreviewTitle(value));
  }

  function isSystemMetadataFile(name) {
    const filename = String(name || "").trim().toLowerCase();
    return [
      "thumbs.db",
      "ehthumbs.db",
      "ehthumbs_vista.db",
      "desktop.ini",
      ".ds_store"
    ].includes(filename);
  }

  function selectVirtualListMatch(entries, expectedName, expectedType, expectedIndex) {
    const requestedIndex = expectedIndex == null ? "" : String(expectedIndex);
    const matchingName = (entries || []).filter(({ item }) => item &&
      item.name === expectedName &&
      (!expectedType || item.type === expectedType));
    if (requestedIndex) {
      const matchingIndex = matchingName.filter(({ item }) => item.itemIndex === requestedIndex);
      if (matchingIndex.length === 1) {
        return { entry: matchingIndex[0], matchedBy: "index", ambiguous: false };
      }
      if (matchingIndex.length > 1) {
        return { entry: null, matchedBy: "", ambiguous: true };
      }
    }
    if (matchingName.length === 1) {
      return { entry: matchingName[0], matchedBy: "name", ambiguous: false };
    }
    return { entry: null, matchedBy: "", ambiguous: matchingName.length > 1 };
  }

  function inferVirtualListItemCount({ indices, knownSizes, paddingBottom, explicitEmpty } = {}) {
    if (explicitEmpty) return 0;
    const numericIndices = (indices || [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0);
    if (!numericIndices.length) return null;

    const maxIndex = Math.max(...numericIndices);
    const sizes = (knownSizes || [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
    const bottomPixels = Number.parseFloat(paddingBottom);
    if (!sizes.length || !Number.isFinite(bottomPixels) || bottomPixels <= 0) {
      return maxIndex + 1;
    }

    sizes.sort((left, right) => left - right);
    const knownSize = sizes[Math.floor(sizes.length / 2)];
    const remaining = bottomPixels / knownSize;
    const roundedRemaining = Math.round(remaining);
    if (Math.abs(remaining - roundedRemaining) > 0.08) return null;
    return maxIndex + 1 + roundedRemaining;
  }

  function normalizeFormats(value) {
    return splitTokens(value).map((format) => format.replace(/^\*\./, "").replace(/^\./, ""));
  }

  function matchesFilters(name, settings) {
    const lowerName = String(name || "").toLowerCase();
    const formats = normalizeFormats(settings.formats);
    const include = splitTokens(settings.includeKeywords);
    const exclude = splitTokens(settings.excludeKeywords);
    const extension = extensionOf(name);

    if (formats.length && !formats.includes(extension)) return false;
    if (include.length && !include.some((token) => lowerName.includes(token))) return false;
    if (exclude.some((token) => lowerName.includes(token))) return false;
    return true;
  }

  function sanitizePathSegment(value) {
    const cleaned = String(value || "")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim();
    return cleaned || "未命名";
  }

  function buildDownloadFilename(item, settings) {
    const rootDir = sanitizePathSegment(settings.downloadRoot || "POPO稳定下载");
    const segments = [rootDir];
    if (settings.preserveStructure !== false) {
      for (const segment of item.directoryPath || []) {
        segments.push(sanitizePathSegment(segment));
      }
    }
    segments.push(sanitizePathSegment(item.downloadName || item.name));
    return segments.join("/");
  }

  const ALLOWED_DOWNLOAD_HOST_SUFFIXES = Object.freeze([
    ".s3v2.nie.netease.com"
  ]);

  function validateDownloadUrl(value) {
    const text = String(value || "").trim();
    if (!text || /[\u0000-\u001f\u007f]/.test(text) || !/^https:\/\//i.test(text)) return "";
    try {
      const url = new URL(text);
      const hostname = url.hostname.toLowerCase();
      const hostAllowed = ALLOWED_DOWNLOAD_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
      if (url.protocol !== "https:" || !hostAllowed ||
          url.username || url.password ||
          (url.port && url.port !== "443")) return "";
      // Parse only for validation. Return the exact signed URL text so query
      // ordering, escaping and unknown signature parameters remain untouched.
      return text;
    } catch {
      return "";
    }
  }

  function normalizeAllowedDownloadUrl(value) {
    return validateDownloadUrl(value);
  }

  function findFirstHttpUrl(value, depth) {
    if (depth > 8 || value == null) return "";
    if (typeof value === "string") {
      return normalizeAllowedDownloadUrl(value);
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = findFirstHttpUrl(entry, depth + 1);
        if (found) return found;
      }
      return "";
    }
    if (typeof value === "object") {
      const preferredKeys = ["downloadUrl", "downloadURL", "url", "fileUrl", "fileURL", "src"];
      for (const key of preferredKeys) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          const found = findFirstHttpUrl(value[key], depth + 1);
          if (found) return found;
        }
      }
      for (const entry of Object.values(value)) {
        const found = findFirstHttpUrl(entry, depth + 1);
        if (found) return found;
      }
    }
    return "";
  }

  function selectObservedDownloadUrl(observedUrls, options = {}) {
    const pageId = String(options.pageId || "").trim().toLowerCase();
    const preferredFilename = normalizePreviewTitle(options.filename || "").toLowerCase();
    const candidates = [];
    for (const [index, raw] of (Array.isArray(observedUrls) ? observedUrls : []).entries()) {
      const validated = validateDownloadUrl(raw);
      if (!validated) continue;
      let url;
      try {
        url = new URL(validated);
      } catch {
        continue;
      }
      const lower = validated.toLowerCase();
      let decodedPath = url.pathname;
      for (let pass = 0; pass < 2; pass += 1) {
        try { decodedPath = decodeURIComponent(decodedPath); } catch { break; }
      }
      const pathFilename = normalizePreviewTitle(
        downloadBasename(decodedPath)
      ).toLowerCase();
      let dispositionFilename = "";
      const explicitFilenames = [];
      const queryPageIds = [];
      for (const [key, value] of url.searchParams.entries()) {
        const lowerKey = key.toLowerCase();
        if (["pageid", "page_id", "page-id"].includes(lowerKey)) {
          queryPageIds.push(String(value || "").toLowerCase());
        }
        if (["response-content-disposition", "content-disposition"].includes(lowerKey)) {
          dispositionFilename ||= normalizePreviewTitle(
            downloadBasename(contentDispositionFilename(value))
          ).toLowerCase();
        }
        if (["filename", "file_name", "download_filename"].includes(lowerKey)) {
          explicitFilenames.push(normalizePreviewTitle(
            downloadBasename(decodeDownloadFilename(value))
          ).toLowerCase());
        }
      }
      const pageIdMatch = Boolean(pageId && (
        decodedPath.toLowerCase().includes(pageId) ||
        queryPageIds.includes(pageId)
      ));
      const filenameMatch = Boolean(preferredFilename && (
        pathFilename === preferredFilename ||
        explicitFilenames.includes(preferredFilename)
      ));
      const dispositionFilenameMatch = Boolean(
        preferredFilename && dispositionFilename === preferredFilename
      );
      if (!pageIdMatch && !filenameMatch && !dispositionFilenameMatch) continue;

      let score = 0;
      if (dispositionFilenameMatch) score += 300;
      if (filenameMatch) score += 200;
      if (pageIdMatch) score += 150;
      if (/x-amz-signature=/i.test(validated)) score += 20;
      if (/response-content-disposition=/i.test(validated)) score += 10;
      if (/\.(?:mp4|mov|mkv|avi|webm|mp3|wav|flac|zip|rar|7z|psd|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif)(?:$|\?)/i.test(lower)) {
        score += 5;
      }
      candidates.push({ index, validated, score });
    }
    candidates.sort((left, right) => right.score - left.score || right.index - left.index);
    return candidates[0]?.validated || "";
  }

  function extractTeamSpaceId(body) {
    const payload = body && typeof body === "object" && !Array.isArray(body) &&
      Object.prototype.hasOwnProperty.call(body, "data")
      ? body.data
      : body;
    if (typeof payload === "string" || typeof payload === "number") {
      return String(payload).trim();
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
    for (const key of ["teamSpaceId", "id", "value"]) {
      const value = payload[key];
      if (typeof value === "string" || typeof value === "number") {
        const normalized = String(value).trim();
        if (normalized) return normalized;
      }
    }
    return "";
  }

  const SIMPLE_RUNTIME_COMMANDS = new Set([
    "GET_STATE",
    "GET_UPDATE_STATUS",
    "GET_UPDATE_DIAGNOSTICS",
    "CHECK_GOPEED",
    "CANCEL_FOLDER_TASK",
    "START_DOWNLOAD",
    "PAUSE",
    "RESUME",
    "SNOOZE_NETWORK_REMINDER",
    "MUTE_NETWORK_REMINDER_TODAY",
    "CANCEL",
    "RETRY_FAILED",
    "RESET"
  ]);
  const JOB_RUNTIME_COMMANDS = new Set([
    "CANCEL_JOB",
    "RETRY_JOB",
    "DISMISS_JOB",
    "RESTORE_CANCELLED_JOB"
  ]);
  const BATCH_RUNTIME_COMMANDS = new Set([
    "PAUSE_DOWNLOAD_BATCH",
    "RESUME_DOWNLOAD_BATCH",
    "REMOVE_DOWNLOAD_BATCH"
  ]);
  const SETTINGS_STRING_LIMITS = Object.freeze({
    formats: 4096,
    includeKeywords: 4096,
    excludeKeywords: 4096,
    downloadRoot: 1024,
    gopeedEndpoint: 2048,
    gopeedToken: 4096,
    gopeedDownloadDirOverride: 32768
  });
  const SETTINGS_NUMBER_LIMITS = Object.freeze({
    concurrency: [1, 5],
    gopeedConnections: [1, 16],
    maxRetries: [0, 10]
  });
  const SETTINGS_BOOLEAN_FIELDS = new Set(["recursive", "preserveStructure"]);
  const SETTINGS_TIMEOUT_FIELDS = new Set([
    "directoryLoad",
    "scanList",
    "itemLookup",
    "fileOpen",
    "previewLoad",
    "downloadStart",
    "transfer"
  ]);

  function runtimeMessageError(field) {
    return new Error(`后台命令格式不正确：${field}`);
  }

  function isPlainRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function boundedMessageString(value, field, maxLength, options = {}) {
    const { allowEmpty = false, allowNumber = false, optional = false } = options;
    if (value == null) {
      if (optional) return "";
      throw runtimeMessageError(field);
    }
    const validNumber = allowNumber && typeof value === "number" && Number.isFinite(value);
    if (typeof value !== "string" && !validNumber) {
      throw runtimeMessageError(field);
    }
    const normalized = String(value).trim();
    if ((!allowEmpty && !normalized) || normalized.length > maxLength || normalized.includes("\u0000")) {
      throw runtimeMessageError(field);
    }
    return normalized;
  }

  function normalizePopoPageUrl(value, field) {
    const input = boundedMessageString(value, field, 4096);
    let url;
    try {
      url = new URL(input);
    } catch {
      throw runtimeMessageError(field);
    }
    const valid = url.protocol === "https:" &&
      url.hostname.toLowerCase() === "docs.popo.netease.com" &&
      (!url.port || url.port === "443") &&
      !url.username &&
      !url.password &&
      /^\/team\/pc\/[^/]+\/pageDetail\/[a-z0-9]+/i.test(url.pathname);
    if (!valid) throw runtimeMessageError(field);
    return url.href;
  }

  function sanitizeSettingsInput(settings, field = "settings") {
    if (settings == null) return {};
    if (!isPlainRecord(settings)) throw runtimeMessageError(field);

    const allowedFields = new Set([
      ...Object.keys(SETTINGS_STRING_LIMITS),
      ...Object.keys(SETTINGS_NUMBER_LIMITS),
      ...SETTINGS_BOOLEAN_FIELDS,
      "timeouts"
    ]);
    const keys = Object.keys(settings);
    if (keys.length > allowedFields.size || keys.some((key) => !allowedFields.has(key))) {
      throw runtimeMessageError(field);
    }

    const sanitized = {};
    for (const [key, maxLength] of Object.entries(SETTINGS_STRING_LIMITS)) {
      if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
      sanitized[key] = boundedMessageString(settings[key], `${field}.${key}`, maxLength, {
        allowEmpty: true
      });
    }
    for (const key of SETTINGS_BOOLEAN_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
      if (typeof settings[key] !== "boolean") throw runtimeMessageError(`${field}.${key}`);
      sanitized[key] = settings[key];
    }
    for (const [key, [minimum, maximum]] of Object.entries(SETTINGS_NUMBER_LIMITS)) {
      if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
      const value = settings[key];
      if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw runtimeMessageError(`${field}.${key}`);
      }
      sanitized[key] = value;
    }
    if (Object.prototype.hasOwnProperty.call(settings, "timeouts")) {
      if (!isPlainRecord(settings.timeouts)) throw runtimeMessageError(`${field}.timeouts`);
      const timeoutKeys = Object.keys(settings.timeouts);
      if (timeoutKeys.length > SETTINGS_TIMEOUT_FIELDS.size ||
        timeoutKeys.some((key) => !SETTINGS_TIMEOUT_FIELDS.has(key))) {
        throw runtimeMessageError(`${field}.timeouts`);
      }
      sanitized.timeouts = {};
      for (const key of timeoutKeys) {
        const value = settings.timeouts[key];
        if (!Number.isInteger(value) || value < 100 || value > 86400000) {
          throw runtimeMessageError(`${field}.timeouts.${key}`);
        }
        sanitized.timeouts[key] = value;
      }
    }
    return sanitized;
  }

  function validateRuntimeMessage(message) {
    if (!isPlainRecord(message)) throw runtimeMessageError("message");
    const type = boundedMessageString(message.type, "type", 64);
    const command = { type };
    if (SIMPLE_RUNTIME_COMMANDS.has(type)) return command;

    if (JOB_RUNTIME_COMMANDS.has(type)) {
      command.jobId = boundedMessageString(message.jobId, "jobId", 200);
      if (type === "RESTORE_CANCELLED_JOB" && message.sourceTabId != null) {
        if (!Number.isInteger(message.sourceTabId) || message.sourceTabId < 0) {
          throw runtimeMessageError("sourceTabId");
        }
        command.sourceTabId = message.sourceTabId;
      }
      return command;
    }

    if (BATCH_RUNTIME_COMMANDS.has(type)) {
      command.batchId = boundedMessageString(message.batchId, "batchId", 200);
      return command;
    }

    switch (type) {
      case "SAVE_GOPEED_SETTINGS":
        return {
          type,
          gopeedEndpoint: boundedMessageString(message.gopeedEndpoint, "gopeedEndpoint", 2048, {
            allowEmpty: true,
            optional: true
          }),
          gopeedToken: boundedMessageString(message.gopeedToken, "gopeedToken", 4096, {
            allowEmpty: true,
            optional: true
          }),
          gopeedDownloadDirOverride: boundedMessageString(
            message.gopeedDownloadDirOverride,
            "gopeedDownloadDirOverride",
            32768,
            { allowEmpty: true, optional: true }
          )
        };
      case "CHOOSE_DOWNLOAD_DIRECTORY":
        return {
          type,
          initialPath: boundedMessageString(message.initialPath, "initialPath", 32768, {
            allowEmpty: true,
            optional: true
          })
        };
      case "SET_DOWNLOAD_CONCURRENCY":
        if (!Number.isInteger(message.concurrency) ||
            message.concurrency < 1 || message.concurrency > 5) {
          throw runtimeMessageError("concurrency");
        }
        return { type, concurrency: message.concurrency };
      case "SAVE_SETTINGS":
        return { type, settings: sanitizeSettingsInput(message.settings) };
      case "START_SCAN":
        return {
          type,
          url: normalizePopoPageUrl(message.url, "url"),
          settings: sanitizeSettingsInput(message.settings)
        };
      case "START_FOLDER_SCAN":
        return {
          type,
          folderName: boundedMessageString(message.folderName, "folderName", 1024),
          folderItemIndex: boundedMessageString(message.folderItemIndex, "folderItemIndex", 200, {
            allowNumber: true
          }),
          parentUrl: normalizePopoPageUrl(message.parentUrl, "parentUrl")
        };
      case "START_PAGE_DOWNLOAD":
        return {
          type,
          pageName: boundedMessageString(message.pageName, "pageName", 1024),
          parentUrl: normalizePopoPageUrl(message.parentUrl, "parentUrl")
        };
      case "SOURCE_PAGE_READY":
      case "REGISTER_WORKER_FRAME":
        return { type, url: normalizePopoPageUrl(message.url, "url") };
      default:
        return command;
    }
  }

  function csvEscape(value) {
    const text = String(value == null ? "" : value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function verifyDirectoryItemCount(expectedValue, actualValue) {
    const actual = Number(actualValue);
    if (!Number.isInteger(actual) || actual < 0) {
      throw new Error("目录实际项目数无效");
    }
    const expected = expectedValue == null || expectedValue === ""
      ? Number.NaN
      : Number(expectedValue);
    if (!Number.isInteger(expected) || expected < 0) {
      return { verified: false, matches: true, expected: null, actual };
    }
    return { verified: true, matches: expected === actual, expected, actual };
  }

  function makeCsv(items) {
    const headers = [
      "文件名",
      "原目录",
      "状态",
      "失败阶段",
      "失败原因",
      "尝试次数",
      "Gopeed任务ID",
      "开始时间",
      "完成时间"
    ];
    const rows = items.map((item) => [
      item.name,
      (item.directoryPath || []).join("/"),
      item.status,
      item.failureStage || "",
      item.error || "",
      item.attempts || 0,
      item.gopeedTaskId || item.retryTaskId || "",
      item.startedAt || "",
      item.completedAt || ""
    ]);
    return [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
  }

  const api = {
    FAILURE,
    buildDownloadFilename,
    extractTeamSpaceId,
    extensionOf,
    findFirstHttpUrl: (value) => findFirstHttpUrl(value, 0),
    inferVirtualListItemCount,
    isSystemMetadataFile,
    looksLikeFileTitle,
    makeCsv,
    matchesFilters,
    normalizeFormats,
    normalizeAllowedDownloadUrl,
    normalizePreviewTitle,
    previewTitleMatchesFile,
    resolveDownloadFilename,
    sanitizePathSegment,
    selectObservedDownloadUrl,
    selectVirtualListMatch,
    splitTokens,
    validateDownloadUrl,
    validateRuntimeMessage,
    verifyDirectoryItemCount
  };

  root.PopoCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
