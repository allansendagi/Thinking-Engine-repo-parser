import type { DesktopState } from "../lib/pairing";

/** Where the Mac app is downloaded. `/download/mac` always serves the current signed build. */
export const DOWNLOAD_URL = "https://www.threadnow.app/download/mac";
/** Opens (and, if installed but not running, launches) Thread for Mac and reopens its pairing window. */
export const PAIR_URL = "thread://pair";

export interface WelcomeView {
  step: "connected" | "connecting" | "open-app" | "download";
  title: string;
  body: string;
  primary?: { label: string; href: string };
  secondary?: { label: string; href: string };
}

/**
 * The ONE next step for someone who just installed the extension. Pure, so every branch is tested
 * without a browser. `paired` wins over everything; otherwise it's whatever the Mac app's
 * loopback says:
 *   open    -> pairing is happening right now (the page adopts the credentials itself)
 *   closed  -> the app is running; one click on `thread://pair` reopens the window
 *   absent  -> not installed / not running: download it (or open it, if it's already installed)
 */
export function welcomeView(paired: boolean, desktop: DesktopState): WelcomeView {
  if (paired) {
    return {
      step: "connected",
      title: "You're connected",
      body: "Thread is now capturing as you think in ChatGPT, Claude, Gemini and Perplexity. Open any of them and start a conversation — there's nothing else to set up.",
    };
  }
  if (desktop === "open") {
    return { step: "connecting", title: "Connecting…", body: "Pairing with Thread for Mac." };
  }
  if (desktop === "closed") {
    return {
      step: "open-app",
      title: "One click to connect",
      body: "Thread for Mac is running. Connect this browser to it.",
      primary: { label: "Connect to Thread", href: PAIR_URL },
    };
  }
  return {
    step: "download",
    title: "Get Thread for Mac",
    body: "The extension captures your conversations; the Mac app is where your ideas live. Install it and this page connects on its own.",
    primary: { label: "Download Thread for Mac", href: DOWNLOAD_URL },
    secondary: { label: "Already installed? Open it", href: PAIR_URL },
  };
}
