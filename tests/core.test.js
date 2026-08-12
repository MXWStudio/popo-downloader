"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FAILURE,
  buildDownloadFilename,
  extractTeamSpaceId,
  extensionOf,
  findFirstHttpUrl,
  inferVirtualListItemCount,
  isSystemMetadataFile,
  looksLikeFileTitle,
  makeCsv,
  matchesFilters,
  previewTitleMatchesFile,
  sanitizePathSegment,
  selectVirtualListMatch,
  validateRuntimeMessage,
  verifyDirectoryItemCount
} = require("../core.js");

test("后台命令在分发前规范化字段并丢弃无关数据", () => {
  assert.deepEqual(validateRuntimeMessage({
    type: "START_FOLDER_SCAN",
    folderName: " 母文件 A ",
    folderItemIndex: 42,
    parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1#preview",
    ignored: "不会进入后台"
  }), {
    type: "START_FOLDER_SCAN",
    folderName: "母文件 A",
    folderItemIndex: "42",
    parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1#preview"
  });
  assert.deepEqual(validateRuntimeMessage({ type: "GET_STATE", ignored: { large: true } }), {
    type: "GET_STATE"
  });
  assert.deepEqual(validateRuntimeMessage({ type: "GET_UPDATE_STATUS", ignored: true }), {
    type: "GET_UPDATE_STATUS"
  });
  assert.deepEqual(validateRuntimeMessage({ type: "SNOOZE_NETWORK_REMINDER" }), {
    type: "SNOOZE_NETWORK_REMINDER"
  });
  assert.deepEqual(validateRuntimeMessage({ type: "MUTE_NETWORK_REMINDER_TODAY" }), {
    type: "MUTE_NETWORK_REMINDER_TODAY"
  });
  assert.deepEqual(validateRuntimeMessage({
    type: "SET_DOWNLOAD_CONCURRENCY",
    concurrency: 3
  }), {
    type: "SET_DOWNLOAD_CONCURRENCY",
    concurrency: 3
  });
  assert.deepEqual(validateRuntimeMessage({ type: "DISMISS_JOB", jobId: "job-a" }), {
    type: "DISMISS_JOB",
    jobId: "job-a"
  });
  assert.deepEqual(validateRuntimeMessage({
    type: "PAUSE_DOWNLOAD_BATCH",
    batchId: " batch-a ",
    ignored: true
  }), {
    type: "PAUSE_DOWNLOAD_BATCH",
    batchId: "batch-a"
  });
  assert.deepEqual(validateRuntimeMessage({
    type: "START_PAGE_DOWNLOAD",
    pageName: " 当前素材页 ",
    parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1#preview",
    ignored: true
  }), {
    type: "START_PAGE_DOWNLOAD",
    pageName: "当前素材页",
    parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1#preview"
  });
});

test("逐目录数量核对区分已验证、数量不一致和无法独立推导", () => {
  assert.deepEqual(verifyDirectoryItemCount(383, 383), {
    verified: true,
    matches: true,
    expected: 383,
    actual: 383
  });
  assert.deepEqual(verifyDirectoryItemCount(383, 380), {
    verified: true,
    matches: false,
    expected: 383,
    actual: 380
  });
  assert.deepEqual(verifyDirectoryItemCount(null, 12), {
    verified: false,
    matches: true,
    expected: null,
    actual: 12
  });
  assert.throws(() => verifyDirectoryItemCount(3, -1), /实际项目数无效/);
});

