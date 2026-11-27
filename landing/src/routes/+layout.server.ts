import { getLatestRelease } from '#lib/server/releases.js';

export async function load() {
	return {
		release: await getLatestRelease()
	};
}
