import { loadConfig } from './config.js';
import { changedPathsBetween, currentFilesByPath, diffCheckpoint, listCheckpoints, loadCheckpoint } from './checkpoint.js';
import { listWorkspaceFiles } from './fs-utils.js';
import { appendDecision, appendEvent, readDecisions, readEvents } from './store.js';
import path from 'node:path';
import type { DecisionRecord, EventRecord, HexMemorySaveRequest, HexMemorySearchRequest, RecommendationDecision, RiskAssessment, RiskLevel } from './types.js';

export async function recordEvent(root: string, input: { type: string; sessionId?: string; toolName?: string; prompt?: string; cwd?: string; files?: string[]; raw?: unknown }): Promise<EventRecord> {
  return appendEvent(root, input);
}

export async function recordDecision(root: string, input: Omit<DecisionRecord, 'id' | 'timestamp'>): Promise<DecisionRecord> {
  return appendDecision(root, input);
}

export async function assessRisk(root: string, input: { checkpointId?: string; files?: string[] } = {}): Promise<RiskAssessment> {
  const config = await loadConfig(root);
  const files = input.files ?? await changedFiles(root, input.checkpointId);
  const addedFiles: string[] = [];
  const deletedFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const reasons: string[] = [];
  let score = 0;

  for (const file of files) {
    const kind = file.startsWith('+') ? 'added' : file.startsWith('-') ? 'deleted' : 'modified';
    const relPath = file.replace(/^[+-]/, '');
    if (kind === 'added') {
      addedFiles.push(relPath);
      score += 1;
    } else if (kind === 'deleted') {
      deletedFiles.push(relPath);
      score += 3;
      reasons.push(`Deleted file: ${relPath}`);
    } else {
      modifiedFiles.push(relPath);
      score += 1;
    }

    if (matchesAny(relPath, config.riskPolicy.highRisk)) {
      score += 10;
      reasons.push(`High-risk path: ${relPath}`);
    } else if (matchesAny(relPath, config.riskPolicy.mediumRisk)) {
      score += 3;
    } else if (matchesAny(relPath, config.riskPolicy.lowRisk)) {
      score -= 1;
    }
  }

  if (files.length >= 10) {
    score += 5;
    reasons.push(`Large change set: ${files.length} files`);
  }
  if (deletedFiles.length >= 3) {
    score += 5;
    reasons.push(`Multiple deleted files: ${deletedFiles.length}`);
  }
  if (!reasons.length && files.length) {
    reasons.push('Code or workspace files changed');
  }

  const risk: RiskLevel = score >= 10 ? 'high' : score >= 4 ? 'medium' : 'low';
  const recommendedAction: RecommendationDecision = risk === 'high'
    ? 'create_checkpoint'
    : risk === 'medium'
      ? 'run_tests'
      : files.length
        ? 'continue'
        : 'no_action';

  return {
    risk,
    score,
    reasons,
    files: files.map(file => file.replace(/^[+-]/, '')),
    changedFiles: files.length,
    addedFiles,
    deletedFiles,
    modifiedFiles,
    recommendedAction
  };
}

export async function recommendAction(root: string, input: { checkpointId?: string; testStatus?: 'pass' | 'fail' | 'unknown'; lastError?: string } = {}): Promise<{
  decision: RecommendationDecision;
  checkpointId?: string;
  mode?: 'delta' | 'change' | 'full';
  confidence: number;
  risk: RiskLevel;
  reason: string;
  requiresApproval: boolean;
}> {
  const checkpoints = await listCheckpoints(root);
  const checkpointId = input.checkpointId ?? checkpoints[0]?.id;
  const risk = await assessRisk(root, checkpointId ? { checkpointId } : {});

  if (input.testStatus === 'fail' && checkpointId) {
    return {
      decision: 'recommend_rewind',
      checkpointId,
      mode: 'change',
      confidence: risk.risk === 'low' ? 0.82 : 0.68,
      risk: risk.risk,
      reason: `Tests failed after checkpoint ${checkpointId}. Recommend rewinding the change that produced this checkpoint.`,
      requiresApproval: true
    };
  }

  if (risk.risk === 'high') {
    return {
      decision: 'create_checkpoint',
      checkpointId,
      confidence: 0.86,
      risk: risk.risk,
      reason: `High-risk changes detected: ${risk.reasons.join('; ')}`,
      requiresApproval: false
    };
  }

  if (risk.risk === 'medium') {
    return {
      decision: 'run_tests',
      checkpointId,
      confidence: 0.72,
      risk: risk.risk,
      reason: 'Medium-risk source changes detected. Run tests before continuing.',
      requiresApproval: false
    };
  }

  return {
    decision: 'continue',
    checkpointId,
    confidence: 0.66,
    risk: risk.risk,
    reason: risk.changedFiles ? 'Low-risk change set; continue with normal validation.' : 'No meaningful changes detected.',
    requiresApproval: false
  };
}

