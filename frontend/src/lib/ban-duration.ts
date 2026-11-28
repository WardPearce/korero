const hour = 60 * 60;
const day = 24 * hour;

/** Ban lengths offered to moderators; the server caps timed bans at one year. */
export const banDurations = {
  never: { label: "Never", seconds: undefined },
  "1h": { label: "1 hour", seconds: hour },
  "24h": { label: "24 hours", seconds: day },
  "7d": { label: "7 days", seconds: 7 * day },
  "30d": { label: "30 days", seconds: 30 * day },
  "365d": { label: "1 year", seconds: 365 * day },
} as const;

export type BanDuration = keyof typeof banDurations;

export const banDurationOptions = (Object.keys(banDurations) as BanDuration[])
  .map((value) => ({ value, label: banDurations[value].label }));

export function banPayload(accountId: string, duration: BanDuration) {
  const expiresInSeconds = banDurations[duration].seconds;
  return expiresInSeconds === undefined ? { accountId } : { accountId, expiresInSeconds };
}
