// VaultStore with all of its methods. Each store-*.js file is a class whose
// methods (and static methods) are copied onto VaultStore with their
// descriptors, so they are non-enumerable exactly like methods declared in
// store.js. The store-*.js files never require each other.
const assert = require("node:assert");
const VaultStore = require("./store");

const METHOD_GROUPS = [
  require("./store-keys"),
  require("./store-backup"),
];

for (const group of METHOD_GROUPS) {
  for (const [target, source, skip] of [
    [VaultStore.prototype, group.prototype, ["constructor"]],
    [VaultStore, group, ["length", "name", "prototype"]],
  ]) {
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(source))) {
      if (skip.includes(name)) continue;
      assert.ok(!Object.hasOwn(target, name), `VaultStore already has ${name}`);
      Object.defineProperty(target, name, descriptor);
    }
  }
}

module.exports = VaultStore;
