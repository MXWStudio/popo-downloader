"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FAILURE,
  buildDownloadFilename,
  extensionOf,
  findFirstHttpUrl,
  isSystemMetadataFile,
  looksLikeFileTitle,
  makeCsv,
  matchesFilters,
  previewTitleMatchesFile,
  sanitizePathSegment,
  selectVirtualListMatch
} = require("../core.js");

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
