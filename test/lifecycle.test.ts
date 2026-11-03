import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDefaultAdapter,setLifecycleAdapter} from '../pi-extension/subagents/adapter.ts';
import {HerdrWorkerHost, TmuxWorkerHost, currentWorkerHost, type WorkerHost} from '../pi-extension/subagents/worker-host.ts';
import {
  persistPreparingIntent,
  persistSplitRequested,
  invokeSplit,
  releaseWithoutClose,
  closeOwned,
  closeCompleted,
  applyRecovery,
  applyStartupReceipt,
  freezePaneStartCommand,
  classifyHost,
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
    host: new TmuxWorkerHost('/tmp/tmux-test/sock', adapter),
    container: '@0',
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

test('Herdr ownership requires the captured terminal id and exact live bash argv', () => {
  const socket = '/tmp/herdr.sock';
  const script = '/tmp/pi-herdr-launch.sh';
  let terminalId = 'term-original';
  let argv = ['bash', script];
  const calls: string[][] = [];
  const adapter = {
    ...createDefaultAdapter(),
    herdr(args: string[]) {
      calls.push([...args]);
      if (args[0] === 'pane' && args[1] === 'split') {
        return JSON.stringify({ result: { pane: { pane_id: 'w1:p2', terminal_id: terminalId, tab_id: 'w1:t1' } } });
      }
      if (args[0] === 'pane' && args[1] === 'run') return '';
      if (args[0] === 'pane' && args[1] === 'get') {
        return JSON.stringify({ result: { pane: { pane_id: 'w1:p2', terminal_id: terminalId, tab_id: 'w1:t1' } } });
      }
      if (args[0] === 'pane' && args[1] === 'process-info') {
        return JSON.stringify({ result: { process_info: { pane_id: 'w1:p2', foreground_processes: [{ argv }] } } });
      }
      throw new Error(`unexpected herdr ${args.join(' ')}`);
    },
  };
  const host = new HerdrWorkerHost(socket, undefined, adapter);
  const split = host.splitLaunch('w1:t1', script, { cwd: '/tmp', callerPane: 'w1:p1' });
  assert.deepEqual(split, { surface: 'w1:p2', launchCommand: `bash ${script}`, attemptTag: '', terminalId: 'term-original' });
  assert.deepEqual(calls[0], ['pane', 'split', '--pane', 'w1:p1', '--direction', 'right', '--cwd', '/tmp', '--no-focus']);
  assert.equal(calls.some((args) => args.some((arg) => arg.includes('PI_SUBAGENT_TOKEN'))), false);
  host.runLaunch('w1:p2', script);
  assert.deepEqual(calls[1], ['pane', 'run', 'w1:p2', 'bash', script]);

  const recovered = new HerdrWorkerHost(socket, 'term-original', adapter);
  assert.equal(recovered.ownsSurface('w1:p2', 'attempt', 'token', script), true);
  terminalId = 'term-reused';
  assert.equal(recovered.ownsSurface('w1:p2', 'attempt', 'token', script), false, 'terminal mismatch is foreign');
  terminalId = 'term-original';
  argv = ['bash', '/tmp/other.sh'];
  assert.equal(recovered.ownsSurface('w1:p2', 'attempt', 'token', script), false, 'argv mismatch is foreign');
  argv = ['zsh'];
  assert.equal(recovered.ownsSurface('w1:p2', 'attempt', 'token', script), false, 'exited script leaves only the shell');
});

test('Herdr recovery never adopts or kills an old pane whose proof has disappeared', () => {
  const root = tempRoot();
  const socket = '/tmp/herdr.sock';
  const script = join(root, 'launch.sh');
  const adapter = {
    ...createDefaultAdapter(),
    herdr(args: string[]) {
      if (args[1] === 'split') return JSON.stringify({ result: { pane: { pane_id: 'w1:p2', terminal_id: 'term-1', tab_id: 'w1:t1' } } });
      if (args[1] === 'run') return '';
      if (args[1] === 'list') return JSON.stringify({ result: { panes: [{ pane_id: 'w1:p2', terminal_id: 'term-1', tab_id: 'w1:t1' }] } });
      if (args[1] === 'get') return JSON.stringify({ result: { pane: { pane_id: 'w1:p2', terminal_id: 'term-1', tab_id: 'w1:t1' } } });
      if (args[1] === 'process-info') return JSON.stringify({ result: { process_info: { pane_id: 'w1:p2', foreground_processes: [{ argv: ['zsh'] }] } } });
      throw new Error(`unexpected herdr ${args.join(' ')}`);
    },
    now: () => 1,
  };
  const registryPath = join(root, 'workers.json');
  const began = persistPreparingIntent({
    registryPath, registry: { version: 1, invocations: 0, workers: [] }, attemptId: randomUUID(),
    name: 'herdr', task: 't', parentSessionId: randomUUID(), sessionFile: join(root, 's.jsonl'),
    launchScriptFile: script, completionFile: join(root, 'done.json'),
    host: new HerdrWorkerHost(socket, undefined, adapter), container: 'w1:t1',
    hostLaunch: { cwd: root, callerPane: 'w1:p1' },
    requested: { provider: 'xai', model: 'grok-4.6', thinking: 'high' }, interactive: false,
  }, adapter);
  const split = persistSplitRequested(registryPath, began.registry, began.record, freezePaneStartCommand(script), adapter);
  const launched = invokeSplit(registryPath, split.registry, split.record, adapter);
  assert.deepEqual(launched.record.host, { kind: 'herdr', id: socket, terminalId: 'term-1' });
  const recovered = applyRecovery(registryPath, launched.registry, launched.record, launched.record.host, adapter);
  assert.equal(recovered.record.resourceState, 'unknown');
  assert.throws(() => closeOwned(registryPath, recovered.registry, recovered.record, adapter), /ownership changed/);
});

test('Herdr preserves split evidence before a failed run and recovers it as unknown', () => {
  const root = tempRoot();
  const socket = '/tmp/herdr.sock';
  const script = join(root, 'launch.sh');
  const adapter = {
    ...createDefaultAdapter(),
    herdr(args: string[]) {
      if (args[1] === 'split') return JSON.stringify({ result: { pane: { pane_id: 'w1:p2', terminal_id: 'term-1', tab_id: 'w1:t1' } } });
      if (args[1] === 'run') throw new Error('run failed');
      if (args[1] === 'list') return JSON.stringify({ result: { panes: [{ pane_id: 'w1:p2', terminal_id: 'term-1', tab_id: 'w1:t1' }] } });
      if (args[1] === 'get') return JSON.stringify({ result: { pane: { pane_id: 'w1:p2', terminal_id: 'term-1', tab_id: 'w1:t1' } } });
      if (args[1] === 'process-info') return JSON.stringify({ result: { process_info: { pane_id: 'w1:p2', foreground_processes: [{ argv: ['zsh'] }] } } });
      throw new Error(`unexpected herdr ${args.join(' ')}`);
    }, now: () => 1,
  };
  const registryPath = join(root, 'workers.json');
  const began = persistPreparingIntent({
    registryPath, registry: { version: 1, invocations: 0, workers: [] }, attemptId: randomUUID(),
    name: 'herdr', task: 't', parentSessionId: randomUUID(), sessionFile: join(root, 's.jsonl'),
    launchScriptFile: script, completionFile: join(root, 'done.json'),
    host: new HerdrWorkerHost(socket, undefined, adapter), container: 'w1:t1',
    hostLaunch: { cwd: root, callerPane: 'w1:p1' },
    requested: { provider: 'xai', model: 'grok-4.6', thinking: 'high' }, interactive: false,
  }, adapter);
  const requested = persistSplitRequested(registryPath, began.registry, began.record, freezePaneStartCommand(script), adapter);
  const result = invokeSplit(registryPath, requested.registry, requested.record, adapter);
  assert.equal(result.record.resourceState, 'unknown');
  assert.equal(result.record.surface, 'w1:p2');
  assert.equal(result.record.host.terminalId, 'term-1');
});

test('Herdr closes a completed worker using its authenticated receipt and terminal identity', () => {
  const root = tempRoot();
  const socket = '/tmp/herdr.sock';
  const calls: string[][] = [];
  const adapter = {
    ...createDefaultAdapter(),
    herdr(args: string[]) {
      calls.push(args);
      if (args[1] === 'get') return JSON.stringify({ result: { pane: { pane_id: 'w1:p2', terminal_id: 'term-1', tab_id: 'w1:t1' } } });
      if (args[1] === 'close') return '';
      throw new Error(`unexpected herdr ${args.join(' ')}`);
    }, now: () => 1,
  };
  const host = new HerdrWorkerHost(socket, 'term-1', adapter);
  const began = persistPreparingIntent({
    registryPath: join(root, 'workers.json'), registry: { version: 1, invocations: 0, workers: [] }, name: 'herdr', task: 't', parentSessionId: randomUUID(),
    sessionFile: join(root, 's.jsonl'), launchScriptFile: join(root, 'launch.sh'), completionFile: join(root, 'done.json'),
    host, container: 'w1:t1', requested: { provider: 'xai', model: 'grok-4.6', thinking: 'high' }, interactive: false,
  }, adapter);
  const running = { ...began.record, surface: 'w1:p2', resourceState: 'running' as const };
  const closed = closeCompleted(join(root, 'workers.json'), began.registry, running, adapter);
  assert.equal(closed.record.resourceState, 'closed');
  assert.deepEqual(calls, [['pane', 'get', 'w1:p2'], ['pane', 'close', 'w1:p2']]);
});

test('detects Herdr only with both required environment variables and keeps tmux fallback', () => {
  const adapter = createDefaultAdapter();
  assert.equal(currentWorkerHost({ HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: '/tmp/herdr.sock', TMUX: '/tmp/tmux.sock,1,2' }, adapter)?.identity.kind, 'tmux');
  assert.equal(currentWorkerHost({ HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: '/tmp/herdr.sock' }, adapter)?.identity.kind, 'herdr');
  assert.equal(currentWorkerHost({ HERDR_PANE_ID: 'w1:p1' }, adapter), null);
  assert.equal(currentWorkerHost({ TMUX: '/tmp/tmux.sock,1,2' }, adapter)?.identity.kind, 'tmux');
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
    host: new TmuxWorkerHost('/tmp/tmux-test/sock', adapter),
    container: '@0',
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
    host: { kind: 'tmux', id: '/tmp/sock' },
    container: '@0',
    surface: null,
    resourceState: 'split_requested',
  };
  const panes = [
    { surface: '%1', launchCommand: `bash ${script} extra`, attemptTag: '' },
    { surface: '%2', launchCommand: `bash ${script}`, attemptTag: '' },
  ];
  const match = matchPaneIdentity(record, panes);
  assert.equal(match?.surface, '%2');
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
    host: new TmuxWorkerHost('/tmp/other-socket', adapter),
    container: '@0',
    requested: { provider: 'xai', model: 'grok-4.6', thinking: 'high' },
    interactive: false,
    paneStartCommand: freezePaneStartCommand(script),
  }, adapter);
  const recovered = applyRecovery(registryPath, began.registry, began.record, { kind: 'tmux', id: '/tmp/current-socket' }, adapter);
  assert.equal(recovered.record.resourceState, 'foreign');
  assert.equal(recovered.tmuxCalls, false);
  assert.equal(calls.length, 0);
  assert.equal(classifyHost(began.record, { kind: 'tmux', id: '/tmp/current-socket' }), 'foreign');
  setLifecycleAdapter(null);
});

