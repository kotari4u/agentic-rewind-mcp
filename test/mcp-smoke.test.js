import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('MCP server lists agentic rewind tools over stdio', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-rewind-mcp-'));
  const client = spawn(process.execPath, ['dist/mcp-server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      AGENTIC_REWIND_WORKSPACE: root
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const messages = [];
  let buffer = '';
  client.stdout.setEncoding('utf8');
  client.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        messages.push(JSON.parse(line));
      }
    }
  });

  client.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' }
    }
  })}\n`);
  await waitFor(messages, message => message.id === 1);

  client.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  client.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  const list = await waitFor(messages, message => message.id === 2);
  client.kill();

  const names = list.result.tools.map(tool => tool.name);
  assert.ok(names.includes('rewind_assess_risk'));
  assert.ok(names.includes('rewind_recommend_action'));
  assert.ok(names.includes('rewind_record_decision'));
  assert.ok(names.includes('rewind_restore_checkpoint'));
});

function waitFor(messages, predicate) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      const found = messages.find(predicate);
      if (found) {
        clearInterval(timer);
        resolve(found);
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for MCP message. Saw: ${JSON.stringify(messages)}`));
      }
    }, 10);
  });
}
