package app.korero.voice;

import android.app.Activity;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.util.Rational;
import android.webkit.WebView;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;

/**
 * Shrinks the app into a picture-in-picture window while the user is in a voice channel, so the
 * WebView stays visible (and unthrottled) and can show who is talking. Taps never reach the WebView
 * inside the window, so mute, deafen and leave are offered as PiP actions and sent back to JS.
 */
@CapacitorPlugin(name = "CallPip")
public class CallPipPlugin extends Plugin {
    private static final String ACTION = "app.korero.voice.CALL_PIP_ACTION";
    private static final String EXTRA = "action";
    private static final Rational ASPECT = new Rational(3, 2);

    private boolean active;
    private boolean muted;
    private boolean deafened;
    private boolean canMute;
    private boolean canDeafen;
    private BroadcastReceiver receiver;

    @Override
    public void load() {
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getStringExtra(EXTRA);
                if (action == null) return;
                // Hanging up returns to the app straight away, without waiting for the server.
                if ("leave".equals(action) && getActivity() != null) getActivity().runOnUiThread(() -> expand(getActivity()));
                JSObject data = new JSObject();
                data.put("action", action);
                notifyListeners("action", data);
            }
        };
        ContextCompat.registerReceiver(getContext(), receiver, new IntentFilter(ACTION), ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override
    protected void handleOnDestroy() {
        if (receiver != null) {
            getContext().unregisterReceiver(receiver);
            receiver = null;
        }
    }

    static boolean supported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O;
    }

    @PluginMethod
    public void update(PluginCall call) {
        boolean wasActive = active;
        active = Boolean.TRUE.equals(call.getBoolean("active", false));
        muted = Boolean.TRUE.equals(call.getBoolean("muted", false));
        deafened = Boolean.TRUE.equals(call.getBoolean("deafened", false));
        canMute = Boolean.TRUE.equals(call.getBoolean("canMute", false));
        canDeafen = Boolean.TRUE.equals(call.getBoolean("canDeafen", false));
        Activity activity = getActivity();
        if (activity == null || !supported()) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                activity.setPictureInPictureParams(params(activity));
                keepRendererAlive(active);
                // The call ended (kicked or disconnected): bring the app back full screen
                // rather than leave the whole UI squeezed into the window.
                if (wasActive && !active) expand(activity);
            } catch (RuntimeException error) {
                // PiP can be disabled for the app or unsupported on the device; the call keeps working.
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void state(PluginCall call) {
        Activity activity = getActivity();
        JSObject result = new JSObject();
        result.put("supported", supported() && activity != null);
        result.put("pictureInPicture", supported() && activity != null && activity.isInPictureInPictureMode());
        call.resolve(result);
    }

    /** Android 8 to 11 have no auto-enter, so the activity enters PiP itself when the user leaves. */
    void onUserLeaveHint(Activity activity) {
        if (!active || !supported() || Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return;
        try {
            activity.enterPictureInPictureMode(params(activity));
        } catch (RuntimeException error) {
            // PiP disabled by the user: the call continues in the background with the notification.
        }
    }

    void onPictureInPictureModeChanged(boolean pictureInPicture) {
        JSObject data = new JSObject();
        data.put("pictureInPicture", pictureInPicture);
        notifyListeners("change", data);
    }

    /** Leaves picture-in-picture by bringing the activity back to the front of its task, full screen. */
    private void expand(Activity activity) {
        if (!supported() || !activity.isInPictureInPictureMode()) return;
        try {
            activity.startActivity(new Intent(activity, activity.getClass())
                .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP));
        } catch (RuntimeException error) {
            // Nothing else to do: the user can still tap the window to expand it.
        }
    }

    private PictureInPictureParams params(Activity activity) {
        PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder()
            .setAspectRatio(ASPECT)
            .setActions(actions(activity));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setAutoEnterEnabled(active).setSeamlessResizeEnabled(false);
        }
        return builder.build();
    }

    private List<RemoteAction> actions(Activity activity) {
        List<RemoteAction> actions = new ArrayList<>();
        if (!active) return actions;
        actions.add(action(activity, "mute", muted ? R.drawable.ic_pip_mic_off : R.drawable.ic_pip_mic,
            muted ? "Unmute" : "Mute", canMute));
        actions.add(action(activity, "deafen", deafened ? R.drawable.ic_pip_headset_off : R.drawable.ic_pip_headset,
            deafened ? "Undeafen" : "Deafen", canDeafen));
        actions.add(action(activity, "leave", R.drawable.ic_pip_call_end, "Leave channel", true));
        int max = activity.getMaxNumPictureInPictureActions();
        return actions.size() > max ? actions.subList(0, max) : actions;
    }

    private RemoteAction action(Activity activity, String name, int icon, String title, boolean enabled) {
        Intent intent = new Intent(ACTION).setPackage(activity.getPackageName()).putExtra(EXTRA, name);
        PendingIntent pending = PendingIntent.getBroadcast(activity, name.hashCode(), intent,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        RemoteAction action = new RemoteAction(Icon.createWithResource(activity, icon), title, title, pending);
        action.setEnabled(enabled);
        return action;
    }

    /** Stops Android from killing the WebView renderer under memory pressure while a call runs unseen. */
    private void keepRendererAlive(boolean call) {
        WebView webView = getBridge().getWebView();
        if (webView != null) webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, !call);
    }
}
