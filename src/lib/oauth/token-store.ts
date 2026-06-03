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
    const { mkdir, chmod } = await import("node:fs/promises");
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const all = await this.readAll();
    all[env] = session;
    await Bun.write(this.file, stringify(all as Record<string, unknown>));
    await chmod(this.file, 0o600);
  }

  async clear(env: Environment): Promise<void> {
    const all = await this.readAll();
    if (!(env in all)) return;
    delete all[env];
    const { chmod } = await import("node:fs/promises");
    await Bun.write(this.file, stringify(all as Record<string, unknown>));
    await chmod(this.file, 0o600);
  }

  private async readAll(): Promise<CredentialsFile> {
    const f = Bun.file(this.file);
    if (!(await f.exists())) return {};
    const text = await f.text();
    if (text.trim().length === 0) return {};
    return parse(text) as CredentialsFile;
  }
}

function credentialsFile(): string {
  return `${configPaths().dir}/credentials.toml`;
}

function dirname(p: string): string {
  return p.slice(0, p.lastIndexOf("/")) || "/";
}

// 0600 file, like aws/gcloud. A native OS keychain is a future enhancement: the
// macOS `security` CLI truncates secrets at 128 bytes and a native addon can't
// be cross-compiled into the bun single-binary build.
export function resolveStore(): TokenStore {
  return new FileStore();
}
