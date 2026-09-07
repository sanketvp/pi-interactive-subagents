// This fork is Pi-only. Validate before creating a pane or writing artifacts.
export function validateLaunch(
  params: {name: string; agent?: string},
  defaults: {cli?: string} | null,
  nested = false,
): void {
  if (!params.name.trim() || params.name.length > 120 || /[\x00-\x1f\x7f]/.test(params.name)) {
    throw new Error('Worker name must be 1–120 printable characters without control characters');
  }
  if (params.agent && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(params.agent)) {
    throw new Error('Agent must be a simple definition name, not a path');
  }
  if (defaults?.cli && defaults.cli !== 'pi') throw new Error('Only Pi worker launches are permitted');
  if (nested) throw new Error('Nested worker spawning is disabled');
}

export function safeScriptPreamble(text: string): string {
  // Metadata is not shell code, even if it contains newline/control characters.
  return text.replace(/\r/g, '\n').split('\n')
    .map(line => '# ' + line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')).join('\n');
}

export function shouldCloseAfterWatchError(): false {
  // A stopped watcher is not a stopped worker; retain the resource for recovery.
  return false;
}
