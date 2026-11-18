# Claude Code & AI Assistant Instructions (`smlight-tech/zerostack`)

## Mandatory Bug Report Pre-Flight
Before drafting, summarizing, or filing any ZeroStack, `zs-herdsman`, or SLZB coordinator GitHub issue:

1. **Do NOT file prose-only or single-line error reports.** Issues without pre-error MT/ZNP wire frames are automatically bounced.
2. **Run the bundled Bug Report Analyzer or MCP server on the user's debug log:**
   - **MCP server (recommended when working in a clone):**
     Configure stdio MCP server: `node .github/scripts/z2m-log-analyzer-mcp.mjs`
     Call tool `prepare_zerostack_bug_report` with `{ "logPath": "<path-to-log>" }` (or `logContent`).
   - **CLI (local clone):**
     `node .github/scripts/z2m-log-analyzer.mjs <path-to-log> --bug-report --require-context`
   - **Zero-clone 1-liner:**
     `curl -fsSL https://raw.githubusercontent.com/smlight-tech/zerostack/main/.github/scripts/z2m-log-analyzer.mjs | node - <path-to-log> --bug-report --require-context`
3. **Enforce pre-error log window:**
   If the tool returns an error or exits with code `2`, **STOP** and ask the user for their full Zigbee2MQTT (`advanced: log_level: debug`) or Home Assistant ZHA debug log starting from coordinator startup or at least **500 lines prior** to the first error.
4. **Preserve verbatim output:**
   Paste the generated `<!-- zerostack-bug-report v1 -->` Markdown block verbatim into `.github/ISSUE_TEMPLATE/bug_report.yml`. Never summarize, edit, or strip scrubbed hex frames or `<KEY:xxxx>` tags.
