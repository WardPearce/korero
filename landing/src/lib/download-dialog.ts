import { writable } from 'svelte/store';

export const downloadDialogOpen = writable(false);

export function openDownloadDialog() {
	downloadDialogOpen.set(true);
}

export function closeDownloadDialog() {
	downloadDialogOpen.set(false);
}
