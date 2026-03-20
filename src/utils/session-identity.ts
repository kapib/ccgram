import { execSync } from 'child_process';
import {
  extractWorkspaceName,
  readSessionMap,
  isExpired,
} from '../../workspace-router';
import type { SessionEntry } from '../types';

export interface SessionContext {
  cwd: string;
  workspace: string | null;
  sessionId: string | null;
  sessionName: string | null;
  sessionType: 'tmux' | 'pty' | null;
  managed: boolean;
  token: string | null;
  entry: SessionEntry | null;
}

export function sanitizeSessionName(name: string): string {
  return name.replace(/[.:\s]/g, '-');
}

function normalizeSessionType(value?: string | null): 'tmux' | 'pty' | null {
  if (value === 'tmux' || value === 'pty') return value;
  return null;
}

export function detectSessionName(cwd?: string | null): string | null {
  const envName = process.env.CCGRAM_SESSION_NAME;
  if (envName) return envName;

  if (process.env.TMUX) {
    try {
      return execSync('tmux display-message -p "#S"', { encoding: 'utf8' }).trim();
    } catch {}
  }

  const raw = extractWorkspaceName(cwd || process.env.CLAUDE_CWD || process.cwd());
  if (!raw) return null;
  return sanitizeSessionName(raw);
}

export function detectSessionType(): 'tmux' | 'pty' | null {
  return normalizeSessionType(process.env.CCGRAM_SESSION_TYPE)
    || (process.env.TMUX ? 'tmux' : null);
}

export function resolveSessionContext({
  cwd,
  sessionId,
}: {
  cwd?: string | null;
  sessionId?: string | null;
} = {}): SessionContext {
  const resolvedCwd = cwd || process.env.CLAUDE_CWD || process.cwd();
  const resolvedSessionId = sessionId || null;
  const sessionName = detectSessionName(resolvedCwd);
  const runtimeSessionType = detectSessionType();
  const workspace = extractWorkspaceName(resolvedCwd);
  const map = readSessionMap();

  let token: string | null = null;
  let entry: SessionEntry | null = null;

  if (resolvedSessionId) {
    for (const [candidateToken, candidate] of Object.entries(map)) {
      if (isExpired(candidate)) continue;
      if (candidate.sessionId && candidate.sessionId === resolvedSessionId) {
        token = candidateToken;
        entry = candidate;
        break;
      }
    }
  }

  if (!entry && process.env.CCGRAM_SESSION_NAME && sessionName) {
    for (const [candidateToken, candidate] of Object.entries(map)) {
      if (isExpired(candidate)) continue;
      if (candidate.tmuxSession !== sessionName) continue;
      if (candidate.cwd !== resolvedCwd) continue;
      token = candidateToken;
      entry = candidate;
      break;
    }
  }

  const managed = !!process.env.CCGRAM_SESSION_NAME || !!entry;

  return {
    cwd: resolvedCwd,
    workspace,
    sessionId: resolvedSessionId,
    sessionName: entry?.tmuxSession || sessionName,
    sessionType: entry?.sessionType || runtimeSessionType,
    managed,
    token,
    entry,
  };
}
