package app.korero.voice;

import android.net.http.X509TrustManagerExtensions;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Sends server HTTP and WebSocket traffic from native code, like the desktop main process.
 * Each server gets a TLS client from the user's certificate decision, and requests carry no
 * WebView origin, so neither WebView certificate handling nor CORS applies.
 */
@CapacitorPlugin(name = "ServerTransport")
public class ServerTransportPlugin extends Plugin {
    private static final int timeout = 8000;
    private static final int maxSocketMessage = 256 * 1024;
    private static final String fingerprintPattern = "^([0-9A-F]{2}:){31}[0-9A-F]{2}$";

    private final OkHttpClient base = new OkHttpClient.Builder()
        .connectTimeout(timeout, TimeUnit.MILLISECONDS)
        .readTimeout(timeout, TimeUnit.MILLISECONDS)
        .writeTimeout(timeout, TimeUnit.MILLISECONDS)
        .build();
    private final Map<String, OkHttpClient> clients = new ConcurrentHashMap<>();
    private final Map<Integer, OpenSocket> sockets = new ConcurrentHashMap<>();
    private final AtomicInteger nextSocket = new AtomicInteger();

    private static final class OpenSocket {
        final String endpoint;
        final WebSocket socket;

        OpenSocket(String endpoint, WebSocket socket) {
            this.endpoint = endpoint;
            this.socket = socket;
        }
    }

    private static String endpoint(String address) {
        try {
            return ServerTrust.endpoint(URI.create(address == null ? "" : address));
        } catch (IllegalArgumentException exception) {
            return null;
        }
    }

    @PluginMethod
    public void inspect(PluginCall call) {
        String origin = call.getString("origin");
        String endpoint = endpoint(origin);
        if (endpoint == null) {
            call.reject("Enter a valid server address.");
            return;
        }
        URI uri = URI.create(origin);
        String host = ServerTrust.host(uri);
        int port = uri.getPort() == -1 ? 443 : uri.getPort();
        getBridge().execute(() -> {
            try {
                JSObject result = probe(host, port);
                result.put("origin", origin);
                call.resolve(result);
            } catch (IOException | GeneralSecurityException exception) {
                call.reject("Could not reach the server: " + exception.getMessage(), exception);
            }
        });
    }

    /** Accepts a server's certificate for later requests. A null fingerprint allows only device-trusted ones. */
    @PluginMethod
    public void allow(PluginCall call) {
        String endpoint = endpoint(call.getString("origin"));
        String fingerprint = call.getString("fingerprint");
        if (endpoint == null || (fingerprint != null && !fingerprint.matches(fingerprintPattern))) {
            call.reject("Review the server certificate before connecting.");
            return;
        }
        try {
            clients.put(endpoint, ServerTrust.client(base, fingerprint));
        } catch (GeneralSecurityException exception) {
            call.reject("Could not prepare the server connection.", exception);
            return;
        }
        // Connections made under an earlier decision end with it.
        for (Iterator<OpenSocket> open = sockets.values().iterator(); open.hasNext(); ) {
            OpenSocket socket = open.next();
            if (socket.endpoint.equals(endpoint)) socket.socket.cancel();
        }
        call.resolve();
    }

    @PluginMethod
    public void request(PluginCall call) {
        String origin = call.getString("origin");
        String path = call.getString("path", "");
        String method = call.getString("method", "GET").toUpperCase();
        String endpoint = endpoint(origin);
        OkHttpClient client = endpoint == null ? null : clients.get(endpoint);
        if (client == null) {
            call.reject("Review the server certificate before connecting.");
            return;
        }
        if (!path.startsWith("/api/v1/")) {
            call.reject("Invalid API path.");
            return;
        }
        boolean attachment = path.equals("/api/v1/chat/attachments") || path.startsWith("/api/v1/chat/attachments/");
        // The server supports attachments up to 32 MiB, sent as base64 JSON.
        long maxResponseBytes = (attachment ? 48L : 16L) * 1024 * 1024;
        Request.Builder request = new Request.Builder().url(origin + path);
        JSObject headers = call.getObject("headers", new JSObject());
        String contentType = null;
        for (Iterator<String> names = headers.keys(); names.hasNext(); ) {
            String name = names.next();
            String value = headers.optString(name);
            if (name.equalsIgnoreCase("content-type")) contentType = value;
            else request.header(name, value);
        }
        String body = call.getString("body");
        RequestBody payload = null;
        if (body != null || method.equals("POST") || method.equals("PUT") || method.equals("PATCH")) {
            payload = RequestBody.create(body == null ? "" : body,
                contentType == null ? null : MediaType.parse(contentType));
        }
        try {
            request.method(method, payload);
        } catch (IllegalArgumentException exception) {
            call.reject("Invalid request.", exception);
            return;
        }
        int limit = call.getInt("timeout", attachment ? 120000 : timeout);
        client.newBuilder().callTimeout(limit, TimeUnit.MILLISECONDS).build()
            .newCall(request.build()).enqueue(new Callback() {
                @Override
                public void onFailure(Call failed, IOException error) {
                    call.reject("Could not reach the server: " + error.getMessage(), error);
                }

                @Override
                public void onResponse(Call done, Response response) {
                    try (Response result = response) {
                        if (result.isRedirect()) throw new IOException("The server redirected the request.");
                        JSObject reply = new JSObject();
                        reply.put("status", result.code());
                        JSObject responseHeaders = new JSObject();
                        for (String name : result.headers().names()) {
                            responseHeaders.put(name, String.join(", ", result.headers(name)));
                        }
                        reply.put("headers", responseHeaders);
                        reply.put("body", read(result.body(), maxResponseBytes));
                        call.resolve(reply);
                    } catch (IOException error) {
                        call.reject(error.getMessage(), error);
                    }
                }
            });
    }

