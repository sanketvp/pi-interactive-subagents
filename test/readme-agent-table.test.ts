import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_AGENTS = [
  "bulk",
  "implementer",
  "implementer-glm",
  "implementer-gpt",
  "implementer-k3",
  "planner",
  "pr-reviewer",
  "researcher",
  "reviewer",
  "scout",
  "verifier",
  "verifier-run",
  "worker",
] as const;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const README_PATH = join(ROOT, "README.md");

type AgentRow = { agent: string; model: string; thinking: string; role: string };

function stripCell(raw: string): string {
  return raw
    .trim()
    .replace(/^\*\*(.*)\*\*$/, "$1")
    .replace(/^`(.*)`$/, "$1")
    .trim();
}

function splitRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutTrail = inner.endsWith("|") ? inner.slice(0, -1) : inner;
  return withoutTrail.split("|").map((cell) => cell.trim());
}

function isSeparator(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseFrontmatterField(content: string, key: string): string | undefined {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return undefined;
  const field = match[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return field ? field[1].trim() : undefined;
}

function parseBundledAgents(readme: string): { rows: AgentRow[]; afterTable: string } {
  const heading = "### Bundled Agents";
  const start = readme.indexOf(heading);
  assert.notEqual(start, -1, "README.md is missing ### Bundled Agents");
  const afterHeading = readme.slice(start + heading.length);
  const nextHeading = afterHeading.search(/\n### /);
  const section = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);

  const lines = section.split("\n");
  const tableLines: string[] = [];
  let tableStarted = false;
  let afterIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("|")) {
      tableStarted = true;
      tableLines.push(line);
      continue;
    }
    if (tableStarted) {
      afterIndex = i;
      break;
    }
  }
  assert.ok(tableLines.length >= 3, "Bundled Agents table is missing rows");

  const header = splitRow(tableLines[0]).map(stripCell);
  assert.deepEqual(header, ["Agent", "Model", "Thinking", "Role"]);
  assert.ok(isSeparator(tableLines[1]), "Bundled Agents table is missing a separator row");

  const rows: AgentRow[] = tableLines.slice(2).map((line) => {
    const cells = splitRow(line).map(stripCell);
    assert.equal(cells.length, 4, `expected 4 cells, got ${cells.length}: ${line}`);
    return { agent: cells[0], model: cells[1], thinking: cells[2], role: cells[3] };
  });

  return { rows, afterTable: lines.slice(afterIndex).join("\n") };
}

describe("README Bundled Agents table", () => {
  const readme = readFileSync(README_PATH, "utf8");
  const { rows, afterTable } = parseBundledAgents(readme);

  it("lists exactly the 13 global agent profiles", () => {
    assert.equal(rows.length, 13);
    assert.deepEqual(rows.map((row) => row.agent), [...EXPECTED_AGENTS]);
  });

  it("has non-empty Model and Thinking cells", () => {
    for (const row of rows) {
      assert.ok(row.model, `${row.agent} is missing Model`);
      assert.ok(row.thinking, `${row.agent} is missing Thinking`);
      assert.ok(row.role, `${row.agent} is missing Role`);
    }
  });

  it("notes that profiles live under ~/.pi/agent/agents", () => {
    const note = afterTable.split("Agent discovery follows priority")[0];
    assert.match(note, /~\/\.pi\/agent\/agents/);
  });

  it("matches live global agent frontmatter when present", (t) => {
    const dir = join(homedir(), ".pi", "agent", "agents");
    if (!existsSync(dir)) {
      t.skip(`${dir} is absent; skipping live frontmatter check`);
      return;
    }

    const files = readdirSync(dir).filter((name) => name.endsWith(".md"));
    const byAgent = new Map(rows.map((row) => [row.agent, row]));
    for (const file of files) {
      const agent = file.replace(/\.md$/, "");
      const row = byAgent.get(agent);
      assert.ok(row, `README is missing a row for ${agent}`);
      const content = readFileSync(join(dir, file), "utf8");
      const model = parseFrontmatterField(content, "model");
      const thinking = parseFrontmatterField(content, "thinking");
      assert.equal(row.model, model, `${agent} Model does not match frontmatter`);
      assert.equal(row.thinking, thinking, `${agent} Thinking does not match frontmatter`);
    }
  });
});
