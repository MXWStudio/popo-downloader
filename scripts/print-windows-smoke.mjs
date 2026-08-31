const downloadLogicChanged = process.argv.includes("--download-logic");

console.log("POPO DEV BROWSER SMOKE");
console.log("[ ] 1. 扩展重新加载正常");
console.log("[ ] 2. POPO 页面识别正常");
console.log("[ ] 3. 单文件下载正常");
console.log("[ ] 4. 文件夹/批量下载正常");

if (downloadLogicChanged) {
  console.log("");
  console.log("DOWNLOAD LOGIC EXTRA");
  console.log("[ ] 暂停正常");
  console.log("[ ] 继续正常");
  console.log("[ ] 失败重试正常");
}
