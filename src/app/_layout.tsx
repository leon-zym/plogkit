import "@/i18n";

import { useEffect } from "react";
import { Stack } from "expo-router";
import { AppState } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { editorRuntime } from "@/features/editor/expoEditorRuntime";
import { initializeExpoExportStaging } from "@/services/export/expoStaging";

export default function RootLayout() {
  useEffect(() => {
    void initializeExpoExportStaging().catch(() => undefined);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") void editorRuntime.flush().catch(() => undefined);
    });
    return () => subscription.remove();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <Stack screenOptions={{ headerShown: false }} />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
