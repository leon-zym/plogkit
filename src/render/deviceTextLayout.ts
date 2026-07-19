import { Skia, type SkTypefaceFontProvider } from "@shopify/react-native-skia";

import {
  createTextLayoutEnvironment,
  createUnavailableTextLayoutEnvironment,
  type AnyTextLayoutEnvironment,
} from "./textLayout";

const DEVICE_FONT_FAMILIES = Object.freeze({
  "system-sans": Object.freeze(["system-ui", "PingFang SC", "sans-serif"]),
  "system-serif": Object.freeze(["serif"]),
});

let deviceEnvironment: AnyTextLayoutEnvironment | null = null;

/** Shared ready environment for device preview and the current Skia export backend. */
export function getDeviceTextLayoutEnvironment(): AnyTextLayoutEnvironment {
  if (deviceEnvironment !== null) return deviceEnvironment;
  try {
    const fontProvider = Skia.FontMgr.System() as SkTypefaceFontProvider | null;
    deviceEnvironment =
      fontProvider === null
        ? createUnavailableTextLayoutEnvironment("device font registry is unavailable")
        : createTextLayoutEnvironment({
            api: Skia,
            fontProvider,
            fontFamilies: DEVICE_FONT_FAMILIES,
          });
  } catch (error: unknown) {
    deviceEnvironment = createUnavailableTextLayoutEnvironment(
      error instanceof Error ? error.message : "device font registry is unavailable",
    );
  }
  return deviceEnvironment;
}
