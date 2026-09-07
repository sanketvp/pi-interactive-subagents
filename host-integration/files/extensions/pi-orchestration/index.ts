import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONTRACT_REVISION, isMbpCodingHost, launchGate } from './policy.js';

export default function (pi: ExtensionAPI) {
  if (!isMbpCodingHost()) return;
  const active = new Map<string, { name: string; started: number }>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let render: (() => void) | undefined;
  const stopTimer = () => { if (timer) clearInterval(timer); timer = undefined; };

  pi.on('before_agent_start', (event) => {
    // Explicit delivery on every turn, independent of cwd and Claude-only imports.
    let contract: string;
    try { contract = readFileSync(join(homedir(), '.pi/agent/AGENTS.md'), 'utf8'); }
    catch { contract = launchGate().reason + ' Global Pi contract could not be read; do not dispatch.'; }
    return { systemPrompt: event.systemPrompt.includes(contract)
      ? event.systemPrompt : `${event.systemPrompt}\n\n${contract}` };
  });

  pi.on('session_start', (_event, ctx) => {
    stopTimer(); active.clear();
    if (ctx.mode !== 'tui') return;
    ctx.ui.setToolsExpanded(true);
    render = () => {
      const rows = [...active.values()].map(({ name, started }) =>
        `${name}: running ${Math.floor((Date.now() - started) / 1000)}s`);
      ctx.ui.setWidget('orchestration-activity', rows.length ? rows : undefined);
    };
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
      ctx.ui.notify(`sid:${ctx.sessionManager.getSessionId()}\n${ctx.model?.provider}/${ctx.model?.id}\n${gate.reason}`, gate.ready ? 'info' : 'warning');
    },
  });
}
