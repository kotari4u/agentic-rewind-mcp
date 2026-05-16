import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgenticRewindConfig } from './types.js';

export const STORE_DIR = '.agentic-rewind';

export const DEFAULT_CONFIG: AgenticRewindConfig = {
  maxStorageBytes: 500 * 1024 * 1024,
  maxCheckpoints: 100,
  maxFileBytes: 50 * 1024 * 1024,
  maxDiffBytes: 1024 * 1024,
  maxTextDiffLinesProduct: 2_000_000,
  hooks: {
    mode: 'observe_only'
  },
  autonomy: {
    checkpointMode: 'agent_decides',
    requireApprovalForRewind: true,
    allowAutoRewindLowRisk: false
  },
  riskPolicy: {
    highRisk: [
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      '.env*',
      'src/auth/**',
      '**/auth/**',
      '**/security/**',
      '**/payment/**',
      '**/payments/**',
      '**/migration/**',
      '**/migrations/**',
      '**/*.sql'
    ],
    mediumRisk: [
      'src/**',
      'app/**',
      'lib/**',
      '**/*.java',
      '**/*.ts',
      '**/*.tsx',
      '**/*.js',
      '**/*.jsx'
    ],
    lowRisk: [
      'README.md',
      '**/*.md',
      'docs/**',
      '**/*.txt'
    ]
  },
  ignore: [
    '.git/**',
    '.agentic-rewind/**',
    'node_modules/**',
    'dist/**',
    'out/**',
    'build/**',
    'coverage/**',
    '.next/**',
    '.turbo/**',
    '**/*.class',
    '*.log'
  ]
};

export async function loadConfig(root: string): Promise<AgenticRewindConfig> {
  const configPath = path.join(root, STORE_DIR, 'config.json');
  const userConfig = await readJson(configPath).catch(() => ({}));
  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
    hooks: { ...DEFAULT_CONFIG.hooks, ...(userConfig.hooks ?? {}) },
    autonomy: { ...DEFAULT_CONFIG.autonomy, ...(userConfig.autonomy ?? {}) },
    riskPolicy: {
      highRisk: [...DEFAULT_CONFIG.riskPolicy.highRisk, ...(userConfig.riskPolicy?.highRisk ?? [])],
      mediumRisk: [...DEFAULT_CONFIG.riskPolicy.mediumRisk, ...(userConfig.riskPolicy?.mediumRisk ?? [])],
      lowRisk: [...DEFAULT_CONFIG.riskPolicy.lowRisk, ...(userConfig.riskPolicy?.lowRisk ?? [])]
    },
    ignore: [...DEFAULT_CONFIG.ignore, ...(userConfig.ignore ?? [])]
  };
}

async function readJson(file: string): Promise<any> {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
