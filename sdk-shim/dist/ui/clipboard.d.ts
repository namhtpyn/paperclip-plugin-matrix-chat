/**
 * Copy text through the host's HTTP-safe clipboard implementation.
 *
 * Plugin UI code must use this helper instead of calling the browser Clipboard
 * API directly so copy actions also work in Paperclip's plain-HTTP deployments.
 */
export declare function copyTextToClipboard(text: string): Promise<void>;
//# sourceMappingURL=clipboard.d.ts.map