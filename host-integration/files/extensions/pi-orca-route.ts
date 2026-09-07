import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { launchGate } from './pi-orchestration/policy.js';

// Quarantine the obsolete adapter: it launches standalone CLIs in separate tabs
// from extension code, outside Bash tool_call guards. Never import it here.
export default function (pi: ExtensionAPI) {
  pi.registerCommand('pi-route', {
    description: 'Report the orchestration launch gate (creates no resources)',
    handler: async (_args, ctx) => {
      const gate = launchGate();
      ctx.ui.notify(gate.reason, gate.ready ? 'info' : 'error');
    },
  });
}
