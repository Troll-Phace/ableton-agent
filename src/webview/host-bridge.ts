/**
 * Host bridge — the webview's one documented channel for *closing* itself.
 *
 * The SDK modal webview returns control to the extension by posting a
 * `close_and_send` message to the platform message handler (per
 * `Ui.showModalDialog` / "Sending Data to the Extension" in the SDK docs):
 *
 *   { method: "close_and_send", params: [resultString] }
 *
 * posted to `window.webkit.messageHandlers.live.postMessage` on macOS
 * (WKWebView) or `window.chrome.webview.postMessage` on Windows (WebView2).
 * `params` MUST be an array containing exactly one string. The host's
 * `ui.showModalDialog(...)` promise resolves with that string and the modal
 * closes; `launch.ts`'s `.then(onClose)` then disposes the session.
 *
 * This is the ONLY thing this module does — it carries no Live-model access and
 * never touches the Anthropic API key (transport discipline, ARCHITECTURE §11).
 * In a browser/jsdom/test context neither global exists, so {@link closeModal}
 * no-ops safely.
 */

/** WKWebView (macOS) message-handler shape we post to. */
interface WebKitHost {
  readonly messageHandlers?: {
    readonly live?: { postMessage(message: unknown): void };
  };
}

/** WebView2 (Windows) message-handler shape we post to. */
interface WebView2Host {
  readonly webview?: { postMessage(message: unknown): void };
}

/** The two platform globals the host may inject into the page. */
interface HostWindow {
  readonly webkit?: WebKitHost;
  readonly chrome?: WebView2Host;
}

/**
 * Close the modal webview and return control to the extension host.
 *
 * Posts the documented `close_and_send` envelope to whichever platform handler
 * is present. The result string is intentionally empty — the extension's
 * `onClose` only needs the close signal (it disposes the session); it does not
 * parse the payload. No-ops if neither handler exists (browser/test), so the
 * call is always safe to make.
 */
export function closeModal(): void {
  if (typeof window === "undefined") {
    return;
  }
  const host = window as unknown as HostWindow;
  const envelope = { method: "close_and_send", params: [""] };

  const webkitLive = host.webkit?.messageHandlers?.live;
  if (webkitLive !== undefined) {
    webkitLive.postMessage(envelope);
    return;
  }

  const webview2 = host.chrome?.webview;
  if (webview2 !== undefined) {
    webview2.postMessage(envelope);
    return;
  }

  // Neither bridge present (browser / jsdom / unit test) — closing is a no-op.
  console.warn(
    "[host-bridge] no modal close handler present; closeModal() ignored."
  );
}