test('legacy tmuxSocket registry records load as host records and recover as before', () => {
  const root = tempRoot();
  const path = join(root, 'workers.json');
  const attemptId = randomUUID();
  const token = randomUUID();
  writeFileSync(path, JSON.stringify({ version: 1, invocations: 1, workers: [{
    attemptId, parentSessionId: randomUUID(), piSessionId: null, invocation: 1, completionToken: token,
    tmuxSocket: '/tmp/legacy-socket', windowId: '@0', surface: '%7', sessionFile: join(root, 's.jsonl'),
    launchScriptFile: join(root, 'launch.sh'), completionFile: join(root, 'done.json'), paneStartCommand: 'bash /tmp/launch.sh',
    requested: { provider: 'xai', model: 'grok-4.6', thinking: 'high' }, observed: null, resourceState: 'running',
    outcome: null, outcomeBytes: null, outcomeDigest: null, deliveryState: null, createdAt: 1, name: 'legacy', task: 't',
  }] }));
  const loaded = loadRegistry(path);
  assert.equal(loaded.status, 'ok');
  if (loaded.status !== 'ok') return;
  assert.deepEqual(loaded.registry.workers[0].host, { kind: 'tmux', id: '/tmp/legacy-socket' });
  assert.equal(loaded.registry.workers[0].container, '@0');
  const recovered = applyRecovery(path, loaded.registry, loaded.registry.workers[0], { kind: 'tmux', id: '/tmp/current-socket' });
  assert.equal(recovered.record.resourceState, 'foreign');
  const written = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(written.workers[0].host, { kind: 'tmux', id: '/tmp/legacy-socket' });
  assert.equal(written.workers[0].tmuxSocket, undefined);
});

