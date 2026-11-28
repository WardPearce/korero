# Multiple Roles per Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an account hold 1–25 roles and combine their permissions Discord-style, without losing anyone's access on upgrade.

**Architecture:** `account_roles` gets a composite key. `Account` carries `roles` (sorted by rank), the display `role` and a `roleSetKey`. A single evaluator in `realtime.ts` resolves `(role set, permission, channel)` with a memo cache. `role.set` is replaced by `role.add`/`role.remove`, which go through the existing `accountChanged` live-update path. A SQL migration writes compensating allows so that existing "deny Member" channels keep admitting higher roles.

**Tech Stack:** Bun, Elysia, Drizzle (bun-sqlite), SvelteKit 5, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-28-multiple-roles-design.md`

## Global Constraints

- Every account holds at least one of `Guest`/`Member`, Owner included.
- Max roles per account: `MAX_ACCOUNT_ROLES = 25`. Exceeding it → `CONFLICT`.
- A custom default role at sign-up also assigns `Guest`.
- Custom roles keep rank 2.5. Effective rank = the highest held rank.
- Display role = the highest-ranked role. Ties between custom roles → earliest created (the DB rank closest to 0).
- Channel rule: at each level, nearest first, any held-role allow → allow; else any deny → deny; else go to the parent. Fallback: union of server grants. Owner → always allowed.
- Deleting a custom role while any account holds it → `CONFLICT` (unchanged).
- Audit actions: `role.added`, `role.removed`, details `{ role, roles }`.
- Wire: `role.add`/`role.remove { accountId, role }`. HTTP `POST`/`DELETE /api/v1/admin/accounts/roles {accountId, role}` → `{roles}`. Remove `role.set` and `PATCH /api/v1/admin/roles`. Account and member payloads carry `roles` plus `role` (display).
- Commits: the working tree has unrelated uncommitted work on `main`. Work on a branch, stage only the files each task lists, and commit only with the user's go-ahead.

## Review Focus

1. A permission is checked (and cached), then an override changes → the next check reflects the change. (Task 4)
2. A channel is reparented under a parent that denies a held role → access is recomputed for the moved subtree. (Task 4)
3. An account with two open connections gets a role removed → both connections are re-checked. (Task 4)
4. The admin accounts listing with accounts that hold 3 roles → each account appears once and a page holds 50 accounts, not 50 rows. (Task 3)
5. An account holding a custom role alongside Member → deleting that role is `CONFLICT`. After `role.remove` it succeeds. (Task 3)

---

### Task 1: Migration and schema

**Files:**
- Create: `backend/src/database/migrations/0022_multiple_roles.sql`
- Modify: `backend/src/database/migrations/meta/_journal.json` (append idx 22, plus a snapshot if the folder keeps them)
- Modify: `backend/src/database/schema.ts:33-36`
- Test: `backend/tests/integration/persistence.test.ts`

**Interfaces:**
- Produces: `accountRoles` with `primaryKey({ columns: [table.accountId, table.role] })` and index `account_roles_role` on `role`.

- [ ] **Step 1: Write the failing test** `"upgrading to multiple roles keeps each account's role, adds Member, and preserves access to Member-denied channels"`. Follow the existing upgrade test's pattern: migrate with entries `idx < 22`, seed roles and permissions, and seed a custom role `Reader` (rank -1, grants `join`). Insert accounts (raw `INSERT INTO accounts`/`account_roles`): `guest`→Guest, `member`→Member, `mod`→Moderator, `admin`→Administrator, `reader`→Reader. Create channels `Parent` ⟶ `Child` ⟶ `Grandchild`. Overrides: `(Parent, Member, join, 0)`, `(Child, Moderator, join, 0)`, `(Parent, Member, text, 0)`, `(Parent, Reader, text, 1)`. Then `openDatabase(directory)` and assert:
  - `account_roles` for each account: guest `[Guest]`, member `[Member]`, mod `[Member, Moderator]`, admin `[Administrator, Member]`, reader `[Member, Reader]` (sorted).
  - A compensating allow exists for `(Parent, Moderator, join)`, `(Parent, Administrator, join)`, `(Parent, Reader, join)`, `(Parent, Moderator, text)` and `(Parent, Administrator, text)`.
  - No new row at `(Child, Moderator, join)`: the existing deny is kept, and the override count at `Child` is unchanged.
  - `(Parent, Reader, text)` is still `1` and there is no duplicate row.
  - No compensating row for `Guest`, `Member` or `Owner`.
  - `PRAGMA index_list('account_roles')` includes `account_roles_role`.
  - Inserting a duplicate `(account_id, role)` throws, and a second distinct role succeeds.

- [ ] **Step 2: Run** `bun test tests/integration/persistence.test.ts`. Expected: FAIL (journal has no idx 22 / single-row PK).

- [ ] **Step 3: Write the migration.** Rebuild the table (`CREATE TABLE account_roles_new … PRIMARY KEY (account_id, role)`, FKs as today with `ON DELETE CASCADE` on account, then copy, drop, rename, `CREATE INDEX account_roles_role`). Then `INSERT … SELECT id, 'Member' FROM accounts WHERE NOT EXISTS (Guest/Member row)`. Then the compensating insert: for each `(C, P)` with `channel_overrides(C, 'Member', P, 0)` and each role R in `roles` with `name NOT IN ('Guest','Member','Owner')` and no override at `(C, R, P)`, insert `(C, R, P, 1)` when R's value at C before the migration is allow:

  ```sql
  WITH RECURSIVE ancestors(channel_id, ancestor_id, depth) AS (
    SELECT id, parent_id, 1 FROM channels WHERE parent_id IS NOT NULL
    UNION ALL
    SELECT a.channel_id, c.parent_id, a.depth + 1 FROM ancestors a JOIN channels c ON c.id = a.ancestor_id
    WHERE c.parent_id IS NOT NULL)
  -- prior(C,R,P) = allow of the override on the minimum-depth ancestor of C for (R,P),
  --                else EXISTS role_permissions(R,P)
  ```
  Update `schema.ts` to the composite key. Add the journal entry.

- [ ] **Step 4: Run** `bun test tests/integration/persistence.test.ts`. Expected: PASS. Then run the whole `bun test` to confirm the other suites still boot. Code that reads `.get()` for a single role still works for single-role accounts.

- [ ] **Step 5: Commit** `feat(db): allow multiple roles per account with access-preserving migration`.

### Task 2: Account loading, registration and bootstrap

**Files:**
- Modify: `backend/src/database/index.ts` (constants and helpers)
- Modify: `backend/src/modules/auth.ts:12,58-72,205-222,252-272,485`
- Modify: `backend/tests/server.ts:10` (`account` type gains `roles: string[]`)
- Test: `backend/tests/integration/auth.test.ts`

**Interfaces:**
- Produces in `database/index.ts`:
  - `MAX_ACCOUNT_ROLES = 25`, `baseRoles = ["Guest", "Member"] as const`
  - `roleRank(name: Role, dbRank: number): number`: built-in → its index in `roles`; custom (dbRank < 0) → 2.5
  - `sortRoles(rows: { name: Role; rank: number }[]): Role[]`: sorted by `roleRank` desc, ties by dbRank desc
- Produces in `auth.ts`: `type Account = accounts row & { roles: Role[]; role: Role; roleSetKey: string; avatarId: string | null }`, where `role = roles[0]` and `roleSetKey = [...roles].sort().join("\0")`. Export `accountRoleNames(db: Queries, id: string): Role[]`.

- [ ] **Step 1: Write the failing tests** in `auth.test.ts`:
  - `"a new account holds the default role"`: `register("Newcomer")` → `account.roles` equals `["Member"]` and `account.role` is `"Member"`.
  - `"a custom default role also grants Guest"`: the owner creates custom `Visitor` (grants `join`) and sets `defaultRole: "Visitor"` through the preferences endpoint. Register → `roles` equals `["Visitor", "Guest"]` and `role` is `"Visitor"`.
  - `"the owner holds Owner and Member"`: `owner().account.roles` equals `["Owner", "Member"]`.
  - `"bootstrapping an existing account adds Owner without dropping its roles"`: follow the existing bootstrap-existing-identity test → `roles` contains `"Owner"` and its previous base role.

- [ ] **Step 2: Run** `bun test tests/integration/auth.test.ts`. Expected: FAIL (`roles` undefined).

- [ ] **Step 3: Implement.**
  - `getAccount`: load the account row plus a second query for its roles joined to `rolesTable` for ranks, then `sortRoles`.
  - `hasOwner`: unchanged query semantics.
  - `createAccount(db, name, device, role, identity, joinedViaInvitation)`: insert `role`, plus `Guest` when `role` is not a base role. Return the account via `getAccount`.
  - New-owner bootstrap: `createAccount(..., "Owner")` inserts `Owner` + `Member`. Make the non-base fallback depend on the role: `Member` for Owner, `Guest` for custom roles.
  - Existing-identity bootstrap: `insert … onConflictDoNothing` for `Owner` instead of the update.
  - `invitationScope` and `auth.ts:485`: `actor.roles.includes("Administrator") || actor.roles.includes("Owner")`.

- [ ] **Step 4: Run** `bun test tests/integration/auth.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(auth): load every role an account holds`.

### Task 3: Combined permission evaluator and `role.add` / `role.remove`

**Files:**
- Modify: `backend/src/modules/realtime.ts` (`allowed`, `roleAllowed`, `channelOverride`, `rank`, `holdsRoleGrants`, `canManageRole`, `lowerRoles`, `listAccounts`, `setRole`→`addRole`/`removeRole`, `deleteRole`, `defineRole`, `subordinate`, `canBan`, `member`, `snapshot`, `authorizeRolePermissionChange`, the `moveChannel` per-role diff, the ban-actor rank check ~1305, and the request switch ~1280)
- Modify: `backend/src/protocol/index.ts:143`
- Modify: `backend/src/app.ts:321-324`
- Modify (callers): `backend/tests/integration/administration.test.ts`, `application.test.ts`, `persistence.test.ts`, `hardening.test.ts`, `hosted-accounts.test.ts`, `backend/tests/e2e/audio.ts`. Every `role.set` or `PATCH /api/v1/admin/roles` becomes `role.add` (plus `role.remove` where the test relied on replacement, e.g. demoting to Guest = add Guest, remove Member)
- Test: `backend/tests/integration/administration.test.ts`

**Interfaces:**
- Consumes: `Account.roles`, `Account.roleSetKey`, `MAX_ACCOUNT_ROLES`, `baseRoles` (Task 2).
- Produces in `RealtimeService`:
  - `private rolesAllowed(roles: readonly Role[], key: string, permission: Permission, channel?: Channel): boolean` (memoised on `key\0channelId\0permission`)
  - `private allowed(account, permission, channel?)` → `rolesAllowed(account.roles, account.roleSetKey, …)`
  - `private roleAllowed(role, permission, channel?)` → `rolesAllowed([role], role, …)` (kept for single-role callers)
  - `private effectiveRank(account: { roles: readonly Role[] }): number`
  - `private clearPermissionCache(): void`
  - `addRole(actor: Account, accountId: string, role: Role): { roles: Role[] }`
  - `removeRole(actor: Account, accountId: string, role: Role): { roles: Role[] }`
- Wire: payloads `"role.add"` and `"role.remove"`, both `object({ accountId: id, role: roleName })`. HTTP `POST`/`DELETE /api/v1/admin/accounts/roles` with body `payloads["role.add"]`.

- [ ] **Step 1: Write the failing tests** in `administration.test.ts`. They use a shared helper `grant(actor, target, role)` = `server.call("/api/v1/admin/accounts/roles", { accountId, role }, token, "POST")` and a matching `revoke` with `"DELETE"`.
  - `"server grants combine across held roles"`: custom `Talker` (grants `speak` only) and custom `Writer` (grants `text` only). A Guest gets both, then Member is removed. Assert `state.get`: in Lobby `canSendText === true`, and `serverPermissions` contains `speak`, `text` and `join`.
  - `"an allow on one role beats a deny on another at the same channel level"`: on channel X set `Member/text = false` and `Writer/text = true`. A Member+Writer account can send text in X, and a plain Member can't (`FORBIDDEN`).
  - `"the nearest channel level decides across roles"`: parent P has `Writer/text = true`, child C has `Member/text = false` → Member+Writer is denied in C. Swap them (P has `Member/text = false`, C has `Writer/text = true`) → allowed in C.
  - `"a channel deny on one role beats a server-wide grant from another"`: X has `Member/join = false`. A Member+Moderator account can't join X (`FORBIDDEN`). After adding `Moderator/join = true` on X it can.
  - `"a Moderator cannot change roles of an account that also holds Administrator"`: target holds Member+Administrator. Moderator `revoke(target, "Member")` → 403, and Moderator `grant(target, "Guest")` → 403.
  - `"an actor cannot grant a role carrying permissions they lack"`: custom `Banner` grants `ban`. An Administrator with `ban` removed from its built-in grants (using the existing definition endpoint as owner) → `grant(member, "Banner")` → 403. Also cover a channel-only escalation: a custom role with an X override allow for `deleteChannels`, granted by an actor without `deleteChannels` in X → 403.
  - `"an account keeps at least one base role"`: `revoke(member, "Member")` → 409. Grant Guest first, then `revoke(member, "Member")` → 200 and `roles` is `["Guest"]`.
  - `"an account holds at most 25 roles"`: create 24 custom roles (each granting `join`) and grant them to a Member (25 total) → 200. The 26th → 409.
  - `"role additions and removals are audited"`: the audit endpoint shows `role.added` and `role.removed`, both with `details.role` and `details.roles`.
  - `"adding a role already held or removing one not held is a no-op"`: 200, `roles` unchanged, no audit event.
  - Review Focus 4: `"the accounts listing pages by account"`: 55 accounts, 3 of which hold 3 roles → the first page has 50 distinct `id`s, `next` is non-null, and each multi-role row has `roles.length === 3`.
  - Review Focus 5: `"a held custom role cannot be deleted until removed"`: `DELETE /api/v1/admin/roles/definition` → 409. After `revoke` → 200.

- [ ] **Step 2: Run** `bun test tests/integration/administration.test.ts`. Expected: FAIL (404 on the new endpoint).

- [ ] **Step 3: Implement the evaluator.** `rolesAllowed`: `roles.includes("Owner")` → true. Walk the chain: at each channel, read `overrides.get(id)` once and check `${role}/${permission}` for every role in `roles`. The first level with any allow → true, with any deny → false. Fallback: `roles.some(r => roleGrants.get(r)?.has(permission))`. Memoise. `effectiveRank` = max `rank(r)`. Replace every `actor.role`/`target.role` comparison listed under Files with the effective rank. `holdsRoleGrants(actor, role, grants)` checks overrides for `role` or for **any** of `actor.roles`. `canManageRole(actor, role)` = `rank(role) < effectiveRank(actor) && holdsRoleGrants(actor, role)`. `lowerRoles` uses `effectiveRank`. `canBan` takes the target `Account` and uses `effectiveRank` plus `allowed(target, "ban")`. `serverPermissions` = the union. `member()` adds `roles`.

- [ ] **Step 4: Implement `addRole`/`removeRole`.**
  - Common checks: `require(actor, "manageRoles")`; load the target; `effectiveRank(target) < effectiveRank(actor)` else FORBIDDEN; `canManageRole(actor, role)` else FORBIDDEN.
  - add: if already held, return. If `roles.length >= MAX_ACCOUNT_ROLES` → `ProtocolError("CONFLICT", "An account can hold at most 25 roles.")`.
  - remove: if not held, return. If it's the last base role → `ProtocolError("CONFLICT", "An account must keep the Guest or Member role.")`.
  - Write the row in an `immediate` transaction with an `audit(...)` (`{ role, roles: next }`), then `accountChanged(accountId)` and return `{ roles }`.
  - `listAccounts`: select a page of account IDs first (`limit(51)`), then their roles in one `inArray` query and group them. Each row: `roles`, `role`, and `editable: effectiveRank(row) < effectiveRank(actor)`.
  - Drop `setRole`, `role.set` and the PATCH route. Wire `role.add`, `role.remove` and the two HTTP routes.

- [ ] **Step 5: Update the callers** listed under Files.

- [ ] **Step 6: Run** `bun test tests/unit tests/integration` and `bun run check`. Expected: all PASS, tsc clean.

- [ ] **Step 7: Commit** `feat: combine permissions across held roles; replace role.set with role.add/remove`.

### Task 4: Live re-checks and cache invalidation

**Files:**
- Modify: `backend/src/modules/realtime.ts` (call `clearPermissionCache()` wherever `roleGrants`, `customRoles`, `overrides` or a channel's `parentId` change: `defineRole`, `deleteRole`, `overrideChannel`, channel create/edit-reparent/delete, startup load)
- Test: `backend/tests/integration/administration.test.ts`

**Interfaces:**
- Consumes: `addRole`, `removeRole`, `clearPermissionCache` (Task 3).

- [ ] **Step 1: Write the failing tests.**
  - `"removing the role that granted join moves the live peer out"`: X has `Member/join = false` and `Writer/join = true`. A Member+Writer peer joins X. Owner revokes Writer → `until(state.get, s => s.channelId !== X)`.
  - `"removing the role that granted speak stops the peer's audio"`: X has `Member/speak = false` and `Talker/speak = true`. The peer joins X and produces audio (use the existing media-producer helper from the mute tests). Revoke Talker → its producer is closed or paused the same way the existing role-change test asserts, and `state.get().channels` shows the loss of speak.
  - Review Focus 3: `"a role change re-checks every connection of the account"`: two sockets for the same account in X. Revoke → both leave X.
  - Review Focus 1: `"override changes take effect after a cached check"`: a Member sends text in X (cached allow). Owner sets `Member/text = false` on X → the next `message.send` fails with FORBIDDEN.
  - Review Focus 2: `"reparenting recomputes inherited access"`: channel C (no overrides) and P with `Member/join = false`. A Member can `channel.join` C. Move C under P → the Member is moved out and can't rejoin.

- [ ] **Step 2: Run** `bun test tests/integration/administration.test.ts`. Expected: the cache tests FAIL. The live tests may already pass through `accountChanged`. Keep them as regression tests.

- [ ] **Step 3: Add the `clearPermissionCache()` calls** listed under Files.

- [ ] **Step 4: Run** `bun test tests/unit tests/integration`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: re-check peers and clear cached permissions on role and override changes`.

