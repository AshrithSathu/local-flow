const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
test("personal credentials use Electron OS encryption without upstream keyring", () => {
  const original = Module._load;
  const file = require.resolve("../../src/helpers/secretCrypto");
  Module._load = function (name, ...args) {
    if (name === "electron")
      return {
        app: { getName: () => "Local Flow" },
        safeStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (text) => Buffer.from("os:" + text),
          decryptString: (blob) => blob.toString().slice(3),
        },
      };
    if (name === "@napi-rs/keyring") assert.fail("upstream credential service must not be used");
    return original.call(this, name, ...args);
  };
  try {
    delete require.cache[file];
    const first = require(file);
    const encrypted = first.encrypt("test-key");
    delete require.cache[file];
    assert.equal(require(file).decrypt(encrypted).value, "test-key");
  } finally {
    Module._load = original;
    delete require.cache[file];
  }
});
