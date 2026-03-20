export const MANAGED_SESSION_NAME_ENV = 'CCGRAM_MANAGED_SESSION_NAME';
export const MANAGED_SESSION_TYPE_ENV = 'CCGRAM_MANAGED_SESSION_TYPE';

const LEGACY_SESSION_NAME_ENV = 'CCGRAM_SESSION_NAME';
const LEGACY_SESSION_TYPE_ENV = 'CCGRAM_SESSION_TYPE';

export function buildManagedSessionEnv(
  sessionName: string,
  sessionType: 'tmux' | 'pty'
): Record<string, string> {
  return {
    [MANAGED_SESSION_NAME_ENV]: sessionName,
    [MANAGED_SESSION_TYPE_ENV]: sessionType,
  };
}

export function readManagedSessionEnv(
  env: NodeJS.ProcessEnv = process.env
): { sessionName: string | null; sessionType: string | null } {
  return {
    sessionName: env[MANAGED_SESSION_NAME_ENV] || env[LEGACY_SESSION_NAME_ENV] || null,
    sessionType: env[MANAGED_SESSION_TYPE_ENV] || env[LEGACY_SESSION_TYPE_ENV] || null,
  };
}
