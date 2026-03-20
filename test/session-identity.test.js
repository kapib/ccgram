import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let testDir;
let router;
let identity;

beforeEach(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-identity-test-'));
  process.env.SESSION_MAP_PATH = path.join(testDir, 'session-map.json');
  process.env.CCGRAM_DATA_DIR = testDir;
  vi.resetModules();
  router = await import('../workspace-router.js');
  identity = await import('../src/utils/session-identity.js');
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
  delete process.env.SESSION_MAP_PATH;
  delete process.env.CCGRAM_DATA_DIR;
  delete process.env.CCGRAM_SESSION_NAME;
  delete process.env.CCGRAM_SESSION_TYPE;
});

describe('resolveSessionContext', () => {
  it('treats env-tagged sessions as managed', () => {
    process.env.CCGRAM_SESSION_NAME = 'claude-demo';
    process.env.CCGRAM_SESSION_TYPE = 'pty';

    const ctx = identity.resolveSessionContext({
      cwd: '/tmp/projects/demo',
      sessionId: 'abc-123',
    });

    expect(ctx.managed).toBe(true);
    expect(ctx.sessionName).toBe('claude-demo');
    expect(ctx.sessionType).toBe('pty');
  });

  it('matches a tracked session by session_id', () => {
    router.upsertSession({
      cwd: '/tmp/projects/demo',
      tmuxSession: 'claude-demo',
      status: 'waiting',
      sessionId: 'session-123',
      sessionType: 'tmux',
    });

    const ctx = identity.resolveSessionContext({
      cwd: '/tmp/projects/demo',
      sessionId: 'session-123',
    });

    expect(ctx.managed).toBe(true);
    expect(ctx.entry?.tmuxSession).toBe('claude-demo');
    expect(ctx.sessionType).toBe('tmux');
  });
});
