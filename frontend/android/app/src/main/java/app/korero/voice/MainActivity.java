package app.korero.voice;

import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CallAudioPlugin.class);
        registerPlugin(ServerTransportPlugin.class);
        super.onCreate(savedInstanceState);
        // Draw behind the system bars so the theme background fills the status and
        // navigation bars; the SystemBars plugin then handles the icon contrast.
        EdgeToEdge.enable(this);
    }
}
