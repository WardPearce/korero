package app.korero.voice;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ResultReceiver;
import androidx.core.content.ContextCompat;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(name = "CallAudio", permissions = {
    @Permission(alias = "microphone", strings = {Manifest.permission.RECORD_AUDIO})
})
public class CallAudioPlugin extends Plugin {
    @PluginMethod
    public void start(PluginCall call) {
        if (Boolean.TRUE.equals(call.getBoolean("microphone")) && getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "microphoneResult");
        } else {
            startService(call);
        }
    }

    @PermissionCallback
    private void microphoneResult(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            startService(call);
        } else {
            call.reject("Microphone permission was denied.");
        }
    }

    private void startService(PluginCall call) {
        Context context = getContext().getApplicationContext();
        ResultReceiver ready = new ResultReceiver(new Handler(Looper.getMainLooper())) {
            @Override
            protected void onReceiveResult(int resultCode, Bundle data) {
                if (resultCode == Activity.RESULT_OK) call.resolve();
                else call.reject("Background call audio could not start. Open the app and rejoin the channel.");
            }
        };
        Intent intent = new Intent(context, CallAudioService.class)
            .putExtra(CallAudioService.MICROPHONE, Boolean.TRUE.equals(call.getBoolean("microphone")))
            .putExtra(CallAudioService.READY, ready);
        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (RuntimeException error) {
            call.reject("Background call audio could not start. Open the app and rejoin the channel.", error);
        }
    }

    private void stopService() {
        getContext().stopService(new Intent(getContext(), CallAudioService.class));
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopService();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        stopService();
    }
}
