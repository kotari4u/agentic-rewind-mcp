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