    private static String read(ResponseBody body, long limit) throws IOException {
        if (body == null) return "";
        if (body.contentLength() > limit) throw new IOException("The server response is too large.");
        ByteArrayOutputStream data = new ByteArrayOutputStream();
        byte[] chunk = new byte[16384];
        try (InputStream stream = body.byteStream()) {
            for (int count; (count = stream.read(chunk)) != -1; ) {
                if (data.size() + count > limit) throw new IOException("The server response is too large.");
                data.write(chunk, 0, count);
            }
        }
        return new String(data.toByteArray(), StandardCharsets.UTF_8);
    }

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        String endpoint = endpoint(url);
        OkHttpClient client = endpoint == null ? null : clients.get(endpoint);
        if (client == null) {
            call.reject("Review the server certificate before connecting.");
            return;
        }
        if (!URI.create(url).getRawPath().equals("/api/v1/ws")) {
            call.reject("Invalid WebSocket path.");
            return;
        }
        int id = nextSocket.incrementAndGet();
        // Signaling stays idle between heartbeats, so only the handshake has a deadline.
        WebSocket socket = client.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build()
            .newWebSocket(new Request.Builder().url(url).build(), new WebSocketListener() {
                @Override
                public void onOpen(WebSocket webSocket, Response response) {
                    emit(id, "open", null);
                }

                @Override
                public void onMessage(WebSocket webSocket, String text) {
                    if (text.length() > maxSocketMessage) {
                        webSocket.close(1009, "Message too large");
                        return;
                    }
                    JSObject event = new JSObject();
                    event.put("data", text);
                    emit(id, "message", event);
                }

                @Override
                public void onMessage(WebSocket webSocket, okio.ByteString bytes) {
                    webSocket.close(1003, "Binary messages are not supported");
                }

                @Override
                public void onClosing(WebSocket webSocket, int code, String reason) {
                    webSocket.close(code, null);
                }

                @Override
                public void onClosed(WebSocket webSocket, int code, String reason) {
                    finish(id, code, reason, false);
                }

                @Override
                public void onFailure(WebSocket webSocket, Throwable error, Response response) {
                    finish(id, 1006, error.getMessage() == null ? "" : error.getMessage(), true);
                }
            });
        sockets.put(id, new OpenSocket(endpoint, socket));
        JSObject result = new JSObject();
        result.put("id", id);
        call.resolve(result);
    }

    @PluginMethod
    public void send(PluginCall call) {
        OpenSocket socket = sockets.get(call.getInt("id", -1));
        String data = call.getString("data");
        if (socket == null || data == null || !socket.socket.send(data)) {
            call.reject("The server connection closed.");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        OpenSocket socket = sockets.get(call.getInt("id", -1));
        if (socket != null && !socket.socket.close(1000, null)) socket.socket.cancel();
        call.resolve();
    }

    private void finish(int id, int code, String reason, boolean failed) {
        if (sockets.remove(id) == null) return;
        JSObject event = new JSObject();
        event.put("code", code);
        event.put("reason", reason);
        if (failed) emit(id, "error", null);
        emit(id, "close", event);
    }

    private void emit(int id, String type, JSObject values) {
        JSObject event = values == null ? new JSObject() : values;
        event.put("id", id);
        event.put("type", type);
        notifyListeners("socket", event);
    }

    @Override
    protected void handleOnDestroy() {
        for (OpenSocket socket : sockets.values()) socket.socket.cancel();
        sockets.clear();
    }

    /**
     * Reads the leaf certificate from a TLS handshake that sends no application data.
     * An untrusted chain aborts the handshake after it is recorded.
     */
    private static JSObject probe(String host, int port) throws IOException, GeneralSecurityException {
        TrustManagerFactory factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        factory.init((KeyStore) null);
        X509TrustManager system = null;
        for (TrustManager manager : factory.getTrustManagers()) {
            if (manager instanceof X509TrustManager) system = (X509TrustManager) manager;
        }
        if (system == null) throw new GeneralSecurityException("The device has no certificate trust store.");
        X509TrustManagerExtensions verifier = new X509TrustManagerExtensions(system);
        AtomicReference<X509Certificate[]> presented = new AtomicReference<>();
        X509TrustManager recorder = new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                throw new CertificateException("Client certificates are not accepted.");
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                presented.set(chain);
                verifier.checkServerTrusted(chain, authType, host);
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        };
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[] {recorder}, null);

        boolean trusted;
        try (Socket plain = new Socket()) {
            plain.connect(new InetSocketAddress(host, port), timeout);
            plain.setSoTimeout(timeout);
            try (SSLSocket socket = (SSLSocket) context.getSocketFactory().createSocket(plain, host, port, false)) {
                try {
                    socket.startHandshake();
                    trusted = HttpsURLConnection.getDefaultHostnameVerifier().verify(host, socket.getSession());
                } catch (IOException exception) {
                    if (presented.get() == null) throw exception;
                    trusted = false;
                }
            }
        }
        X509Certificate[] chain = presented.get();
        if (chain == null || chain.length == 0) throw new GeneralSecurityException("The server did not present a certificate.");
        JSObject result = new JSObject();
        result.put("fingerprint", ServerTrust.fingerprint(chain[0]));
        result.put("publiclyTrusted", trusted);
        return result;
    }
}