test('modern registry identities take precedence over legacy disk aliases', () => {
  const root = tempRoot();
  const record = {
    attemptId: randomUUID(), parentSessionId: randomUUID(), piSessionId: null, invocation: 1, completionToken: randomUUID(),
    host: { kind: 'tmux', id: '/tmp/authoritative-socket' }, container: '@1',
    tmuxSocket: 'relative', windowId: 'garbage', surface: null, sessionFile: join(root, 's.jsonl'),
    launchScriptFile: join(root, 'launch.sh'), completionFile: join(root, 'done.json'), paneStartCommand: 'bash /tmp/launch.sh',
    requested: { provider: 'xai', model: 'grok-4.6', thinking: 'high' }, observed: null, resourceState: 'running',
    outcome: null, outcomeBytes: null, outcomeDigest: null, deliveryState: null, createdAt: 1, name: 'worker', task: 't',
  };
  const validated = validateRegistry({ version: 1, invocations: 1, workers: [record] });
  assert.deepEqual(validated.workers[0].host, record.host);
  assert.equal(validated.workers[0].container, '@1');
  assert.equal((validated.workers[0] as Record<string, unknown>).tmuxSocket, undefined);
  assert.equal((validated.workers[0] as Record<string, unknown>).windowId, undefined);
});

test('lifecycle uses the WorkerHost contract rather than direct tmux operations', () => {
  const root = tempRoot();
  const calls: string[] = [];
  const host: WorkerHost = {
    identity: { kind: 'tmux', id: '/tmp/mock-host' },
    currentContainer() { calls.push('container'); return '@0'; },
    splitLaunch() { calls.push('split'); return { surface: '%9', launchCommand: 'bash /tmp/launch.sh', attemptTag: '' }; },
    runLaunch() { calls.push('run'); },
    listSurfaces() { calls.push('list'); return [{ surface: '%9', launchCommand: 'bash /tmp/launch.sh', attemptTag: '' }]; },
    ownsSurface() { calls.push('owns'); return true; },
    ownershipPreamble() { return 'true'; },
    clearOwnership() { calls.push('clear'); },
    killOwned() { calls.push('kill'); },
    interruptOwned() { calls.push('interrupt'); },
    closeCompleted() { calls.push('close-completed'); },
  };
  const adapter = { ...createDefaultAdapter(), workerHost: () => host, tmux() { throw new Error('direct tmux call'); }, now: () => 1 };
  const began = persistPreparingIntent({ registryPath: join(root, 'workers.json'), registry: { version: 1, invocations: 0, workers: [] }, name: 'w', task: 't', parentSessionId: randomUUID(), sessionFile: join(root, 's.jsonl'), launchScriptFile: '/tmp/launch.sh', completionFile: join(root, 'done.json'), host, container: '@0', requested: { provider: 'xai', model: 'grok-4.6', thinking: 'high' }, interactive: false }, adapter);
  const split = persistSplitRequested(join(root, 'workers.json'), began.registry, began.record, began.record.paneStartCommand, adapter);
  const launched = invokeSplit(join(root, 'workers.json'), split.registry, split.record, adapter);
  assert.equal(launched.record.surface, '%9');
  const released = releaseWithoutClose(join(root, 'workers.json'), launched.registry, launched.record, adapter);
  assert.equal(released.record.resourceState, 'released');
  assert.deepEqual(calls, ['split', 'run', 'owns', 'clear']);
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
    host: new TmuxWorkerHost('/tmp/sock', adapter),
    container: '@0',
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
    host: new TmuxWorkerHost('/tmp/sock', adapter),
    container: '@0',
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
    ownershipPreamble: new TmuxWorkerHost('/tmp/sock', adapter).ownershipPreamble('attempt', 'token'),
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
    host: new TmuxWorkerHost('/tmp/tmux-test/sock', adapter),
    container: '@0',
    requested: { provider: 'xai', model: 'grok-4.6', thinking: 'high' },
    interactive: false,
    paneStartCommand: freezePaneStartCommand(script),
  }, adapter);
  assert.equal(began.record.resourceState, 'preparing');
  assert.equal(began.record.surface, null);
  const recovered = applyRecovery(registryPath, began.registry, began.record, { kind: 'tmux', id: '/tmp/tmux-test/sock' }, adapter);
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
    host: new TmuxWorkerHost('/tmp/sock', adapter),
    container: '@0',
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
    host: { kind: 'tmux', id: '/tmp/sock-a' },
    container: '@0',
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
  const a = baseWorker({ host: { kind: 'tmux', id: '/tmp/sock-a' }, surface: '%1' });
  const b = baseWorker({ host: { kind: 'tmux', id: '/tmp/sock-b' }, surface: '%1' });
  assert.doesNotThrow(() => validateRegistry({ version: 1, invocations: 1, workers: [a, b] }));

  // Same pane number on the SAME socket IS a duplicate.
  const c = baseWorker({ host: { kind: 'tmux', id: '/tmp/sock-a' }, surface: '%1' });
  const d = baseWorker({ host: { kind: 'tmux', id: '/tmp/sock-a' }, surface: '%1' });
  assert.throws(() => validateRegistry({ version: 1, invocations: 1, workers: [c, d] }), /duplicate surface/);

  // outcome present but bytes/digest missing or mismatched is rejected.
  assert.throws(() => validateRegistry({ version: 1, invocations: 1, workers: [baseWorker({ outcome: 'done', outcomeBytes: null })] }), /outcomeBytes/);
  assert.throws(() => validateRegistry({ version: 1, invocations: 1, workers: [baseWorker({ outcome: 'done', outcomeBytes: '{}', outcomeDigest: 'a'.repeat(64) })] }), /outcomeDigest/);
  // deliveryState present without an outcome is rejected.
  assert.throws(() => validateRegistry({ version: 1, invocations: 1, workers: [baseWorker({ deliveryState: 'pending' })] }), /deliveryState/);
});