test("后台命令拒绝越界字段、未知设置和非 POPO 页面", () => {
  assert.throws(() => validateRuntimeMessage(null), /message/);
  assert.throws(() => validateRuntimeMessage({ type: "CANCEL_JOB", jobId: "" }), /jobId/);
  assert.throws(
    () => validateRuntimeMessage({ type: "REMOVE_DOWNLOAD_BATCH", batchId: "" }),
    /batchId/
  );
  assert.throws(() => validateRuntimeMessage({
    type: "RESTORE_CANCELLED_JOB",
    jobId: "job-a",
    sourceTabId: "7"
  }), /sourceTabId/);
  assert.throws(() => validateRuntimeMessage({
    type: "START_FOLDER_SCAN",
    folderName: "母文件 A",
    folderItemIndex: Number.NaN,
    parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1"
  }), /folderItemIndex/);
  assert.throws(() => validateRuntimeMessage({
    type: "START_FOLDER_SCAN",
    folderName: "母文件 A",
    folderItemIndex: "1",
    parentUrl: "https://example.com/team/pc/team1/pageDetail/root1"
  }), /parentUrl/);
  assert.throws(() => validateRuntimeMessage({
    type: "START_PAGE_DOWNLOAD",
    pageName: "",
    parentUrl: "https://docs.popo.netease.com/team/pc/team1/pageDetail/root1"
  }), /pageName/);
  assert.throws(() => validateRuntimeMessage({
    type: "SAVE_SETTINGS",
    settings: { unexpected: true }
  }), /settings/);
  assert.throws(() => validateRuntimeMessage({
    type: "SAVE_GOPEED_SETTINGS",
    gopeedToken: "x".repeat(4097)
  }), /gopeedToken/);
  assert.throws(() => validateRuntimeMessage({
    type: "SET_DOWNLOAD_CONCURRENCY",
    concurrency: 6
  }), /concurrency/);
});

test("旧版设置命令只保留已知且范围有效的配置", () => {
  assert.deepEqual(validateRuntimeMessage({
    type: "SAVE_SETTINGS",
    settings: {
      recursive: true,
      concurrency: 5,
      gopeedConnections: 1,
      downloadRoot: " POPO稳定下载 ",
      timeouts: { directoryLoad: 45000, transfer: 1800000 }
    }
  }), {
    type: "SAVE_SETTINGS",
    settings: {
      downloadRoot: "POPO稳定下载",
      recursive: true,
      concurrency: 5,
      gopeedConnections: 1,
      timeouts: { directoryLoad: 45000, transfer: 1800000 }
    }
  });
});

test("虚拟列表不滚动也能根据底部占位准确还原项目总数", () => {
  assert.equal(inferVirtualListItemCount({
    indices: Array.from({ length: 12 }, (_, index) => String(index)),
    knownSizes: Array(12).fill("48"),
    paddingBottom: "1056px"
  }), 34);
  assert.equal(inferVirtualListItemCount({
    indices: ["0", "1", "2", "3", "4", "5", "6"],
    knownSizes: Array(7).fill("48"),
    paddingBottom: "0px"
  }), 7);
  assert.equal(inferVirtualListItemCount({ explicitEmpty: true }), 0);
  assert.equal(inferVirtualListItemCount({ indices: [], knownSizes: [] }), null);
});

test("文件格式和关键词筛选可组合", () => {
  const settings = {
    formats: ".mp4, mov",
    includeKeywords: "夏日, 叶修",
    excludeKeywords: "低清, 预览"
  };
  assert.equal(matchesFilters("夏日派对-正式版.mp4", settings), true);
  assert.equal(matchesFilters("夏日派对-低清.mp4", settings), false);
  assert.equal(matchesFilters("夏日派对.png", settings), false);
  assert.equal(matchesFilters("无关内容.mp4", settings), false);
});

test("没有筛选条件时各种格式和无扩展名文件都可下载", () => {
  const settings = { formats: "", includeKeywords: "", excludeKeywords: "" };
  for (const filename of [
    "视频.mp4",
    "设计源文件.psd",
    "压缩包.7z",
    "表格.xlsx",
    "说明文档.pdf",
    "无扩展名文件"
  ]) {
    assert.equal(matchesFilters(filename, settings), true, filename);
  }
});

test("扩展名读取忽略大小写", () => {
  assert.equal(extensionOf("视频.MP4"), "mp4");
  assert.equal(extensionOf("无扩展名"), "");
});

