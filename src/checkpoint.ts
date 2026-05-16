import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { applyReverseLinePatch, joinLines, splitLines, unifiedDiff } from './diff.js';
import { hashBytes, isProbablyBinary, listWorkspaceFiles, removeEmptyParents, resolveWorkspacePath, validateRelativePath } from './fs-utils.js';
import { blobsDir, checkpointsDir, ensureStore, makeId, readJson, writeJsonAtomic } from './store.js';
import type { AgenticRewindConfig, Checkpoint, CheckpointFile, RewindReport } from './types.js';

export async function createCheckpoint(root: string, input: { reason: string; intent?: string; sessionId?: string; allowEmpty?: boolean }): Promise<{ ok: true; id: string; message: string }> {
  const config = await loadConfig(root);
  await ensureStore(root);
  const files: CheckpointFile[] = [];
  const skipped: string[] = [];
  for (const relPath of await listWorkspaceFiles(root, config)) {
    const absPath = resolveWorkspacePath(root, relPath);
    const stat = await fs.stat(absPath);
    if (stat.size > config.maxFileBytes) {
      skipped.push(`${relPath} larger than maxFileBytes (${stat.size})`);
      continue;
    }
    const bytes = await fs.readFile(absPath);
    const sha256 = hashBytes(bytes);
    await writeBlob(root, sha256, bytes);
    files.push({ path: relPath, kind: 'file', blob: sha256, sha256, size: bytes.length, binary: isProbablyBinary(bytes) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifestHash = hashBytes(Buffer.from(JSON.stringify(files.map(file => [file.path, file.sha256, file.size]))));
  const latest = await getLatestCheckpoint(root);
  if (!input.allowEmpty && latest?.manifestHash === manifestHash) {
    return { ok: true, id: latest.id, message: `Skipped checkpoint because workspace matches ${latest.id}` };
  }
  const checkpoint: Checkpoint = {
    id: makeId('cp'),
    createdAt: new Date().toISOString(),
    reason: input.reason,
    intent: input.intent,
    sessionId: input.sessionId,
    files,
    skipped,
    manifestHash,
    stats: { files: files.length, skipped: skipped.length, sizeBytes: files.reduce((sum, file) => sum + file.size, 0) }
  };
  await writeJsonAtomic(checkpointPath(root, checkpoint.id), checkpoint);
  await enforceStorageLimit(root, config, new Set([checkpoint.id]));
  return { ok: true, id: checkpoint.id, message: `Created checkpoint ${checkpoint.id} with ${files.length} files` };
}

export async function listCheckpoints(root: string): Promise<Array<Pick<Checkpoint, 'id' | 'createdAt' | 'reason' | 'intent' | 'sessionId' | 'manifestHash'> & { files: number; sizeBytes: number }>> {
  await ensureStore(root);
  const names = await safeReaddir(checkpointsDir(root));
  const checkpoints = await Promise.all(names.filter(name => name.endsWith('.json')).map(name => readJson<Checkpoint>(path.join(checkpointsDir(root), name))));
  return checkpoints
    .map(cp => ({ id: cp.id, createdAt: cp.createdAt, reason: cp.reason, intent: cp.intent, sessionId: cp.sessionId, manifestHash: cp.manifestHash, files: cp.files.length, sizeBytes: cp.stats.sizeBytes }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function diffCheckpoint(root: string, id: string): Promise<{ ok: true; text: string }> {
  const config = await loadConfig(root);
  const checkpoint = await loadCheckpoint(root, id);
  const before = byPath(checkpoint.files);
  const currentFiles = new Set(await listWorkspaceFiles(root, config));
  const all = [...new Set([...before.keys(), ...currentFiles])].sort();
  const chunks: string[] = [];
  for (const relPath of all) {
    validateRelativePath(relPath);
    const checkpointFile = before.get(relPath);
    const currentExists = currentFiles.has(relPath);
    if (!checkpointFile && currentExists) {
      chunks.push(renderAddedDiff(config, relPath, await fs.readFile(resolveWorkspacePath(root, relPath))));
    } else if (checkpointFile && !currentExists) {
      const oldBytes = await readBlob(root, checkpointFile.blob);
      chunks.push(renderDeletedDiff(config, relPath, oldBytes, checkpointFile));
    } else if (checkpointFile && currentExists) {
      const currentBytes = await fs.readFile(resolveWorkspacePath(root, relPath));
      if (hashBytes(currentBytes) !== checkpointFile.sha256) {
        chunks.push(renderChangedDiff(config, relPath, await readBlob(root, checkpointFile.blob), currentBytes, checkpointFile));
      }
    }
  }
  let text = chunks.filter(Boolean).join('\n');
  if (!text.trim()) {
    text = `No changes since checkpoint ${id}.`;
  }
  if (Buffer.byteLength(text) > config.maxDiffBytes) {
    text = `${text.slice(0, config.maxDiffBytes)}\n\n[diff truncated at ${config.maxDiffBytes} bytes]`;
  }
  return { ok: true, text };
}

export async function rewindToCheckpoint(root: string, input: { id: string; dryRun?: boolean; fullRestore?: boolean; changeCheckpoint?: boolean }): Promise<{ ok: boolean; message: string; report: RewindReport }> {
  const config = await loadConfig(root);
  const selected = await loadCheckpoint(root, input.id);
  const report: RewindReport = {
    checkpointId: input.id,
    mode: input.fullRestore ? 'full' : input.changeCheckpoint ? 'change' : 'delta',
    dryRun: Boolean(input.dryRun),
    restored: [],
    deleted: [],
    unchanged: [],
    skipped: [],
    errors: []
  };
  if (!input.dryRun) {
    const safety = await createCheckpoint(root, { reason: `safety-before-rewind:${input.id}`, allowEmpty: true });
    report.safetyCheckpointId = safety.id;
  }
  if (input.fullRestore) {
    await rewindFull(root, config, selected, report, input.dryRun);
  } else if (input.changeCheckpoint) {
    const previous = await getPreviousCheckpoint(root, selected);
    if (!previous) {
      report.errors.push(`Checkpoint ${selected.id} has no previous checkpoint.`);
    } else {
      await rewindWindow(root, config, previous, selected, report, input.dryRun);
    }
  } else {
    await rewindWindow(root, config, selected, await getNextCheckpoint(root, selected), report, input.dryRun);
  }
  if (!input.dryRun) {
    await enforceStorageLimit(root, config, new Set([input.id, report.safetyCheckpointId].filter(Boolean) as string[]));
  }
  return { ok: report.errors.length === 0, message: `${report.mode} rewind ${input.dryRun ? 'dry run ' : ''}complete for ${input.id}`, report };
}

async function rewindWindow(root: string, config: AgenticRewindConfig, base: Checkpoint, after: Checkpoint | undefined, report: RewindReport, dryRun?: boolean): Promise<void> {
  report.windowStartCheckpointId = base.id;
  report.windowEndCheckpointId = after?.id ?? 'current-workspace';
  const baseByPath = byPath(base.files);
  const afterByPath = after ? byPath(after.files) : await currentFilesByPath(root, config);
  const currentByPath = await currentFilesByPath(root, config);
  const changed = changedPathsBetween(baseByPath, afterByPath);
  for (const relPath of changed) {
    try {
      const baseFile = baseByPath.get(relPath);
      const afterFile = afterByPath.get(relPath);
      const currentFile = currentByPath.get(relPath);
      if (after && !sameFile(currentFile, afterFile)) {
        const patched = await tryLinePatch(root, config, relPath, baseFile, afterFile, currentFile);
        if (!patched.ok) {
          report.skipped.push(`${relPath} changed after checkpoint window; ${patched.reason}`);
          continue;
        }
        report.restored.push(`${relPath} (patched)`);
        if (!dryRun) {
          await fs.writeFile(resolveWorkspacePath(root, relPath), patched.bytes);
        }
        continue;
      }
      if (!baseFile) {
        if (!currentFile) {
          report.unchanged.push(relPath);
          continue;
        }
        report.deleted.push(relPath);
        if (!dryRun) {
          const target = resolveWorkspacePath(root, relPath);
          await fs.rm(target, { force: true });
          await removeEmptyParents(root, path.dirname(target));
        }
        continue;
      }
      if (sameFile(currentFile, baseFile)) {
        report.unchanged.push(relPath);
        continue;
      }
      report.restored.push(relPath);
      if (!dryRun) {
        const target = resolveWorkspacePath(root, relPath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, await readBlob(root, baseFile.blob));
      }
    } catch (error: any) {
      report.errors.push(`${relPath}: ${error.message}`);
    }
  }
}

async function rewindFull(root: string, config: AgenticRewindConfig, checkpoint: Checkpoint, report: RewindReport, dryRun?: boolean): Promise<void> {
  const checkpointByPath = byPath(checkpoint.files);
  const current = await listWorkspaceFiles(root, config);
  const currentSet = new Set(current);
  for (const file of checkpoint.files) {
    const target = resolveWorkspacePath(root, file.path);
    if (currentSet.has(file.path) && hashBytes(await fs.readFile(target)) === file.sha256) {
      report.unchanged.push(file.path);
      continue;
    }
    report.restored.push(file.path);
    if (!dryRun) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, await readBlob(root, file.blob));
    }
  }
  for (const relPath of current) {
    if (checkpointByPath.has(relPath)) {
      continue;
    }
    report.deleted.push(relPath);
    if (!dryRun) {
      const target = resolveWorkspacePath(root, relPath);
      await fs.rm(target, { force: true });
      await removeEmptyParents(root, path.dirname(target));
    }
  }
}

async function tryLinePatch(root: string, config: AgenticRewindConfig, relPath: string, baseFile?: CheckpointFile, afterFile?: CheckpointFile, currentFile?: CheckpointFile): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: string }> {
  if (!baseFile || !afterFile || !currentFile) {
    return { ok: false, reason: 'newer create/delete edit; not safe to patch.' };
  }
  if (baseFile.binary || afterFile.binary || currentFile.binary) {
    return { ok: false, reason: 'binary file cannot be line-patched safely.' };
  }
  const baseBytes = await readBlob(root, baseFile.blob);
  const afterBytes = await readBlob(root, afterFile.blob);
  const currentBytes = await fs.readFile(resolveWorkspacePath(root, relPath));
  const baseLines = splitLines(baseBytes.toString('utf8'));
  const afterLines = splitLines(afterBytes.toString('utf8'));
  const currentLines = splitLines(currentBytes.toString('utf8'));
  if (baseLines.length * afterLines.length > config.maxTextDiffLinesProduct) {
    return { ok: false, reason: 'text diff is too large.' };
  }
  const patch = applyReverseLinePatch(baseLines, afterLines, currentLines);
  return patch.ok ? { ok: true, bytes: Buffer.from(joinLines(patch.lines), 'utf8') } : patch;
}

export async function currentFilesByPath(root: string, config: AgenticRewindConfig): Promise<Map<string, CheckpointFile>> {
  const current = new Map<string, CheckpointFile>();
  for (const relPath of await listWorkspaceFiles(root, config)) {
    const bytes = await fs.readFile(resolveWorkspacePath(root, relPath));
    current.set(relPath, { path: relPath, kind: 'file', blob: '', sha256: hashBytes(bytes), size: bytes.length, binary: isProbablyBinary(bytes) });
  }
  return current;
}

export function changedPathsBetween(before: Map<string, CheckpointFile>, after: Map<string, CheckpointFile>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter(relPath => !sameFile(before.get(relPath), after.get(relPath))).sort();
}

export async function loadCheckpoint(root: string, id: string): Promise<Checkpoint> {
  if (!/^[a-zA-Z0-9_.:-]+$/.test(id)) {
    throw new Error(`Invalid checkpoint id: ${id}`);
  }
  return readJson<Checkpoint>(checkpointPath(root, id));
}

async function getLatestCheckpoint(root: string): Promise<Checkpoint | undefined> {
  const checkpoints = await listCheckpoints(root);
  return checkpoints[0] ? loadCheckpoint(root, checkpoints[0].id) : undefined;
}

async function getNextCheckpoint(root: string, checkpoint: Checkpoint): Promise<Checkpoint | undefined> {
  const next = (await listCheckpoints(root)).filter(item => item.createdAt > checkpoint.createdAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  return next ? loadCheckpoint(root, next.id) : undefined;
}

async function getPreviousCheckpoint(root: string, checkpoint: Checkpoint): Promise<Checkpoint | undefined> {
  const previous = (await listCheckpoints(root)).filter(item => item.createdAt < checkpoint.createdAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return previous ? loadCheckpoint(root, previous.id) : undefined;
}

function byPath(files: CheckpointFile[]): Map<string, CheckpointFile> {
  return new Map(files.map(file => [file.path, file]));
}

function sameFile(left?: CheckpointFile, right?: CheckpointFile): boolean {
  return Boolean(left && right && left.sha256 === right.sha256 && left.size === right.size) || (!left && !right);
}

async function writeBlob(root: string, sha256: string, bytes: Buffer): Promise<void> {
  const target = blobPath(root, sha256);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.access(target);
  } catch {
    await fs.writeFile(target, bytes);
  }
}

async function readBlob(root: string, sha256: string): Promise<Buffer> {
  return fs.readFile(blobPath(root, sha256));
}

function blobPath(root: string, sha256: string): string {
  return path.join(blobsDir(root), sha256.slice(0, 2), sha256);
}

function checkpointPath(root: string, id: string): string {
  return path.join(checkpointsDir(root), `${id}.json`);
}

async function enforceStorageLimit(root: string, config: AgenticRewindConfig, keep: Set<string>): Promise<void> {
  let checkpoints = await listCheckpoints(root);
  while (checkpoints.length > config.maxCheckpoints) {
    const oldest = checkpoints[checkpoints.length - 1];
    if (keep.has(oldest.id)) {
      break;
    }
    await fs.rm(checkpointPath(root, oldest.id), { force: true });
    checkpoints = await listCheckpoints(root);
  }
}

function renderAddedDiff(config: AgenticRewindConfig, relPath: string, bytes: Buffer): string {
  return isProbablyBinary(bytes) ? `Binary file added: ${relPath} (${bytes.length} bytes)` : unifiedDiff('/dev/null', `workspace/${relPath}`, '', bytes.toString('utf8'), config.maxTextDiffLinesProduct);
}

function renderDeletedDiff(config: AgenticRewindConfig, relPath: string, bytes: Buffer, file: CheckpointFile): string {
  return file.binary || isProbablyBinary(bytes) ? `Binary file deleted: ${relPath} (${bytes.length} bytes)` : unifiedDiff(`checkpoint/${relPath}`, '/dev/null', bytes.toString('utf8'), '', config.maxTextDiffLinesProduct);
}

function renderChangedDiff(config: AgenticRewindConfig, relPath: string, oldBytes: Buffer, newBytes: Buffer, oldFile: CheckpointFile): string {
  return oldFile.binary || isProbablyBinary(oldBytes) || isProbablyBinary(newBytes)
    ? `Binary file changed: ${relPath} (${oldBytes.length} -> ${newBytes.length} bytes)`
    : unifiedDiff(`checkpoint/${relPath}`, `workspace/${relPath}`, oldBytes.toString('utf8'), newBytes.toString('utf8'), config.maxTextDiffLinesProduct);
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
