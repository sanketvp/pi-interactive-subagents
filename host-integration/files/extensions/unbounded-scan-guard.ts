// @orca-managed-pi-extension
//
// unbounded-scan-guard.ts — blocks `find /` (searching the ENTIRE filesystem
// from root) before it executes, via Pi's native `tool_call` event (which
// supports `{block: true}`, per @earendil-works/pi-coding-agent's
// ToolCallEventResult contract).
//
// WHY THIS EXISTS AS A PI EXTENSION, NOT A ~/.claude/hooks/*.sh SCRIPT
// (found 2026-09-06): Claude Code's `~/.claude/settings.json` PreToolUse
// hooks (merge-review-guard.sh, blast-radius-gate.sh, etc.) are a Claude
// Code-only mechanism — Pi has NO support for them at all (confirmed: no
// "hooks" key anywhere in ~/.pi/agent/settings.json, no extension bridges
// settings.json hooks into Pi's tool execution). A `~/.claude/hooks/*.sh`
// script registered in settings.json is silently NEVER INVOKED when a Bash
// tool call happens inside a `pi` session — proven by writing exactly such a
// script (unbounded-scan-guard.sh) for this same problem, wiring it into
// settings.json's PreToolUse Bash matcher, and then testing `find /` inside
// this very Pi session: it ran uninterrupted. This is a real gap that
// concerns every OTHER PreToolUse gate in this config (merge-review-guard,
// blast-radius-gate, simplify-commit-guard) — they may be silently
// non-enforcing for any work done under Pi, which is now the primary coding
// harness. That is a separate, larger finding to investigate; this file
// fixes the immediate, concrete, twice-repeated problem it was written for.
//
// EVIDENCE: 2026-09-06, a broad `find /` hung for 26+ minutes in an unrelated
// ModusGoAPI session, looking indistinguishable from a genuinely stuck
// session — the second such incident in the same day (the first was the
// orchestrating session itself, caught and corrected immediately).
//
// SCOPE: blocks the `bash` tool when its command contains `find` with a
// standalone `/` (optionally quoted) as the search-root argument. Does NOT
// touch Pi's native `find` tool (glob-pattern search, already scoped
// differently and far less dangerous by design — respects .gitignore, has a
// result limit).
// BYPASS: include the literal text `--allow-root-find` anywhere in the bash
// command (as a trailing shell comment, same convention as the other gates
// in this repo, e.g. blast-radius-gate.sh's `# --no-blast-check`).

const ROOT_FIND_RE = /(^|[;&|\s])find\s+["']?\/["']?(\s|$)/

export default function (pi) {
  pi.on('tool_call', (event, _ctx) => {
    if (event.toolName !== 'bash') return
    const cmd = event.input?.command
    if (typeof cmd !== 'string' || !cmd) return
    if (cmd.includes('--allow-root-find')) return
    if (!ROOT_FIND_RE.test(cmd)) return
    return {
      block: true,
      reason:
        '`find /` searches the ENTIRE filesystem from root. This has repeatedly hung for ' +
        'tens of minutes scanning irrelevant system/vendor trees (evidence: 2026-09-06, two ' +
        'independent incidents in one day) and looks indistinguishable from a genuinely ' +
        'stuck/frozen session. Scope the search instead, e.g. `find ~/GIT -maxdepth 6 -path ' +
        '"*<pattern>*"` or `find ~/DEV_vault -iname "*<name>*"`. If a genuine full-filesystem ' +
        'search is required, include the literal text --allow-root-find anywhere in the command.',
    }
  })
}
