# Integrations

Two ways to give another agent working knowledge of this protocol.

## The skill

[`skill/agent-warranty-court/SKILL.md`](skill/agent-warranty-court/SKILL.md)

Drop it into your agent's skills directory. It covers when the protocol applies
at all, the lifecycle in call order, the verdict grammar, evidence rules, the
commitment hash, and the limitations.

```bash
cp -r integrations/skill/agent-warranty-court ~/.claude/skills/
```

## The MCP server

[`mcp/`](mcp/) — stdio transport, seven tools.

```bash
cd integrations/mcp && npm install
```

```json
{
  "mcpServers": {
    "agent-warranty-court": {
      "command": "node",
      "args": ["/absolute/path/to/agent-warranty-court/integrations/mcp/src/server.mjs"]
    }
  }
}
```

| Tool | Returns |
|---|---|
| `get_deployment` | live addresses and parameters for a chain |
| `get_verdict_grammar` | codes, buckets, slash table, coherence rules, enum orders |
| `check_verdict_coherence` | whether Base would accept a verdict, and why not if it would not |
| `compute_verdict_commitment` | the `verdictHash` Base stores |
| `get_job_state` | `stateOf(jobId)` read live, as a state name |
| `get_case_status` | `statusOf(caseId)` read live |
| `explain_lifecycle` | the ordered steps and the permissionless escape hatches |

### Why it reads the repository at startup

The server derives the verdict grammar, both enum orders and its function
selectors from the project's own sources every time it starts, and refuses to
start if it cannot find them.

That is deliberate. The grammar already exists in four places and
`scripts/check-grammar-parity.mjs` exists because four copies of one rule set is
a liability. A fifth copy inside a server a developer installs once and never
updates would be the most dangerous of them — it would drift silently and teach
agents a grammar the chain no longer accepts.

The selectors are read from `web/generated/data.js`, which is produced with
`cast sig`. Hand-written selectors have been wrong three times in this project,
including twice in the first draft of this server, and the failure is quiet: a
wrong selector hits the fallback, `eth_call` returns empty, and the caller reads
it as enum `0` — which for both of these enums means "unknown". A plausible
wrong answer is worse than an error.

A consequence worth knowing: the server needs the repository checked out, not
just the `mcp` directory.

## Verification

```bash
node scripts/check-mcp.mjs    # starts the server, handshakes, calls six tools
node scripts/check-skill.mjs  # frontmatter, paths, grammar parity, limitations
```

`check-mcp.mjs` is a real MCP client. It verifies the commitment against an
independent sha256, requires an incoherent verdict to be *rejected with reasons*,
and checks the job-state enum is not transposed — a bug this project shipped once
in its own front end.
