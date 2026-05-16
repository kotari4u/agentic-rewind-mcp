import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AgenticRewindConfig } from './types.js';

export function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

export function validateRelativePath(relPath: string): string {
  if (!relPath || relPath.includes('\0') || path.isAbsolute(relPath)) {
    throw new Error(`Invalid workspace path: ${relPath}`);
  }
  const normalized = normalizePath(path.posix.normalize(normalizePath(relPath)));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Path traversal is not allowed: ${relPath}`);
  }
  return normalized;
}

export function resolveWorkspacePath(root: string, relPath: string): string {
  const normalized = validateRelativePath(relPath);
  const target = path.resolve(root, ...normalized.split('/'));
  const resolvedRoot = path.resolve(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path escapes workspace: ${relPath}`);
  }
  return target;
}

export async function listWorkspaceFiles(root: string, config: AgenticRewindConfig): Promise<string[]> {
  const regexes = config.ignore.map(patternToRegex);
  const files: string[] = [];

  async function visit(absDir: string, relDir: string): Promise<void> {
    const entries = await safeReaddir(absDir);
    for (const entry of entries) {
      const relPath = normalizePath(relDir ? `${relDir}/${entry.name}` : entry.name);
      if (isIgnored(relPath, entry.isDirectory(), regexes)) {
        continue;
      }
      const absPath = resolveWorkspacePath(root, relPath);
      if (entry.isDirectory()) {
        await visit(absPath, relPath);
      } else if (entry.isFile()) {
        files.push(relPath);
      }
    }
  }

  await visit(root, '');
  return files.sort();
}

export function hashBytes(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function isProbablyBinary(bytes: Buffer): boolean {
  if (!bytes.length) {
    return false;
  }
  const sample = bytes.subarray(0, Math.min(bytes.length, 8000));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
    if ((byte < 7 || (byte > 14 && byte < 32)) && byte !== 9 && byte !== 10 && byte !== 13) {
      suspicious += 1;
    }
  }
  return suspicious / sample.length > 0.3;
}

export async function removeEmptyParents(root: string, absDir: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  let current = path.resolve(absDir);
  while (current.startsWith(`${resolvedRoot}${path.sep}`) && current !== resolvedRoot) {
    try {
      await fs.rmdir(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

function isIgnored(relPath: string, isDir: boolean, regexes: RegExp[]): boolean {
  const candidates = isDir ? [relPath, `${relPath}/`] : [relPath];
  return regexes.some(regex => candidates.some(candidate => regex.test(candidate)));
}

function patternToRegex(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if ('\\^$+?.()|{}[]'.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  if (!normalized.includes('/')) {
    return new RegExp(`(^|/)${source}($|/)`);
  }
  return new RegExp(`^${source}$|^${source}/`);
}

async function safeReaddir(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error: any) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') {
      return [];
    }
    throw error;
  }
}
