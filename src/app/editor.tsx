import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Stack, useNavigation, useRouter, type Href } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { PlogDocument, Point } from "@/core/document";
import {
  resolveExportPolicy,
  type ExportFormat,
  type ExportPolicyError,
  type ExportPresetId,
  type MetadataPolicy,
} from "@/core/exportPolicy";
import {
  editIntents,
  type EditIntent,
  type EditResult,
} from "@/core/editing";
import { BackgroundPanel } from "@/features/editor/components/BackgroundPanel";
import { EditorHeader } from "@/features/editor/components/EditorHeader";
import { EditorToolbar, type EditorTool } from "@/features/editor/components/EditorToolbar";
import { ExportPanel, type ExportStatus } from "@/features/editor/components/ExportPanel";
import { StitchPanel } from "@/features/editor/components/StitchPanel";
import { TextGestureOverlay } from "@/features/editor/components/TextGestureOverlay";
import {
  TextPanel,
  type TextDraft,
  type TextStyleDraft,
} from "@/features/editor/components/TextPanel";
import { editorRuntime } from "@/features/editor/expoEditorRuntime";
import type { PreparedEditor } from "@/features/editor/runtime";
import { useEditCommit } from "@/features/editor/state/editCommit";
import { useTextLayoutSnapshot } from "@/features/editor/useTextLayoutSnapshot";
import { DocumentCanvas } from "@/features/editor/components/DocumentCanvas";
import { documentToExportSourceFacts } from "@/render/exportSourceFacts";
import { getDeviceTextLayoutEnvironment } from "@/render/deviceTextLayout";
import { documentToRenderScene } from "@/render/scene";
import { exportDocument, SKIA_EXPORT_CAPABILITIES } from "@/services/export";
import { ActionButton } from "@/ui/ActionButton";
import { colors, spacing, typography } from "@/ui/theme";

function LoadingEditor() {
  const { t } = useTranslation();
  return (
    <SafeAreaView style={styles.loading} testID="editor-loading">
      <ActivityIndicator color={colors.accent} />
      <Text style={styles.loadingText}>{t("editor.saving")}</Text>
    </SafeAreaView>
  );
}

function EditorPreparationError({
  onBack,
  onRetry,
}: {
  readonly onBack: () => void;
  readonly onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <SafeAreaView style={styles.preparationError} testID="editor-prepare-error">
      <Text
        accessibilityLiveRegion="assertive"
        style={styles.preparationErrorText}
        testID="editor-prepare-error-message"
      >
        {t("editor.preparationFailed")}
      </Text>
      <View style={styles.preparationErrorActions}>
        <ActionButton
          accessibilityLabel={t("common.retry")}
          label={t("common.retry")}
          onPress={onRetry}
          testID="retry-editor-preparation"
        />
        <ActionButton
          accessibilityLabel={t("common.back")}
          label={t("common.back")}
          onPress={onBack}
          testID="leave-editor-preparation"
          variant="secondary"
        />
      </View>
    </SafeAreaView>
  );
}

interface ExportPolicyPreflight {
  readonly error: ExportPolicyError | null;
  readonly canRetainBasic: boolean;
}

function preflightExportPolicy(document: PlogDocument): ExportPolicyPreflight {
  const sourceFacts = documentToExportSourceFacts(document);
  const current = resolveExportPolicy(
    document.exportSettings,
    sourceFacts,
    SKIA_EXPORT_CAPABILITIES,
  );
  const retainBasic = resolveExportPolicy(
    { ...document.exportSettings, metadataPolicy: "retain-basic" },
    sourceFacts,
    SKIA_EXPORT_CAPABILITIES,
  );
  return {
    error: current.status === "failed" ? current.error : null,
    canRetainBasic: retainBasic.status === "resolved",
  };
}

export default function EditorScreen() {
  const router = useRouter();
  const [preparation, setPreparation] = useState<
    | PreparedEditor
    | { readonly status: "loading" }
    | { readonly status: "failed" }
  >({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void editorRuntime
      .prepareEditor()
      .then((next) => {
        if (!active) return;
        if (next.status === "no-draft") {
          router.replace("/" as Href);
        } else if (next.status !== "prepared") {
          setPreparation({ status: "failed" });
        } else {
          setPreparation(next);
        }
      })
      .catch(() => {
        if (active) setPreparation({ status: "failed" });
      });
    return () => {
      active = false;
    };
  }, [attempt, router]);

  return (
    <>
      <Stack.Screen
        options={{ gestureEnabled: false, headerBackButtonMenuEnabled: false }}
      />
      {preparation.status === "loading" ? (
        <LoadingEditor />
      ) : preparation.status === "failed" ? (
        <EditorPreparationError
          onBack={() => router.replace("/" as Href)}
          onRetry={() => {
            setPreparation({ status: "loading" });
            setAttempt((current) => current + 1);
          }}
        />
      ) : (
        <ConnectedEditor {...preparation} />
      )}
    </>
  );
}

