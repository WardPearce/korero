import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.korero.voice",
  appName: "VNX.chat",
  webDir: "dist",
  server: {
    hostname: "localhost",
    androidScheme: "https",
    iosScheme: "capacitor",
  },
};

export default config;
