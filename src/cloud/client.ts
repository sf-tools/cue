import { hostname } from 'node:os';
import { defaultCueCloudUrl, type CueCloudAuth } from './auth-storage';

export type DeviceStartResponse = {
  code: string;
  expiresAt: string;
  verificationUrl: string;
};

export type DevicePollResponse =
  | { status: 'pending' | 'cancelled' | 'completed' | 'expired' }
  | { status: 'approved'; accessToken: string; tokenId: string; user: { id: string; email: string | null } };

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, init);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cue Cloud is unavailable at ${defaultCueCloudUrl()} (${detail})`);
  }

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload?.error) detail = payload.error;
    } catch {}

    throw new Error(detail);
  }

  return response.json() as Promise<T>;
}

export async function startDeviceLogin(baseUrl = defaultCueCloudUrl()) {
  return request<DeviceStartResponse>(joinUrl(baseUrl, '/api/cli/device/start'), {
    body: JSON.stringify({
      clientHostname: hostname(),
      clientName: 'Cue CLI'
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST'
  });
}

export async function pollDeviceLogin(code: string, baseUrl = defaultCueCloudUrl()) {
  return request<DevicePollResponse>(joinUrl(baseUrl, '/api/cli/device/poll'), {
    body: JSON.stringify({ code }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST'
  });
}

export async function logoutCueCloud(auth: CueCloudAuth) {
  await request<{ ok: true }>(joinUrl(auth.baseUrl, '/api/cli/logout'), {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    method: 'POST'
  });
}

export async function syncPromptHistory(auth: CueCloudAuth, entry: { cwd: string; text: string; createdAt: string }) {
  await request<{ ok: true }>(joinUrl(auth.baseUrl, '/api/cli/prompt-history'), {
    body: JSON.stringify(entry),
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json'
    },
    method: 'POST'
  });
}

export async function syncSessionSnapshot(
  auth: CueCloudAuth,
  sessionId: string,
  snapshot: { cwd: string; state: unknown; totalCost: number | string; updatedAt: string }
) {
  await request<{ ok: true }>(joinUrl(auth.baseUrl, `/api/cli/sessions/${encodeURIComponent(sessionId)}`), {
    body: JSON.stringify(snapshot),
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json'
    },
    method: 'PUT'
  });
}

export async function shareCueThread(auth: CueCloudAuth, sessionId: string) {
  return request<{ share: { shareId: string; sharedAt: string; url: string } }>(
    joinUrl(auth.baseUrl, `/api/cli/sessions/${encodeURIComponent(sessionId)}/share`),
    {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'Content-Type': 'application/json'
      },
      method: 'POST'
    }
  );
}

export async function makeCueThreadPrivate(auth: CueCloudAuth, sessionId: string) {
  return request<{ ok: true }>(joinUrl(auth.baseUrl, `/api/cli/sessions/${encodeURIComponent(sessionId)}/share`), {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json'
    },
    method: 'DELETE'
  });
}
