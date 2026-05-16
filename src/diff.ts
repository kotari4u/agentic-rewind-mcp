export interface LineOp {
  type: 'equal' | 'insert' | 'delete';
  text: string;
  oldLine: number;
  newLine: number;
}

export function splitLines(text: string): string[] {
  if (!text) {
    return [];
  }
  return text.replace(/\n$/, '').split(/\r?\n/);
}

export function joinLines(lines: string[]): string {
  return lines.length ? `${lines.join('\n')}\n` : '';
}

export function unifiedDiff(from: string, to: string, oldText: string, newText: string, maxProduct: number): string {
  if (oldText === newText) {
    return '';
  }
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length * newLines.length > maxProduct) {
    return [`--- ${from}`, `+++ ${to}`, '@@ text diff skipped @@', `[text diff too large: ${oldLines.length} x ${newLines.length} lines]`].join('\n');
  }
  const hunks = buildUnifiedHunks(oldLines, newLines, 3);
  return [
    `--- ${from}`,
    `+++ ${to}`,
    ...hunks.flatMap(hunk => [
      `@@ -${range(hunk.oldStart, hunk.oldCount)} +${range(hunk.newStart, hunk.newCount)} @@`,
      ...hunk.lines.map(line => `${line.type}${line.text}`)
    ])
  ].join('\n');
}

export function diffLineOps(oldLines: string[], newLines: string[]): LineOp[] {
  const oldLength = oldLines.length;
  const newLength = newLines.length;
  const table = Array.from({ length: oldLength + 1 }, () => new Uint32Array(newLength + 1));
  for (let oldIndex = oldLength - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLength - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? table[oldIndex + 1][newIndex + 1] + 1
        : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
    }
  }

  const ops: LineOp[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let oldLine = 1;
  let newLine = 1;
  while (oldIndex < oldLength || newIndex < newLength) {
    if (oldIndex < oldLength && newIndex < newLength && oldLines[oldIndex] === newLines[newIndex]) {
      ops.push({ type: 'equal', text: oldLines[oldIndex], oldLine, newLine });
      oldIndex += 1;
      newIndex += 1;
      oldLine += 1;
      newLine += 1;
    } else if (newIndex < newLength && (oldIndex === oldLength || table[oldIndex][newIndex + 1] > table[oldIndex + 1][newIndex])) {
      ops.push({ type: 'insert', text: newLines[newIndex], oldLine, newLine });
      newIndex += 1;
      newLine += 1;
    } else {
      ops.push({ type: 'delete', text: oldLines[oldIndex], oldLine, newLine });
      oldIndex += 1;
      oldLine += 1;
    }
  }
  return ops;
}

export function applyReverseLinePatch(baseLines: string[], afterLines: string[], currentLines: string[]): { ok: true; lines: string[] } | { ok: false; reason: string } {
  const blocks = buildChangeBlocks(baseLines, afterLines);
  const patched = [...currentLines];
  for (const block of blocks.reverse()) {
    const result = applyReverseBlock(patched, afterLines, block);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true, lines: patched };
}

function buildUnifiedHunks(oldLines: string[], newLines: string[], context: number) {
  const ops = diffLineOps(oldLines, newLines);
  const changed = ops.flatMap((op, index) => op.type === 'equal' ? [] : [index]);
  if (!changed.length) {
    return [];
  }
  const groups: Array<[number, number]> = [];
  let start = changed[0];
  let end = changed[0];
  for (const index of changed.slice(1)) {
    if (index - end <= context * 2 + 1) {
      end = index;
    } else {
      groups.push([start, end]);
      start = index;
      end = index;
    }
  }
  groups.push([start, end]);
  return groups.map(([firstChange, lastChange]) => {
    const slice = ops.slice(Math.max(0, firstChange - context), Math.min(ops.length, lastChange + context + 1));
    return {
      oldStart: slice[0].oldLine,
      newStart: slice[0].newLine,
      oldCount: slice.reduce((sum, op) => sum + (op.type === 'insert' ? 0 : 1), 0),
      newCount: slice.reduce((sum, op) => sum + (op.type === 'delete' ? 0 : 1), 0),
      lines: slice.map(op => ({ type: op.type === 'equal' ? ' ' : op.type === 'delete' ? '-' : '+', text: op.text }))
    };
  });
}

function buildChangeBlocks(oldLines: string[], newLines: string[]) {
  const ops = diffLineOps(oldLines, newLines);
  const blocks: Array<{ newStartIndex: number; oldChange: string[]; newChange: string[] }> = [];
  for (let index = 0; index < ops.length;) {
    if (ops[index].type === 'equal') {
      index += 1;
      continue;
    }
    const first = ops[index];
    const oldChange: string[] = [];
    const newChange: string[] = [];
    while (index < ops.length && ops[index].type !== 'equal') {
      if (ops[index].type === 'delete') {
        oldChange.push(ops[index].text);
      } else {
        newChange.push(ops[index].text);
      }
      index += 1;
    }
    blocks.push({ newStartIndex: first.newLine - 1, oldChange, newChange });
  }
  return blocks;
}

function applyReverseBlock(lines: string[], afterLines: string[], block: { newStartIndex: number; oldChange: string[]; newChange: string[] }) {
  if (block.newChange.length > 0) {
    const index = findSequence(lines, block.newChange, block.newStartIndex);
    if (index === -1) {
      return { ok: false as const, reason: 'overlapping newer edit; reverse patch context was not found.' };
    }
    lines.splice(index, block.newChange.length, ...block.oldChange);
    return { ok: true as const };
  }
  const index = findInsertionPoint(lines, afterLines, block.newStartIndex);
  if (index === -1) {
    return { ok: false as const, reason: 'overlapping newer edit; insertion context was not found.' };
  }
  lines.splice(index, 0, ...block.oldChange);
  return { ok: true as const };
}

function findSequence(lines: string[], sequence: string[], preferredIndex: number): number {
  const start = Math.max(0, preferredIndex - 50);
  const end = Math.min(lines.length - sequence.length, preferredIndex + 50);
  for (let index = start; index <= end; index += 1) {
    if (sequence.every((line, offset) => lines[index + offset] === line)) {
      return index;
    }
  }
  const matches: number[] = [];
  for (let index = 0; index <= lines.length - sequence.length; index += 1) {
    if (sequence.every((line, offset) => lines[index + offset] === line)) {
      matches.push(index);
      if (matches.length > 1) {
        return -1;
      }
    }
  }
  return matches[0] ?? -1;
}

function findInsertionPoint(lines: string[], afterLines: string[], preferredIndex: number): number {
  const before = afterLines.slice(Math.max(0, preferredIndex - 3), preferredIndex);
  const after = afterLines.slice(preferredIndex, preferredIndex + 3);
  const matches: number[] = [];
  for (let index = 0; index <= lines.length; index += 1) {
    if (contextMatches(lines, index, before, after)) {
      if (Math.abs(index - preferredIndex) <= 50) {
        return index;
      }
      matches.push(index);
    }
  }
  return matches.length === 1 ? matches[0] : -1;
}

function contextMatches(lines: string[], index: number, before: string[], after: string[]): boolean {
  if (index < before.length || index + after.length > lines.length) {
    return false;
  }
  return before.every((line, offset) => lines[index - before.length + offset] === line)
    && after.every((line, offset) => lines[index + offset] === line);
}

function range(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}
