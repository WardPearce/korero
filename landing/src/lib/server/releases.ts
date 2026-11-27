import { buildLatestRelease, type GithubRelease, type LatestRelease } from '#lib/releases.js';

const repository = 'WardPearce/korero';
const apiUrl = `https://api.github.com/repos/${repository}/releases/latest`;

// The unauthenticated GitHub API allows 60 requests per hour per IP, so keep
// responses in memory rather than hitting it on every page view.
const cacheTtlMs = 10 * 60 * 1000;
const failureTtlMs = 60 * 1000;

let cache: { release: LatestRelease | null; expiresAt: number } | null = null;

export async function getLatestRelease(): Promise<LatestRelease | null> {
	if (cache && Date.now() < cache.expiresAt) return cache.release;

	const headers: Record<string, string> = {
		Accept: 'application/vnd.github+json',
		'User-Agent': 'korero-landing',
		'X-GitHub-Api-Version': '2022-11-28'
	};

	// Optional: a token raises the API rate limit for busy deployments.
	if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

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
