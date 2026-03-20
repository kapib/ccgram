import { execSync } from 'child_process';
import {
  extractWorkspaceName,
  readSessionMap,
  isExpired,
} from '../../workspace-router';
import type { SessionEntry } from '../types';
import { normalizeExistingPath } from './path-normalize';
import { readManagedSessionEnv } from './session-env';

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
  const { sessionName: envName } = readManagedSessionEnv();
  if (envName) return envName;

  if (process.env.TMUX) {
    try {
      return execSync('tmux display-message -p "#S"', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {}
  }

  const raw = extractWorkspaceName(cwd || process.env.CLAUDE_CWD || process.cwd());
  if (!raw) return null;
  return sanitizeSessionName(raw);
}

export function detectSessionType(): 'tmux' | 'pty' | null {
  const { sessionType } = readManagedSessionEnv();
  return normalizeSessionType(sessionType)
    || (process.env.TMUX ? 'tmux' : null);
}

export function resolveSessionContext({
  cwd,
  sessionId,
}: {
  cwd?: string | null;
  sessionId?: string | null;
} = {}): SessionContext {
  const resolvedCwd = normalizeExistingPath(cwd || process.env.CLAUDE_CWD || process.cwd())
    || cwd
    || process.env.CLAUDE_CWD
    || process.cwd();
  const resolvedSessionId = sessionId || null;
  const sessionName = detectSessionName(resolvedCwd);
  const runtimeSessionType = detectSessionType();
  const workspace = extractWorkspaceName(resolvedCwd);
  const map = readSessionMap();
  const { sessionName: envSessionName } = readManagedSessionEnv();

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

  if (!entry && envSessionName && sessionName) {
    for (const [candidateToken, candidate] of Object.entries(map)) {
      if (isExpired(candidate)) continue;
      if (candidate.tmuxSession !== sessionName) continue;
      if ((normalizeExistingPath(candidate.cwd) || candidate.cwd) !== resolvedCwd) continue;
      token = candidateToken;
      entry = candidate;
      break;
    }
  }

  // Fallback for ccgram-managed tmux sessions when hook subprocesses do not
  // preserve CCGRAM_SESSION_NAME. Only trust tmux-backed matches here so a
  // direct terminal session with the same cwd-derived name does not get marked managed.
  if (!entry && process.env.TMUX && sessionName) {
    for (const [candidateToken, candidate] of Object.entries(map)) {
      if (isExpired(candidate)) continue;
      if ((candidate.sessionType || 'tmux') !== 'tmux') continue;
      if (candidate.tmuxSession !== sessionName) continue;
      if ((normalizeExistingPath(candidate.cwd) || candidate.cwd) !== resolvedCwd) continue;
      token = candidateToken;
      entry = candidate;
      break;
    }
  }

  const managed = !!envSessionName || !!entry;

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
