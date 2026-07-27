import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { appSettings } from "@/services/settings/expoAppSettings";
import { ActionButton } from "@/ui/ActionButton";
import { colors, radii, spacing, typography } from "@/ui/theme";

export default function SettingsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const settingsState = useSyncExternalStore(
    appSettings.subscribe,
    appSettings.getState,
    appSettings.getState,
  );
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const settingsReady = settingsState.status === "ready";
  const retainBasic = settingsState.settings.defaultMetadataPolicy === "retain-basic";

  useEffect(() => {
    void appSettings.initialize();
  }, []);

  const setRetainBasic = async (enabled: boolean) => {
    if (settingsState.status !== "ready" || saving) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      const result = await appSettings.setDefaultMetadataPolicy(enabled ? "retain-basic" : "strip");
      setSaveFailed(result.status !== "saved");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} testID="settings-screen">
      <View style={styles.header}>
        <Pressable
          accessibilityLabel={t("common.back")}
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => router.back()}
          style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
          testID="settings-back"
        >
          <Text style={styles.backSymbol}>‹</Text>
        </Pressable>
        <Text style={styles.title}>{t("settings.title")}</Text>
        <View style={styles.headerSpacer} />
      </View>
      <View style={styles.content}>
        <View style={styles.card}>
          <View style={styles.copy}>
            <Text style={styles.label}>{t("settings.retainBasic")}</Text>
            <Text style={styles.description}>{t("settings.retainBasicDescription")}</Text>
          </View>
          <View style={styles.control}>
            {settingsState.status === "uninitialized" || settingsState.status === "loading" ? (
              <ActivityIndicator color={colors.accent} testID="settings-loading" />
            ) : null}
            <Switch
              accessibilityLabel={t("settings.retainBasic")}
              accessibilityState={{
                checked: retainBasic,
                disabled: !settingsReady || saving,
              }}
              disabled={!settingsReady || saving}
              onValueChange={(enabled) => void setRetainBasic(enabled)}
              testID="settings-retain-basic"
              thumbColor={colors.surface}
              trackColor={{ false: colors.line, true: colors.accent }}
              value={retainBasic}
            />
          </View>
        </View>
        <Text style={styles.privacy}>{t("settings.privacyNotice")}</Text>
        {settingsState.status === "load-failed" || saveFailed ? (
          <Text accessibilityLiveRegion="assertive" style={styles.error} testID="settings-error">
            {t(
              settingsState.status === "load-failed"
                ? "settings.loadFailed"
                : "settings.saveFailed",
            )}
          </Text>
        ) : null}
        {settingsState.status === "load-failed" ? (
          <ActionButton
            accessibilityLabel={t("common.retry")}
            label={t("common.retry")}
            onPress={() => void appSettings.initialize()}
            testID="retry-app-settings"
            variant="secondary"
          />
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.canvasWarm,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 60,
    paddingHorizontal: spacing.s4,
  },
  backButton: {
    alignItems: "center",
    justifyContent: "center",
    width: 44,
    height: 44,
    borderRadius: radii.r12,
  },
  backSymbol: {
    color: colors.ink,
    fontSize: 32,
    lineHeight: 36,
  },
  title: {
    flex: 1,
    ...typography.title,
    color: colors.ink,
    textAlign: "center",
  },
  headerSpacer: {
    width: 44,
  },
  content: {
    padding: spacing.s4,
    gap: spacing.s3,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 104,
    padding: spacing.s4,
    gap: spacing.s4,
    borderRadius: radii.r20,
    backgroundColor: colors.surface,
  },
  copy: {
    flex: 1,
    gap: spacing.s1,
  },
  control: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s2,
  },
  label: {
    ...typography.label,
    color: colors.ink,
  },
  description: {
    ...typography.caption,
    color: colors.inkMuted,
  },
  privacy: {
    ...typography.caption,
    color: colors.inkMuted,
  },
  error: {
    ...typography.caption,
    color: colors.danger,
  },
  pressed: {
    opacity: 0.6,
  },
});
