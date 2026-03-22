#!/usr/bin/env node

/**
 * Enhanced Hook Notifier — called by Claude Code hooks.
 *
 * Handles: Stop (completed), Notification (waiting), SessionStart,
 *          SessionEnd, SubagentStop (subagent-done).
 *
 * Usage (in ~/.claude/settings.json hooks):
 *   node /path/to/ccgram/dist/enhanced-hook-notify.js completed
 *   node /path/to/ccgram/dist/enhanced-hook-notify.js waiting
 *   node /path/to/ccgram/dist/enhanced-hook-notify.js session-start
 *   node /path/to/ccgram/dist/enhanced-hook-notify.js session-end
 *   node /path/to/ccgram/dist/enhanced-hook-notify.js subagent-done
 */

import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from './src/utils/paths';
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

import https from 'https';
import Logger from './src/core/logger';
import { upsertSession, extractWorkspaceName, trackNotificationMessage } from './workspace-router';
import { hasPendingForWorkspace } from './prompt-bridge';
import { isUserActiveAtTerminal } from './src/utils/active-check';
import {
  clearRemoteSession,
  isRemoteSessionActive,
  stopRemoteTyping,
} from './src/utils/notification-state';
import { resolveSessionContext } from './src/utils/session-identity';
import type { TelegramMessage } from './src/types';

const logger = new Logger('hook:enhanced');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_ENABLED = process.env.TELEGRAM_ENABLED === 'true';
const TELEGRAM_MESSAGE_LIMIT = 4096;

const STATUS_ARG = process.argv[2] || 'completed';

// ── Status configuration ─────────────────────────────────────────

interface StatusConfig {
  icon: string;
  label: string;
  /** When true, notification fires even if user is active at terminal */
  alwaysNotify: boolean;
  /** When true, register/update the session map entry */
  upsertSession: boolean;
}

const STATUS_CONFIG: Record<string, StatusConfig> = {
  'completed':     { icon: '\u2705', label: 'Task completed',    alwaysNotify: false, upsertSession: true  },
  'waiting':       { icon: '\u23f3', label: 'Waiting for input', alwaysNotify: false, upsertSession: true  },
  'session-start': { icon: '\u{1F7E2}', label: 'Session started',   alwaysNotify: false, upsertSession: true  },
  'session-end':   { icon: '\u{1F534}', label: 'Session ended',     alwaysNotify: false, upsertSession: false },
  'subagent-done': { icon: '\u{1F916}', label: 'Subagent finished', alwaysNotify: false, upsertSession: true  },
};

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    const raw = await readStdin();
    payload = JSON.parse(raw);
  } catch {
    payload = {};
  }

  const sessionId = (payload.session_id as string) || null;
  const sessionContext = resolveSessionContext({
    cwd: (payload.cwd as string) || process.env.CLAUDE_CWD || process.cwd(),
    sessionId,
  });
  const cwd = sessionContext.cwd;
  const workspace = sessionContext.workspace || extractWorkspaceName(cwd)!;
  const tmuxSession = sessionContext.entry?.tmuxSession || sessionContext.sessionName;

  const config = STATUS_CONFIG[STATUS_ARG] ?? STATUS_CONFIG['waiting'];

  // Update session map (skip for session-end — session is over)
  if (config.upsertSession && tmuxSession && sessionContext.managed) {
    try {
      upsertSession({
        cwd,
        tmuxSession,
        status: STATUS_ARG,
        sessionId,
        sessionType: sessionContext.sessionType || undefined,
      });
    } catch (err: unknown) {
      logger.error(`Failed to update session map: ${(err as Error).message}`);
    }
  }

  const isTelegramInjected = !!(
    sessionContext.managed
    && tmuxSession
    && isRemoteSessionActive(tmuxSession)
  );

  // Never send notifications from sessions that ccgram does not manage.
  // Direct terminal sessions can share the same cwd-derived session name as a
  // ccgram session, so allowing them past this point can leak local replies to Telegram.
  if (!sessionContext.managed) {
    return;
  }

  // Suppress notification if user is actively at terminal AND this wasn't Telegram-injected
  if (!config.alwaysNotify && !isTelegramInjected && isUserActiveAtTerminal(cwd)) {
    return;
  }

  // Send Telegram notification
  if (TELEGRAM_ENABLED && BOT_TOKEN && CHAT_ID) {
    if (STATUS_ARG === 'waiting' && tmuxSession) {
      stopRemoteTyping(tmuxSession);
    }

    // Dedup: if a richer prompt (permission/question) is already pending for this
    // workspace, skip the basic "Waiting for input" notification
    if (STATUS_ARG === 'waiting' && hasPendingForWorkspace(workspace)) {
      return;
    }

    const messageHeaderHtml = `${config.icon} ${config.label} in <b>${escapeHtml(workspace)}</b>`;
    const messageHeaderPlain = `${config.icon} ${config.label} in ${workspace}`;
    const messages: Array<{ html: string; plain: string }> = [];

    // Append Claude's last response text (skip for session-start — nothing said yet)
    if (STATUS_ARG !== 'session-start') {
      const responseText = getResponseText(payload);
      if (responseText) {
        messages.push(...buildTelegramMessages(messageHeaderHtml, messageHeaderPlain, responseText));
      }
    }

    if (messages.length === 0) {
      messages.push({ html: messageHeaderHtml, plain: messageHeaderPlain });
    }

    for (const [index, message] of messages.entries()) {
      try {
        const result = await sendTelegram(message.html, 'HTML');
        if (result && result.message_id) {
          trackNotificationMessage(result.message_id, workspace, `hook-${STATUS_ARG}`);
        }
      } catch {
        // HTML failed — send as plain text
        try {
          const result = await sendTelegram(message.plain, false);
          if (result && result.message_id) {
            trackNotificationMessage(result.message_id, workspace, `hook-${STATUS_ARG}`);
          }
        } catch (err2: unknown) {
          logger.error(`Telegram send failed for chunk ${index + 1}: ${(err2 as Error).message}`);
        }
      }
    }
  }

  if (tmuxSession && ['completed', 'session-end', 'subagent-done'].includes(STATUS_ARG)) {
    clearRemoteSession(tmuxSession);
  }
}

