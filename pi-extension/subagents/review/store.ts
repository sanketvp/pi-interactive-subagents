/**
 * Content-addressed store for plan/research bytes and manifests.
 * Bytes are durable (temp + rename, mode 0600) before packet release.
 */
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getLifecycleAdapter, type LifecycleFs } from "../adapter.ts";

export function contentSha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function contentIdOf(value: string | Buffer): string {
  return `sha256:${contentSha256(value)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export interface PlanResearchFile {
  path: string;
  sha256: string;
  size: number;
}

export interface PlanResearchManifest {
  kind: "plan" | "research";
  requestId: string;
  assignedPath: string;
  files: PlanResearchFile[];
  sourceRoots: string[];
}

export class ContentStore {
  readonly root: string;
  private readonly fs: LifecycleFs;

  constructor(root: string, fs: LifecycleFs = getLifecycleAdapter().fs) {
    this.root = root;
    this.fs = fs;
  }

  private objectPath(hex: string): string {
    return join(this.root, hex.slice(0, 2), hex);
  }

  exists(id: string): boolean {
    const hex = id.startsWith("sha256:") ? id.slice(7) : id;
    return this.fs.existsSync(this.objectPath(hex));
  }

  put(bytes: Buffer | string): string {
    const buf = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
    const hex = contentSha256(buf);
    const path = this.objectPath(hex);
    if (this.fs.existsSync(path)) return `sha256:${hex}`;
    this.fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = path + "." + randomUUID() + ".tmp";
    this.fs.writeFileSync(temp, buf, { mode: 0o600, flag: "wx" });
    this.fs.renameSync(temp, path);
    return `sha256:${hex}`;
  }

  get(id: string): Buffer {
    const hex = id.startsWith("sha256:") ? id.slice(7) : id;
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`invalid content id ${id}`);
    const raw = this.fs.readFileSync(this.objectPath(hex));
    return Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
  }

  putManifest(manifest: PlanResearchManifest): string {
    const sorted: PlanResearchManifest = {
      ...manifest,
      files: [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      sourceRoots: [...manifest.sourceRoots].sort(),
    };
    return this.put(canonicalJson(sorted));
  }

  getManifest(id: string): PlanResearchManifest {
    return JSON.parse(this.get(id).toString("utf8")) as PlanResearchManifest;
  }
}
