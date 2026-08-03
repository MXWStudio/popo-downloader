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
    segments.push(sanitizePathSegment(item.name));
    return segments.join("/");
  }

  function findFirstHttpUrl(value, depth) {
    if (depth > 8 || value == null) return "";
    if (typeof value === "string") {
      return /^https?:\/\//i.test(value) ? value : "";
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

  function csvEscape(value) {
    const text = String(value == null ? "" : value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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
    extensionOf,
    findFirstHttpUrl: (value) => findFirstHttpUrl(value, 0),
    isSystemMetadataFile,
    looksLikeFileTitle,
    makeCsv,
    matchesFilters,
    normalizeFormats,
    normalizePreviewTitle,
    previewTitleMatchesFile,
    sanitizePathSegment,
    selectVirtualListMatch,
    splitTokens
  };

  root.PopoCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
