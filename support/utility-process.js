// A stand-in for Electron's utilityProcess in tests. fork() runs the entry
// module in this process with a fake process.parentPort; messages in both
// directions go through structuredClone, as Electron's do.
const { EventEmitter } = require("node:events");

// Runs `modulePath` as a decoder entry for one message and returns its reply.
function runEntry(modulePath, message) {
  const parentPort = new EventEmitter();
  let reply;
  parentPort.postMessage = (value) => { reply = structuredClone(value); };
  const previous = Object.getOwnPropertyDescriptor(process, "parentPort");
  Object.defineProperty(process, "parentPort", { value: parentPort, configurable: true, writable: true });
  try {
    delete require.cache[require.resolve(modulePath)];
    require(modulePath);
    parentPort.emit("message", { data: message });
  } finally {
    if (previous) Object.defineProperty(process, "parentPort", previous);
    else delete process.parentPort;
  }
  return reply;
}

// `behavior` (optional) replaces running the entry: it receives the child and
// the cloned message and may emit "message", "error", or "exit" itself.
function createUtilityProcessStub({ behavior = null } = {}) {
  const forks = [];
  return {
    forks,
    fork(modulePath, args, options) {
      const child = new EventEmitter();
      const record = { modulePath, args, options, child, messages: [], killed: false };
      forks.push(record);
      child.pid = 4000 + forks.length;
      child.kill = () => {
        record.killed = true;
        return true;
      };
      child.postMessage = (message) => {
        const cloned = structuredClone(message);
        record.messages.push(cloned);
        setImmediate(() => {
          if (record.killed) return;
          if (behavior) {
            behavior(child, cloned);
            return;
          }
          const reply = runEntry(modulePath, cloned);
          if (!record.killed) child.emit("message", reply);
        });
      };
      return child;
    },
  };
}

module.exports = { createUtilityProcessStub, runEntry };
