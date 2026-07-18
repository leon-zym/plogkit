import { useEffect, useState } from "react";
import { useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { editorRuntime } from "@/features/editor/expoEditorRuntime";
import type { RestoreDraftResult } from "@/features/editor/runtime";
import { ActionButton } from "@/ui/ActionButton";
import { colors, radii, shadows, spacing, typography } from "@/ui/theme";

type HomeStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly restore: RestoreDraftResult }
  | { readonly kind: "importing" }
  | { readonly kind: "error"; readonly messageKey: string };

export default function HomeScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const [status, setStatus] = useState<HomeStatus>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    void editorRuntime
      .restore()
      .then((restore) => {
        if (active) setStatus({ kind: "ready", restore });
      })
      .catch(() => {
        if (active) setStatus({ kind: "error", messageKey: "home.recoveryFailed" });
      });
    return () => {
      active = false;
    };
  }, []);

  const choosePhotos = async () => {
    setStatus({ kind: "importing" });
    try {
      const result = await editorRuntime.choosePhotos();
      if (result.status === "created") {
        router.push("/editor" as Href);
        return;
      }
      if (result.status === "create-failed" || result.errors.length > 0) {
        setStatus({ kind: "error", messageKey: "home.importFailed" });
      } else {
        setStatus({ kind: "ready", restore: { status: "none" } });
      }
    } catch {
      setStatus({ kind: "error", messageKey: "home.importFailed" });
    }
  };

  const canResume = status.kind === "ready" && status.restore.status === "restored";
  const recoveryFailed = status.kind === "ready" && status.restore.status === "recovery-failed";

  return (
    <SafeAreaView style={styles.safeArea} testID="home-screen">
      <View style={styles.header}>
        <View style={styles.eyebrowRow}>
          <Text style={styles.eyebrow}>{t("home.eyebrow")}</Text>
          <Pressable
            accessibilityLabel={t("settings.title")}
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => router.push("/settings" as Href)}
            style={({ pressed }) => [styles.settingsButton, pressed && styles.pressed]}
            testID="open-settings"
          >
            <Text style={styles.settingsSymbol}>•••</Text>
          </Pressable>
        </View>
        <Text style={styles.title}>{t("home.title")}</Text>
        <Text style={styles.tagline}>{t("home.tagline")}</Text>
        <Text style={styles.description}>{t("home.description")}</Text>
      </View>

      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.photoWell}
      >
        <View style={[styles.photoSheet, styles.photoBack]} />
        <View style={[styles.photoSheet, styles.photoMiddle]} />
        <View style={[styles.photoSheet, styles.photoFront]}>
          <View style={styles.photoHorizon} />
          <View style={styles.photoCaption} />
          <View style={[styles.corner, styles.cornerTopLeft]} />
          <View style={[styles.corner, styles.cornerBottomRight]} />
        </View>
      </View>

      <View style={styles.actions}>
        {canResume ? (
          <Pressable
            accessibilityLabel={t("home.resume")}
            accessibilityRole="button"
            onPress={() => router.push("/editor" as Href)}
            style={({ pressed }) => [styles.resume, pressed && styles.pressed]}
            testID="resume-session"
          >
            <View style={styles.resumeCopy}>
              <Text style={styles.resumeTitle}>{t("home.resume")}</Text>
              <Text style={styles.resumeDescription}>{t("home.resumeDescription")}</Text>
            </View>
            <Text style={styles.resumeArrow}>›</Text>
          </Pressable>
        ) : null}
        {status.kind === "loading" || status.kind === "importing" ? (
          <View accessibilityLiveRegion="polite" style={styles.progress}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.progressText}>
              {t(status.kind === "importing" ? "home.importing" : "editor.saving")}
            </Text>
          </View>
        ) : (
          <ActionButton
            accessibilityLabel={t("home.choosePhotos")}
            label={t("home.choosePhotos")}
            onPress={() => void choosePhotos()}
            testID="choose-photos"
          />
        )}
        {status.kind === "error" || recoveryFailed ? (
          <Text accessibilityLiveRegion="assertive" style={styles.error} testID="home-error">
            {t(status.kind === "error" ? status.messageKey : "home.recoveryFailed")}
          </Text>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.canvasWarm,
    paddingHorizontal: spacing.s6,
  },
  header: {
    paddingTop: spacing.s6,
    gap: spacing.s2,
  },
  eyebrowRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  eyebrow: {
    ...typography.caption,
    color: colors.accent,
    letterSpacing: 1.4,
  },
  settingsButton: {
    alignItems: "center",
    justifyContent: "center",
    width: 44,
    height: 44,
    marginTop: -spacing.s2,
    borderRadius: radii.r12,
  },
  settingsSymbol: {
    color: colors.inkMuted,
    fontSize: 15,
    lineHeight: 24,
    letterSpacing: 1.5,
  },
  title: {
    ...typography.display,
    color: colors.ink,
    letterSpacing: -0.7,
  },
  tagline: {
    ...typography.title,
    color: colors.ink,
    maxWidth: 320,
  },
  description: {
    ...typography.body,
    color: colors.inkMuted,
    maxWidth: 330,
  },
  photoWell: {
    flex: 1,
    minHeight: 220,
    alignItems: "center",
    justifyContent: "center",
  },
  photoSheet: {
    position: "absolute",
    width: 190,
    height: 230,
    borderRadius: radii.r20,
  },
  photoBack: {
    transform: [{ rotate: "-8deg" }, { translateX: -24 }],
    backgroundColor: "#D8C9B5",
  },
  photoMiddle: {
    transform: [{ rotate: "7deg" }, { translateX: 24 }],
    backgroundColor: "#9FAE99",
  },
  photoFront: {
    overflow: "hidden",
    backgroundColor: colors.stage,
    boxShadow: shadows.level2,
  },
  photoHorizon: {
    flex: 1,
    margin: spacing.s3,
    marginBottom: spacing.s2,
    borderRadius: radii.r12,
    backgroundColor: "#B4C0C4",
  },
  photoCaption: {
    width: 108,
    height: 8,
    marginLeft: spacing.s4,
    marginBottom: spacing.s4,
    borderRadius: radii.pill,
    backgroundColor: colors.stageText,
    opacity: 0.82,
  },
  corner: {
    position: "absolute",
    width: 22,
    height: 22,
    borderColor: colors.accent,
  },
  cornerTopLeft: {
    top: spacing.s2,
    left: spacing.s2,
    borderTopWidth: 3,
    borderLeftWidth: 3,
  },
  cornerBottomRight: {
    right: spacing.s2,
    bottom: spacing.s2,
    borderRightWidth: 3,
    borderBottomWidth: 3,
  },
  actions: {
    gap: spacing.s3,
    paddingBottom: spacing.s6,
  },
  resume: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 76,
    padding: spacing.s4,
    borderRadius: radii.r20,
    backgroundColor: colors.surface,
    boxShadow: shadows.level1,
  },
  resumeCopy: {
    flex: 1,
    gap: spacing.s1,
  },
  resumeTitle: {
    ...typography.label,
    color: colors.ink,
  },
  resumeDescription: {
    ...typography.caption,
    color: colors.inkMuted,
  },
  resumeArrow: {
    color: colors.accent,
    fontSize: 28,
    lineHeight: 32,
  },
  pressed: {
    transform: [{ scale: 0.98 }],
    opacity: 0.82,
  },
  progress: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
    gap: spacing.s2,
  },
  progressText: {
    ...typography.label,
    color: colors.inkMuted,
  },
  error: {
    ...typography.caption,
    color: colors.danger,
  },
});