### Task 5: Protocol docs and schema

**Files:**
- Modify: `docs/protocol.md:46-47,66,85-99,179` and the WebSocket request table entry for `role.set`
- Modify: `docs/protocol-v1.schema.json` (regenerate it the same way it's generated today. Check `backend/scripts` for a generator; if there isn't one, edit it by hand.)

- [ ] **Step 1:** Document `roles` on Account and member objects and `role` as the display role. Document the two endpoints and `role.add`/`role.remove`, the combination rules (the spec's Permission rules section, including the deny-vs-server-grant example), effective rank, the base-role rule, the 25-role cap, and the note that "deny Member" channels need explicit allows for higher roles. Remove `role.set` and `PATCH /api/v1/admin/roles`.
- [ ] **Step 2:** Run `grep -n "role.set\|admin/roles\"" docs/` and expect no matches. Validate the JSON with `bun -e 'JSON.parse(await Bun.file("docs/protocol-v1.schema.json").text())'`.
- [ ] **Step 3: Commit** `docs: describe multiple roles in protocol v1`.

### Task 6: Frontend

**Files:**
- Modify: `frontend/src/lib/components/server/ServerAdministration.svelte:164-172,575-590` (chips plus an add picker; `setRole` → `addRole`/`removeRole` via `apiFor(origin).admin.accounts.roles.post/delete`)
- Modify: `frontend/src/lib/components/server/ChannelMember.svelte:33-34,145-147` (`canModerate` = every role in `member.roles` is in `lowerRoles`; checkbox items over `assignableRoles` that send `role.add`/`role.remove`; `displayedRole` keeps using `member.role`)
- Modify: `frontend/src/lib/components/server/ChannelPane.svelte:97` (same `canModerate` rule)
- Modify: frontend member/account types wherever `role: string` is declared (grep `role: string` in `frontend/src/lib`) to add `roles: string[]`
- Modify: `frontend/src/app.css` (chip style next to `.member-role`, if the existing badge classes don't fit)

- [ ] **Step 1:** Make the edits. Use the svelte-file-editor agent or autofixer for the `.svelte` files.
- [ ] **Step 2: Run** `cd frontend && bun run check`. Expected: 0 errors.
- [ ] **Step 3:** Manual smoke test (the `run` skill): add and remove a role through both UIs, and confirm the badge shows the highest role.
- [ ] **Step 4: Commit** `feat(frontend): show and edit multiple roles per account`.

### Task 7: Final verification

- [ ] `cd backend && bun run check && bun test`. Expected: all pass.
- [ ] `cd frontend && bun run check`. Expected: 0 errors.
- [ ] `cd backend && bun run test:e2e`, if Chromium is available. Otherwise report it as skipped.
- [ ] Report the outputs to the user.
