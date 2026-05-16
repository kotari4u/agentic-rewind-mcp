export type RiskLevel = 'low' | 'medium' | 'high';
export type RecommendationDecision =
  | 'create_checkpoint'
  | 'recommend_rewind'
  | 'continue'
  | 'ask_approval'
  | 'run_tests'
  | 'no_action';

export interface AgenticRewindConfig {
  maxStorageBytes: number;
  maxCheckpoints: number;
  maxFileBytes: number;
  maxDiffBytes: number;
  maxTextDiffLinesProduct: number;
  hooks: {
    mode: 'off' | 'observe_only' | 'auto_checkpoint' | 'policy_checkpoint';
  };
  autonomy: {
    checkpointMode: 'agent_decides' | 'policy_decides' | 'always';
    requireApprovalForRewind: boolean;
    allowAutoRewindLowRisk: boolean;
  };
  riskPolicy: {
    highRisk: string[];
    mediumRisk: string[];
    lowRisk: string[];
  };
  ignore: string[];
}

export interface CheckpointFile {
  path: string;
  kind: 'file';
  blob: string;
  sha256: string;
  size: number;
  binary: boolean;
}

export interface Checkpoint {
  id: string;
  createdAt: string;
  reason: string;
  intent?: string;
  sessionId?: string;
  files: CheckpointFile[];
  skipped: string[];
  manifestHash: string;
  stats: {
    files: number;
    skipped: number;
    sizeBytes: number;
  };
}

export interface EventRecord {
  id: string;
  timestamp: string;
  type: string;
  sessionId?: string;
  toolName?: string;
  prompt?: string;
  cwd?: string;
  files?: string[];
  raw?: unknown;
}

export interface DecisionRecord {
  id: string;
  timestamp: string;
  sessionId?: string;
  event?: string;
  checkpointId?: string;
  decision: RecommendationDecision | string;
  action?: string;
  confidence?: number;
  risk?: RiskLevel;
  reason: string;
  files?: string[];
  approvedByUser?: boolean;
  outcome?: string;
}

export interface RiskAssessment {
  risk: RiskLevel;
  score: number;
  reasons: string[];
  files: string[];
  changedFiles: number;
  addedFiles: string[];
  deletedFiles: string[];
  modifiedFiles: string[];
  recommendedAction: RecommendationDecision;
}

export interface EnterpriseMemorySaveRequest {
  instruction: string;
  namespace: 'enterprise_memory';
  operation: 'save';
  record: {
    schemaVersion: '1.0';
    type: 'agentic_rewind_decision_summary' | 'agentic_rewind_session_summary' | 'agentic_rewind_recovery_pattern';
    timestamp: string;
    workspaceName?: string;
    taskType?: string;
    changeType?: string;
    risk?: RiskLevel;
    decision?: string;
    action?: string;
    approval?: 'approved' | 'rejected' | 'not_required' | 'unknown';
    outcome?: string;
    sanitizedReason: string;
    evidence: {
      checkpointId?: string;
      testsBefore?: 'pass' | 'fail' | 'unknown';
      testsAfter?: 'pass' | 'fail' | 'unknown';
      filesChangedCount?: number;
      fileTypes?: string[];
      decisionsCount?: number;
      eventsCount?: number;
    };
    tags: string[];
  };
  redactionPolicy: string[];
}

export interface EnterpriseMemorySearchRequest {
  instruction: string;
  namespace: 'enterprise_memory';
  operation: 'search';
  query: string;
  filters: {
    type?: string;
    taskType?: string;
    changeType?: string;
    risk?: RiskLevel;
    tags?: string[];
  };
  expectedUse: string;
}

export interface RewindReport {
  checkpointId: string;
  mode: 'delta' | 'change' | 'full';
  windowStartCheckpointId?: string;
  windowEndCheckpointId?: string;
  safetyCheckpointId?: string;
  dryRun: boolean;
  restored: string[];
  deleted: string[];
  unchanged: string[];
  skipped: string[];
  errors: string[];
}
