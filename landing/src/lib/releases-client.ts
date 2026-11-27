import { browser } from '$app/environment';
import { buildLatestRelease, type GithubRelease, type LatestRelease } from '#lib/releases.js';

const repository = 'WardPearce/korero';
const apiUrl = `https://api.github.com/repos/${repository}/releases/latest`;

// The unauthenticated GitHub API allows 60 requests per hour per IP. Keep
// responses in memory so a visitor only hits it once per browser session.
const cacheTtlMs = 10 * 60 * 1000;
const failureTtlMs = 60 * 1000;

let cache: { release: LatestRelease | null; expiresAt: number } | null = null;
let pending: Promise<LatestRelease | null> | null = null;

async function fetchLatestRelease(): Promise<LatestRelease | null> {
	const headers: Record<string, string> = {
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28'
	};

	try {
		const response = await fetch(apiUrl, { headers });
		if (!response.ok) throw new Error(`GitHub API responded with ${response.status}`);

		const release = buildLatestRelease((await response.json()) as GithubRelease);
		cache = { release, expiresAt: Date.now() + cacheTtlMs };
		return release;
	} catch (error) {
		console.warn('Could not load the latest GitHub release:', error);
		// Serve a stale response if one is available, otherwise fall back to the
		// releases page in the UI and retry again shortly.
		cache = { release: cache?.release ?? null, expiresAt: Date.now() + failureTtlMs };
		return cache.release;
	}
}

export async function getLatestRelease(): Promise<LatestRelease | null> {
	if (!browser) return null;
	if (cache && Date.now() < cache.expiresAt) return cache.release;
	if (!pending) pending = fetchLatestRelease().finally(() => (pending = null));
	return pending;
}
