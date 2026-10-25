import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const APP_NAME = 'void-workshop';
export const APP_VERSION = '0.3.0';

/** Locations the sidecar owns. Nothing here ever holds the API key except `keyFile` (file backend only). */
export interface AppPaths {
  dataDir: string;
  configDir: string;
  dbPath: string;
  /** Isolated config dir for the Agent SDK runtime. Holds session transcripts; never subscription credentials. */
  claudeConfigDir: string;
  logDir: string;
  preimageDir: string;
  /** Images the agent looked at (screenshots), kept per task so they can be shown later. */
  imageDir: string;
  keyFile: string;
  keyHelper: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** sidecar/ directory, whether running from src/ (tests) or dist/ (built). */
export const SIDECAR_DIR = path.resolve(here, '..');

export function resolveAppPaths(env: NodeJS.ProcessEnv = process.env): AppPaths {
  const home = os.homedir();
  const dataDir = env.VOID_WORKSHOP_DATA_DIR ?? path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), APP_NAME);
  const configDir = env.VOID_WORKSHOP_CONFIG_DIR ?? path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_NAME);
  return {
    dataDir,
    configDir,
    dbPath: path.join(dataDir, 'workshop.db'),
    claudeConfigDir: path.join(dataDir, 'agent-runtime'),
    logDir: path.join(dataDir, 'logs'),
    preimageDir: path.join(dataDir, 'preimages'),
    imageDir: path.join(dataDir, 'images'),
    keyFile: env.VOID_WORKSHOP_KEY_FILE ?? path.join(configDir, 'credentials', 'anthropic-api-key'),
    keyHelper: env.VOID_WORKSHOP_KEY_HELPER ?? path.join(SIDECAR_DIR, 'bin', 'key-helper.sh'),
  };
}

export function ensureAppDirs(p: AppPaths): void {
  for (const dir of [p.dataDir, p.configDir, p.claudeConfigDir, p.logDir, p.preimageDir, p.imageDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
}

/** Refuse to operate with root privileges. */
export function assertNotRoot(): void {
  if (typeof process.getuid === 'function' && (process.getuid() === 0 || process.geteuid?.() === 0)) {
    throw new Error('VOID Workshop refuses to run as root. Start it as your normal user.');
  }
}
