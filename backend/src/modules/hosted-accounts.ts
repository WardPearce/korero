import { and, count, eq } from "drizzle-orm";
import type { Config } from "../config";
import type { Queries, Store } from "../database";
import { hostedAccounts, hostedAccountUsage } from "../database/schema";
import { equalDigest, type Credentials } from "../security/credentials";
import { fail, ProtocolError } from "../security/errors";

export class HostedAccounts {
  constructor(private readonly db: Store, private readonly credentials: Credentials, private readonly config: Config) {}

  private digest(username: string, credential: string) {
    return this.credentials.digest("hosted-account", `${username}\0${credential}`);
  }

  requireOpenRegistration() {
    if (this.config["remote-account-host"].registration !== "open") {
      throw new ProtocolError("FORBIDDEN", "This provider has closed account registration.");
    }
  }

  private write<T>(run: (tx: Queries) => T) {
    return this.db.transaction((tx) => {
      const usage = () => tx.select({ bytes: hostedAccountUsage.bytes }).from(hostedAccountUsage).get()!.bytes;
      // Providers already over budget can continue serving accounts and shrinking their data.
      const limit = Math.max(this.config.limits.hosted_account_bytes, usage());
      const result = run(tx);
      if (usage() > limit) throw new ProtocolError("LIMIT", "Hosted account storage is full.");
      return result;
    }, { behavior: "immediate" });
  }

  register(username: string, credential: string, encryptedData: string) {
    this.requireOpenRegistration();
    const revision = 1;
    const inserted = this.write((tx) => {
      const { total } = tx.select({ total: count() }).from(hostedAccounts).get()!;
      if (total >= this.config.limits.hosted_accounts) {
        throw new ProtocolError("LIMIT", "This provider is not accepting new accounts.");
      }
      return tx.insert(hostedAccounts)
        .values({ username, credentialDigest: this.digest(username, credential), encryptedData, revision })
        .onConflictDoNothing().returning({ revision: hostedAccounts.revision }).get();
    });
    if (!inserted) throw new ProtocolError("CONFLICT", "This username is already taken at this provider.");
    return { revision };
  }

  private authenticate(db: Queries, username: string, credential: string) {
    const account = db.select({ credentialDigest: hostedAccounts.credentialDigest })
      .from(hostedAccounts).where(eq(hostedAccounts.username, username)).get();
    const valid = equalDigest(account?.credentialDigest ?? "0".repeat(64), this.digest(username, credential));
    if (!account || !valid) fail("AUTH_FAILED");
  }

  read(username: string, credential: string) {
    this.authenticate(this.db, username, credential);
    return this.db.select({ encryptedData: hostedAccounts.encryptedData, revision: hostedAccounts.revision })
      .from(hostedAccounts).where(eq(hostedAccounts.username, username)).get()!;
  }

  update(username: string, credential: string, revision: number, encryptedData: string) {
    return this.write((tx) => {
      this.authenticate(tx, username, credential);
      const updated = tx.update(hostedAccounts).set({ encryptedData, revision: revision + 1 })
        .where(and(eq(hostedAccounts.username, username), eq(hostedAccounts.revision, revision)))
        .returning({ revision: hostedAccounts.revision }).get();
      if (!updated) fail("CONFLICT");
      return updated;
    });
  }
}
