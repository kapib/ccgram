/**
 * active-check.ts — Detects whether the user is actively working at the terminal.
 *
 * Reads a per-workspace timestamp file written by the UserPromptSubmit hook to
 * determine when the user last sent a message to Claude in a specific workspace.
 *
 * Per-workspace file: /tmp/claude_last_msg_time_<workspace>
 * Global fallback:    /tmp/claude_last_msg_time
 *
 * If the gap is below ACTIVE_THRESHOLD_SECONDS (default: 300 = 5 min), the user
 * is considered active at the terminal and Telegram notifications should be
 * suppressed (they can see the output directly).
 *
 * Applied to: enhanced-hook-notify (Stop/Notification), permission-hook (PermissionRequest).
 * Skipped when: typing-active file exists (command was Telegram-injected).
 */

import fs from 'fs';
import crypto from 'crypto';
import path from 'path';

const LAST_MSG_FILE = '/tmp/claude_last_msg_time';
const DEFAULT_THRESHOLD = 300; // 5 minutes

/**
 * Derive the per-workspace timestamp file path from a cwd.
 * Uses the basename of the cwd (the workspace/project name) as a suffix.
 */
export function getLastMsgFile(cwd?: string): string {
  if (!cwd) return LAST_MSG_FILE;
  const normalized = path.resolve(cwd);
  const workspace = path.basename(normalized);
  if (!workspace) return LAST_MSG_FILE;
  const safe = workspace.replace(/[^a-zA-Z0-9_-]/g, '_');
  const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 10);
  return `${LAST_MSG_FILE}_${safe}_${hash}`;
}

function resolveThreshold(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const fromEnv = parseInt(process.env.ACTIVE_THRESHOLD_SECONDS || '', 10);
  return Number.isFinite(fromEnv) ? fromEnv : DEFAULT_THRESHOLD;
}

function normalizeArgs(
  cwdOrThreshold?: string | number,
  thresholdSeconds?: number
): { cwd?: string; thresholdSeconds: number } {
  if (typeof cwdOrThreshold === 'number') {
    return { thresholdSeconds: resolveThreshold(cwdOrThreshold) };
  }

  return {
    cwd: cwdOrThreshold,
    thresholdSeconds: resolveThreshold(thresholdSeconds),
  };
}

/**
 * Returns true if the user sent a Claude message within the active threshold.
 * @param cwd - workspace directory; when provided, checks the per-workspace file
 * @param thresholdSeconds - seconds since last message to consider user "active" (default 300)
 */
export function isUserActiveAtTerminal(
  thresholdSeconds?: number
): boolean;
export function isUserActiveAtTerminal(
  cwd?: string,
  thresholdSeconds?: number
): boolean;
export function isUserActiveAtTerminal(
  cwdOrThreshold?: string | number,
  thresholdSeconds?: number
): boolean {
  const { cwd, thresholdSeconds: resolvedThreshold } = normalizeArgs(cwdOrThreshold, thresholdSeconds);
  const filePath = getLastMsgFile(cwd);
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    const lastMsg = parseInt(raw, 10);
    if (!lastMsg || isNaN(lastMsg)) return false;
    const nowSeconds = Math.floor(Date.now() / 1000);
    return (nowSeconds - lastMsg) < resolvedThreshold;
  } catch {
    // Per-workspace file doesn't exist — fall back to global file
    if (filePath !== LAST_MSG_FILE) {
      try {
        const raw = fs.readFileSync(LAST_MSG_FILE, 'utf8').trim();
        const lastMsg = parseInt(raw, 10);
        if (!lastMsg || isNaN(lastMsg)) return false;
        const nowSeconds = Math.floor(Date.now() / 1000);
        return (nowSeconds - lastMsg) < resolvedThreshold;
      } catch {
        return false;
      }
    }
    return false;
  }
}