// ── Response text extraction ─────────────────────────────────────

/**
 * Get Claude's full response text from the hook payload.
 * Prefers transcript parsing so multiple text blocks separated by tool calls
 * are preserved, then falls back to last_assistant_message when needed.
 * For SubagentStop, also tries agent_transcript_path.
 */
function getResponseText(payload: Record<string, unknown>): string | null {
  const agentTranscript = payload.agent_transcript_path as string | undefined;
  if (agentTranscript) {
    try {
      const response = extractLastResponse(agentTranscript);
      if (response) return response;
    } catch {}
  }
  const transcript = payload.transcript_path as string | undefined;
  if (transcript) {
    try {
      const response = extractLastResponse(transcript);
      if (response) return response;
    } catch {}
  }

  const direct = payload.last_assistant_message as string | undefined;
  if (direct) return direct;

  return null;
}

// ── Telegram ────────────────────────────────────────────────────

function sendTelegram(text: string, parseMode: string | false = 'Markdown'): Promise<TelegramMessage | null> {
  return new Promise((resolve, reject) => {
    const msgPayload: Record<string, unknown> = { chat_id: CHAT_ID, text };
    if (parseMode) msgPayload.parse_mode = parseMode;
    const body = JSON.stringify(msgPayload);

    const options: https.RequestOptions = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 5000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode! >= 200 && res.statusCode! < 300) {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.result || null);
          } catch {
            resolve(null);
          }
        } else {
          reject(new Error(`Telegram API ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Telegram request timed out'));
    });

    req.write(body);
    req.end();
  });
}

// ── Helpers ──────────────────────────────────────────────────────

function extractLastResponse(transcriptPath: string): string | null {
  const data = fs.readFileSync(transcriptPath, 'utf8').trimEnd();
  const lines = data.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === 'assistant' && entry.message?.content) {
        const texts = entry.message.content
          .filter((c: Record<string, unknown>) => c.type === 'text')
          .map((c: Record<string, unknown>) => typeof c.text === 'string' ? c.text.trim() : '')
          .filter((text: string) => text.length > 0);
        if (texts.length > 0) return texts.join('\n\n');
      }
    } catch {}
  }
  return null;
}

function buildTelegramMessages(
  headerHtml: string,
  headerPlain: string,
  responseText: string
): Array<{ html: string; plain: string }> {
  const reserved = Math.max(headerHtml.length, headerPlain.length) + 2;
  const firstChunkLimit = Math.max(500, TELEGRAM_MESSAGE_LIMIT - reserved);
  const responseChunks = splitTextForTelegram(responseText, firstChunkLimit, TELEGRAM_MESSAGE_LIMIT);

  return responseChunks.map((chunk, index) => {
    if (index === 0) {
      return {
        html: `${headerHtml}\n\n${markdownToHtml(chunk)}`,
        plain: `${headerPlain}\n\n${chunk}`,
      };
    }

    return {
      html: markdownToHtml(chunk),
      plain: chunk,
    };
  });
}

function splitTextForTelegram(text: string, firstLimit: number, nextLimit: number): string[] {
  const normalized = text.trim();
  if (!normalized) return [];

  const chunks: string[] = [];
  let remaining = normalized;
  let limit = firstLimit;

  while (remaining.length > limit) {
    const splitAt = findSplitPoint(remaining, limit);
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
    limit = nextLimit;
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function findSplitPoint(text: string, limit: number): number {
  const paragraphBreak = text.lastIndexOf('\n\n', limit);
  if (paragraphBreak >= Math.floor(limit * 0.5)) {
    return paragraphBreak;
  }

  const lineBreak = text.lastIndexOf('\n', limit);
  if (lineBreak >= Math.floor(limit * 0.5)) {
    return lineBreak;
  }

  const spaceBreak = text.lastIndexOf(' ', limit);
  if (spaceBreak >= Math.floor(limit * 0.5)) {
    return spaceBreak;
  }

  return limit;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    let resolved = false;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => {
      if (!resolved) { resolved = true; resolve(data); }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        process.stdin.destroy();
        resolve(data || '{}');
      }
    }, 500);
  });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function markdownToHtml(text: string): string {
  let html = escapeHtml(text);
  const placeholders: string[] = [];

  // Extract code blocks/inline code first to protect them from bold/italic regexes
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_: string, __: string, code: string) => {
    const idx = placeholders.length;
    placeholders.push(`<pre>${code.trim()}</pre>`);
    return `\x00P${idx}\x00`;
  });
  html = html.replace(/`([^`]+)`/g, (_: string, code: string) => {
    const idx = placeholders.length;
    placeholders.push(`<code>${code}</code>`);
    return `\x00P${idx}\x00`;
  });

  // Apply inline formatting only to non-code text
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  html = html.replace(/\*(.+?)\*/g, '<i>$1</i>');
  html = html.replace(/^[-*]\s+/gm, '\u2022 ');
  html = html.replace(/^#{1,6}\s+/gm, '');

  // Restore code placeholders
  html = html.replace(/\x00P(\d+)\x00/g, (_: string, idx: string) => placeholders[parseInt(idx)]);
  return html;
}

// ── Run ─────────────────────────────────────────────────────────

main().catch((err: Error) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
