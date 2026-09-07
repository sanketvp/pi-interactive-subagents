export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const CALLBACK_PORT = 53692;
export const CALLBACK_HOST = "127.0.0.1";
export const CALLBACK_PATH = "/callback";
export const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
export const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
// Keep this aligned with the installed Claude Code client. Anthropic rejects
// Fable requests when the billing identity advertises a client older than the
// model's minimum supported version.
export const USER_AGENT = "claude-code/2.1.263";

// Claude Code request shaping constants
export const CLAUDE_CODE_VERSION = "2.1.263";
export const BILLING_HEADER_SALT = "59cf53e54c78";
export const BILLING_HEADER_POSITIONS = [4, 7, 20] as const;
export const CLAUDE_CODE_ENTRYPOINT = "sdk-cli";

// Prompt de-fingerprinting
export const PI_DEFAULT_PROMPT_PREFIX =
  "You are an expert coding assistant operating inside pi, a coding agent harness.";

export const PI_DEFAULT_PROMPT_TERMINATOR =
  "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";

export const MINIMAL_ANTHROPIC_OAUTH_PROMPT_PREFIX =
  "You are an expert coding assistant.";

export const MINIMAL_ANTHROPIC_OAUTH_PROMPT = [
  MINIMAL_ANTHROPIC_OAUTH_PROMPT_PREFIX,
  "Be concise and helpful.",
  "Use the available tools to answer the user's request.",
  "Show file paths clearly when working with files.",
].join("\n");

export const PARAGRAPH_REMOVAL_ANCHORS: readonly string[] = [
  "operating inside pi, a coding agent harness",
  "In addition to the tools above",
  "Pi documentation (read only when the user asks about pi itself",
];

export const TEXT_REPLACEMENTS: readonly {
  match: string;
  replacement: string;
}[] = [
  {
    match:
      "Here is some useful information about the environment you are running in:",
    replacement: "Environment context you are running in:",
  },
];

// Cooldown default: 3 hours for Claude Pro rolling window
export const DEFAULT_COOLDOWN_MS = 3 * 60 * 60 * 1000;
