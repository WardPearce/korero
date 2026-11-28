# Multiple roles per account

## Intent

Korero gives each account exactly one role. Admins want Discord-style stacking: an account
holds several roles at once (for example `Member` + `Moderator` + a custom `Streamer`),
and its permissions come from all of them combined. Existing servers must keep the access
they have today after upgrading.

## Goals

- An account holds 1–25 roles. Every permission check uses the full role set.
- Server-wide grants combine as a union.
- Channel overrides combine per channel level, with allow beating deny (rules below).
- The hierarchy still holds: you can only manage someone if you outrank every role they hold.
- Upgrading keeps every existing account's effective permissions.
- Live peers are re-checked when their roles change.
- Role additions and removals are audit-logged.

## Non-goals

- Reorderable ranks for custom roles. They keep the shared 2.5 tier between Moderator and
  Administrator. A real rank column is a separate, later step.
- Per-user (member-level) channel overrides.
- Version gating of protocol v1 (see Protocol).

## Anti-goals

- An existing Moderator or Administrator losing access to a channel after the upgrade.
- An actor being able to raise anyone above their own permissions by combining roles.
- Permission checks getting noticeably slower on the media and chat hot path.

## Approaches considered

**Permission evaluation**

- **A. One check over the role set, with a shared memo cache (chosen).** Results are cached
  by (sorted role set, channel, permission). Accounts share a handful of role sets, so the
  cache stays small. Changing one account's roles doesn't clear it, because the account
  just moves to a different key.
- B. Per-account permission tables built at login. Lookups are faster, but memory grows with
  online users and every grant or override edit rebuilds everyone's table.
- C. No cache. It's simplest, but it costs up to 25 roles × channel depth on every media
  and chat check.

**Migration**

- **SQL migration (chosen)**, matching the existing `migrations/*.sql` style, including a
  recursive query for the compensating allows.
- A TypeScript data fix after migrations. It's easier to read, but no other data fix is
  done outside SQL.

**Existing "deny Member" channels.** Chosen: Discord-style semantics, and the migration
writes compensating allows so that today's access survives. The rejected options were
"migrate as-is and let admins fix lockouts by hand" and "drop the base-role requirement".

## Decisions

### Permission rules

`allowed(account, permission, channel?)`:

1. If the account holds `Owner` → allowed.
2. If there is a channel, walk from that channel up through its parents. At each level, look at
   the overrides for **every** held role and permission:
   - if any held role has an explicit **allow** → allowed;
   - else if any held role has an explicit **deny** → denied;
   - else go to the parent.
3. If nothing was found, or there's no channel → allowed if **any** held role grants the
   permission server-wide.

Consequence, spelled out: a channel deny on role A beats a server-wide grant from role B.
Only an explicit allow for B, at the same level or a nearer one, restores it. Example: Alice
holds `Member` + `Moderator`, channel X denies `Member/join`, and Moderator has `join`
server-wide. Alice **cannot** join X until X (or a child she is joining) gets
`Moderator/join = allow`. Tests cover this at the same level and at different levels.

### Base role

Every account always holds at least one of `Guest`/`Member`. This includes Owner, where it
is harmless because Owner short-circuits. `role.remove` fails with `CONFLICT` if it would
remove the account's last base role. To swap Member for Guest, add Guest and then remove Member.