test("扫描时识别并忽略常见系统元数据文件", () => {
  assert.equal(isSystemMetadataFile("Thumbs.db"), true);
  assert.equal(isSystemMetadataFile("DESKTOP.INI"), true);
  assert.equal(isSystemMetadataFile(".DS_Store"), true);
  assert.equal(isSystemMetadataFile("宝箱图标.png"), false);
});

test("虚拟列表行标识变化时使用唯一文件名回退定位", () => {
  const entries = [
    { row: "six", item: { name: "6.三排赶路+打架5.mp4", type: "file", itemIndex: "5" } }
  ];
  assert.deepEqual(selectVirtualListMatch(entries, "6.三排赶路+打架5.mp4", "file", "8"), {
    entry: entries[0],
    matchedBy: "name",
    ambiguous: false
  });
});

test("同名文件仍优先使用稳定行标识且不误点", () => {
  const entries = [
    { row: "first", item: { name: "同名.mp4", type: "file", itemIndex: "5" } },
    { row: "second", item: { name: "同名.mp4", type: "file", itemIndex: "6" } }
  ];
  assert.equal(selectVirtualListMatch(entries, "同名.mp4", "file", "6").entry.row, "second");
  assert.equal(selectVirtualListMatch(entries, "同名.mp4", "file", "9").entry, null);
  assert.equal(selectVirtualListMatch(entries, "同名.mp4", "file", "9").ambiguous, true);
});

test("预览标题匹配文件名并忽略父文件夹面包屑", () => {
  const filename = "（B级）特写1-叶修S0时装【全职高手 兴欣战队】.mp4";
  assert.equal(previewTitleMatchesFile(`${filename} - POPO 云空间`, filename), true);
  assert.equal(previewTitleMatchesFile("20260617-叶修S0全职高手预购展示", filename), false);
  assert.equal(looksLikeFileTitle("20260617-叶修S0全职高手预购展示"), false);
  assert.equal(looksLikeFileTitle(filename), true);
});

test("下载路径保留目录结构并清理 Windows 非法字符", () => {
  const filename = buildDownloadFilename({
    directoryPath: ["根目录", "角色:张起灵"],
    name: '预览<最终>?.mp4'
  }, {
    downloadRoot: "POPO:素材",
    preserveStructure: true
  });
  assert.equal(filename, "POPO_素材/根目录/角色_张起灵/预览_最终__.mp4");
});

test("关闭目录结构后只保留根目录和文件名", () => {
  const filename = buildDownloadFilename({
    directoryPath: ["A", "B"],
    name: "video.mp4"
  }, {
    downloadRoot: "POPO",
    preserveStructure: false
  });
  assert.equal(filename, "POPO/video.mp4");
});

test("从嵌套接口响应中提取优先下载地址", () => {
  assert.equal(findFirstHttpUrl({
    data: {
      metadata: { url: "https://example.com/file.mp4" }
    }
  }), "https://example.com/file.mp4");
  assert.equal(findFirstHttpUrl({ data: { value: "not-a-url" } }), "");
});

test("团队空间短码接口响应可提取真实 ID", () => {
  assert.equal(extractTeamSpaceId({ code: 0, data: "987654321" }), "987654321");
  assert.equal(extractTeamSpaceId({ data: { teamSpaceId: 12345 } }), "12345");
  assert.equal(extractTeamSpaceId({ code: 500, data: null }), "");
});

test("CSV 正确转义逗号、引号和换行", () => {
  const csv = makeCsv([{
    name: 'a,"b".mp4',
    directoryPath: ["目录"],
    status: "failed",
    failureStage: FAILURE.TRANSFER_INTERRUPTED,
    error: "第一行\n第二行",
    attempts: 3
  }]);
  assert.match(csv, /"a,""b""\.mp4"/);
  assert.match(csv, /"第一行\n第二行"/);
});

test("路径片段不会产生空名称", () => {
  assert.equal(sanitizePathSegment("..."), "未命名");
  assert.equal(sanitizePathSegment(" name. "), "name");
});
