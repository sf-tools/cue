import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type CueCloudAuth = {
  baseUrl: string;
  accessToken: string;
  userId?: string | null;
  email?: string | null;
  savedAt: string;
};

export const CUE_CLOUD_AUTH_PATH = join(homedir(), '.cue', 'cloud-auth.json');

export const CUE_CLOUD_BASE_URL = 'https://cue.sf.tools';

export function defaultCueCloudUrl() {
  return CUE_CLOUD_BASE_URL;
}

export async function loadCueCloudAuth(path = CUE_CLOUD_AUTH_PATH): Promise<CueCloudAuth | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CueCloudAuth>;

    if (!parsed || typeof parsed.baseUrl !== 'string' || typeof parsed.accessToken !== 'string') {
      return null;
    }

    return {
      accessToken: parsed.accessToken,
      baseUrl: parsed.baseUrl,
      email: typeof parsed.email === 'string' ? parsed.email : null,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date().toISOString(),
      userId: typeof parsed.userId === 'string' ? parsed.userId : null
    };
  } catch {
    return null;
  }
}

export async function saveCueCloudAuth(auth: CueCloudAuth, path = CUE_CLOUD_AUTH_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(auth, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export async function clearCueCloudAuth(path = CUE_CLOUD_AUTH_PATH) {
  await rm(path, { force: true });
}
