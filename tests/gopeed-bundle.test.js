"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const vendorRoot = path.join(__dirname, "..", "vendor", "gopeed", "v1.9.3");
const expectedHash = "02b3b2f0ce4b0e0008edc835802ad6f4b241eb863f312b0bdd77b2b2afc9e012";

test("bundled Gopeed is the verified official v1.9.3 portable release", () => {
  const archive = fs.readFileSync(
    path.join(vendorRoot, "Gopeed-v1.9.3-windows-amd64-portable.zip")
  );
  assert.equal(crypto.createHash("sha256").update(archive).digest("hex"), expectedHash);
  assert.ok(fs.statSync(path.join(vendorRoot, "portable", "gopeed.exe")).size > 0);

  const metadata = JSON.parse(fs.readFileSync(path.join(vendorRoot, "metadata.json"), "utf8"));
  assert.equal(metadata.version, "v1.9.3");
  assert.equal(metadata.license, "GPL-3.0");
  assert.equal(metadata.binarySha256, expectedHash);

  const license = fs.readFileSync(path.join(vendorRoot, "LICENSE"), "utf8");
  assert.match(license, /GNU GENERAL PUBLIC LICENSE/);
  assert.ok(fs.statSync(path.join(vendorRoot, "Gopeed-v1.9.3-source.zip")).size > 0);
});
