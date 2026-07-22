import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { editorRuntime } from "@/features/editor/expoEditorRuntime";
import type {
  DraftId,
  DraftLibraryState,
  DraftListEntry,
  DraftThumbnailPair,
} from "@/services/drafts/draftLibrary";
import { settingsRuntime } from "@/services/settings/expoSettingsRuntime";
import {
  APP_SETTINGS_SCHEMA_VERSION,
  createDefaultAppSettings,
  type AppSettings,
  type DraftThumbnailDisplay,
} from "@/services/settings/settingsRepository";
import { ActionButton } from "@/ui/ActionButton";
import { colors, radii, shadows, spacing, typography } from "@/ui/theme";

interface DeleteTarget {
  readonly entry: DraftListEntry;
  readonly corrupt: boolean;
}

interface OpenedRevision {
  readonly draftId: DraftId;
  readonly contentRevision: number;
}

function thumbnailUri(
  pair: DraftThumbnailPair | null,
  display: DraftThumbnailDisplay,
): string | null {
  if (pair === null) return null;
  return display === "square" ? pair.squareUri : pair.originalUri;
}

export default function HomeScreen() {
  const { i18n, t } = useTranslation();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const listRef = useRef<FlatList<DraftListEntry>>(null);
  const openedRevision = useRef<OpenedRevision | null>(null);
  const [libraryState, setLibraryState] = useState<DraftLibraryState>(() =>
    editorRuntime.getDraftLibraryState(),
  );
  const [settings, setSettings] = useState<AppSettings>(createDefaultAppSettings());
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [actionTarget, setActionTarget] = useState<DraftListEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [unknownDeletion, setUnknownDeletion] = useState<DraftId | null>(null);
  const [importing, setImporting] = useState(false);
  const [opening, setOpening] = useState<DraftId | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const columnCount = useMemo(
    () =>
      width < 600
        ? 3
        : Math.max(3, Math.floor((width - spacing.s8 + spacing.s2) / (128 + spacing.s2))),
    [width],
  );
  const itemSize =
    (width - spacing.s8 - spacing.s2 * (columnCount - 1)) / columnCount;

  useEffect(() => {
    let active = true;
    const install = (next: DraftLibraryState) => {
      if (!active) return;
      setLibraryState(next);
      const opened = openedRevision.current;
      if (next.status !== "ready" || opened === null) return;
      const entry = next.entries.find(
        (candidate) => candidate.status === "ready" && candidate.draftId === opened.draftId,
      );
      if (
        entry?.status === "ready" &&
        entry.contentRevision !== opened.contentRevision
      ) {
        openedRevision.current = {
          draftId: entry.draftId,
          contentRevision: entry.contentRevision,
        };
        listRef.current?.scrollToOffset({ animated: false, offset: 0 });
      }
    };
    const unsubscribe = editorRuntime.subscribeDraftLibrary(() => {
      install(editorRuntime.getDraftLibraryState());
    });
    void editorRuntime.loadDraftLibrary().then(install);
    void settingsRuntime.load().then((loaded) => {
      if (active) {
        setSettings(loaded);
        setSettingsLoaded(true);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const choosePhotos = async () => {
    setImporting(true);
    setErrorKey(null);
    try {
      const result = await editorRuntime.choosePhotos();
      if (result.status === "created") {
        openedRevision.current = {
          draftId: result.draftId,
          contentRevision: result.contentRevision,
        };
        router.push("/editor" as Href);
      } else if (result.status === "create-failed" || result.errors.length > 0) {
        setErrorKey("home.importFailed");
      }
    } catch {
      setErrorKey("home.importFailed");
    } finally {
      setImporting(false);
    }
  };

  const openDraft = async (entry: Extract<DraftListEntry, { status: "ready" }>) => {
    if (opening !== null) return;
    setOpening(entry.draftId);
    setErrorKey(null);
    try {
      const result = await editorRuntime.openDraft(entry.draftId);
      if (result.status === "opened") {
        openedRevision.current = {
          draftId: result.draftId,
          contentRevision: result.contentRevision,
        };
        router.push("/editor" as Href);
      } else {
        setErrorKey("home.openFailed");
      }
    } catch {
      setErrorKey("home.openFailed");
    } finally {
      setOpening(null);
    }
  };

  const deleteDraft = async (id: DraftId) => {
    setDeleteTarget(null);
    setActionTarget(null);
    setErrorKey(null);
    const result = await editorRuntime.deleteDraft(id);
    if (result.status === "delete-unknown") {
      setUnknownDeletion(id);
    } else if (result.status === "delete-failed") {
      setUnknownDeletion(null);
      setErrorKey("home.deleteFailed");
    } else {
      setUnknownDeletion(null);
    }
  };

  const saveDisplay = async (display: DraftThumbnailDisplay) => {
    if (!settingsLoaded) return;
    const next: AppSettings = {
      ...settings,
      schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
      draftThumbnailDisplay: display,
    };
    setSettings(next);
    setMenuVisible(false);
    try {
      await settingsRuntime.save(next);
    } catch {
      setErrorKey("home.settingsFailed");
    }
  };

  const formatUpdatedAt = (updatedAt: string): string => {
    try {
      return new Intl.DateTimeFormat(i18n.resolvedLanguage ?? i18n.language, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(updatedAt));
    } catch {
      return updatedAt;
    }
  };

  const itemAccessibility = (entry: DraftListEntry, index: number, total: number): string => {
    const parts = [t("home.draftPosition", { position: index + 1, total })];
    if (entry.updatedAt !== null) {
      parts.push(t("home.draftUpdated", { time: formatUpdatedAt(entry.updatedAt) }));
    }
    if (entry.photoCount !== null) {
      parts.push(t("home.draftPhotoCount", { count: entry.photoCount }));
    }
    parts.push(
      entry.status === "corrupt"
        ? t("home.draftStatus.corrupt")
        : entry.thumbnailStatus === "generating"
          ? t("home.draftStatus.generating")
          : entry.thumbnailStatus === "unavailable"
            ? t("home.draftStatus.unavailable")
            : t("home.draftStatus.ready"),
    );
    parts.push(
      entry.status === "corrupt"
        ? t("home.draftActions.corrupt")
        : t("home.draftActions.ready"),
    );
    return parts.join(" ");
  };

  const renderDraft = ({ item, index }: { item: DraftListEntry; index: number }) => {
    const pair = item.thumbnail;
    const uri = thumbnailUri(pair, settings.draftThumbnailDisplay);
    const corrupt = item.status === "corrupt";
    const onPress = () => {
      if (corrupt) {
        setDeleteTarget({ entry: item, corrupt: true });
      } else {
        void openDraft(item);
      }
    };
    return (
      <Pressable
        accessibilityActions={
          corrupt
            ? [{ name: "activate", label: t("home.deleteDraft") }]
            : [
                { name: "activate", label: t("home.openDraft") },
                { name: "delete", label: t("home.deleteDraft") },
              ]
        }
        accessibilityLabel={itemAccessibility(
          item,
          index,
          libraryState.status === "ready" ? libraryState.entries.length : 0,
        )}
        accessibilityRole="button"
        onAccessibilityAction={({ nativeEvent }) => {
          if (!corrupt && nativeEvent.actionName === "delete") {
            setActionTarget(item);
          } else {
            onPress();
          }
        }}
        disabled={opening === item.draftId}
        onLongPress={
          corrupt ? undefined : () => setActionTarget(item)
        }
        onPress={onPress}
        style={({ pressed }) => [
          styles.draftItem,
          { width: itemSize, height: itemSize },
          pressed && styles.pressed,
        ]}
        testID={`draft-item-${index}`}
      >
        {uri === null ? (
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.thumbnailPlaceholder, corrupt && styles.corruptPlaceholder]}
          >
            <View style={styles.placeholderMark} />
          </View>
        ) : (
          <Image
            accessibilityIgnoresInvertColors
            accessible={false}
            onError={() => {
              if (pair !== null) editorRuntime.reportThumbnailLoadFailure(item.draftId, pair);
            }}
            resizeMode={settings.draftThumbnailDisplay === "square" ? "cover" : "contain"}
            source={{ uri }}
            style={styles.thumbnail}
            testID={`draft-thumbnail-${index}`}
          />
        )}
        {corrupt ? (
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.corruptOverlay}
          >
            <Text style={styles.warningIcon}>!</Text>
          </View>
        ) : null}
      </Pressable>
    );
  };

  const showStorageFailure =
    unknownDeletion !== null || libraryState.status === "storage-failed";

  const banner = (
    <View style={styles.banner}>
      <View style={styles.bannerTopline}>
        <Text style={styles.eyebrow}>{t("home.eyebrow")}</Text>
        <Pressable
          accessibilityLabel={t("home.menu")}
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => setMenuVisible(true)}
          style={({ pressed }) => [styles.menuButton, pressed && styles.pressed]}
          testID="home-menu"
        >
          <Text style={styles.menuSymbol}>•••</Text>
        </Pressable>
      </View>
      <Text style={styles.bannerTitle}>{t("home.libraryTitle")}</Text>
      <Text style={styles.bannerDescription}>{t("home.description")}</Text>
      {importing ? (
        <View accessibilityLiveRegion="polite" style={styles.importing} testID="home-importing">
          <ActivityIndicator color={colors.stageText} />
          <Text style={styles.importingText}>{t("home.importing")}</Text>
        </View>
      ) : (
        <ActionButton
          accessibilityLabel={t("home.choosePhotos")}
          label={t("home.choosePhotos")}
          onPress={() => void choosePhotos()}
          testID="choose-photos"
        />
      )}
      {errorKey !== null ? (
        <Text accessibilityLiveRegion="assertive" style={styles.bannerError} testID="home-error">
          {t(errorKey)}
        </Text>
      ) : null}
      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>{t("home.drafts")}</Text>
        {!showStorageFailure && libraryState.status === "ready" ? (
          <Text style={styles.sectionCount}>{libraryState.entries.length}</Text>
        ) : null}
      </View>
    </View>
  );

  const entries = !showStorageFailure && libraryState.status === "ready" ? libraryState.entries : [];

  return (
    <SafeAreaView style={styles.safeArea} testID="home-screen">
      <FlatList
        columnWrapperStyle={styles.gridRow}
        contentContainerStyle={styles.content}
        data={entries}
        key={`draft-grid-${columnCount}`}
        keyExtractor={(entry) => entry.draftId}
        ListEmptyComponent={
          showStorageFailure ? (
            <View style={styles.pageMessage} testID="home-storage-failed">
              <Text accessibilityLiveRegion="assertive" style={styles.pageMessageTitle}>
                {t("home.storageFailed")}
              </Text>
              <Text style={styles.pageMessageBody}>{t("home.storageFailedDescription")}</Text>
              <ActionButton
                accessibilityLabel={t("common.retry")}
                label={t("common.retry")}
                onPress={() => {
                  if (unknownDeletion !== null) {
                    void deleteDraft(unknownDeletion);
                  } else {
                    void editorRuntime.loadDraftLibrary();
                  }
                }}
                testID={
                  unknownDeletion === null
                    ? "retry-draft-library"
                    : "retry-draft-deletion"
                }
                variant="secondary"
              />
            </View>
          ) : libraryState.status !== "ready" ? (
            <View accessibilityLiveRegion="polite" style={styles.pageMessage} testID="home-loading">
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.pageMessageBody}>{t("home.loadingDrafts")}</Text>
            </View>
          ) : null
        }
        ListHeaderComponent={banner}
        numColumns={columnCount}
        ref={listRef}
        renderItem={renderDraft}
        testID="home-grid"
      />

      <Modal
        animationType="fade"
        onRequestClose={() => setMenuVisible(false)}
        transparent
        visible={menuVisible}
      >
        <View style={styles.modalScrim}>
          <View style={styles.menuCard} testID="display-menu">
            <Text style={styles.modalTitle}>{t("home.displayMode")}</Text>
            {(["square", "original"] as const).map((display) => (
              <Pressable
                accessibilityLabel={t(`home.display.${display}`)}
                accessibilityRole="radio"
                accessibilityState={{
                  checked: settings.draftThumbnailDisplay === display,
                  disabled: !settingsLoaded,
                }}
                disabled={!settingsLoaded}
                key={display}
                onPress={() => void saveDisplay(display)}
                style={({ pressed }) => [
                  styles.menuRow,
                  !settingsLoaded && styles.disabledMenuRow,
                  pressed && settingsLoaded && styles.pressed,
                ]}
                testID={`display-${display}`}
              >
                <Text style={styles.menuRowText}>{t(`home.display.${display}`)}</Text>
                <Text style={styles.menuCheck}>
                  {settings.draftThumbnailDisplay === display ? "●" : "○"}
                </Text>
              </Pressable>
            ))}
            <View style={styles.menuDivider} />
            <Pressable
              accessibilityLabel={t("settings.title")}
              accessibilityRole="button"
              onPress={() => {
                setMenuVisible(false);
                router.push("/settings" as Href);
              }}
              style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
              testID="open-settings"
            >
              <Text style={styles.menuRowText}>{t("settings.title")}</Text>
              <Text style={styles.menuArrow}>›</Text>
            </Pressable>
            <ActionButton
              accessibilityLabel={t("common.done")}
              label={t("common.done")}
              onPress={() => setMenuVisible(false)}
              testID="close-home-menu"
              variant="secondary"
            />
          </View>
        </View>
      </Modal>

      <Modal
        animationType="fade"
        onRequestClose={() => setActionTarget(null)}
        transparent
        visible={actionTarget !== null}
      >
        <View style={styles.modalScrim}>
          <View style={styles.menuCard} testID="draft-actions">
            <Pressable
              accessibilityLabel={t("home.deleteDraft")}
              accessibilityRole="button"
              onPress={() => {
                if (actionTarget !== null) {
                  setDeleteTarget({ entry: actionTarget, corrupt: false });
                  setActionTarget(null);
                }
              }}
              style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
              testID="delete-draft-action"
            >
              <Text style={styles.deleteText}>{t("home.deleteDraft")}</Text>
            </Pressable>
            <ActionButton
              accessibilityLabel={t("common.cancel")}
              label={t("common.cancel")}
              onPress={() => setActionTarget(null)}
              testID="cancel-draft-actions"
              variant="secondary"
            />
          </View>
        </View>
      </Modal>

      <Modal
        animationType="fade"
        onRequestClose={() => setDeleteTarget(null)}
        transparent
        visible={deleteTarget !== null}
      >
        <View style={styles.modalScrim}>
          <View
            style={styles.confirmCard}
            testID={deleteTarget?.corrupt ? "corrupt-delete-confirmation" : "delete-confirmation"}
          >
            <Text style={styles.modalTitle}>
              {t(deleteTarget?.corrupt ? "home.corruptTitle" : "home.deleteTitle")}
            </Text>
            <Text style={styles.modalBody}>
              {t(deleteTarget?.corrupt ? "home.corruptDescription" : "home.deleteDescription")}
            </Text>
            <View style={styles.confirmActions}>
              <ActionButton
                accessibilityLabel={t("common.cancel")}
                label={t("common.cancel")}
                onPress={() => setDeleteTarget(null)}
                testID="cancel-delete"
                variant="secondary"
              />
              <ActionButton
                accessibilityLabel={t("home.deleteDraft")}
                label={t("home.deleteDraft")}
                onPress={() => {
                  if (deleteTarget !== null) void deleteDraft(deleteTarget.entry.draftId);
                }}
                testID="confirm-delete"
              />
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.canvasWarm },
  content: { paddingHorizontal: spacing.s4, paddingBottom: spacing.s8 },
  banner: { paddingTop: spacing.s4, paddingBottom: spacing.s4, gap: spacing.s3 },
  bannerTopline: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  eyebrow: { ...typography.caption, color: colors.accent, letterSpacing: 1.4 },
  menuButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.r12,
  },
  menuSymbol: { color: colors.ink, fontSize: 16, lineHeight: 20, letterSpacing: 2 },
  bannerTitle: { ...typography.display, color: colors.ink, letterSpacing: -0.8 },
  bannerDescription: { ...typography.body, color: colors.inkMuted, maxWidth: 360 },
  importing: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
    gap: spacing.s2,
    borderRadius: radii.r12,
    backgroundColor: colors.stage,
  },
  importingText: { ...typography.label, color: colors.stageText },
  bannerError: { ...typography.caption, color: colors.danger },
  sectionHeading: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: spacing.s2,
    marginTop: spacing.s4,
  },
  sectionTitle: { ...typography.title, color: colors.ink },
  sectionCount: { ...typography.caption, color: colors.inkMuted },
  gridRow: { gap: spacing.s2, marginBottom: spacing.s2 },
  draftItem: { overflow: "hidden", backgroundColor: colors.line },
  thumbnail: { width: "100%", height: "100%", backgroundColor: colors.surface },
  thumbnailPlaceholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#E6DED2",
  },
  corruptPlaceholder: { backgroundColor: "#D9D1C7" },
  placeholderMark: {
    width: "30%",
    height: 3,
    borderRadius: radii.pill,
    backgroundColor: colors.inkMuted,
    opacity: 0.28,
  },
  corruptOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(29, 27, 24, 0.54)",
  },
  warningIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    overflow: "hidden",
    textAlign: "center",
    color: colors.ink,
    backgroundColor: colors.canvasWarm,
    fontSize: 21,
    lineHeight: 32,
    fontWeight: "800",
  },
  pageMessage: {
    minHeight: 180,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.s3,
    paddingHorizontal: spacing.s6,
  },
  pageMessageTitle: { ...typography.title, color: colors.ink, textAlign: "center" },
  pageMessageBody: { ...typography.body, color: colors.inkMuted, textAlign: "center" },
  modalScrim: {
    flex: 1,
    justifyContent: "flex-end",
    padding: spacing.s4,
    backgroundColor: "rgba(29, 27, 24, 0.42)",
  },
  menuCard: {
    gap: spacing.s2,
    padding: spacing.s4,
    borderRadius: radii.r20,
    backgroundColor: colors.surface,
    boxShadow: shadows.level2,
  },
  confirmCard: {
    gap: spacing.s3,
    padding: spacing.s6,
    borderRadius: radii.r20,
    backgroundColor: colors.surface,
    boxShadow: shadows.level2,
  },
  modalTitle: { ...typography.title, color: colors.ink },
  modalBody: { ...typography.body, color: colors.inkMuted },
  menuRow: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.s3,
    borderRadius: radii.r12,
  },
  disabledMenuRow: { opacity: 0.5 },
  menuRowText: { ...typography.body, color: colors.ink },
  menuCheck: { color: colors.accent, fontSize: 18 },
  menuArrow: { color: colors.inkMuted, fontSize: 26 },
  menuDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  deleteText: { ...typography.body, color: colors.danger, fontWeight: "600" },
  confirmActions: { gap: spacing.s2 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.985 }] },
});