Sign-up assigns the registration default role. **If the default role is a custom role, sign-up
also assigns `Guest`** so that the base-role rule holds. (Builder's call. See open question.)

### Owner

It's still one special role, and holding it short-circuits every check. Bootstrap adds an `Owner` row
to the existing account instead of overwriting its role. The new-account bootstrap path creates
`Owner` + `Member`.

### Rank and hierarchy

- `rank(role)` is unchanged: built-ins by position, custom roles = 2.5.
- An account's effective rank is the highest rank among its roles.
- `subordinate`, `canBan` and kick/mute checks compare the actor's effective rank with the
  target's effective rank. They need actor > target, so roles you hold equal to or above
  yours protect the target.
- `role.add` / `role.remove` require all of the following:
  - the actor has `manageRoles`;
  - the actor's effective rank is above the target's effective rank (this also rules out
    changing your own roles);
  - the actor's effective rank is above `rank(role)`;
  - `holdsRoleGrants(actor, role)` is true, evaluated against the actor's combined role set
    at every override scope.
  The "Moderator can't remove a role from someone who also holds Administrator" case follows
  from the effective-rank rule.
- `lowerRoles` and `assignableRoles` use the actor's effective rank.
- Admin-only gates that read `actor.role === "Administrator" || "Owner"`
  (`auth.ts:59,485`, `defineRole`, `deleteRole`, `canDefineRoles`) become "effective rank ≥
  Administrator".

### Display

- `role` on Account and on member payloads = the **display role**, which is the highest-ranked
  held role. Ties between custom roles go to the earliest-created one (the rank closest to 0).
- Member lists show the display role's badge, as today (Guest/Member show no badge).
- The admin UI shows all held roles as chips. Each chip has a remove control when the actor
  may remove that role, plus an "add role" picker. The member context menu uses checkbox items
  over `assignableRoles` that toggle add/remove.

### Protocol

- Account and member objects gain `roles: Role[]`. `role` stays as the display role, so older
  clients keep rendering badges.
- WebSocket: `role.set` is **removed**. It's replaced by `role.add { accountId, role }` and
  `role.remove { accountId, role }`.
- HTTP: `PATCH /api/v1/admin/roles` is **removed**. It's replaced by
  `POST /api/v1/admin/accounts/roles` and `DELETE /api/v1/admin/accounts/roles`. Both take
  `{accountId, role}` and return `{roles}`.
- The admin accounts listing returns `roles` and `role` per account. `editable` means the actor
  outranks the account's effective rank.
- `serverPermissions` in the snapshot = the union across held roles.
- No version gating. `docs/compatibility.md` has no protocol-version policy, and the client
  ignores `protocolVersions`. An old client's role menu fails with an unknown-request error, and
  nothing else breaks. Update `docs/protocol.md` and `docs/protocol-v1.schema.json`.

### Limit

There's a hard cap of 25 roles per account (a constant). `role.add` beyond the cap → `CONFLICT`.

### Deleting a custom role

It stays **blocked** while any account holds it (current behaviour and error message).

### Caching (hot path)

- The memo is `Map<string, boolean>`, keyed `roleSetKey + "\0" + (channelId ?? "") + "\0" + permission`.
  `roleSetKey` = the sorted held roles joined by `\0`, computed once when the `Account` is loaded.
- The whole memo is cleared whenever `roleGrants`, `overrides`, `customRoles` or the channel
  tree's parent links change. That covers role define/delete, channel override changes, channel
  create/move/reparent/delete, and the default-role change if it touches grants.
- An account's role change needs no cache clearing. It reloads the `Account` (new `roleSetKey`).
- Callers that check a hypothetical single role (`registrationRoles`, `channelPermissions`
  listing's `inherited`, `authorizeRolePermissionChange`, `moveChannel`'s per-role diff) use the
  same evaluator with a one-role set.

### Live updates

`role.add`/`role.remove` call the existing `accountChanged(accountId)`. It reloads the account,
runs `recheck` on every peer (leaving channels it can no longer join, stopping media without
speak permission, re-checking whispers), broadcasts the member change, and sends `state.invalidated`.
Role-definition and override changes keep calling `recheckAll`.

### Audit

`role.added` and `role.removed` events, target = account ID, details `{ role, roles }` (the
resulting set). Existing `role.changed` events stay in history untouched.

### Migration (`0022_multiple_roles.sql`)

1. Rebuild `account_roles` with `PRIMARY KEY (account_id, role)`, the FK to `accounts` (cascade)
   and `roles`, and the `account_roles_role` index. Copy every existing row (one per account).
2. Insert `(account_id, 'Member')` for every account that holds neither `Guest` nor `Member`.
3. Compensating allows: for every channel C and permission P where `Member` has an explicit
   **deny** at C, and for every role R ∉ {Guest, Member, Owner} that has **no** override at
   (C, P): compute R's pre-migration value at C, which is R's nearest override on a strict ancestor
   of C, else R's server grant for P. If that value is allow, insert `(C, R, P, allow = 1)`. This
   is done for every such role, held or not. Only Member denies matter, because the migration
   adds Member and never Guest.
4. Known, accepted change: where `Member` has a channel **allow** that a higher role lacked,
   holders of that higher role now gain it, because they're Members too.
5. Update `meta/_journal.json`, and the Drizzle snapshot if the repo keeps them.

After the upgrade, new promotions don't get automatic compensation. `docs/` should note that
a channel which denies `Member` needs explicit allows for the higher roles.

## Tests (written first)

- Union of server grants across two roles.
- A channel deny on A vs. an allow on B at the same level (→ allow), at different levels
  (the nearer level wins, whichever way), and a deny on A vs. a server-wide grant from B (→ deny).
- Hierarchy: a Moderator can't remove a role from an account that also holds Administrator. An actor
  can't add a role carrying a permission they don't hold (server-wide or via an override).
- Base role: removing the last of Guest/Member → `CONFLICT`.
- The cap: adding a 26th role → `CONFLICT`.
- Migration: a database at migration 0021 with single-role accounts (including a Moderator and
  a "deny Member join" channel) upgrades to the same roles plus `Member`. The Moderator can still
  join the channel, and plain Members still can't.
- Live: removing the role that granted `join` moves the peer out of the channel. Removing the role
  that granted `speak` stops its producer.
- Audit events for add/remove.
- Deleting a held custom role is still `CONFLICT`.
- `backend/tests/e2e/audio.ts` and existing `role.set` callers move to `role.add`/`role.remove`.

## Left to the builder

The exact SQL for the recursive compensation query. Where the memo-clearing calls go. The UI
details of the chips and checkbox menu within the existing component styles. How to fit the
`Account` type changes (`roles`, `role`, `roleSetKey`) into `auth.ts` loading.