export async function searchMemory(root: string, input: { query: string; limit?: number }): Promise<{ matches: Array<EventRecord | DecisionRecord> }> {
  const query = input.query.toLowerCase();
  const items = [...await readDecisions(root, 500), ...await readEvents(root, 500)];
  const matches = items
    .filter(item => JSON.stringify(item).toLowerCase().includes(query))
    .slice(-(input.limit ?? 10))
    .reverse();
  return { matches };
}

export async function summarizeSession(root: string, input: { sessionId?: string; limit?: number } = {}): Promise<{ summary: string; events: EventRecord[]; decisions: DecisionRecord[] }> {
  const events = (await readEvents(root, input.limit ?? 100)).filter(event => !input.sessionId || event.sessionId === input.sessionId);
  const decisions = (await readDecisions(root, input.limit ?? 100)).filter(decision => !input.sessionId || decision.sessionId === input.sessionId);
  const summary = [
    `Events: ${events.length}`,
    `Decisions: ${decisions.length}`,
    `Rewind recommendations: ${decisions.filter(decision => decision.decision === 'recommend_rewind').length}`,
    `Approved decisions: ${decisions.filter(decision => decision.approvedByUser).length}`
  ].join('\n');
  return { summary, events, decisions };
}

export async function planSafety(root: string, input: { task?: string; files?: string[] } = {}): Promise<{ plan: string[]; risk: RiskAssessment }> {
  const risk = await assessRisk(root, { files: input.files });
  const plan = [
    'Record current prompt/tool events in memory.',
    risk.risk === 'high' ? 'Create a checkpoint before editing high-risk files.' : 'Create a checkpoint before the first source edit.',
    'Run focused tests after each meaningful checkpoint.',
    'If tests fail, call rewind_recommend_action before editing further.',
    'Require user approval before any real rewind.',
    'Record the decision and outcome in memory.'
  ];
  return { plan, risk };
}

