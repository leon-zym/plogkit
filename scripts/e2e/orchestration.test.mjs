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
