import {
  Canvas,
  Group,
  Image,
  Line,
  Paragraph,
  Rect,
  Skia,
  type SkImage,
  type SkParagraph,
} from "@shopify/react-native-skia";
import React, { useEffect, useMemo, useState } from "react";
import type { StyleProp, ViewStyle } from "react-native";

import type { PlogDocument } from "@/core/document";
import { documentToRenderScene, type SceneImage, type SceneText } from "@/render/scene";
import { makeSceneParagraph } from "@/render/skiaDraw";

interface ImageLoadState {
  readonly uri: string;
  readonly status: "ready" | "error";
  readonly image: SkImage | null;
}

function useDisposableImage(uri: string): ImageLoadState | null {
  const [state, setState] = useState<ImageLoadState | null>(null);

  useEffect(() => {
    let cancelled = false;
    let ownedImage: SkImage | null = null;

    void Skia.Data.fromURI(uri)
      .then((data) => {
        try {
          ownedImage = Skia.Image.MakeImageFromEncoded(data);
        } finally {
          data.dispose();
        }

        if (cancelled) {
          ownedImage?.dispose();
          ownedImage = null;
          return;
        }
        setState({
          uri,
          status: ownedImage === null ? "error" : "ready",
          image: ownedImage,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setState({ uri, status: "error", image: null });
        }
      });

    return () => {
      cancelled = true;
      ownedImage?.dispose();
      ownedImage = null;
    };
  }, [uri]);

  return state?.uri === uri ? state : null;
}

function PendingImage({ node, failed }: { readonly node: SceneImage; readonly failed: boolean }) {
  const { x, y, width, height } = node.destination;
  const color = failed ? "#A83A3A" : "#8A8A8A";
  return (
    <Group>
      <Rect x={x} y={y} width={width} height={height} color="#E3E3E3" />
      <Rect
        x={x}
        y={y}
        width={width}
        height={height}
        color={color}
        style="stroke"
        strokeWidth={Math.max(2, width / 250)}
      />
      <Line p1={{ x, y }} p2={{ x: x + width, y: y + height }} color={color} strokeWidth={3} />
      <Line p1={{ x: x + width, y }} p2={{ x, y: y + height }} color={color} strokeWidth={3} />
    </Group>
  );
}

function SceneImageNode({ node }: { readonly node: SceneImage }) {
  const state = useDisposableImage(node.uri);
  if (state?.image === null || state?.image === undefined) {
    return <PendingImage node={node} failed={state?.status === "error"} />;
  }
  return (
    <Image
      image={state.image}
      x={node.destination.x}
      y={node.destination.y}
      width={node.destination.width}
      height={node.destination.height}
      fit="fill"
    />
  );
}

interface ParagraphState {
  readonly text: SceneText;
  readonly paragraph: SkParagraph;
}

function useDisposableParagraph(text: SceneText): SkParagraph | null {
  const [state, setState] = useState<ParagraphState | null>(null);
  useEffect(() => {
    let cancelled = false;
    let disposed = false;
    const nextParagraph = makeSceneParagraph(Skia, text);
    const dispose = () => {
      if (!disposed) {
        nextParagraph.dispose();
        disposed = true;
      }
    };
    void Promise.resolve().then(() => {
      if (cancelled) {
        dispose();
      } else {
        setState({ text, paragraph: nextParagraph });
      }
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, [text]);
  return state?.text === text ? state.paragraph : null;
}

function SceneTextNode({ text }: { readonly text: SceneText }) {
  const paragraph = useDisposableParagraph(text);
  return <Paragraph paragraph={paragraph} x={text.x} y={text.y} width={text.width} />;
}

export interface DocumentCanvasProps {
  readonly document: PlogDocument;
  readonly width: number;
  readonly accessibilityLabel: string;
  readonly testID?: string;
  readonly style?: StyleProp<ViewStyle>;
}

/** Device preview. It intentionally consumes previewUri while export consumes originalUri. */
export function DocumentCanvas({
  document,
  width,
  accessibilityLabel,
  testID = "document-canvas",
  style,
}: DocumentCanvasProps) {
  const scene = useMemo(() => documentToRenderScene(document, "preview"), [document]);
  const scale = width / scene.width;

  if (!Number.isFinite(width) || width <= 0) {
    throw new Error("DocumentCanvas width must be a positive finite number");
  }

  return (
    <Canvas
      accessible
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={[style, { width, height: scene.height * scale }]}
    >
      <Group transform={[{ scale }]}>
        <Rect x={0} y={0} width={scene.width} height={scene.height} color={scene.backgroundColor} />
        {scene.images.map((image) => (
          <SceneImageNode key={image.imageId} node={image} />
        ))}
        {scene.texts.map((text) => (
          <SceneTextNode key={text.id} text={text} />
        ))}
      </Group>
    </Canvas>
  );
}
