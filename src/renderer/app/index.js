// Entry point of the page (the only <script type="module"> in index.html).
// Importing it loads every slice; this module creates the context and wires
// them together.
import * as recoveryKeyFeature from "../features/recovery-key/index.js";
import * as importerFeature from "../features/import/index.js";
import * as settingsFeature from "../features/settings/index.js";
import * as touchIdFeature from "../features/touch-id/index.js";
import * as updatesFeature from "../features/updates/index.js";
import * as accessPage from "../pages/access/index.js";
import * as vaultPage from "../pages/vault/index.js";
import { $ } from "../shared/lib/dom.js";
import { t } from "../shared/lib/i18n.js";
import * as passphraseStrength from "../shared/ui/passphrase-strength.js";
import * as passwordVisibility from "../shared/ui/password-visibility.js";
import { createContext } from "./model/context.js";
import { bindNavigation } from "./navigation.js";

const ctx = createContext();

await settingsFeature.loadSettings(ctx);
ctx.recoveryKey = recoveryKeyFeature.init(ctx);
ctx.importer = importerFeature.init(ctx);
ctx.touchId = touchIdFeature.init(ctx);
ctx.updates = updatesFeature.init(ctx);
settingsFeature.bind(ctx);

// Page composition follows FSD direction: pages compose widgets and features;
// the app layer wires pages together and owns application-wide navigation.
ctx.pages.vault = vaultPage.create(ctx);
ctx.pages.access = accessPage.create(ctx);
passwordVisibility.bindAll();
passphraseStrength.bindAll();
bindNavigation(ctx);

ctx.api.getVersion()
  .then((version) => { $("#app-version").textContent = version; })
  .catch(() => { $("#app-version").textContent = t("common.unavailable"); });

void ctx.pages.access.refreshProfiles();
