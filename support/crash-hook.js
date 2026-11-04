// Loaded with `node --require` by the durability tests: kills the process
// (SIGKILL, as a power cut or a force quit would) right before its N-th
// file system change, N from MNEMO_CRASH_AT. Changes counted: opening a file
// for writing, writing or flushing through a file handle, renaming,
// removing, copying, and creating folders. With MNEMO_CRASH_COUNT_FILE set,
// the number of changes made is written there at a normal exit, so the
// test knows how many steps an operation has.
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const crashAt = Number(process.env.MNEMO_CRASH_AT ?? 0);
const countFile = process.env.MNEMO_CRASH_COUNT_FILE ?? "";
let count = 0;

function step() {
  count += 1;
  if (crashAt > 0 && count === crashAt) process.kill(process.pid, "SIGKILL");
}

const isWriteFlag = (flags) => typeof flags === "string" && /[wax+]/.test(flags);

function wrapHandle(handle) {
  for (const name of ["writeFile", "write", "sync", "datasync", "truncate"]) {
    const original = handle[name].bind(handle);
    handle[name] = (...args) => {
      step();
      return original(...args);
    };
  }
  return handle;
}

const originalOpen = fsp.open;
fsp.open = async (filePath, flags = "r", mode) => {
  if (isWriteFlag(flags)) step();
  const handle = await originalOpen(filePath, flags, mode);
  return isWriteFlag(flags) ? wrapHandle(handle) : handle;
};

for (const name of ["rename", "unlink", "rm", "rmdir", "copyFile", "mkdir", "writeFile", "appendFile", "chmod"]) {
  const original = fsp[name];
  fsp[name] = (...args) => {
    step();
    return original(...args);
  };
}

process.on("exit", () => {
  if (countFile) fs.writeFileSync(countFile, String(count));
});
