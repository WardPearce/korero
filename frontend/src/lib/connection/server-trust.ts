import { browserServerOrigin } from "./browser-session";
import { call, desktopApp } from "./platform";
import { androidTransport, nativeTransport, type CertificateContact } from "./transport";

export type { CertificateContact };

/** Whether this client can approve a private server certificate by its fingerprint. */
export function certificateApproval() {
  return desktopApp() || nativeTransport();
}

/** Reads the certificate a server presents, without sending credentials. */
export function inspectServer(address: string) {
  if (desktopApp()) return call<CertificateContact>("inspect_server", { address });
  return androidTransport.inspect({ origin: browserServerOrigin(address) });
}

/**
 * Accepts the server's certificate for later requests. A null fingerprint allows only
 * a publicly trusted certificate. Returns the server origin.
 */
export async function trustServer(origin: string, fingerprint: string | null) {
  if (desktopApp()) return call<string>("prepare_server", { origin, fingerprint });
  await androidTransport.allow({ origin, fingerprint });
  return origin;
}
