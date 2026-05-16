#!/usr/bin/env node
import { createCheckpoint, diffCheckpoint, listCheckpoints, rewindToCheckpoint } from './checkpoint.js';
import { assessRisk, planSafety, prepareHexMemorySave, prepareHexMemorySearch, recommendAction, recordDecision, recordEvent, searchMemory, summarizeSession } from './agent.js';

main().catch(error => {
  const json = process.argv.includes('--json');
  if (json) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message }, null, 2));
  } else {
    process.stderr.write(`${error.stack ?? error.message}\n`);
  }
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = takeFlag(args, '--json');
  const command = args.shift() ?? 'help';
  const root = process.env.AGENTIC_REWIND_WORKSPACE ?? process.cwd();

  if (command === 'help' || command === '--help') {
    return output(json, {
      text: [
        'agentic-rewind commands:',
        '  event --type <HookEvent>',
        '  checkpoint --reason <reason> [--intent <intent>]',
        '  list',
        '  diff <checkpoint-id>',
        '  rewind <checkpoint-id> [--dry-run] [--change] [--full]',
        '  assess-risk [checkpoint-id]',
        '  recommend [checkpoint-id] [--test-status pass|fail|unknown]',
        '  record-decision --decision <decision> --reason <reason>',
        '  search-memory --query <query>',
        '  prepare-hex-save [--decision-id <id>] [--task-type <type>] [--change-type <type>] [--outcome <outcome>]',
        '  prepare-hex-search [--query <query>] [--task-type <type>] [--change-type <type>]',
        '  summarize-session'
      ].join('\n')
    });
  }

  if (command === 'event') {
    const type = takeOption(args, '--type') ?? 'Unknown';
    const raw = await readStdinJson();
    const event = await recordEvent(root, {
      type,
      sessionId: raw?.session_id ?? raw?.sessionId,
      toolName: raw?.tool_name ?? raw?.toolName,
      prompt: raw?.prompt,
      cwd: raw?.cwd ?? root,
      raw
    });
    return output(json, { ok: true, event }, { quiet: true });
  }

  if (command === 'checkpoint') {
    return output(json, await createCheckpoint(root, {
      reason: takeOption(args, '--reason') ?? 'agent requested checkpoint',
      intent: takeOption(args, '--intent')
    }));
  }

  if (command === 'list') {
    return output(json, { ok: true, checkpoints: await listCheckpoints(root) });
  }

  if (command === 'diff') {
    const id = args.shift();
    if (!id) throw new Error('Missing checkpoint id');
    return output(json, await diffCheckpoint(root, id));
  }

  if (command === 'rewind') {
    const id = args.shift();
    if (!id) throw new Error('Missing checkpoint id');
    return output(json, await rewindToCheckpoint(root, {
      id,
      dryRun: takeFlag(args, '--dry-run'),
      fullRestore: takeFlag(args, '--full'),
      changeCheckpoint: takeFlag(args, '--change')
    }));
  }

  if (command === 'assess-risk') {
    return output(json, { ok: true, assessment: await assessRisk(root, { checkpointId: args[0] }) });
  }

  if (command === 'recommend') {
    return output(json, { ok: true, recommendation: await recommendAction(root, {
      checkpointId: args[0]?.startsWith('--') ? undefined : args[0],
      testStatus: takeOption(args, '--test-status') as any
    }) });
  }

  if (command === 'record-decision') {
    return output(json, { ok: true, decision: await recordDecision(root, {
      decision: takeOption(args, '--decision') ?? 'no_action',
      reason: takeOption(args, '--reason') ?? 'manual decision record'
    }) });
  }

  if (command === 'search-memory') {
    return output(json, { ok: true, ...await searchMemory(root, { query: takeOption(args, '--query') ?? '' }) });
  }

  if (command === 'prepare-hex-save') {
    return output(json, { ok: true, ...await prepareHexMemorySave(root, {
      decisionId: takeOption(args, '--decision-id'),
      workspaceName: takeOption(args, '--workspace-name'),
      taskType: takeOption(args, '--task-type'),
      changeType: takeOption(args, '--change-type'),
      outcome: takeOption(args, '--outcome'),
      testsBefore: takeOption(args, '--tests-before') as any,
      testsAfter: takeOption(args, '--tests-after') as any,
      notes: takeOption(args, '--notes')
    }) });
  }

  if (command === 'prepare-hex-search') {
    return output(json, { ok: true, ...await prepareHexMemorySearch(root, {
      query: takeOption(args, '--query'),
      taskType: takeOption(args, '--task-type'),
      changeType: takeOption(args, '--change-type'),
      risk: takeOption(args, '--risk') as any
    }) });
  }

  if (command === 'summarize-session') {
    return output(json, { ok: true, ...await summarizeSession(root) });
  }

  if (command === 'plan-safety') {
    return output(json, { ok: true, ...await planSafety(root) });
  }

  throw new Error(`Unknown command: ${command}`);
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

async function readStdinJson(): Promise<any | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function output(json: boolean, result: any, options: { quiet?: boolean } = {}): void {
  if (options.quiet && !json) return;
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2));
  } else if (result.text) {
    process.stdout.write(`${result.text}\n`);
  } else if (result.message) {
    process.stdout.write(`${result.message}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
