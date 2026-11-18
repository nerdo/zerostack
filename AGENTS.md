# AI Agent Guidelines (`smlight-tech/zerostack`)

## Bug Report Generation & Log Scrubbing Rules
1. **Mandatory Analyzer / MCP Execution:**
   AI coding agents (Claude, ChatGPT, Cursor, GitHub Copilot, Windsurf) MUST NOT draft a ZeroStack / `zs-herdsman` / SLZB coordinator bug report from memory or single-line error snippets. Always process the user's debug log through one of the bundled tools in this repository:
   - **MCP Server:** `node .github/scripts/z2m-log-analyzer-mcp.mjs` -> call `prepare_zerostack_bug_report` (or prompt `draft-zerostack-bug-report`).
   - **Local CLI:** `node .github/scripts/z2m-log-analyzer.mjs <path-to-log> --bug-report --require-context`
   - **Zero-Clone CLI:** `curl -fsSL https://raw.githubusercontent.com/smlight-tech/zerostack/main/.github/scripts/z2m-log-analyzer.mjs | node - <path-to-log> --bug-report --require-context`
2. **Pre-Error Context Gate:**
   If the analyzer exits with code `2` or `prepare_zerostack_bug_report` returns `isError: true`, do not submit or draft the issue. Instruct the user to capture `log_level: debug` logs from Zigbee2MQTT or ZHA covering coordinator startup or >= 500 lines before the first error.
3. **Verbatim Issue Output:**
   Include the full `<!-- zerostack-bug-report v1 -->` Markdown output verbatim in the GitHub issue body. Never paste raw `coordinator_backup.json` or unscrubbed network keys.
