import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import {
  defaultCyclotomyConfig,
  loadCyclotomyConfig,
  type CyclotomyConfig,
} from "../config.ts";
import {
  createDriftCommandHandler,
  createRestoreCommandHandler,
} from "./commands.ts";
import { createCyclotomyI18n } from "./i18n.ts";
import { registerCyclotomyLifecycle } from "./lifecycle.ts";
import { CyclotomyRuntime } from "./runtime.ts";

/** Assemble Cyclotomy's runtime, lifecycle hooks, and command boundary. */
export function registerCyclotomy(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  // Pi treats a throwing extension factory as a fatal load error and exits.
  // An unusable configuration must therefore disable Cyclotomy rather than
  // stop the host: register normally, then fail closed on the first bind.
  let config: CyclotomyConfig;
  let registrationFailure: unknown;
  try {
    config = loadCyclotomyConfig(agentDir);
  } catch (error) {
    config = defaultCyclotomyConfig(agentDir);
    registrationFailure = error;
  }
  const i18n = createCyclotomyI18n(config.locale);
  const runtime = new CyclotomyRuntime(config, i18n, registrationFailure);

  registerCyclotomyLifecycle(pi, runtime);
  pi.registerCommand("drift", {
    description: i18n.t("driftCommandDescription"),
    handler: createDriftCommandHandler(runtime),
  });
  pi.registerCommand("restore", {
    description: i18n.t("restoreCommandDescription"),
    handler: createRestoreCommandHandler(runtime),
  });
}
