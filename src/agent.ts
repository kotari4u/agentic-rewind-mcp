import { loadConfig } from './config.js';
import { changedPathsBetween, currentFilesByPath, diffCheckpoint, listCheckpoints, loadCheckpoint } from './checkpoint.js';
import { listWorkspaceFiles } from './fs-utils.js';
import { appendDecision, appendEvent, readDecisions, readEvents } from './store.js';
import type { DecisionRecord, EventRecord, RecommendationDecision, RiskAssessment, RiskLevel } from './types.js';

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
