import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from './paths';
import { sanitizeSessionName } from './session-identity';

const DATA_DIR = process.env.CCGRAM_DATA_DIR || path.join(PROJECT_ROOT, 'src/data');
const REMOTE_STATE_DIR = path.join(DATA_DIR, 'remote-state');
const ROUTE_TTL_MS = (parseInt(process.env.REMOTE_ROUTE_TTL_SECONDS || '', 10) || 1800) * 1000;
const TYPING_TTL_MS = (parseInt(process.env.REMOTE_TYPING_TTL_SECONDS || '', 10) || 300) * 1000;

interface RemoteSessionState {
  sessionName: string;
  routeToTelegram: boolean;
  typing: boolean;
  workspace?: string | null;
  startedAt: number;
  updatedAt: number;
}

function ensureStateDir(): void {
  fs.mkdirSync(REMOTE_STATE_DIR, { recursive: true });
}

function getStatePath(sessionName: string): string {
  const safe = sanitizeSessionName(sessionName).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(REMOTE_STATE_DIR, `${safe}.json`);
}

function readState(sessionName: string): RemoteSessionState | null {
  try {
    const raw = fs.readFileSync(getStatePath(sessionName), 'utf8');
    return JSON.parse(raw) as RemoteSessionState;
  } catch {
    return null;
  }
}

function writeState(state: RemoteSessionState): void {
  ensureStateDir();
  fs.writeFileSync(getStatePath(state.sessionName), JSON.stringify(state), 'utf8');
}

function isExpired(state: RemoteSessionState, ttlMs: number): boolean {
  return (Date.now() - state.updatedAt) > ttlMs;
}

export function markRemoteSession(sessionName: string, workspace?: string | null): void {
  const now = Date.now();
  const existing = readState(sessionName);
  writeState({
    sessionName,
    workspace: workspace ?? existing?.workspace ?? null,
    routeToTelegram: true,
    typing: true,
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
  });
}

export function stopRemoteTyping(sessionName: string): void {
  const existing = readState(sessionName);
  if (!existing) return;
  writeState({
    ...existing,
    typing: false,
    updatedAt: Date.now(),
  });
}

export function clearRemoteSession(sessionName: string): void {
  try {
    fs.unlinkSync(getStatePath(sessionName));
  } catch {}
}

export function clearAllRemoteSessions(): void {
  try {
    for (const entry of fs.readdirSync(REMOTE_STATE_DIR)) {
      if (entry.endsWith('.json')) {
        try { fs.unlinkSync(path.join(REMOTE_STATE_DIR, entry)); } catch {}
      }
    }
  } catch {}
}

export function isRemoteSessionActive(sessionName: string): boolean {
  const state = readState(sessionName);
  if (!state) return false;
  if (!state.routeToTelegram || isExpired(state, ROUTE_TTL_MS)) {
    clearRemoteSession(sessionName);
    return false;
  }
  return true;
}

export function isRemoteSessionTyping(sessionName: string): boolean {
  const state = readState(sessionName);
  if (!state) return false;
  if (!state.routeToTelegram || !state.typing || isExpired(state, TYPING_TTL_MS)) {
    stopRemoteTyping(sessionName);
    return false;
  }
  return true;
}
