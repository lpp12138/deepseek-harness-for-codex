import { DesktopAttachManager } from "./desktop-manager.js";
import { RunManager } from "./run-manager.js";
import { resolveMode } from "./runtime.js";

/** Selection is explicit; attachment failure never constructs a managed runtime. */
export function createRunManager(): RunManager | DesktopAttachManager {
  return resolveMode() === "desktop-attach" ? new DesktopAttachManager() : new RunManager();
}
