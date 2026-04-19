import { createOpenAI } from '@ai-sdk/openai';
import { loadCueCloudAuth, type CueCloudAuth } from './auth-storage';

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

const providerCache = new Map<string, ReturnType<typeof createOpenAI>>();

function getProviderCacheKey(auth: CueCloudAuth) {
  return `${auth.baseUrl}:${auth.accessToken}`;
}

function getCueCloudProvider(auth: CueCloudAuth) {
  const cacheKey = getProviderCacheKey(auth);
  const existing = providerCache.get(cacheKey);
  if (existing) return existing;

  const provider = createOpenAI({
    apiKey: auth.accessToken,
    baseURL: joinUrl(auth.baseUrl, '/api/cli/chat')
  });

  providerCache.set(cacheKey, provider);
  return provider;
}

export async function requireCueCloudAuth() {
  const auth = await loadCueCloudAuth();
  if (!auth) {
    throw new Error('Cue Cloud login required. Please sign in first.');
  }

  return auth;
}

export async function loadCueCloudModel(modelId: string) {
  const auth = await requireCueCloudAuth();
  return getCueCloudProvider(auth)(modelId);
}
