import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerCyclotomy } from "./pi/register.ts";

// Keep the extension module boundary intentionally small. Application,
// domain, Pi adapters, and infrastructure remain internal modules.
export default function cyclotomy(pi: ExtensionAPI): void {
  registerCyclotomy(pi);
}
