package app.korero.voice;

import java.net.URI;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.cert.CertificateEncodingException;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Locale;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import okhttp3.OkHttpClient;

/** Server addresses, certificate fingerprints and the TLS clients built from an approval. */
final class ServerTrust {
    private ServerTrust() {}

    /** Returns `host:port` for an HTTPS or WSS address, or null for any other scheme. */
    static String endpoint(URI uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost();
        if (!(scheme.equals("https") || scheme.equals("wss")) || host == null) return null;
        return host(uri) + ":" + (uri.getPort() == -1 ? 443 : uri.getPort());
    }

    static String host(URI uri) {
        return uri.getHost().replaceAll("^\\[|\\]$", "").toLowerCase(Locale.ROOT);
    }

    /** Formats a SHA-256 digest of the DER certificate the way the desktop app does. */
    static String fingerprint(X509Certificate certificate) throws CertificateEncodingException {
        byte[] digest;
        try {
            digest = MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded());
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException(exception);
        }
        StringBuilder text = new StringBuilder(digest.length * 3);
        for (byte value : digest) {
            if (text.length() > 0) text.append(':');
            text.append(String.format(Locale.ROOT, "%02X", value));
        }
        return text.toString();
    }

    /**
     * Builds a client for one server. A null fingerprint uses the device trust store.
     * Otherwise the approved leaf certificate is the only trust anchor. Both check the hostname.
     */
    static OkHttpClient client(OkHttpClient base, String fingerprint) throws GeneralSecurityException {
        OkHttpClient.Builder builder = base.newBuilder().followRedirects(false).followSslRedirects(false);
        if (fingerprint == null) return builder.build();
        X509TrustManager pinned = new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                throw new CertificateException("Client certificates are not accepted.");
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                if (chain == null || chain.length == 0) throw new CertificateException("The server did not present a certificate.");
                chain[0].checkValidity();
                if (!MessageDigest.isEqual(fingerprint.getBytes(), fingerprint(chain[0]).getBytes())) {
                    throw new CertificateException("The server certificate changed.");
                }
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        };
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[] {pinned}, null);
        return builder.sslSocketFactory(context.getSocketFactory(), pinned).build();
    }
}
