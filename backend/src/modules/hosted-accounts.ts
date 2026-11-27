import { and, eq } from "drizzle-orm";
import type { Config } from "../config";
import type { Store } from "../database";
import { hostedAccounts } from "../database/schema";
import { equalDigest, type Credentials } from "../security/credentials";
import { fail, ProtocolError } from "../security/errors";

export class HostedAccounts {
  constructor(private readonly db: Store, private readonly credentials: Credentials, private readonly config: Config) {}

  private digest(username: string, credential: string) {
    return this.credentials.digest("hosted-account", `${username}\0${credential}`);
  }

  register(username: string, credential: string, encryptedData: string) {
    if (this.config.server.registration !== "open") {
      throw new ProtocolError("FORBIDDEN", "This provider has closed account registration.");
    }
    const revision = 1;
    const inserted = this.db.insert(hostedAccounts)
      .values({ username, credentialDigest: this.digest(username, credential), encryptedData, revision })
      .onConflictDoNothing().returning({ revision: hostedAccounts.revision }).get();
    if (!inserted) throw new ProtocolError("CONFLICT", "This username is already taken at this provider.");
    return { revision };
  }

  read(username: string, credential: string) {
    const account = this.db.select().from(hostedAccounts).where(eq(hostedAccounts.username, username)).get();
    const valid = equalDigest(account?.credentialDigest ?? "0".repeat(64), this.digest(username, credential));
    if (!account || !valid) fail("AUTH_FAILED");
    return { encryptedData: account.encryptedData, revision: account.revision };
  }

  update(username: string, credential: string, revision: number, encryptedData: string) {
    this.read(username, credential);
    const updated = this.db.update(hostedAccounts).set({ encryptedData, revision: revision + 1 })
      .where(and(eq(hostedAccounts.username, username), eq(hostedAccounts.revision, revision)))
      .returning({ revision: hostedAccounts.revision }).get();
    if (!updated) fail("CONFLICT");
    return updated;
  }
}
