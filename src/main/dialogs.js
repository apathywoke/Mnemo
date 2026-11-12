// Native dialogs that show vault data and close when the vault locks.

// Windows that show a secret close on their own, like the clipboard clears.
const REVEAL_DIALOG_MS = 30_000;

// What confirmRevision says about each finding.
const REVISION_TEXT = Object.freeze({
  older: { message: "dialog.revisionOlderMessage", detail: "dialog.revisionOlderDetail" },
  noRecord: { message: "dialog.revisionNoRecordMessage", detail: "dialog.revisionNoRecordDetail" },
  differentVault: { message: "dialog.revisionDifferentMessage", detail: "dialog.revisionDifferentDetail" },
  restoreOlder: { message: "dialog.restoreOlderMessage", detail: "dialog.restoreOlderDetail" },
});

function createDialogs(ctx) {
  const { state, tr } = ctx;
  const { dialog } = ctx.electron;

  async function showVaultDialog(options, { closeAfterMs = 0 } = {}) {
    const controller = new AbortController();
    state.openVaultDialogs.add(controller);
    const timer = closeAfterMs ? setTimeout(() => controller.abort(), closeAfterMs) : null;
    try {
      return await dialog.showMessageBox(state.mainWindow, { ...options, signal: controller.signal });
    } finally {
      if (timer) clearTimeout(timer);
      state.openVaultDialogs.delete(controller);
    }
  }

  // A native window with one secret value. It is drawn by macOS, so the value
  // never enters the renderer, and it closes after REVEAL_DIALOG_MS or on lock.
  // "Copy" puts the value on the clipboard for 30 seconds, as the copy
  // buttons do; resolves { copied }.
  async function showSecretDialog({ entryName, fieldLabel, value }) {
    const epoch = state.lockEpoch;
    const { response } = await showVaultDialog({
      type: "none",
      title: entryName,
      // The value is alone in `detail` so selecting it copies nothing extra;
      // the auto-close note goes under the heading instead.
      message: `${entryName} · ${fieldLabel}\n${tr("dialog.revealCloses", { seconds: REVEAL_DIALOG_MS / 1000 })}`,
      detail: value,
      buttons: [tr("dialog.done"), tr("dialog.copy")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }, { closeAfterMs: REVEAL_DIALOG_MS });
    // A window closed by locking reports Done; the epoch check also covers
    // a click that raced with the lock.
    if (response !== 1 || state.lockEpoch !== epoch) return { copied: false };
    await ctx.copyToClipboardTemporarily(value);
    return { copied: true };
  }

  // Before a vault is deleted: whether its local snapshots go with it. Asked
  // only when there are some; keeping them is the default.
  async function confirmDeletingSnapshots(profile) {
    if (!(await state.profileManager.hasSnapshots(profile.id))) return false;
    const { response } = await dialog.showMessageBox(state.mainWindow, {
      type: "warning",
      title: tr("dialog.deleteSnapshotsTitle"),
      message: tr("dialog.deleteSnapshotsMessage", { name: profile.name }),
      detail: tr("dialog.deleteSnapshotsDetail"),
      buttons: [tr("dialog.keepSnapshots"), tr("dialog.deleteSnapshotsConfirm")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return response === 1;
  }

  // After a change of passphrase (`kind` "passphrase") or recovery key
  // ("recovery"): snapshots taken before it still open with the old one.
  // Offers to delete them; keeping them is the default.
  async function offerDeletingOldSnapshots(store, kind) {
    const epoch = state.lockEpoch;
    const names = await store.snapshotsWithOtherKeys().catch(() => []);
    if (names.length === 0 || store !== state.vaultStore || state.lockEpoch !== epoch) return;
    const { response } = await showVaultDialog({
      type: "warning",
      title: tr("dialog.oldSnapshotsTitle"),
      message: tr(kind === "passphrase" ? "dialog.oldSnapshotsPassphraseMessage" : "dialog.oldSnapshotsRecoveryMessage",
        { count: names.length }),
      detail: tr("dialog.oldSnapshotsDetail"),
      buttons: [tr("dialog.keepSnapshots"), tr("dialog.deleteSnapshotsConfirm")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response !== 1 || store !== state.vaultStore || state.lockEpoch !== epoch) return;
    await store.deleteSnapshotsWithOtherKeys();
    // Their copies outside this Mac go too: that is where an old key matters
    // most (iCloud).
    if (store !== state.vaultStore || state.lockEpoch !== epoch) return;
    await state.outsideCopies?.deleteWithOtherKeys(store.filePath, (bytes) => store.isOtherKeyBytes(bytes));
  }

  // A vault, or a backup about to be restored, is not the newest revision
  // this Mac has seen of it (vault/store-revisions.js). `kind`: "older",
  // "noRecord", "differentVault", or "restoreOlder". Keeping it closed (or
  // not restoring) is the default; it closes with a lock, as a refusal.
  async function confirmRevision({ kind, savedAt, revision, recordRevision }) {
    const saved = savedAt === null
      ? tr("dialog.revisionSavedUnknown")
      : new Date(savedAt).toLocaleString(state.language, { dateStyle: "long", timeStyle: "short" });
    const params = { saved, revision, newest: recordRevision };
    const restoring = kind === "restoreOlder";
    const { response } = await showVaultDialog({
      type: "warning",
      title: tr(restoring ? "dialog.restoreOlderTitle" : "dialog.revisionTitle"),
      message: tr(REVISION_TEXT[kind].message, params),
      detail: tr(REVISION_TEXT[kind].detail, params),
      buttons: [
        tr(restoring ? "common.cancel" : "dialog.revisionClose"),
        tr(restoring ? "dialog.restoreOlderConfirm" : "dialog.revisionOpen"),
      ],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return response === 1;
  }

  return { showVaultDialog, showSecretDialog, confirmDeletingSnapshots, offerDeletingOldSnapshots, confirmRevision };
}

module.exports = { createDialogs };
