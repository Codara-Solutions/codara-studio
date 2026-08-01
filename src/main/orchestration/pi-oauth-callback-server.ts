import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { codaraOAuthErrorHtml, codaraOAuthSuccessHtml } from "./pi-oauth-callback-page";

/**
 * Codara's own loopback listener for Pi's OpenAI (ChatGPT) OAuth callback.
 *
 * Pi renders its success page from a module-level import inside
 * `dist/auth/oauth/openai-codex.js` (`oauthSuccessHtml` from `oauth-page.js`),
 * an ESM binding no caller can substitute, and its login entry point takes no
 * page override. The one seam is the callback port itself: Pi's OpenAI flow
 * treats a failed bind as "no listener available" and falls through to its
 * `manual_code` prompt. So Codara binds the *same registered redirect URI*
 * first, serves a Codara-branded page, and hands Pi the redirect URL through
 * that prompt. Pi still owns PKCE, state validation and the token exchange.
 *
 * This trick is deliberately NOT used for Anthropic: that flow's callback
 * server rejects on a bind error instead of falling back, so taking its port
 * would break the sign-in outright.
 */

/** Fixed by the OAuth client registration Pi authorizes against. */
export const PI_OPENAI_CALLBACK_PORT = 1455;
export const PI_OPENAI_CALLBACK_PATH = "/auth/callback";
export const PI_OPENAI_REDIRECT_URI = `http://localhost:${PI_OPENAI_CALLBACK_PORT}${PI_OPENAI_CALLBACK_PATH}`;

/** Pi resolves its own callback host the same way; the two must agree. */
function callbackHost(): string {
  const configured = process.env.PI_OAUTH_CALLBACK_HOST?.trim();
  return configured && configured.length > 0 ? configured : "127.0.0.1";
}

export interface PiOAuthCallbackServer {
  /**
   * Record the `state` Pi generated, read off the authorize URL it reports.
   * Until this is known no callback can be trusted, so none is accepted.
   */
  expectState(state: string): void;
  /**
   * Resolve with the redirect URL to hand back to Pi, or null once the
   * listener is cancelled or closed without one.
   */
  waitForRedirect(): Promise<string | null>;
  /** Give up waiting (the user pasted a code instead, or the flow aborted). */
  cancel(): void;
  close(): void;
}

function respond(res: ServerResponse, status: number, html: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(html);
}

/**
 * Bind the callback port, or resolve null when it is unavailable — in which
 * case the caller simply lets Pi run its own listener and its own page.
 */
export async function startPiOAuthCallbackServer(): Promise<PiOAuthCallbackServer | null> {
  let expectedState: string | null = null;
  let settle!: (value: string | null) => void;
  const redirect = new Promise<string | null>((resolve) => {
    let settled = false;
    settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method !== "GET") {
        respond(res, 405, codaraOAuthErrorHtml("Unsupported request."));
        return;
      }
      const url = new URL(req.url ?? "", PI_OPENAI_REDIRECT_URI);
      if (url.pathname !== PI_OPENAI_CALLBACK_PATH) {
        respond(res, 404, codaraOAuthErrorHtml("That address is not part of the sign-in."));
        return;
      }
      const providerError = url.searchParams.get("error");
      if (providerError) {
        respond(res, 400, codaraOAuthErrorHtml("The provider reported an error. Return to Codara Studio and try again."));
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      // Same check Pi's own listener makes. Anything that arrives before the
      // authorize URL is known, or under another state, is not this sign-in and
      // must not settle the wait — the real callback may still be coming.
      if (!expectedState || !state || state !== expectedState || !code) {
        respond(res, 400, codaraOAuthErrorHtml("This sign-in link is not valid. Return to Codara Studio and try again."));
        return;
      }
      respond(res, 200, codaraOAuthSuccessHtml());
      // Rebuilt from the two parameters Pi reads, so nothing else the browser
      // appended travels back into the flow.
      const handback = new URL(PI_OPENAI_REDIRECT_URI);
      handback.searchParams.set("code", code);
      handback.searchParams.set("state", state);
      settle(handback.toString());
    } catch {
      respond(res, 500, codaraOAuthErrorHtml("Codara Studio could not read the sign-in response."));
    }
  });

  const listening = await new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (value: boolean): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
    server.once("error", () => {
      try {
        server.close();
      } catch {
        // Already unusable; nothing to release.
      }
      finish(false);
    });
    server.listen(PI_OPENAI_CALLBACK_PORT, callbackHost(), () => finish(true));
  });

  if (!listening) {
    settle(null);
    return null;
  }

  // A late socket error must not strand the wait, and a listener left open by a
  // crashed flow must never keep the app alive.
  server.on("error", () => settle(null));
  server.unref();

  return {
    expectState: (state: string) => {
      if (typeof state === "string" && state.length > 0) expectedState = state;
    },
    waitForRedirect: () => redirect,
    cancel: () => settle(null),
    close: () => {
      settle(null);
      try {
        // The browser holds the callback connection open with keep-alive, and
        // close() alone would wait for it — leaving the port bound and the next
        // sign-in unable to take it.
        server.closeAllConnections();
        server.close();
      } catch {
        // Closing twice is harmless.
      }
    },
  };
}
