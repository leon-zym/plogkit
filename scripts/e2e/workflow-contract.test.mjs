import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = join(root, ".github/workflows/e2e.yml");
const ciWorkflowPath = join(root, ".github/workflows/ci.yml");

test("CI delegates the complete Android simulator lifecycle to the project runner", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(
    workflow,
    /sudo apt-get update[\s\S]*sudo apt-get install --yes --no-install-recommends libpulse0[\s\S]*sdkmanager/,
  );
  assert.match(
    workflow,
    /sdkmanager"[\s\\]*"cmdline-tools;22\.0"[\s\\]*"emulator"[\s\\]*"platform-tools"/,
  );
  assert.match(workflow, /system-images;android-36;default;x86_64/);
  assert.match(workflow, /ANDROID_HOME\/platform-tools.*GITHUB_PATH/);
  assert.match(workflow, /run: pnpm e2e:android/);
  assert.doesNotMatch(workflow, /reactivecircus\/android-emulator-runner|--device/);
  assert.doesNotMatch(workflow, /--phase|launch-soak|android_launch_soak/);
  assert.doesNotMatch(workflow, /swiftshader_indirect|ubuntu-latest/);
});

test("CI and local E2E share exact repository-owned host tool versions", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  assert.equal(readFileSync(join(root, ".node-version"), "utf8").trim(), "24.19.0");
  assert.equal(readFileSync(join(root, ".java-version"), "utf8").trim(), "17.0.20+8");
  assert.equal(readFileSync(join(root, ".maestro-version"), "utf8").trim(), "2.8.0");
  assert.equal(packageJson.packageManager, "pnpm@11.21.0");

  assert.match(workflow, /actions\/checkout@v7\.0\.1/g);
  assert.match(workflow, /pnpm\/action-setup@v6\.0\.10/g);
  assert.match(workflow, /actions\/setup-node@v7\.0\.0/g);
  assert.match(workflow, /node-version-file: \.node-version/g);
  assert.match(workflow, /actions\/setup-java@v5\.7\.0/g);
  assert.match(workflow, /java-version-file: \.java-version/g);
  assert.match(workflow, /MAESTRO_VERSION="\$\(< \.maestro-version\)"/g);
  assert.equal((workflow.match(/checksums_sha256\.txt/g) ?? []).length, 6);
  assert.equal((workflow.match(/shasum -a 256 -c checksums_sha256\.txt/g) ?? []).length, 2);
  assert.doesNotMatch(workflow, /get\.maestro\.mobile\.dev/);
  assert.match(
    workflow,
    /sudo xcode-select --switch \/Applications\/Xcode_26\.6\.app\/Contents\/Developer/,
  );
  assert.doesNotMatch(workflow, /node-version:\s*22\b|java-version:\s*17\b|version:\s*11\b/);
});

test("every CI layer reads the same repository-owned host versions", () => {
  const workflow = readFileSync(ciWorkflowPath, "utf8");

  assert.equal((workflow.match(/actions\/setup-node@v7\.0\.0/g) ?? []).length, 3);
  assert.equal((workflow.match(/node-version-file: \.node-version/g) ?? []).length, 3);
  assert.match(workflow, /actions\/setup-java@v5\.7\.0[\s\S]*java-version-file: \.java-version/);
  assert.match(
    workflow,
    /sudo xcode-select --switch \/Applications\/Xcode_26\.6\.app\/Contents\/Developer/,
  );
  assert.doesNotMatch(
    workflow,
    /ubuntu-latest|node-version:\s*22\b|java-version:\s*17\b|version:\s*11\b/,
  );
});

test("each mobile job has one complete E2E step and diagnostic-upload headroom", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  assert.equal((workflow.match(/^\s+timeout-minutes: 165$/gm) ?? []).length, 2);
  assert.equal((workflow.match(/^\s+timeout-minutes: 135$/gm) ?? []).length, 2);
  assert.equal((workflow.match(/run: pnpm e2e:ios/g) ?? []).length, 1);
  assert.equal((workflow.match(/run: pnpm e2e:android/g) ?? []).length, 1);
  assert.equal((workflow.match(/path: \$\{\{ runner\.temp \}\}\/plogkit-e2e$/gm) ?? []).length, 2);
  assert.match(
    workflow,
    /run: pnpm e2e:ios[\s\S]*E2E_ARTIFACTS_DIR: \$\{\{ runner\.temp \}\}\/plogkit-e2e-private[\s\S]*E2E_PUBLIC_ARTIFACTS_DIR: \$\{\{ runner\.temp \}\}\/plogkit-e2e[\s\S]*name: Upload failure artifacts/,
  );
  assert.doesNotMatch(
    workflow,
    /PlogKit\.app\.dSYM|app-release\.apk|native-debug-symbols|generated\/sourcemaps/,
  );
});

test("manual dispatch selects only a platform and optional business flow", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  assert.match(workflow, /platform:[\s\S]*options:[\s\S]*- all[\s\S]*- ios[\s\S]*- android/);
  assert.match(workflow, /flow:[\s\S]*required: false[\s\S]*type: string/);
  assert.doesNotMatch(workflow, /ios_runner|macos-26-xlarge/);
  assert.doesNotMatch(workflow, /soak|iterations|--phase/);
});
