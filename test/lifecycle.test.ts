import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDefaultAdapter,setLifecycleAdapter} from '../pi-extension/subagents/adapter.ts';
import {
  persistPreparingIntent,
  persistSplitRequested,
  invokeSplit,
  applyRecovery,
  applyStartupReceipt,
  freezePaneStartCommand,
  classifySocket,
  matchPaneIdentity,
  writeLaunchScript,
} from '../pi-extension/subagents/lifecycle.ts';
import {loadRegistry, validateRegistry} from '../pi-extension/subagents/registry.ts';
import * as subagentsModule from '../pi-extension/subagents/index.ts';
import {observedFromExtensionContext} from '../pi-extension/subagents/subagent-done.ts';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'pi-life-'));
}

function mockAdapter(opts: {tmux?: (args: string[]) => string; calls?: string[][]}) {
  const base = createDefaultAdapter();
  const calls = opts.calls ?? [];
  return {
    ...base,
    tmux(args: string[]) {
      calls.push([...args]);
      if (opts.tmux) return opts.tmux(args);
      throw new Error('tmux disabled');
    },
    now: () => 1,
    fs: base.fs,
  };
}

test('preparing and split_requested persist before tmux; start command is exact', () => {
  const root = tempRoot();
  const calls: string[][] = [];
  const adapter = mockAdapter({
    calls,
    tmux(args) {
      if (args.includes('split-window')) return '%12';
      throw new Error('unexpected tmux ' + args.join(' '));
    },
  });
  setLifecycleAdapter(adapter);
  const registryPath = join(root, 'workers.json');
  const script = join(root, 'launch.sh');
  const began = persistPreparingIntent({
    registryPath,
    registry: { version: 1, invocations: 0, workers: [] },
    attemptId: randomUUID(),
    name: 'w',
    task: 't',
    parentSessionId: randomUUID(),
    sessionFile: join(root, 's.jsonl'),
    launchScriptFile: script,
    completionFile: join(root, 'done.json'),
    tmuxSocket: '/tmp/tmux-test/sock',
    windowId: '@0',
    requested: { provider: 'xai', model: 'grok-4.6', thinking: 'high' },
    interactive: false,
    paneStartCommand: freezePaneStartCommand(script),
  }, adapter);
  assert.equal(began.record.resourceState, 'preparing');
  assert.equal(calls.length, 0);
  const split = persistSplitRequested(registryPath, began.registry, began.record, freezePaneStartCommand(script), adapter);
  assert.equal(split.record.resourceState, 'split_requested');
  assert.equal(calls.length, 0);
  const launched = invokeSplit(registryPath, split.registry, split.record, adapter);
  assert.equal(launched.record.surface, '%12');
  assert.equal(launched.record.resourceState, 'launching');
  assert.equal(calls[0][0], '-S');
  assert.equal(calls[0][1], '/tmp/tmux-test/sock');
  assert.ok(calls[0].includes('split-window'));
  assert.equal(launched.record.paneStartCommand, freezePaneStartCommand(script));
  setLifecycleAdapter(null);
});

test('split failure without matching start command on reachable window is proven_absent', () => {
  const root = tempRoot();
  const adapter = mockAdapter({
    tmux(args) {
      if (args.includes('split-window')) throw new Error('split failed');
      if (args.includes('list-panes')) return '';
      throw new Error('unexpected');
    },
  });
  setLifecycleAdapter(adapter);
  const registryPath = join(root, 'workers.json');
  const script = join(root, 'launch.sh');
  const began = persistPreparingIntent({
    registryPath,
    registry: { version: 1, invocations: 0, workers: [] },
    name: 'w',
    task: 't',
    parentSessionId: randomUUID(),
    sessionFile: join(root, 's.jsonl'),
    launchScriptFile: script,
    completionFile: join(root, 'done.json'),
    tmuxSocket: '/tmp/tmux-test/sock',
    windowId: '@0',
    requested: { provider: 'xai', model: 'grok-4.6', thinking: 'high' },
    interactive: false,
    paneStartCommand: freezePaneStartCommand(script),
  }, adapter);
  const split = persistSplitRequested(registryPath, began.registry, began.record, freezePaneStartCommand(script), adapter);
  assert.throws(() => invokeSplit(registryPath, split.registry, split.record, adapter), /split was not accepted/);
  const loaded = loadRegistry(registryPath);
  assert.equal(loaded.status, 'ok');
  assert.equal(loaded.registry.workers[0].resourceState, 'proven_absent');
  setLifecycleAdapter(null);
});

