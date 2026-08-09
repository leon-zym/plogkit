import assert from "node:assert/strict";
import test from "node:test";

import { prepareAndWarmDevices } from "./orchestration.mjs";

test("device startup is serial and Android post-install readiness immediately precedes warm-up", async () => {
  const events = [];
  const devices = await prepareAndWarmDevices({
    artifactRoot: "/artifacts",
    assertAndroidDeviceReady: async ({ device, stage }) => {
      events.push(`ready:${device.platform}:${stage}`);
    },
    cleanup: {},
    deviceId: null,
    installAndSeed: async (device) => {
      events.push(`install:${device.platform}`);
    },
    platforms: ["ios", "android"],
    prewarmMetroBundle: async ({ platform }) => {
      events.push(`prewarm:${platform}`);
    },
    prepareDevice: async (platform) => {
      events.push(`prepare:${platform}`);
      return { platform, deviceId: `${platform}-device` };
    },
    root: "/repo",
    startMetro: async () => {
      events.push("metro");
    },
    warmUpApp: async ({ device }) => {
      events.push(`warmup:${device.platform}`);
    },
  });

  assert.deepEqual(events, [
    "prepare:ios",
    "install:ios",
    "metro",
    "prewarm:ios",
    "warmup:ios",
    "prepare:android",
    "install:android",
    "ready:android:post-install",
    "warmup:android",
  ]);
  assert.deepEqual(
    devices.map((device) => device.platform),
    ["ios", "android"],
  );
});

test("warm-up fails when the owned Metro transport fails after initial readiness", async () => {
  await assert.rejects(
    prepareAndWarmDevices({
      artifactRoot: "/artifacts",
      assertAndroidDeviceReady: async () => {},
      cleanup: {},
      deviceId: null,
      installAndSeed: async () => {},
      platforms: ["ios"],
      prewarmMetroBundle: async () => {},
      prepareDevice: async () => ({ platform: "ios", deviceId: "ios-device" }),
      root: "/repo",
      startMetro: async () => ({
        failure: Promise.resolve(
          new Error("Owned Metro transport failed: ERR_STREAM_PREMATURE_CLOSE"),
        ),
      }),
      warmUpApp: () => new Promise((resolvePromise) => setImmediate(resolvePromise)),
    }),
    /Owned Metro transport failed: ERR_STREAM_PREMATURE_CLOSE/,
  );
});
