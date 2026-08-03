import { mkdir, writeFile, readFile, readdir, stat, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeFileEnsured(path: string, content: string | Uint8Array): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content);
}

export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}

/** Recursively copy a directory tree. */
export async function copyDir(src: string, dest: string): Promise<void> {
  await ensureDir(dest);
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else {
      await ensureDir(dirname(d));
      await copyFile(s, d);
    }
  }
}

export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string) => {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else total += (await stat(p)).size;
    }
  };
  if (existsSync(dir)) await walk(dir);
  return total;
}

export { resolve, join };