test('recovery adopts via exact pane_start_command, never substring', () => {
  const script = '/tmp/unique-attempt.sh';
  const record: any = {
    attemptId: randomUUID(),
    paneStartCommand: `bash ${script}`,
    tmuxSocket: '/tmp/sock',
    windowId: '@0',
    surface: null,
    resourceState: 'split_requested',
  };
  const panes = [
    { paneId: '%1', paneStartCommand: `bash ${script} extra`, attemptTag: '' },
    { paneId: '%2', paneStartCommand: `bash ${script}`, attemptTag: '' },
  ];
  const match = matchPaneIdentity(record, panes);
  assert.equal(match?.paneId, '%2');
});

test('foreign socket recovery performs zero tmux calls', () => {
  const root = tempRoot();
  const calls: string[][] = [];
  const adapter = mockAdapter({ calls, tmux() { throw new Error('tmux must not run'); } });
  setLifecycleAdapter(adapter);
  const registryPath = join(root, 'workers.json');
  const script = join(root, 'launch.sh');
  const began = persistPreparingIntent({
    registryPath,
    registry: { version: 1, invocations: 0, workers: [] },
    name: 'w',
    task: 't',
    parentSessionId: randomUUID(),
    sessionFile: join(root, 's.jsonl'),
    launchScriptFile: script,
    completionFile: join(root, 'done.json'),
    tmuxSocket: '/tmp/other-socket',
    windowId: '@0',
    requested: { provider: 'xai', model: 'grok-4.6', thinking: 'high' },
    interactive: false,
    paneStartCommand: freezePaneStartCommand(script),
  }, adapter);
  const recovered = applyRecovery(registryPath, began.registry, began.record, '/tmp/current-socket', adapter);
  assert.equal(recovered.record.resourceState, 'foreign');
  assert.equal(recovered.tmuxCalls, false);
  assert.equal(calls.length, 0);
  assert.equal(classifySocket(began.record, '/tmp/current-socket'), 'foreign');
  setLifecycleAdapter(null);
});

test('corrupt registry load leaves bytes untouched', () => {
  const root = tempRoot();
  const path = join(root, 'workers.json');
  writeFileSync(path, '{bad');
  const loaded = loadRegistry(path);
  assert.equal(loaded.status, 'invalid');
  assert.equal(readFileSync(path, 'utf8'), '{bad');
});

test('duplicate live session writer is refused', () => {
  const root = tempRoot();
  const adapter = mockAdapter({ tmux() { return '%1'; } });
  setLifecycleAdapter(adapter);
  const registryPath = join(root, 'workers.json');
  const sessionFile = join(root, 'same.jsonl');
  const script = join(root, 'a.sh');
  const first = persistPreparingIntent({
    registryPath,
    registry: { version: 1, invocations: 0, workers: [] },
    name: 'a',
    task: 't',
    parentSessionId: randomUUID(),
    sessionFile,
    launchScriptFile: script,
    completionFile: join(root, 'done.json'),
    tmuxSocket: '/tmp/sock',
    windowId: '@0',
    requested: { provider: 'xai', model: 'grok-4.6', thinking: 'high' },
    interactive: false,
    paneStartCommand: freezePaneStartCommand(script),
  }, adapter);
  assert.throws(() => persistPreparingIntent({
    registryPath,
    registry: first.registry,
    name: 'b',
    task: 't',
    parentSessionId: randomUUID(),
    sessionFile,
    launchScriptFile: join(root, 'b.sh'),
    completionFile: join(root, 'done2.json'),
    tmuxSocket: '/tmp/sock',
    windowId: '@0',
    requested: { provider: 'xai', model: 'grok-4.6', thinking: 'high' },
    interactive: false,
    paneStartCommand: freezePaneStartCommand(join(root, 'b.sh')),
  }, adapter), /single writer/);
  setLifecycleAdapter(null);
});

test('registered handlers include release/diagnose/replay and session_start', () => {
  const { api, registeredCommands, eventHandlers } = (() => {
    const registeredTools: any[] = [];
    const registeredCommands: any[] = [];
    const eventHandlers: Record<string, Function[]> = {};
    const api = {
      on(event: string, handler: Function) { (eventHandlers[event] ??= []).push(handler); },
      registerTool(tool: any) { registeredTools.push(tool); },
      registerCommand(name: string, command: any) { registeredCommands.push({ name, ...command }); },
      registerMessageRenderer() {},
      registerShortcut() {},
      sendUserMessage() {},
      sendMessage() {},
      getAllTools() { return []; },
    } as any;
    return { api, registeredTools, registeredCommands, eventHandlers };
  })();
  (subagentsModule as any).default(api);
  assert.ok(registeredCommands.some((c) => c.name === 'subagent-release'));
  assert.ok(registeredCommands.some((c) => c.name === 'subagents-diagnose'));
  assert.ok(registeredCommands.some((c) => c.name === 'subagents-replay'));
  assert.ok(eventHandlers.session_start?.length);
  const ctx = {
    mode: 'print',
    hasUI: true,
    ui: { notify() {}, setWidget() {}, confirm: async () => false },
    sessionManager: {
      getSessionDir: () => join(tempRoot(), 'sessions'),
      getSessionId: () => randomUUID(),
      getSessionFile: () => null,
    },
  };
  eventHandlers.session_start[0]({ reason: 'startup' }, ctx);
});

