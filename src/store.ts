import fs from 'node:fs/promises';
import path from 'node:path';
import { STORE_DIR } from './config.js';
import type { DecisionRecord, EventRecord } from './types.js';

export function checkpointsDir(root: string): string {
  return path.join(root, STORE_DIR, 'checkpoints');
}

export function blobsDir(root: string): string {
  return path.join(root, STORE_DIR, 'blobs');
}

export function memoryDir(root: string): string {
  return path.join(root, STORE_DIR, 'memory');
}

export function eventsPath(root: string): string {
  return path.join(memoryDir(root), 'events.jsonl');
}

export function decisionsPath(root: string): string {
  return path.join(memoryDir(root), 'decisions.jsonl');
}

export async function ensureStore(root: string): Promise<void> {
  await fs.mkdir(checkpointsDir(root), { recursive: true });
  await fs.mkdir(blobsDir(root), { recursive: true });
  await fs.mkdir(memoryDir(root), { recursive: true });
}

export async function appendEvent(root: string, event: Omit<EventRecord, 'id' | 'timestamp'>): Promise<EventRecord> {
  await ensureStore(root);
  const record: EventRecord = {
    id: makeId('event'),
    timestamp: new Date().toISOString(),
    ...event
  };
  await fs.appendFile(eventsPath(root), `${JSON.stringify(record)}\n`);
  return record;
}

export async function appendDecision(root: string, decision: Omit<DecisionRecord, 'id' | 'timestamp'>): Promise<DecisionRecord> {
  await ensureStore(root);
  const record: DecisionRecord = {
    id: makeId('decision'),
    timestamp: new Date().toISOString(),
    ...decision
  };
  await fs.appendFile(decisionsPath(root), `${JSON.stringify(record)}\n`);
  return record;
}

export async function readEvents(root: string, limit = 100): Promise<EventRecord[]> {
  return readJsonl<EventRecord>(eventsPath(root), limit);
}

export async function readDecisions(root: string, limit = 100): Promise<DecisionRecord[]> {
  return readJsonl<DecisionRecord>(decisionsPath(root), limit);
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tmp, file);
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

export function makeId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
  return `${prefix}_${stamp}_${Math.random().toString(16).slice(2, 8)}`;
}

async function readJsonl<T>(file: string, limit: number): Promise<T[]> {
  try {
    const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
    return lines.slice(-limit).map(line => JSON.parse(line) as T);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
