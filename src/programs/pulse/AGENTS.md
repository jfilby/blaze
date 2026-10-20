# AGENTS.md

## Project
Blaze Pulse is a small real-time HTTP benchmark dashboard demonstrating Blaze's TypeScript compiler, native backends, and facil.io HTTP runtime.

## Architecture
- **Backend:** TypeScript compiled by Blaze; use the existing facil.io runtime.
- **Frontend:** Static HTML, CSS, vanilla JavaScript/TypeScript, and SVG.
- **Live metrics:** Server-Sent Events (SSE).
- **Load generation:** Separate process using `oha` or `wrk`.
- No frontend framework or database unless explicitly required.

## Guidelines
- Inspect existing code, conventions, CLI commands, and runtime APIs before making changes.
- Reuse existing Blaze and facil.io integrations; do not duplicate runtime functionality.
- Keep the implementation minimal, modular, and easy to run locally.
- Keep benchmark generation separate from server request handling.
- Never block the HTTP event loop with long-running work.
- Validate inputs and handle malformed requests, disconnects, and benchmark failures.
- Keep API behavior consistent across supported backends.
- Report measured performance honestly; never fabricate metrics or claim unverified speedups.
- Avoid unnecessary dependencies and abstractions.

## Development
- Implement features incrementally, following the documented implementation order.
- Run relevant tests after each change.
- Test API endpoints, SSE updates, benchmark start/stop, and error handling.
- Compare C and machine-code backends using identical workloads and settings.
- Record reproducible benchmark configurations and results.
- Do not modify unrelated code or weaken existing tests to make changes pass.

## Completion Criteria
A change is complete when:
1. It builds successfully with the supported Blaze commands.
2. Relevant tests pass.
3. The behavior works on supported backends, where applicable.
4. Documentation and run instructions reflect the actual implementation.
5. Performance claims are supported by reproducible measurements.