test('startup receipt helper fails loudly without ctx.model/getSessionId/thinkingLevel', () => {
  assert.throws(() => observedFromExtensionContext({}), /getSessionId/);
  assert.throws(() => observedFromExtensionContext({
    sessionManager: { getSessionId: () => 'id' },
  }), /ctx.model.provider/);
  const ok = observedFromExtensionContext({
    sessionManager: { getSessionId: () => 'sess' },
    model: { provider: 'xai', id: 'grok-4.6' },
    thinkingLevel: 'high',
  });
  assert.equal(ok.piSessionId, 'sess');
  assert.equal(ok.observed.provider, 'xai');
});

test('launch script is argv array with no eval and unique wx path', () => {
  const root = tempRoot();
  const adapter = createDefaultAdapter();
  const script = join(root, 'w.sh');
  writeLaunchScript({
    scriptPath: script,
    attemptId: randomUUID(),
    token: randomUUID(),
    socket: '/tmp/sock',
    dispatcher: '/bin/echo',
    dispatcherArgs: ['--interactive', '--provider', 'xai', '--', '$(touch /tmp/should-not)'],
    env: {
      PI_SUBAGENT_COMPLETION_FILE: join(root, 'done.json'),
      PI_SUBAGENT_SESSION: join(root, 's.jsonl'),
    },
  }, adapter);
  const body = readFileSync(script, 'utf8');
  assert.match(body, /dispatch_args=\(/);
  assert.doesNotMatch(body, /\beval\b/);
  assert.match(body, /@pi-attempt/);
  assert.equal(existsSync(script), true);
});

// ── P1-3: preparing-with-no-surface recovery is proven_absent, zero tmux calls ──
test('applyRecovery: preparing with no surface is proven_absent with zero tmux calls', () => {
  const root = tempRoot();
  const calls: string[][] = [];
  const adapter = mockAdapter({ calls, tmux() { throw new Error('tmux must not run for preparing/no-surface'); } });
  setLifecycleAdapter(adapter);
  const registryPath = join(root, 'workers.json');
  const script = join(root, 'launch.sh');
  const began = persistPreparingIntent({
    registryPath,
    registry: { version: 1, invocations: 0, workers: [] },
    name: 'w',
    task: 't',
    parentSessionId: randomUUID(),
    sessionFile: join(root, 's.jsonl'),
    launchScriptFile: script,
    completionFile: join(root, 'done.json'),
    tmuxSocket: '/tmp/tmux-test/sock',
    windowId: '@0',
    requested: { provider: 'xai', model: 'grok-4.6', thinking: 'high' },
    interactive: false,
    paneStartCommand: freezePaneStartCommand(script),
  }, adapter);
  assert.equal(began.record.resourceState, 'preparing');
  assert.equal(began.record.surface, null);
  const recovered = applyRecovery(registryPath, began.registry, began.record, '/tmp/tmux-test/sock', adapter);
  assert.equal(recovered.record.resourceState, 'proven_absent');
  assert.equal(recovered.tmuxCalls, false);
  assert.equal(calls.length, 0, 'a preparing/no-surface record proves tmux was never invoked; recovery must not call tmux at all');
  setLifecycleAdapter(null);
});

// ── P1-4: resumed-session identity persists and is enforced on startup ──
test('persistPreparingIntent persists expectedPiSessionId; applyStartupReceipt rejects a mismatched resumed UUID', () => {
  const root = tempRoot();
  const adapter = mockAdapter({ tmux() { return '%1'; } });
  setLifecycleAdapter(adapter);
  const registryPath = join(root, 'workers.json');
  const script = join(root, 'r.sh');
  const expectedPiSessionId = randomUUID();
  const began = persistPreparingIntent({
    registryPath,
    registry: { version: 1, invocations: 0, workers: [] },
    name: 'resume',
    task: 'resumed session',
    parentSessionId: randomUUID(),
    sessionFile: join(root, 's.jsonl'),
    launchScriptFile: script,
    completionFile: join(root, 'done.json'),
    tmuxSocket: '/tmp/sock',
    windowId: '@0',
    requested: { provider: 'xai', model: 'grok-4.6', thinking: 'high' },
    interactive: true,
    paneStartCommand: freezePaneStartCommand(script),
    expectedPiSessionId,
  }, adapter);
  assert.equal(began.record.piSessionId, expectedPiSessionId);

  // The live startup receipt reports the WRONG session UUID (e.g. attached
  // to the wrong session file / stale resume) -- must be rejected, not
  // silently accepted.
  assert.throws(() => applyStartupReceipt(registryPath, began.registry, began.record, {
    attemptId: began.record.attemptId,
    token: began.record.completionToken,
    piSessionId: randomUUID(),
    observed: { provider: 'xai', model: 'grok-4.6', thinking: 'high' },
  }, adapter), /session UUID mismatch/);

  // The correct receipt (matching the canonical resumed UUID) is accepted
  // and flips resourceState to running.
  const applied = applyStartupReceipt(registryPath, began.registry, began.record, {
    attemptId: began.record.attemptId,
    token: began.record.completionToken,
    piSessionId: expectedPiSessionId,
    observed: { provider: 'xai', model: 'grok-4.6', thinking: 'high' },
  }, adapter);
  assert.equal(applied.record.resourceState, 'running');
  assert.equal(applied.record.piSessionId, expectedPiSessionId);
  setLifecycleAdapter(null);
});

// ── P1-4: registry validation — UUID syntax, socket-scoped pane uniqueness, outcome consistency ──
test('registry validation enforces UUID identity fields, socket-scoped pane uniqueness, and outcome/digest/delivery consistency', () => {
  const baseWorker = (overrides: Record<string, unknown> = {}) => ({
    attemptId: randomUUID(),
    parentSessionId: randomUUID(),
    piSessionId: null,
    invocation: 1,
    completionToken: randomUUID(),
    tmuxSocket: '/tmp/sock-a',
    windowId: '@0',
    surface: null,
    sessionFile: '/tmp/s.jsonl',
    launchScriptFile: '/tmp/l.sh',
    completionFile: '/tmp/d.json',
    paneStartCommand: 'bash /tmp/l.sh',
    requested: { provider: 'xai', model: 'grok-4.6', thinking: 'high' },
    observed: null,
    resourceState: 'running',
    outcome: null,
    outcomeBytes: null,
    outcomeDigest: null,
    deliveryState: null,
    createdAt: 1,
    name: 'w',
    task: 't',
    ...overrides,
  });

  // Non-UUID parentSessionId/piSessionId rejected.
  assert.throws(() => validateRegistry({ version: 1, invocations: 1, workers: [baseWorker({ parentSessionId: 'not-a-uuid' })] }), /parentSessionId/);
  assert.throws(() => validateRegistry({ version: 1, invocations: 1, workers: [baseWorker({ piSessionId: 'not-a-uuid' })] }), /piSessionId/);

  // Same pane number on two DIFFERENT sockets is legitimate, not a duplicate.
  const a = baseWorker({ tmuxSocket: '/tmp/sock-a', surface: '%1' });
  const b = baseWorker({ tmuxSocket: '/tmp/sock-b', surface: '%1' });
  assert.doesNotThrow(() => validateRegistry({ version: 1, invocations: 1, workers: [a, b] }));

  // Same pane number on the SAME socket IS a duplicate.
  const c = baseWorker({ tmuxSocket: '/tmp/sock-a', surface: '%1' });
  const d = baseWorker({ tmuxSocket: '/tmp/sock-a', surface: '%1' });
  assert.throws(() => validateRegistry({ version: 1, invocations: 1, workers: [c, d] }), /duplicate surface/);

  // outcome present but bytes/digest missing or mismatched is rejected.
  assert.throws(() => validateRegistry({ version: 1, invocations: 1, workers: [baseWorker({ outcome: 'done', outcomeBytes: null })] }), /outcomeBytes/);
  assert.throws(() => validateRegistry({ version: 1, invocations: 1, workers: [baseWorker({ outcome: 'done', outcomeBytes: '{}', outcomeDigest: 'a'.repeat(64) })] }), /outcomeDigest/);
  // deliveryState present without an outcome is rejected.
  assert.throws(() => validateRegistry({ version: 1, invocations: 1, workers: [baseWorker({ deliveryState: 'pending' })] }), /deliveryState/);
});
