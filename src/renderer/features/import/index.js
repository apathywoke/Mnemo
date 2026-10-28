(() => {
  const ns = window.mnemoRenderer;
  const { $ } = ns.shared.dom;
  const { t, errorText, onChange } = ns.shared.i18n;
  const { conceal } = ns.shared.passwordVisibility;
  const { show: showToast } = ns.shared.toast;

  const INSTRUCTIONS = Object.freeze({
    bitwarden: "import.instructionsBitwarden",
    onepassword: "import.instructionsOnePassword",
    mnemo: "import.instructionsMnemo",
  });
  const SKIPPED_KEYS = Object.freeze({
    withTotp: "import.withTotp",
    nonLogin: "import.skippedNonLogin",
    noPassword: "import.skippedNoPassword",
    archived: "import.skippedArchived",
    totpNotImported: "import.skippedTotp",
    attachmentsNotImported: "import.skippedAttachments",
  });

  // Import in three steps: choose the source and file (parsed in main), review
  // the counts, then confirm. File contents never reach this renderer.
  function init(ctx) {
    const dialog = $("#import-dialog");
    const chooseStep = $("#import-choose-step");
    const reviewStep = $("#import-review-step");
    const doneStep = $("#import-done-step");
    const chooseButton = $("#import-choose");
    const error = $("#import-error");
    let source = null;
    let useRecoveryKey = false;
    let review = null;

    function selectedSource() {
      return chooseStep.querySelector("input[name='import-source']:checked")?.value ?? null;
    }

    function showStep(step) {
      chooseStep.hidden = step !== chooseStep;
      reviewStep.hidden = step !== reviewStep;
      doneStep.hidden = step !== doneStep;
    }

    function renderChoose() {
      source = selectedSource();
      chooseButton.disabled = source === null;
      $("#import-instructions").textContent = source ? t(INSTRUCTIONS[source]) : "";
      $("#import-mnemo-fields").hidden = source !== "mnemo";
      $("#import-passphrase-field").hidden = useRecoveryKey;
      $("#import-key-field").hidden = !useRecoveryKey;
      $("#import-mnemo-mode").textContent = t(
        useRecoveryKey ? "import.usePassphrase" : "import.useRecoveryKey",
      );
    }

    function renderReview() {
      if (!review) return;
      $("#import-file-name").textContent = review.fileName;
      $("#import-summary").textContent = t("import.found", { count: review.count });
      const skipped = $("#import-skipped");
      skipped.replaceChildren();
      for (const [key, messageKey] of Object.entries(SKIPPED_KEYS)) {
        const count = review.stats?.[key] ?? 0;
        if (count === 0) continue;
        const item = document.createElement("li");
        item.textContent = t(messageKey, { count });
        skipped.append(item);
      }
      const commit = $("#import-commit");
      commit.disabled = review.count === 0;
      commit.textContent = t("import.commit", { count: review.count });
    }

    function clearSecrets() {
      $("#import-passphrase").value = "";
      $("#import-recovery-key").value = "";
      conceal(chooseStep);
    }

    function reset() {
      chooseStep.reset();
      clearSecrets();
      useRecoveryKey = false;
      review = null;
      error.hidden = true;
      $("#import-trash").hidden = true;
      $("#import-trash-note").hidden = true;
      showStep(chooseStep);
      renderChoose();
    }

    function open() {
      reset();
      dialog.showModal();
    }

    // Closing at any step drops what main has parsed.
    function close() {
      if (dialog.open) dialog.close();
    }

    chooseStep.addEventListener("change", renderChoose);
    $("#import-mnemo-mode").addEventListener("click", () => {
      useRecoveryKey = !useRecoveryKey;
      clearSecrets();
      renderChoose();
      $(useRecoveryKey ? "#import-recovery-key" : "#import-passphrase").focus();
    });

    chooseStep.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!source) return;
      error.hidden = true;
      chooseButton.disabled = true;
      try {
        let credentials;
        if (source === "mnemo") {
          credentials = useRecoveryKey
            ? { recoveryKey: $("#import-recovery-key").value }
            : $("#import-passphrase").value;
        }
        const result = await ctx.api.chooseImportFile(source, credentials);
        if (result.canceled) return;
        clearSecrets();
        review = result;
        renderReview();
        showStep(reviewStep);
      } catch (cause) {
        ctx.setError(error, errorText(cause, "errors.importFile"));
      } finally {
        chooseButton.disabled = selectedSource() === null;
      }
    });

    $("#import-back").addEventListener("click", () => {
      void ctx.api.cancelImport();
      review = null;
      showStep(chooseStep);
    });

    $("#import-commit").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const result = await ctx.api.commitImport();
        review = null;
        $("#import-result").textContent = [
          t("import.imported", { count: result.imported }),
          result.duplicates ? t("import.duplicates", { count: result.duplicates }) : "",
          result.invalid ? t("import.invalid", { count: result.invalid }) : "",
          result.totpSkipped ? t("import.totpSkipped", { count: result.totpSkipped }) : "",
        ].filter(Boolean).join(" ");
        $("#import-trash").hidden = !result.canTrashFile;
        $("#import-trash-note").hidden = !result.canTrashFile;
        showStep(doneStep);
        await ctx.pages.vault.refreshEntries(null, true);
      } catch (cause) {
        showToast(errorText(cause, "errors.importFile"), { type: "error" });
      } finally {
        button.disabled = false;
      }
    });

    $("#import-trash").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const result = await ctx.api.trashImportFile();
        if (result.trashed) {
          showToast(t("toast.importFileTrashed"));
          button.hidden = true;
        }
      } catch (cause) {
        showToast(errorText(cause, "errors.trashImportFile"), { type: "error" });
      } finally {
        button.disabled = false;
      }
    });

    $("#import-cancel").addEventListener("click", close);
    $("#close-import-dialog").addEventListener("click", close);
    $("#import-done").addEventListener("click", close);
    dialog.addEventListener("close", () => {
      void ctx.api.cancelImport().catch(() => {});
      clearSecrets();
      review = null;
    });
    onChange(() => {
      renderChoose();
      renderReview();
    });

    return {
      open,
      close,
      get isOpen() {
        return dialog.open;
      },
    };
  }

  ns.features.importer = { init };
})();
