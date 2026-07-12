#!/bin/bash -eu
# Build the Jazzer.js fuzz targets for ClusterFuzzLite / OSS-Fuzz.
# Each target is an ESM module exporting `fuzz(data)`; the invariants are the
# fail-safe contracts at hands' trust boundaries — the PreToolUse guardrail
# hook never throws on an arbitrary payload and never denies without a reason
# (a crash would silently disable enforcement, since the runtime fails open by
# design), the Claude Code stream parser yields [] rather than throwing on any
# malformed JSONL line, and the recipe frontmatter/step parser never throws,
# never accepts a path-traversal name, and round-trips through serializeRecipe.
cd "$SRC/hands"
npm ci --no-audit --no-fund
# Targets import the compiled ./dist output (the package is TypeScript).
npm run build

# --excludes: Jazzer's ESM instrumentation can't compile the shebang line in
# dist/hook-pre-tool-use.js (it ships as an executable hook script); excluding
# it only drops coverage feedback for that thin wrapper — the guardrail
# matcher it calls stays instrumented. node_modules must be re-listed because
# --excludes replaces the default exclude list.
for target in hook_decide cli_stream recipe_parse; do
  compile_javascript_fuzzer hands "fuzz/${target}.fuzz.js" --sync \
    --excludes hook-pre-tool-use node_modules
done
