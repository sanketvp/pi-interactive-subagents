// @orca-managed-pi-extension
//
// pi-dispatch-mandate-guard.ts — blocks dispatching subagents via the
// standalone `claude`/`codex` CLI binaries, and blocks opening them as
// separate `orca terminal create` tabs, before either happens.
//
// WHY THIS EXISTS (2026-09-06): the 2026-09-04 unified-dispatch directive
// (CLAUDE.md §Pi Harness item 0, "use pi-dispatch.sh, not standalone CLIs")
// and the 2026-09-06 tiling pattern (SWARM_ORCHESTRATION.md item 6, "split
// into the current tab, don't open separate tabs") were BOTH documented in
// prose only. A brand-new session, told to "use multi-agent swarm," ignored
// both: it spawned 4 subagents as literal `claude`/`codex` CLI processes,
// each in its own new tab. Prose-only rules are not enough — the same lesson
// as unbounded-scan-guard.ts (a `find /` block that was also prose-only
// until it became a mechanical `tool_call` guard). This is the same fix
// applied to a different, arguably more important violation.
//
// SCOPE:
// 1. Blocks `codex exec ...` and `claude -p .../--print ...` — these are the
//    actual non-interactive subagent-dispatch invocation shapes. Does NOT
//    block diagnostic/auth commands (`codex login`, `codex --version`,
//    `claude --version`, `claude mcp ...`, `command -v codex/claude`) --
//    those aren't dispatching a subagent.
// 2. Blocks `orca terminal create ... --command "..."` when the --command
//    argument itself invokes `claude` or `codex` as a bare command (the
//    "opened it in a new tab running the standalone CLI" pattern this was
//    written for). Does NOT block `orca terminal create` for other purposes
//    (its --command can be anything else, e.g. `pi`, `bash`, a build watch).
// BYPASS: include the literal text `--allow-standalone-cli` anywhere in the
// bash command (same convention as unbounded-scan-guard.ts).

const CODEX_EXEC_RE = /(^|[;&|\s])codex\s+exec\b/
const CLAUDE_DISPATCH_RE = /(^|[;&|\s])claude\s+(-p\b|--print\b)/
const ORCA_CREATE_WITH_CLI_RE = /orca\s+terminal\s+create\b[^;&|]*--command\s+["']?[^"'\n]*\b(claude|codex)\b/

const REASON =
  'Launch workers with the `subagent` tool (profiles in ~/.pi/agent/agents/). Do not call `claude`/`codex` CLIs, `pi-dispatch.sh`, or `orca terminal create/split` directly for workers. Bypass with --allow-standalone-cli only for a deliberate, disclosed exception.'

export default function (pi) {
  pi.on('tool_call', (event, _ctx) => {
    if (event.toolName !== 'bash') return
    const cmd = event.input?.command
    if (typeof cmd !== 'string' || !cmd) return
    if (cmd.includes('--allow-standalone-cli')) return

    if (CODEX_EXEC_RE.test(cmd) || CLAUDE_DISPATCH_RE.test(cmd) || ORCA_CREATE_WITH_CLI_RE.test(cmd)) {
      return { block: true, reason: REASON }
    }
  })
}
