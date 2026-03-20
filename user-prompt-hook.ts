#!/usr/bin/env node

/**
 * UserPromptSubmit hook — called by Claude Code whenever the user submits a prompt.
 *
 * Writes the current Unix timestamp to a per-workspace file so that
 * active-check.ts can detect when the user is actively working at the terminal
 * and suppress redundant Telegram notifications for THAT specific workspace only.
 *
 * File: /tmp/claude_last_msg_time_<workspace>
 *
 * Must be fast — registered with timeout: 2 in settings.json.
 * No stdout output. No Telegram calls.
 */

import path from 'path';
import { PROJECT_ROOT } from './src/utils/paths';
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

import fs from 'fs';
import { getLastMsgFile } from './src/utils/active-check';

const now = String(Math.floor(Date.now() / 1000));

// Read stdin to get cwd from the hook payload, then write the timestamp file
let stdinData = '';
let resolved = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => { stdinData += chunk; });

function writeTimestamp(): void {
  let cwd: string | undefined;
  try {
    const payload = JSON.parse(stdinData);
    cwd = payload.cwd || process.env.CLAUDE_CWD || undefined;
  } catch {
    cwd = process.env.CLAUDE_CWD || undefined;
  }

  for (const filePath of new Set([getLastMsgFile(cwd), getLastMsgFile()])) {
    try {
      fs.writeFileSync(filePath, now);
    } catch {
      // Non-fatal — active-check will just assume user is inactive
    }
  }
}

process.stdin.on('end', () => {
  if (!resolved) { resolved = true; writeTimestamp(); process.stdin.destroy(); }
});
setTimeout(() => {
  if (!resolved) { resolved = true; writeTimestamp(); process.stdin.destroy(); }
}, 500);
