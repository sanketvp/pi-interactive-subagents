import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONTRACT_REVISION, isCoordinator, isMbpCodingHost, launchGate } from './policy.js';

// Coordinator enforcement (2026-09-07c, user directive): the session model is a
// COORDINATOR. It may do a few surgical edits per turn, but substantive
// implementation must be dispatched to `subagent` workers. This is mechanical
// (tool_call block), not prose — prose alone was ignored repeatedly.
export default function (pi: ExtensionAPI) {
  if (!isMbpCodingHost()) return;
  const coordinator = isCoordinator();
  const active = new Map<string, { name: string; started: number }>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let render: (() => void) | undefined;
  let writesThisTurn = 0;
  let dispatchesThisTurn = 0;
    const stopTimer = () => { if (timer) clearInterval(timer); timer = undefined; };

  pi.on('before_agent_start', (event) => {
    let contract: string;
    try { contract = readFileSync(join(homedir(), '.pi/agent/AGENTS.md'), 'utf8'); }
    catch { contract = launchGate().reason + ' Global Pi contract could not be read; do not dispatch.'; }
    return { systemPrompt: event.systemPrompt.includes(contract)
      ? event.systemPrompt : `${event.systemPrompt}\n\n${contract}` };
  });

  pi.on('agent_start', () => { writesThisTurn = 0; dispatchesThisTurn = 0; render?.(); });

  // Visibility only (user directive 2026-09-07): count dispatches and edits
  // for the widget. Tool calls are NEVER blocked or budgeted here; the only
  // budget in this harness is the per-session SUBAGENT invocation limit,
  // enforced (and user-adjustable) inside the subagent tool itself.
  pi.on('tool_call', (event) => {
    if (!coordinator) return;
    if (event.toolName === 'subagent') dispatchesThisTurn += 1;
    else if (event.toolName === 'write' || event.toolName === 'edit') writesThisTurn += 1;
    render?.();
  });

  pi.on('session_start', (_event, ctx) => {
    stopTimer(); active.clear();
    if (ctx.mode !== 'tui') return;
    ctx.ui.setToolsExpanded(true);
    render = () => {
      const rows = [...active.values()].map(({ name, started }) =>
        `${name}: running ${Math.floor((Date.now() - started) / 1000)}s`);
      if (coordinator) {
        rows.unshift(`swarm: ${dispatchesThisTurn} dispatched · ${writesThisTurn} direct edits this request`);
      }
      ctx.ui.setWidget('orchestration-activity', rows.length ? rows : undefined);
    };
    render();
    const gate = launchGate();
    ctx.ui.notify(`Orchestration contract ${CONTRACT_REVISION}: worker launch ${gate.ready ? 'READY (tmux host, subagent tool)' : 'BLOCKED — not under the Orca tmux host; start with plain `pi` in an Orca terminal'}.`, gate.ready ? 'info' : 'warning');
  });
  pi.on('tool_execution_start', (event, ctx) => {
    if (ctx.mode !== 'tui') return;
    active.set(event.toolCallId, { name: event.toolName, started: Date.now() });
    render?.();
    if (!timer) { timer = setInterval(() => render?.(), 1000); timer.unref?.(); }
  });
  pi.on('tool_execution_end', (event) => {
    active.delete(event.toolCallId); render?.();
    if (!active.size) stopTimer();
  });
  pi.on('session_shutdown', (_event, ctx) => {
    stopTimer(); active.clear(); render = undefined;
    if (ctx.mode === 'tui') ctx.ui.setWidget('orchestration-activity', undefined);
  });
  pi.registerCommand('orchestration-status', {
    description: 'Show exact session identity and current orchestration acceptance gate',
    handler: async (_args, ctx) => {
      const gate = launchGate();
      ctx.ui.notify(`sid:${ctx.sessionManager.getSessionId()}\n${ctx.model?.provider}/${ctx.model?.id}\nrole: ${coordinator ? 'coordinator' : 'worker'}\n${gate.reason}`, gate.ready ? 'info' : 'warning');
    },
  });
}
