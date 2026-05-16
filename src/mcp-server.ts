#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createCheckpoint, diffCheckpoint, listCheckpoints, rewindToCheckpoint } from './checkpoint.js';
import { assessRisk, planSafety, prepareHexMemorySave, prepareHexMemorySearch, recommendAction, recordDecision, recordEvent, searchMemory, summarizeSession } from './agent.js';

const server = new McpServer({
  name: 'agentic-rewind',
  version: '0.1.0'
});

function root(inputRoot?: string): string {
  return inputRoot ?? process.env.AGENTIC_REWIND_WORKSPACE ?? process.cwd();
}

function json(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

server.tool('rewind_create_checkpoint', 'Create a workspace checkpoint when the agent decides risk or task phase warrants it.', {
  workspaceRoot: z.string().optional(),
  reason: z.string(),
  intent: z.string().optional()
}, async input => json(await createCheckpoint(root(input.workspaceRoot), { reason: input.reason, intent: input.intent })));

server.tool('rewind_list_checkpoints', 'List available checkpoints with reason, intent, and metadata.', {
  workspaceRoot: z.string().optional()
}, async input => json({ checkpoints: await listCheckpoints(root(input.workspaceRoot)) }));

server.tool('rewind_diff_checkpoint', 'Show a hunk-based diff between a checkpoint and the current workspace.', {
  workspaceRoot: z.string().optional(),
  checkpointId: z.string()
}, async input => json(await diffCheckpoint(root(input.workspaceRoot), input.checkpointId)));

server.tool('rewind_restore_checkpoint', 'Restore a checkpoint. Default mode undoes changes after the checkpoint; changeCheckpoint undoes the change that produced the checkpoint.', {
  workspaceRoot: z.string().optional(),
  checkpointId: z.string(),
  dryRun: z.boolean().optional(),
  changeCheckpoint: z.boolean().optional(),
  fullRestore: z.boolean().optional()
}, async input => json(await rewindToCheckpoint(root(input.workspaceRoot), {
  id: input.checkpointId,
  dryRun: input.dryRun,
  changeCheckpoint: input.changeCheckpoint,
  fullRestore: input.fullRestore
})));

server.tool('rewind_assess_risk', 'Assess risk for current workspace changes or changes since a checkpoint.', {
  workspaceRoot: z.string().optional(),
  checkpointId: z.string().optional(),
  files: z.array(z.string()).optional()
}, async input => json(await assessRisk(root(input.workspaceRoot), { checkpointId: input.checkpointId, files: input.files })));

server.tool('rewind_recommend_action', 'Recommend the next autonomous action using risk, checkpoint, and optional test status.', {
  workspaceRoot: z.string().optional(),
  checkpointId: z.string().optional(),
  testStatus: z.enum(['pass', 'fail', 'unknown']).optional(),
  lastError: z.string().optional()
}, async input => json(await recommendAction(root(input.workspaceRoot), { checkpointId: input.checkpointId, testStatus: input.testStatus, lastError: input.lastError })));

server.tool('rewind_plan_safety', 'Create an agent safety plan for a task or file set.', {
  workspaceRoot: z.string().optional(),
  task: z.string().optional(),
  files: z.array(z.string()).optional()
}, async input => json(await planSafety(root(input.workspaceRoot), { task: input.task, files: input.files })));

server.tool('rewind_record_event', 'Record an observed hook/tool/prompt event into memory.', {
  workspaceRoot: z.string().optional(),
  type: z.string(),
  sessionId: z.string().optional(),
  toolName: z.string().optional(),
  prompt: z.string().optional(),
  files: z.array(z.string()).optional()
}, async input => json(await recordEvent(root(input.workspaceRoot), input)));

server.tool('rewind_record_decision', 'Record an agent decision, reason, risk, approval, and outcome into memory.', {
  workspaceRoot: z.string().optional(),
  sessionId: z.string().optional(),
  event: z.string().optional(),
  checkpointId: z.string().optional(),
  decision: z.string(),
  action: z.string().optional(),
  confidence: z.number().optional(),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  reason: z.string(),
  files: z.array(z.string()).optional(),
  approvedByUser: z.boolean().optional(),
  outcome: z.string().optional()
}, async input => {
  const { workspaceRoot, ...decision } = input;
  return json(await recordDecision(root(workspaceRoot), decision));
});

server.tool('rewind_search_memory', 'Search event and decision memory for similar past situations.', {
  workspaceRoot: z.string().optional(),
  query: z.string(),
  limit: z.number().optional()
}, async input => json(await searchMemory(root(input.workspaceRoot), { query: input.query, limit: input.limit })));

server.tool('rewind_summarize_session', 'Summarize recent event and decision memory.', {
  workspaceRoot: z.string().optional(),
  sessionId: z.string().optional(),
  limit: z.number().optional()
}, async input => json(await summarizeSession(root(input.workspaceRoot), { sessionId: input.sessionId, limit: input.limit })));

server.tool('rewind_prepare_hex_memory_save', 'Prepare a sanitized decision/session/recovery record and instruct the agent to save it to hex_memory. This does not call Hex directly.', {
  workspaceRoot: z.string().optional(),
  decisionId: z.string().optional(),
  workspaceName: z.string().optional(),
  taskType: z.string().optional(),
  changeType: z.string().optional(),
  outcome: z.string().optional(),
  testsBefore: z.enum(['pass', 'fail', 'unknown']).optional(),
  testsAfter: z.enum(['pass', 'fail', 'unknown']).optional(),
  notes: z.string().optional()
}, async input => {
  const { workspaceRoot, ...payload } = input;
  return json(await prepareHexMemorySave(root(workspaceRoot), payload));
});

server.tool('rewind_prepare_hex_memory_search', 'Prepare a hex_memory search request and instruct the agent to search shared memory before deciding. This does not call Hex directly.', {
  workspaceRoot: z.string().optional(),
  query: z.string().optional(),
  taskType: z.string().optional(),
  changeType: z.string().optional(),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  tags: z.array(z.string()).optional()
}, async input => {
  const { workspaceRoot, ...payload } = input;
  return json(await prepareHexMemorySearch(root(workspaceRoot), payload));
});

await server.connect(new StdioServerTransport());
