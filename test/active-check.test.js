import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { getLastMsgFile, isUserActiveAtTerminal } from '../src/utils/active-check.js';

const LAST_MSG_FILE = '/tmp/claude_last_msg_time';
const WORKSPACE_FILE = getLastMsgFile('/tmp/projects/demo.workspace');

function nowSecs() {
  return Math.floor(Date.now() / 1000);
}

let savedContent = null;
let savedWorkspaceContent = null;

beforeEach(() => {
  // Save existing file so we can restore it after the test
  try { savedContent = fs.readFileSync(LAST_MSG_FILE, 'utf8'); } catch { savedContent = null; }
  try { savedWorkspaceContent = fs.readFileSync(WORKSPACE_FILE, 'utf8'); } catch { savedWorkspaceContent = null; }
  try { fs.unlinkSync(LAST_MSG_FILE); } catch {}
  try { fs.unlinkSync(WORKSPACE_FILE); } catch {}
  delete process.env.ACTIVE_THRESHOLD_SECONDS;
});

afterEach(() => {
  try { fs.unlinkSync(LAST_MSG_FILE); } catch {}
  try { fs.unlinkSync(WORKSPACE_FILE); } catch {}
  if (savedContent !== null) {
    fs.writeFileSync(LAST_MSG_FILE, savedContent);
  }
  if (savedWorkspaceContent !== null) {
    fs.writeFileSync(WORKSPACE_FILE, savedWorkspaceContent);
  }
  delete process.env.ACTIVE_THRESHOLD_SECONDS;
});

describe('isUserActiveAtTerminal', () => {
  it('returns false when timestamp file does not exist', () => {
    expect(isUserActiveAtTerminal()).toBe(false);
  });

  it('returns true when timestamp is within the threshold', () => {
    fs.writeFileSync(LAST_MSG_FILE, String(nowSecs() - 60));
    expect(isUserActiveAtTerminal()).toBe(true);
  });

  it('returns false when timestamp is older than the threshold', () => {
    fs.writeFileSync(LAST_MSG_FILE, String(nowSecs() - 400));
    expect(isUserActiveAtTerminal()).toBe(false);
  });

  it('respects explicit threshold argument', () => {
    fs.writeFileSync(LAST_MSG_FILE, String(nowSecs() - 30));
    expect(isUserActiveAtTerminal(20)).toBe(false);
    expect(isUserActiveAtTerminal(60)).toBe(true);
  });

  it('threshold of 0 always returns false', () => {
    fs.writeFileSync(LAST_MSG_FILE, String(nowSecs()));
    expect(isUserActiveAtTerminal(0)).toBe(false);
  });

  it('reads ACTIVE_THRESHOLD_SECONDS from env when no argument is given', () => {
    fs.writeFileSync(LAST_MSG_FILE, String(nowSecs() - 5));
    process.env.ACTIVE_THRESHOLD_SECONDS = '10';
    expect(isUserActiveAtTerminal()).toBe(true);

    process.env.ACTIVE_THRESHOLD_SECONDS = '3';
    expect(isUserActiveAtTerminal()).toBe(false);
  });

  it('returns false for malformed timestamp', () => {
    fs.writeFileSync(LAST_MSG_FILE, 'not-a-number');
    expect(isUserActiveAtTerminal()).toBe(false);
  });

  it('returns false for empty file', () => {
    fs.writeFileSync(LAST_MSG_FILE, '');
    expect(isUserActiveAtTerminal()).toBe(false);
  });

  it('uses a per-workspace file when cwd is provided', () => {
    fs.writeFileSync(WORKSPACE_FILE, String(nowSecs() - 20));
    expect(isUserActiveAtTerminal('/tmp/projects/demo.workspace', 60)).toBe(true);
    expect(isUserActiveAtTerminal('/tmp/projects/demo.workspace', 10)).toBe(false);
  });

  it('falls back to the global file when workspace file is missing', () => {
    fs.writeFileSync(LAST_MSG_FILE, String(nowSecs() - 20));
    expect(isUserActiveAtTerminal('/tmp/projects/demo.workspace', 60)).toBe(true);
  });

  it('derives unique files for similar workspace basenames', () => {
    const file1 = getLastMsgFile('/tmp/projects/foo.bar');
    const file2 = getLastMsgFile('/tmp/projects/foo_bar');
    expect(file1).not.toBe(file2);
  });
});
