import { dirname } from "node:path";
import { parse, stringify } from "smol-toml";
import { configPaths } from "../config.ts";
import type { Environment } from "../global-flags.ts";
import type { StoredSession } from "./types.ts";

export interface TokenStore {
  load(env: Environment): Promise<StoredSession | null>;
  save(env: Environment, session: StoredSession): Promise<void>;
  clear(env: Environment): Promise<void>;
}

interface CredentialsFile {
  [env: string]: StoredSession;
}

export class FileStore implements TokenStore {
  constructor(private readonly file: string = credentialsFile()) {}

  async load(env: Environment): Promise<StoredSession | null> {
    const all = await this.readAll();
    return all[env] ?? null;
  }

  async save(env: Environment, session: StoredSession): Promise<void> {
    const all = await this.readAll();
    all[env] = session;
    await this.writeAll(all);
  }

  async clear(env: Environment): Promise<void> {
    const all = await this.readAll();
    if (!(env in all)) return;
    delete all[env];
    await this.writeAll(all);
  }

  private async readAll(): Promise<CredentialsFile> {
    const f = Bun.file(this.file);
    if (!(await f.exists())) return {};
    const text = await f.text();
    if (text.trim().length === 0) return {};
    return parse(text) as CredentialsFile;
  }

  // Write 0600 to a temp file then atomically rename over the target, so the
  // credentials file is never briefly readable at the umask default (TOCTOU).
  private async writeAll(all: CredentialsFile): Promise<void> {
    const { mkdir, writeFile, rename } = await import("node:fs/promises");
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, stringify(all as Record<string, unknown>), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}

function credentialsFile(): string {
  return `${configPaths().dir}/credentials.toml`;
}

// 0600 file, like aws/gcloud. A native OS keychain is a future enhancement: the
// macOS `security` CLI truncates secrets at 128 bytes and a native addon can't
// be cross-compiled into the bun single-binary build.
export function resolveStore(): TokenStore {
  return new FileStore();
}
