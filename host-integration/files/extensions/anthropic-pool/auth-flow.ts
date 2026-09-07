import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  AUTHORIZE_URL,
  CALLBACK_HOST,
  CALLBACK_PATH,
  CALLBACK_PORT,
  CLIENT_ID,
  REDIRECT_URI,
  SCOPES,
  TOKEN_URL,
} from "./constants.js";

export interface PKCEPair {
  verifier: string;
  challenge: string;
}

export async function generatePKCE(): Promise<PKCEPair> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const verifier = Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = Buffer.from(new Uint8Array(digest))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  return { verifier, challenge };
}

function makeCallbackHtml(title: string, message: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f1117; color: #e1e4ea; }
      .card { background: #1a1d26; padding: 2.5rem; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.5); text-align: center; max-width: 420px; border: 1px solid #2d313e; }
      h1 { font-size: 1.5rem; margin-bottom: 0.8rem; color: #70a5fd; }
      p { line-height: 1.5; color: #9da5b4; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${title}</h1>
      <p>${message}</p>
    </div>
  </body>
</html>`;
}

export function buildAuthorizeUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export function parseCallbackInput(input: string): { code?: string; state?: string } {
  const text = input.trim();
  if (!text) return {};

  try {
    const url = new URL(text);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {}

  if (text.includes("#")) {
    const [code, state] = text.split("#", 2);
    return { code, state };
  }

  if (text.includes("code=")) {
    const params = new URLSearchParams(text);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: text };
}

export interface CallbackServerSession {
  server: Server;
  waitForCode: () => Promise<{ code: string; state: string } | null>;
  cancel: () => void;
}

export async function startOAuthCallbackServer(expectedState: string): Promise<CallbackServerSession> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let finish: ((val: { code: string; state: string } | null) => void) | null = null;
    const waitPromise = new Promise<{ code: string; state: string } | null>((res) => {
      finish = res;
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
          res.end(makeCallbackHtml("Not Found", "Callback route not found."));
          return;
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(makeCallbackHtml("Authorization Error", `Anthropic returned error: ${error}`));
          if (!resolved) {
            resolved = true;
            finish?.(null);
          }
          return;
        }

        if (!code || !state || state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(makeCallbackHtml("Authorization Failed", "Missing or invalid OAuth state."));
          if (!resolved) {
            resolved = true;
            finish?.(null);
          }
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(makeCallbackHtml("Authorization Successful!", "Account logged in. You can close this window and return to Pi."));

        if (!resolved) {
          resolved = true;
          finish?.({ code, state });
        }
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal Error");
      }
    });

    server.once("error", reject);

    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      resolve({
        server,
        waitForCode: () => waitPromise,
        cancel: () => {
          if (!resolved) {
            resolved = true;
            finish?.(null);
          }
          try {
            server.closeAllConnections();
            server.close();
          } catch {}
        },
      });
    });
  });
}

export async function exchangeCodeForTokens(
  code: string,
  state: string,
  verifier: string,
): Promise<{ access: string; refresh: string; expires: number }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed HTTP ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}
