import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../", import.meta.url));

test("iOS prebuild registers Expo's scene delegate for the UIKit application lifecycle", () => {
  const config = JSON.parse(
    execFileSync(
      process.execPath,
      [require.resolve("expo/bin/cli"), "config", "--type", "introspect", "--json"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, EXPO_OFFLINE: "1", EXPO_NO_DOTENV: "1" },
        timeout: 60000,
      },
    ),
  );
  const manifest = config._internal.modResults.ios.infoPlist.UIApplicationSceneManifest;
  assert.ok(manifest, "iOS prebuild must adopt UIScene lifecycle");
  const scenes = manifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication;
  assert.ok(scenes.some((scene) => scene.UISceneDelegateClassName === "EXExpoAppSceneDelegate"));
});