export async function prepareHexMemorySave(root: string, input: {
  decisionId?: string;
  workspaceName?: string;
  taskType?: string;
  changeType?: string;
  outcome?: string;
  testsBefore?: 'pass' | 'fail' | 'unknown';
  testsAfter?: 'pass' | 'fail' | 'unknown';
  notes?: string;
} = {}): Promise<HexMemorySaveRequest> {
  const decisions = await readDecisions(root, 100);
  const events = await readEvents(root, 100);
  const decision = input.decisionId
    ? decisions.find(item => item.id === input.decisionId)
    : decisions[decisions.length - 1];
  const assessment = await assessRisk(root).catch(() => undefined);
  const workspaceName = sanitizeText(input.workspaceName ?? path.basename(root));
  const sanitizedReason = sanitizeText(input.notes ?? decision?.reason) ?? 'Agentic rewind decision summary';
  const files = unique([...(decision?.files ?? []), ...(assessment?.files ?? [])]);
  const fileTypes = unique(files.map(file => path.extname(file)).filter(Boolean));
  const approval = decision?.approvedByUser === true
    ? 'approved'
    : decision?.approvedByUser === false
      ? 'rejected'
      : 'unknown';

  const record: HexMemorySaveRequest['record'] = {
    schemaVersion: '1.0',
    type: decision?.decision === 'recommend_rewind' ? 'agentic_rewind_recovery_pattern' : 'agentic_rewind_decision_summary',
    timestamp: new Date().toISOString(),
    workspaceName,
    taskType: sanitizeText(input.taskType),
    changeType: sanitizeText(input.changeType),
    risk: decision?.risk ?? assessment?.risk,
    decision: sanitizeText(decision?.decision),
    action: sanitizeText(decision?.action),
    approval,
    outcome: sanitizeText(input.outcome ?? decision?.outcome),
    sanitizedReason,
    evidence: {
      checkpointId: sanitizeText(decision?.checkpointId),
      testsBefore: input.testsBefore,
      testsAfter: input.testsAfter,
      filesChangedCount: files.length || assessment?.changedFiles,
      fileTypes,
      decisionsCount: decisions.length,
      eventsCount: events.length
    },
    tags: unique([
      'agentic-rewind',
      'code-safety',
      input.taskType,
      input.changeType,
      decision?.decision,
      decision?.risk,
      input.outcome ?? decision?.outcome
    ].filter(Boolean).map(String).map(sanitizeTag))
  };

  return {
    namespace: 'hex_memory',
    operation: 'save',
    instruction: 'Agent: save the following sanitized record to hex_memory. Do not store raw source code, full diffs, secrets, or checkpoint blobs. Use this record as shared long-term context across workspaces.',
    record,
    redactionPolicy: [
      'Do not include raw source code.',
      'Do not include full diffs.',
      'Do not include secrets, tokens, credentials, .env values, or proprietary payloads.',
      'Store file extensions and counts, not full sensitive file content.',
      'Prefer generalized task/change/risk/outcome patterns over repo-specific implementation details.'
    ]
  };
}

export async function prepareHexMemorySearch(_root: string, input: {
  query?: string;
  taskType?: string;
  changeType?: string;
  risk?: RiskLevel;
  tags?: string[];
} = {}): Promise<HexMemorySearchRequest> {
  const queryParts = [
    input.query,
    input.taskType && `task:${input.taskType}`,
    input.changeType && `change:${input.changeType}`,
    input.risk && `risk:${input.risk}`,
    ...(input.tags ?? [])
  ].filter(Boolean).map(String);

  return {
    namespace: 'hex_memory',
    operation: 'search',
    instruction: 'Agent: search hex_memory using this query before deciding whether to checkpoint, test, recommend rewind, or record a new outcome. Use any matching prior decisions as advisory context, not as an automatic command.',
    query: queryParts.join(' ') || 'agentic-rewind code safety prior decisions recovery patterns',
    filters: {
      type: 'agentic_rewind_decision_summary OR agentic_rewind_recovery_pattern OR agentic_rewind_session_summary',
      taskType: sanitizeText(input.taskType),
      changeType: sanitizeText(input.changeType),
      risk: input.risk,
      tags: input.tags?.map(sanitizeTag)
    },
    expectedUse: 'Compare prior outcomes with the current risk assessment. If similar rewind actions succeeded before, mention that as supporting evidence and still ask for approval before destructive actions.'
  };
}

async function changedFiles(root: string, checkpointId?: string): Promise<string[]> {
  const config = await loadConfig(root);
  if (!checkpointId) {
    return listWorkspaceFiles(root, config);
  }
  const checkpoint = await loadCheckpoint(root, checkpointId);
  const before = new Map(checkpoint.files.map(file => [file.path, file]));
  const after = await currentFilesByPath(root, config);
  return changedPathsBetween(before, after).map(file => {
    if (!before.has(file)) {
      return `+${file}`;
    }
    if (!after.has(file)) {
      return `-${file}`;
    }
    return file;
  });
}

function matchesAny(relPath: string, patterns: string[]): boolean {
  return patterns.some(pattern => globToRegex(pattern).test(relPath));
}

function globToRegex(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
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
  return new RegExp(`^${source}$`);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function sanitizeText(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return value
    .replace(/(?:token|password|secret|key)\s*[:=]\s*\S+/gi, '<redacted>')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

function sanitizeTag(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}
