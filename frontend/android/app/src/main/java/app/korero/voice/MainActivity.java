package app.korero.voice;

import android.content.res.Configuration;
import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CallAudioPlugin.class);
        registerPlugin(CallPipPlugin.class);
        registerPlugin(ServerTransportPlugin.class);
        super.onCreate(savedInstanceState);
        // Draw behind the system bars so the theme background fills the status and
        // navigation bars; the SystemBars plugin then handles the icon contrast.
        EdgeToEdge.enable(this);
    }

    @Override
    public void onUserLeaveHint() {
        super.onUserLeaveHint();
        CallPipPlugin pip = callPip();
        if (pip != null) pip.onUserLeaveHint(this);
    }

    @Override
    public void onPictureInPictureModeChanged(boolean pictureInPicture, Configuration newConfig) {
        super.onPictureInPictureModeChanged(pictureInPicture, newConfig);
        CallPipPlugin pip = callPip();
        if (pip != null) pip.onPictureInPictureModeChanged(pictureInPicture);
    }

    private CallPipPlugin callPip() {
        if (getBridge() == null) return null;
        PluginHandle handle = getBridge().getPlugin("CallPip");
        return handle != null && handle.getInstance() instanceof CallPipPlugin ? (CallPipPlugin) handle.getInstance() : null;
    }
}
