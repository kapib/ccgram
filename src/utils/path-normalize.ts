import fs from 'fs';

export function normalizeExistingPath(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    return fs.realpathSync.native(input);
  } catch {
    return input;
  }
}
