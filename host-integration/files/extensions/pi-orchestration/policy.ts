import { hostname } from 'node:os';

export const CONTRACT_REVISION = '2026-09-12a';

// Accepted 2026-09-07 (live trial, sid 01a07d3f-2a3a-711e-9cd2-0b22c4b2d4ed and
// 01a07d44-2364-7214-a244-b78cd3d4ad8b): the pi-interactive-subagents `subagent`
// tool tiles workers as tmux panes inside the SAME Orca tab without changing the
// active pane. It requires this Pi to be running under the private tmux host
// that the `pi` wrapper in ~/.zshrc starts for Orca terminals.
export const LAUNCH_READY =
  'Worker launch READY: use the `subagent` tool (agent profiles: bulk, implementer, implementer-gpt, implementer-k3, implementer-glm, planner, pr-reviewer, researcher, reviewer, scout, verifier, verifier-run, worker). Workers tile as tmux panes in this tab; results are steered back ' +
  'automatically. Never use standalone agent CLIs, new Orca tabs, or hidden print-mode workers.';

export const LAUNCH_BLOCKER =
  'Worker launch blocked: this Pi is not running under the Orca tmux host, so the `subagent` tool ' +
  'has no multiplexer to tile into. Remedy: start Pi from an Orca terminal with plain `pi` ' +
  '(the ~/.zshrc wrapper provides tmux). Do not fall back to standalone agent CLIs, ' +
  'new tabs, or hidden print-mode workers. Existing sessions are unchanged.';

export function isMbpCodingHost(platform = process.platform, host = hostname()): boolean {
  return platform === 'darwin' && /macbook|mbp/i.test(host);
}

export function launchGate(env: NodeJS.ProcessEnv = process.env) {
  const ready = Boolean(env.TMUX);
  return { revision: CONTRACT_REVISION, ready, reason: ready ? LAUNCH_READY : LAUNCH_BLOCKER } as const;
}

// Coordinator = an interactive Pi that is NOT itself a subagent worker.
// Workers carry PI_SUBAGENT_ID from the launcher and are exempt from the budget.
export function isCoordinator(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.PI_SUBAGENT_ID;
}

