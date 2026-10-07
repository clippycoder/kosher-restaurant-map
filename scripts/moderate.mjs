#!/usr/bin/env node
// The moderation tool lives in worker/scripts/moderate.mjs; this lets
// `node scripts/moderate.mjs <command>` work from the project root too.
await import('../worker/scripts/moderate.mjs');
