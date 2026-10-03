import { getSdkUiRuntimeValue } from "./runtime.js";
/**
 * Copy text through the host's HTTP-safe clipboard implementation.
 *
 * Plugin UI code must use this helper instead of calling the browser Clipboard
 * API directly so copy actions also work in Paperclip's plain-HTTP deployments.
 */
export function copyTextToClipboard(text) {
    const copy = getSdkUiRuntimeValue("copyTextToClipboard");
    return copy(text);
}
//# sourceMappingURL=clipboard.js.map