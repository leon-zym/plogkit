import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { settingsRuntime } from "@/services/settings/expoSettingsRuntime";
import {
  APP_SETTINGS_SCHEMA_VERSION,
  type AppSettings,
} from "@/services/settings/settingsRepository";
import { colors, radii, spacing, typography } from "@/ui/theme";

export default function SettingsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void settingsRuntime.load().then((loaded) => {
      if (active) setSettings(loaded);
    });
    return () => {
      active = false;
    };
  }, []);

  const setRetainBasic = async (enabled: boolean) => {
    if (settings === null) return;
    const next: AppSettings = {
      ...settings,
      schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
      defaultMetadataPolicy: enabled ? "retain-basic" : "strip",
    };
    setSettings(next);
    setSaving(true);
    try {
      await settingsRuntime.save(next);
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
          {settings === null ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <Switch
              accessibilityLabel={t("settings.retainBasic")}
              disabled={saving}
              onValueChange={(enabled) => void setRetainBasic(enabled)}
              testID="settings-retain-basic"
              thumbColor={colors.surface}
              trackColor={{ false: colors.line, true: colors.accent }}
              value={settings.defaultMetadataPolicy === "retain-basic"}
            />
          )}
        </View>
        <Text style={styles.privacy}>{t("settings.privacyNotice")}</Text>
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
  pressed: {
    opacity: 0.6,
  },
});
