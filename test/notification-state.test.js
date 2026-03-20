import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let testDir;
let state;

beforeEach(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notification-state-test-'));
  process.env.CCGRAM_DATA_DIR = testDir;
  process.env.REMOTE_ROUTE_TTL_SECONDS = '1800';
  process.env.REMOTE_TYPING_TTL_SECONDS = '300';
  vi.resetModules();
  state = await import('../src/utils/notification-state.js');
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
  delete process.env.CCGRAM_DATA_DIR;
  delete process.env.REMOTE_ROUTE_TTL_SECONDS;
  delete process.env.REMOTE_TYPING_TTL_SECONDS;
});

describe('notification-state', () => {
  it('tracks route and typing state per session', () => {
    state.markRemoteSession('claude-demo', 'demo');
    expect(state.isRemoteSessionActive('claude-demo')).toBe(true);
    expect(state.isRemoteSessionTyping('claude-demo')).toBe(true);

    state.stopRemoteTyping('claude-demo');
    expect(state.isRemoteSessionActive('claude-demo')).toBe(true);
    expect(state.isRemoteSessionTyping('claude-demo')).toBe(false);
  });

  it('clears one session without affecting another', () => {
    state.markRemoteSession('claude-a', 'a');
    state.markRemoteSession('claude-b', 'b');

    state.clearRemoteSession('claude-a');

    expect(state.isRemoteSessionActive('claude-a')).toBe(false);
    expect(state.isRemoteSessionActive('claude-b')).toBe(true);
  });
});