type ActiveEditorTool = EditorTool | "export";

function ConnectedEditor({ assets, editing }: PreparedEditor) {
  const { t } = useTranslation();
  const router = useRouter();
  const navigation = useNavigation();
  const { document, previewDocument, canUndo, canRedo } = useEditCommit(editing);
  const previewScene = useMemo(
    () => documentToRenderScene(previewDocument),
    [previewDocument],
  );
  const textLayoutEnvironment = useMemo(() => getDeviceTextLayoutEnvironment(), []);
  const textLayout = useTextLayoutSnapshot(textLayoutEnvironment, previewScene.texts);
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<ActiveEditorTool>("background");

  const [stageWidth, setStageWidth] = useState(0);
  const [exportStatus, setExportStatus] = useState<ExportStatus>({ kind: "idle" });
  const [importErrorCount] = useState(() => editorRuntime.takeImportErrorCount());
  const [saveFailed, setSaveFailed] = useState(false);
  const leavePending = useRef(false);
  const [leaveAllowed, setLeaveAllowed] = useState(false);
  const pendingLeave = useRef<(() => void) | null>(null);
  const canvasScrollRef = useRef<ScrollView>(null);
  const canvasScrollY = useRef(0);
  const canvasScrollYBeforeKeyboard = useRef<number | null>(null);
  const panelScrollRef = useRef<ScrollView>(null);

  const canvasWidth = Math.max(0, stageWidth - spacing.s8);
  const selectedText =
    document.textElements.find((element) => element.id === selectedTextId) ?? null;
  const toolbarTool: EditorTool = activeTool === "export" ? "background" : activeTool;
  const exportPreflight = useMemo(() => preflightExportPolicy(document), [document]);

  useEffect(() => {
    panelScrollRef.current?.scrollTo({ animated: false, y: 0 });
  }, [activeTool, selectedTextId]);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const showSubscription = Keyboard.addListener(showEvent, () => {
      canvasScrollYBeforeKeyboard.current ??= canvasScrollY.current;
    });
    const hideSubscription = Keyboard.addListener("keyboardDidHide", () => {
      const previousOffset = canvasScrollYBeforeKeyboard.current;
      canvasScrollYBeforeKeyboard.current = null;
      if (previousOffset !== null) {
        requestAnimationFrame(() => {
          canvasScrollRef.current?.scrollTo({ animated: false, y: previousOffset });
        });
      }
    });
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  const onStageLayout = (event: LayoutChangeEvent) => {
    setStageWidth(event.nativeEvent.layout.width);
  };

  const consumeEffects = useCallback((result: EditResult) => {
    if (result.status !== "changed") return;
    setSelectedTextId((current) =>
      current !== null &&
      result.effects.removed.some(({ kind, id }) => kind === "text" && id === current)
        ? null
        : current,
    );
  }, []);

  const commitIntent = useCallback(
    (intent: EditIntent): EditResult => {
      const result = editing.dispatch({ type: "commit", intent });
      consumeEffects(result);
      return result;
    },
    [consumeEffects, editing],
  );

  const selectText = (id: string | null) => {
    editing.dispatch({ type: "cancel-preview" });
    setSelectedTextId(id);
    setActiveTool("text");
  };

  const submitText = (draft: TextDraft) => {
    if (selectedText !== null) {
      commitIntent(editIntents.text.replaceDraft(selectedText.id, draft));
      return;
    }
    const result = commitIntent(editIntents.text.add(draft));
    if (result.status === "changed") {
      const createdText = result.effects.created.find(({ kind }) => kind === "text");
      if (createdText !== undefined) setSelectedTextId(createdText.id);
      canvasScrollRef.current?.scrollTo({ animated: true, y: 0 });
    }
  };

  const commitSelectedTextStyle = (style: TextStyleDraft) => {
    if (selectedText === null) return;
    commitIntent(editIntents.text.applyStyle(selectedText.id, style));
  };

  const deleteSelectedText = () => {
    if (selectedText === null) return;
    commitIntent(editIntents.text.remove(selectedText.id));
  };

  const moveText = (id: string, position: Point) => {
    commitIntent(editIntents.text.move(id, position));
    selectText(id);
  };

  const commitExportIntent = (intent: EditIntent) => {
    commitIntent(intent);
    setExportStatus({ kind: "idle" });
  };

  const changeExportPreset = (presetId: ExportPresetId) => {
    commitExportIntent(editIntents.export.changePreset(presetId));
  };

  const changeExportFormat = (format: ExportFormat) => {
    commitExportIntent(editIntents.export.changeFormat(format));
  };

  const changeExportMetadataPolicy = (policy: MetadataPolicy) => {
    commitExportIntent(editIntents.export.changeMetadataPolicy(policy));
  };

  const previewSelectedText = useCallback(
    (draft: TextDraft | null) => {
      if (draft === null || selectedTextId === null) {
        editing.dispatch({ type: "cancel-preview" });
        return;
      }
      editing.dispatch({
        type: "preview",
        intent: editIntents.text.replaceDraft(selectedTextId, draft),
      });
    },
    [editing, selectedTextId],
  );

  const runExport = async () => {
    setExportStatus({ kind: "exporting" });
    try {
      const firstImage = document.sourceImages[0];
      const basicMetadata =
        document.exportSettings.metadataPolicy === "retain-basic" && firstImage !== undefined
          ? await editorRuntime.readBasicMetadata(firstImage.id)
          : undefined;
      const result = await exportDocument(document, assets, { basicMetadata });
      setExportStatus({
        kind: "success",
        width: result.plan.width,
        height: result.plan.height,
        wasReduced: result.plan.wasReduced,
        format: result.plan.format,
      });
    } catch {
      setExportStatus({ kind: "error" });
    }
  };

  const attemptLeave = useCallback(async (navigate: () => void) => {
    if (leavePending.current) return;
    leavePending.current = true;
    setSaveFailed(false);
    try {
      const result = await editorRuntime.flush();
      if (result.status === "flushed") {
        pendingLeave.current = navigate;
        setLeaveAllowed(true);
      } else {
        setSaveFailed(true);
      }
    } catch {
      setSaveFailed(true);
    } finally {
      leavePending.current = false;
    }
  }, []);

  usePreventRemove(!leaveAllowed, ({ data }) => {
    void attemptLeave(() => navigation.dispatch(data.action));
  });

  useEffect(() => {
    if (!leaveAllowed) return;
    const navigate = pendingLeave.current;
    pendingLeave.current = null;
    navigate?.();
  }, [leaveAllowed]);

  const goBack = () => attemptLeave(() => router.replace("/" as Href));

  const renderPanel = () => {
    if (activeTool === "export") {
      return (
        <ExportPanel
          canRetainBasic={exportPreflight.canRetainBasic}
          onExport={() => void runExport()}
          onFormatChange={changeExportFormat}
          onMetadataPolicyChange={changeExportMetadataPolicy}
          onPresetChange={changeExportPreset}
          policyError={exportPreflight.error}
          settings={document.exportSettings}
          status={exportStatus}
        />
      );
    }
    if (activeTool === "stitch") {
      return (
        <StitchPanel
          images={document.sourceImages}
          mode={document.stitch.mode}
          onModeChange={(mode) => commitIntent(editIntents.stitch.changeMode(mode))}
          onOrderChange={(order) => commitIntent(editIntents.stitch.reorderImages(order))}
          onSpacingCommit={(value) => commitIntent(editIntents.stitch.changeSpacing(value))}
          onSpacingPreview={(value) =>
            editing.dispatch({
              type: "preview",
              intent: editIntents.stitch.changeSpacing(value),
            })
          }
          order={document.stitch.order}
          spacingValue={previewDocument.stitch.spacing}
        />
      );
    }
    if (activeTool === "text") {
      return (
        <TextPanel
          elements={document.textElements}
          onDelete={selectedText === null ? null : deleteSelectedText}
          onPreview={previewSelectedText}
          onSelect={selectText}
          onStyleCommit={commitSelectedTextStyle}
          onSubmit={(draft) => {
            submitText(draft);
            panelScrollRef.current?.scrollTo({ animated: true, y: 0 });
          }}
          selected={selectedText}
        />
      );
    }
    return (
      <BackgroundPanel
        backgroundColor={document.canvas.backgroundColor}
        onBackgroundColorChange={(backgroundColor) =>
          commitIntent(editIntents.canvas.changeBackground(backgroundColor))
        }
        onRatioChange={(ratio) => commitIntent(editIntents.canvas.changeRatio(ratio))}
        ratio={document.canvas.ratio}
      />
    );
  };

  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.root} testID="editor-screen">
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
        style={styles.keyboardLayout}
      >
        <EditorHeader
          canRedo={canRedo}
          canUndo={canUndo}
          imageCount={document.sourceImages.length}
          onBack={() => void goBack()}
          onExport={() => setActiveTool("export")}
          onRedo={() => {
            consumeEffects(editing.dispatch({ type: "redo" }));
          }}
          onUndo={() => {
            consumeEffects(editing.dispatch({ type: "undo" }));
          }}
        />
        {saveFailed ? (
          <Text
            accessibilityLiveRegion="assertive"
            style={styles.saveError}
            testID="editor-save-error"
          >
            {t("editor.saveFailed")}
          </Text>
        ) : null}
        {importErrorCount > 0 ? (
          <Text
            accessibilityLiveRegion="polite"
            style={styles.importWarning}
            testID="import-warning"
          >
            {t("home.importPartial")}
          </Text>
        ) : null}
        <View onLayout={onStageLayout} style={styles.stage}>
          <ScrollView
            contentContainerStyle={styles.canvasScrollContent}
            maximumZoomScale={3}
            minimumZoomScale={1}
            onScroll={(event) => {
              canvasScrollY.current = event.nativeEvent.contentOffset.y;
            }}
            ref={canvasScrollRef}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={false}
          >
            {canvasWidth > 0 ? (
              <View style={styles.canvasWrapper}>
                <DocumentCanvas
                  accessibilityLabel={t("editor.photoCount", {
                    count: document.sourceImages.length,
                  })}
                  assets={assets}
                  scene={previewScene}
                  textLayout={textLayout.snapshot}
                  width={canvasWidth}
                />
                <TextGestureOverlay
                  accessibilityLabel={(index) => `${t("text.edit")} ${index + 1}`}
                  canvasWidth={canvasWidth}
                  geometry={textLayout.snapshot?.geometry ?? []}
                  onCommitPosition={moveText}
                  onSelect={selectText}
                  selectedTextId={selectedTextId}
                />
              </View>
            ) : null}
          </ScrollView>
        </View>
        <EditorToolbar
          activeTool={toolbarTool}
          onToolChange={(tool) => {
            editing.dispatch({ type: "cancel-preview" });
            setActiveTool(tool);
            if (tool === "text" && selectedTextId === null) {
              canvasScrollRef.current?.scrollTo({ animated: true, y: 0 });
            }
          }}
        />
        <ScrollView
          contentContainerStyle={styles.panelScrollContent}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="always"
          ref={panelScrollRef}
          style={styles.panelScroll}
        >
          {renderPanel()}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  keyboardLayout: {
    flex: 1,
  },
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.s2,
    backgroundColor: colors.stage,
  },
  loadingText: {
    ...typography.label,
    color: colors.stageMuted,
  },
  preparationError: {
    flex: 1,
    justifyContent: "center",
    gap: spacing.s6,
    paddingHorizontal: spacing.s6,
    backgroundColor: colors.surface,
  },
  preparationErrorText: {
    ...typography.body,
    color: colors.danger,
    textAlign: "center",
  },
  preparationErrorActions: {
    gap: spacing.s2,
  },
  importWarning: {
    ...typography.caption,
    color: colors.ink,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: spacing.s4,
    paddingVertical: spacing.s2,
  },
  saveError: {
    ...typography.caption,
    color: colors.danger,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: spacing.s4,
    paddingVertical: spacing.s2,
  },
  stage: {
    flex: 1,
    minHeight: 180,
    backgroundColor: colors.stage,
  },
  canvasScrollContent: {
    alignItems: "center",
    paddingVertical: spacing.s4,
  },
  canvasWrapper: {
    position: "relative",
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.22)",
  },
  panelScroll: {
    flexShrink: 1,
    maxHeight: 344,
    backgroundColor: colors.surface,
  },
  panelScrollContent: {
    flexGrow: 1,
  },
});
