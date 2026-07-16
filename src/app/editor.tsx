import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, type Href } from "expo-router";
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

import type { ExportSettings, Point } from "@/core/document";
import {
  editIntents,
  type EditCommitModule,
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
import { editorRuntime } from "@/features/editor/runtime";
import { useEditCommit } from "@/features/editor/state/editCommit";
import { DocumentCanvas } from "@/features/editor/components/DocumentCanvas";
import { exportDocument } from "@/services/export";
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

export default function EditorScreen() {
  const router = useRouter();
  const [editing, setEditing] = useState<EditCommitModule | null>(() => editorRuntime.getEditing());

  useEffect(() => {
    if (editing !== null) return;
    let active = true;
    void editorRuntime.restore().then((result) => {
      if (!active) return;
      const restoredEditing = editorRuntime.getEditing();
      if (result.status === "restored" && restoredEditing !== null) {
        setEditing(restoredEditing);
      } else {
        router.replace("/" as Href);
      }
    });
    return () => {
      active = false;
    };
  }, [editing, router]);

  return editing === null ? <LoadingEditor /> : <ConnectedEditor editing={editing} />;
}

type ActiveEditorTool = EditorTool | "export";

function ConnectedEditor({ editing }: { readonly editing: EditCommitModule }) {
  const { t } = useTranslation();
  const router = useRouter();
  const { document, previewDocument, canUndo, canRedo } = useEditCommit(editing);
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<ActiveEditorTool>("background");

  const [stageWidth, setStageWidth] = useState(0);
  const [exportStatus, setExportStatus] = useState<ExportStatus>({ kind: "idle" });
  const [importErrorCount] = useState(() => editorRuntime.takeImportErrorCount());
  const canvasScrollRef = useRef<ScrollView>(null);
  const canvasScrollY = useRef(0);
  const canvasScrollYBeforeKeyboard = useRef<number | null>(null);
  const panelScrollRef = useRef<ScrollView>(null);

  const canvasWidth = Math.max(0, stageWidth - spacing.s8);
  const selectedText =
    document.textElements.find((element) => element.id === selectedTextId) ?? null;
  const toolbarTool: EditorTool = activeTool === "export" ? "background" : activeTool;

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

  const updateExportSettings = (settings: ExportSettings) => {
    commitIntent(editIntents.export.changeSettings(settings));
    setExportStatus({ kind: "idle" });
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
      const result = await exportDocument(document, { basicMetadata });
      setExportStatus({
        kind: "success",
        width: result.plan.width,
        height: result.plan.height,
        wasReduced: result.plan.wasReduced,
      });
    } catch {
      setExportStatus({ kind: "error" });
    }
  };

  const goBack = async () => {
    try {
      await editorRuntime.flush();
    } finally {
      router.replace("/" as Href);
    }
  };

  const renderPanel = () => {
    if (activeTool === "export") {
      return (
        <ExportPanel
          onExport={() => void runExport()}
          onSettingsChange={updateExportSettings}
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
                  document={previewDocument}
                  width={canvasWidth}
                />
                <TextGestureOverlay
                  accessibilityLabel={(index) => `${t("text.edit")} ${index + 1}`}
                  canvasWidth={canvasWidth}
                  onCommitPosition={moveText}
                  onSelect={selectText}
                  selectedTextId={selectedTextId}
                  texts={previewDocument.textElements}
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
  importWarning: {
    ...typography.caption,
    color: colors.ink,
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
