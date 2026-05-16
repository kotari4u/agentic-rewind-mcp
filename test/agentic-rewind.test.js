import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCheckpoint, diffCheckpoint, listCheckpoints, rewindToCheckpoint } from '../dist/checkpoint.js';
import { assessRisk, recommendAction, recordDecision, recordEvent, searchMemory, summarizeSession } from '../dist/agent.js';

test('agent can checkpoint, change-rewind middle Java method, and preserve later method', async () => {
  const root = await workspace();
  await write(root, 'src/Addition.java', javaClass('Addition', []));
  await write(root, 'src/Multiply.java', javaClass('Multiply', []));
  await createCheckpoint(root, { reason: 'classes-created' });

  await write(root, 'src/Addition.java', javaClass('Addition', ['print']));
  await write(root, 'src/Multiply.java', javaClass('Multiply', ['print']));
  await createCheckpoint(root, { reason: 'print-added' });

  await write(root, 'src/Addition.java', javaClass('Addition', ['print', 'print1']));
  await write(root, 'src/Multiply.java', javaClass('Multiply', ['print', 'print1']));
  const print1 = await createCheckpoint(root, { reason: 'print1-added', intent: 'add print1 methods' });

  await write(root, 'src/Addition.java', javaClass('Addition', ['print', 'print1', 'print2']));
  await write(root, 'src/Multiply.java', javaClass('Multiply', ['print', 'print1', 'print2']));
  const result = await rewindToCheckpoint(root, { id: print1.id, changeCheckpoint: true });

  assert.equal(result.ok, true);
  assert.deepEqual(result.report.restored, ['src/Addition.java (patched)', 'src/Multiply.java (patched)']);
  assert.equal(await read(root, 'src/Addition.java'), javaClass('Addition', ['print', 'print2']));
  assert.equal(await read(root, 'src/Multiply.java'), javaClass('Multiply', ['print', 'print2']));
});

test('risk assessment marks auth and dependency changes high risk', async () => {
  const root = await workspace();
  await write(root, 'src/auth/LoginService.java', 'class LoginService {}\n');
  await write(root, 'package.json', '{"name":"demo"}\n');
  const risk = await assessRisk(root);

  assert.equal(risk.risk, 'high');
  assert.match(risk.reasons.join('\n'), /High-risk path/);
  assert.equal(risk.recommendedAction, 'create_checkpoint');
});

test('recommendation asks for change rewind after test failure', async () => {
  const root = await workspace();
  await write(root, 'Calculator.java', javaClass('Calculator', ['print']));
  const cp = await createCheckpoint(root, { reason: 'after calculator edit' });
  const recommendation = await recommendAction(root, { checkpointId: cp.id, testStatus: 'fail' });

  assert.equal(recommendation.decision, 'recommend_rewind');
  assert.equal(recommendation.mode, 'change');
  assert.equal(recommendation.requiresApproval, true);
});

test('hooks record events without creating checkpoints by default', async () => {
  const root = await workspace();
  await write(root, 'a.txt', 'hello\n');
  await recordEvent(root, { type: 'PreToolUse', toolName: 'editFiles', prompt: 'modify a.txt' });
  const checkpoints = await listCheckpoints(root);
  const summary = await summarizeSession(root);

  assert.equal(checkpoints.length, 0);
  assert.equal(summary.events.length, 1);
  assert.match(summary.summary, /Events: 1/);
});

test('decision memory is searchable', async () => {
  const root = await workspace();
  await recordDecision(root, {
    decision: 'recommend_rewind',
    action: 'rewind --change',
    risk: 'medium',
    confidence: 0.8,
    reason: 'JUnit failed after print1 method addition',
    outcome: 'tests_passed_after_rewind'
  });
  const result = await searchMemory(root, { query: 'print1', limit: 5 });

  assert.equal(result.matches.length, 1);
  assert.match(JSON.stringify(result.matches[0]), /tests_passed_after_rewind/);
});

test('diff is hunk based', async () => {
  const root = await workspace();
  await write(root, 'file.txt', Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  const cp = await createCheckpoint(root, { reason: 'before' });
  await write(root, 'file.txt', Array.from({ length: 20 }, (_, i) => i === 9 ? 'line 10 changed' : `line ${i + 1}`).join('\n') + '\n');
  const diff = await diffCheckpoint(root, cp.id);

  assert.match(diff.text, /^\+line 10 changed$/m);
  assert.doesNotMatch(diff.text, /line 1\n/);
});

async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'agentic-rewind-'));
}

async function write(root, rel, text) {
  const target = path.join(root, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text);
}

async function read(root, rel) {
  return fs.readFile(path.join(root, rel), 'utf8');
}

function javaClass(name, methods) {
  const body = methods.map(method => `    public void ${method}() {\n        System.out.println("${name}.${method}");\n    }`).join('\n\n');
  return body ? `public class ${name} {\n${body}\n}\n` : `public class ${name} {\n}\n`;
}
