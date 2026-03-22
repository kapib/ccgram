import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';

import {
  extractLastResponse,
  getResponseText,
} from '../enhanced-hook-notify.js';

const FIXTURE_HOME = path.join(process.cwd(), 'test', 'fixtures', 'home');
const FIXTURE_PROJECTS = path.join(
  FIXTURE_HOME,
  '.claude',
  'projects',
  '-Users-kapi-Documents-GitHub-kabu'
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('enhanced-hook-notify response extraction', () => {
  it('extracts both text blocks when a response is split across assistant and tool_use entries', () => {
    const transcriptPath = path.join(
      FIXTURE_PROJECTS,
      '4dfe8fb5-79bc-4d34-8f10-dcadd057512f.jsonl'
    );

    expect(extractLastResponse(transcriptPath)).toBe(
      '了解。一旦コミットしてからクリアしよう。\n\nコミットすべきものはない。クリアしてAIイベントに集中しよう。'
    );
  });

  it('extracts text from an assistant entry that mixes text and tool_use blocks', () => {
    const transcriptPath = path.join(
      FIXTURE_PROJECTS,
      '1ee37e48-bd1f-4b49-bd9f-da8944afc647.jsonl'
    );

    expect(extractLastResponse(transcriptPath)).toBe(
      '液冷いこう。Vera RubinのTDP倍増で「物理的に必須」なところ、サクッと当たる。'
    );
  });

  it('falls back to session_id + cwd lookup when transcript_path is missing from the hook payload', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(FIXTURE_HOME);

    expect(
      getResponseText({}, '/Users/kapi/Documents/GitHub/kabu', '4dfe8fb5-79bc-4d34-8f10-dcadd057512f')
    ).toBe(
      '了解。一旦コミットしてからクリアしよう。\n\nコミットすべきものはない。クリアしてAIイベントに集中しよう。'
    );
  });
});
