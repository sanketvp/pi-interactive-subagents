// UUIDs are ASCII. Keep every character and respect the TUI width contract.
// Style each resulting line at the call site; never slice ANSI escape sequences.
export function sessionIdLines(sessionId: string, width: number): string[] {
  if (!Number.isFinite(width) || width < 1) return [];
  const columns = Math.floor(width);
  const text = `sid:${sessionId}`;
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += columns) lines.push(text.slice(i, i + columns));
  return lines;
}
