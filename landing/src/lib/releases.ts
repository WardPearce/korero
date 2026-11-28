export type PlatformId = 'linux' | 'windows' | 'macos' | 'android';

export type ReleaseDownload = {
	label: string;
	url: string;
	size: number;
};

export type PlatformRelease = {
	id: PlatformId;
	primary: ReleaseDownload;
	alternatives: ReleaseDownload[];
};

export type LatestRelease = {
	tag: string;
	version: string;
	url: string;
	publishedAt: string | null;
	platforms: PlatformRelease[];
};

type GithubAsset = {
	name: string;
	size: number;
	browser_download_url: string;
};

export type GithubRelease = {
	tag_name: string;
	html_url: string;
	published_at: string | null;
	assets: GithubAsset[];
};

type Format = {
	label: string;
	pattern: RegExp;
};

const formats: Record<PlatformId, { primary: Format; alternatives: Format[] }> = {
	linux: {
		primary: { label: 'AppImage', pattern: /\.AppImage$/i },
		alternatives: [
			{ label: 'Debian package', pattern: /\.deb$/i },
			{ label: 'RPM package', pattern: /\.rpm$/i },
			{
				label: 'Zip archive',
				pattern: /(?:korero\.chat-linux-[\w]+|korero-chat-frontend-.*)\.zip$/i
			}
		]
	},
	windows: {
		primary: { label: 'Installer', pattern: /(?:korero\.chat-win-[\w]+|Setup\..*)\.exe$/i },
		alternatives: [
			{ label: '7z archive', pattern: /-win(?:-[\w]+)?\.7z$/i },
			{ label: 'Zip archive', pattern: /-win(?:-[\w]+)?\.zip$/i }
		]
	},
	macos: {
		primary: { label: 'Disk image', pattern: /\.dmg$/i },
		alternatives: [{ label: 'Zip archive', pattern: /-mac(?:-[\w]+)?\.zip$/i }]
	},
	android: {
		primary: { label: 'APK', pattern: /\.apk$/i },
		alternatives: []
	}
};

const platformOrder: PlatformId[] = ['linux', 'windows', 'macos', 'android'];

function findAsset(assets: GithubAsset[], format: Format): ReleaseDownload | null {
	const asset = assets.find((candidate) => format.pattern.test(candidate.name));
	if (!asset) return null;

	return {
		label: format.label,
		url: asset.browser_download_url,
		size: asset.size
	};
}

export function buildLatestRelease(release: GithubRelease): LatestRelease {
	const platforms: PlatformRelease[] = [];

	for (const id of platformOrder) {
		const primary = findAsset(release.assets, formats[id].primary);
		if (!primary) continue;

		const alternatives = formats[id].alternatives
			.map((format) => findAsset(release.assets, format))
			.filter((download): download is ReleaseDownload => download !== null);

		platforms.push({ id, primary, alternatives });
	}

	return {
		tag: release.tag_name,
		version: release.tag_name.replace(/^v/, ''),
		url: release.html_url,
		publishedAt: release.published_at,
		platforms
	};
}
