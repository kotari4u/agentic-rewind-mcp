# Agentic Rewind MCP

Agentic Rewind is a code-change safety layer for agentic development workflows.

It is intentionally different from a simple `/rewind` command:

- Hooks act as **sensors** and record events.
- MCP tools act as the **agent-facing decision layer**.
- Checkpoints, recommendations, risk assessments, and outcomes are saved in memory.
- The agent decides when to checkpoint, when to assess risk, when to recommend rewind, and when to record decisions.

## Architecture

```text
Copilot Agent
  |
  | MCP tool calls
  v
Agentic Rewind MCP Server
  |
  | reads/writes
  v
.agentic-rewind/
  checkpoints/
  blobs/
  memory/
    events.jsonl
    decisions.jsonl
```

Hooks are observe-only by default:

```text
Hook fires -> record event -> MCP/agent decides later
```

They do not automatically checkpoint unless you explicitly change the config.

## MCP Tools

The server exposes:

```text
rewind_create_checkpoint
rewind_list_checkpoints
rewind_diff_checkpoint
rewind_restore_checkpoint
rewind_assess_risk
rewind_recommend_action
rewind_plan_safety
rewind_record_event
rewind_record_decision
rewind_search_memory
rewind_summarize_session
```

## Install And Build

```bash
npm install
npm run build
npm run verify
```

## Local CLI Demo

Create a checkpoint:

```bash
node dist/cli.js checkpoint --reason "before java method changes"
```

List checkpoints:

```bash
node dist/cli.js list
```

Assess current risk:

```bash
node dist/cli.js assess-risk
```

Ask for an autonomous recommendation:

```bash
node dist/cli.js recommend <checkpoint-id> --test-status fail
```

Rewind the change that produced a checkpoint:

```bash
node dist/cli.js rewind <checkpoint-id> --change
```

Preview only:

```bash
node dist/cli.js rewind <checkpoint-id> --change --dry-run
```

## The Important Rewind Modes

Undo changes after a checkpoint:

```bash
node dist/cli.js rewind <checkpoint-id>
```

Undo the change that produced a checkpoint:

```bash
node dist/cli.js rewind <checkpoint-id> --change
```

Restore the full snapshot:

```bash
node dist/cli.js rewind <checkpoint-id> --full
```

For the `Addition.java` / `Multiply.java` scenario:

```text
classes-created
print-added
print1-added
print2-added
```

To remove `print1` while keeping `print` and `print2`, run:

```bash
node dist/cli.js rewind <print1-added-checkpoint-id> --change
```

## Hook Setup

Copy this repo's hook file into the target workspace:

```text
.github/hooks/agentic-rewind.json
```

The hook file records events such as:

```text
SessionStart
UserPromptSubmit
PreToolUse
PostToolUse
Stop
```

Events are stored in:

```text
.agentic-rewind/memory/events.jsonl
```

## MCP Setup In VS Code

For a workspace that installs this package locally, use:

```json
{
  "servers": {
    "agentic-rewind": {
      "command": "node",
      "args": [
        "${workspaceFolder}/node_modules/agentic-rewind-mcp/dist/mcp-server.js"
      ],
      "env": {
        "AGENTIC_REWIND_WORKSPACE": "${workspaceFolder}"
      }
    }
  }
}
```

Place that in:

```text
.vscode/mcp.json
```

Then in Copilot Agent, ask for behavior like:

```text
Before editing these Java files, use agentic-rewind to assess risk and create a checkpoint if needed.
```

Or:

```text
Tests failed. Use agentic-rewind to recommend whether to rewind the last checkpoint.
```

## Agentic Demo Flow

1. Agent receives task.
2. Agent calls `rewind_plan_safety`.
3. Agent calls `rewind_assess_risk`.
4. If risk warrants, agent calls `rewind_create_checkpoint`.
5. Agent edits files.
6. Agent runs tests.
7. If tests fail, agent calls `rewind_recommend_action`.
8. Agent asks user for approval if rewind is recommended.
9. Agent calls `rewind_restore_checkpoint`.
10. Agent calls `rewind_record_decision` with outcome.

## Memory

Decisions are stored in:

```text
.agentic-rewind/memory/decisions.jsonl
```

Example decision:

```json
{
  "decision": "recommend_rewind",
  "action": "rewind --change",
  "risk": "medium",
  "reason": "JUnit failed after print1 method addition",
  "approvedByUser": true,
  "outcome": "tests_passed_after_rewind"
}
```

Search memory:

```bash
node dist/cli.js search-memory --query print1
```

## Configuration

Optional config lives at:

```text
.agentic-rewind/config.json
```

Example:

```json
{
  "hooks": {
    "mode": "observe_only"
  },
  "autonomy": {
    "checkpointMode": "agent_decides",
    "requireApprovalForRewind": true,
    "allowAutoRewindLowRisk": false
  },
  "riskPolicy": {
    "highRisk": ["src/auth/**", "**/payment/**", "**/*.sql"],
    "mediumRisk": ["src/**", "**/*.java"],
    "lowRisk": ["README.md", "**/*.md"]
  }
}
```

## Tests

Run:

```bash
npm run verify
```

The test suite covers:

- Java `Addition.java` and `Multiply.java` middle-change rewind
- hunk-based diff output
- risk assessment
- recommendations after test failure
- observe-only hook event behavior
- decision memory search
