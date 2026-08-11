import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { androidBuildArtifact, androidBuildSidecars, buildAndroid } from "./android.mjs";
import { buildIos, iosBuildArtifact, iosBuildSidecars } from "./ios.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

test("iOS E2E builds a standalone Release simulator app", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-ios-release-build-"));
  const binaries = join(directory, "bin");
  const commandLog = join(directory, "xcodebuild-args.log");
  mkdirSync(binaries);
  writeExecutable(
    join(binaries, "xcodebuild"),
    `#!/bin/sh
printf '%s\n' "\${NODE_ENV:-unset}" > "${commandLog}"
printf '%s\n' "$*" >> "${commandLog}"
mkdir -p "${directory}/ios/build/Build/Products/Release-iphonesimulator/PlogKit.app"
printf '\\306\\037\\274\\003\\301\\003\\031\\037bundle' > "${directory}/ios/build/Build/Products/Release-iphonesimulator/PlogKit.app/main.jsbundle"
mkdir -p "${directory}/ios/build/Build/Products/Release-iphonesimulator/PlogKit.app.dSYM/Contents/Resources/DWARF"
printf '%s' symbols > "${directory}/ios/build/Build/Products/Release-iphonesimulator/PlogKit.app.dSYM/Contents/Resources/DWARF/PlogKit"
`,
  );

  const previousPath = process.env.PATH;
  process.env.PATH = `${binaries}:${previousPath}`;
  try {
    await buildIos({ cleanup: { add() {} }, root: directory, workers: "2" });
  } finally {
    process.env.PATH = previousPath;
  }

  const [nodeEnvironment, argumentsLine] = readFileSync(commandLog, "utf8").trim().split("\n");
  assert.equal(nodeEnvironment, "production");
  assert.match(argumentsLine, /-configuration Release/);
  assert.match(argumentsLine, /CODE_SIGNING_ALLOWED=NO build/);
  assert.doesNotMatch(argumentsLine, /\bDebug\b/);
  assert.equal(
    iosBuildArtifact(directory),
    join(directory, "ios/build/Build/Products/Release-iphonesimulator/PlogKit.app"),
  );
  assert.deepEqual(iosBuildSidecars(directory), [
    join(directory, "ios/build/Build/Products/Release-iphonesimulator/PlogKit.app.dSYM"),
  ]);
});

test("Android E2E builds a standalone Release APK for the device architecture", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-android-release-build-"));
  const androidDirectory = join(directory, "android");
  const binaries = join(directory, "bin");
  const commandLog = join(directory, "gradle-args.log");
  mkdirSync(androidDirectory);
  mkdirSync(binaries);
  writeExecutable(
    join(androidDirectory, "gradlew"),
    `#!/bin/sh
printf '%s\n' "\${NODE_ENV:-unset}" > "${commandLog}"
printf '%s\n' "\${GRADLE_USER_HOME:-unset}" >> "${commandLog}"
printf '%s\n' "$*" >> "${commandLog}"
mkdir -p "${directory}/android/app/build/outputs/apk/release"
printf '%s' apk > "${directory}/android/app/build/outputs/apk/release/app-release.apk"
mkdir -p "${directory}/android/app/build/generated/sourcemaps/react/release"
printf '%s' source-map > "${directory}/android/app/build/generated/sourcemaps/react/release/index.android.bundle.map"
`,
  );
  writeExecutable(
    join(binaries, "unzip"),
    "#!/bin/sh\nprintf '\\306\\037\\274\\003\\301\\003\\031\\037bundle'\n",
  );

  const previousArch = process.env.E2E_ANDROID_ARCH;
  const previousPath = process.env.PATH;
  process.env.E2E_ANDROID_ARCH = "x86_64";
  process.env.PATH = `${binaries}:${previousPath}`;
  try {
    await buildAndroid({
      cleanup: { add() {} },
      javaHome: "/controlled/temurin-17",
      root: directory,
      workers: "2",
    });
  } finally {
    if (previousArch === undefined) delete process.env.E2E_ANDROID_ARCH;
    else process.env.E2E_ANDROID_ARCH = previousArch;
    process.env.PATH = previousPath;
  }

  const [nodeEnvironment, gradleUserHome, argumentsLine] = readFileSync(commandLog, "utf8")
    .trim()
    .split("\n");
  assert.equal(nodeEnvironment, "production");
  assert.equal(gradleUserHome, join(directory, ".e2e-cache/gradle"));
  assert.match(argumentsLine, /^app:assembleRelease\b/);
  assert.match(argumentsLine, /-Dorg\.gradle\.java\.home=\/controlled\/temurin-17/);
  assert.match(argumentsLine, /-PreactNativeArchitectures=x86_64/);
  assert.doesNotMatch(argumentsLine, /assembleDebug/);
  assert.equal(
    androidBuildArtifact(directory),
    join(directory, "android/app/build/outputs/apk/release/app-release.apk"),
  );
  assert.deepEqual(androidBuildSidecars(directory), [
    join(
      directory,
      "android/app/build/generated/sourcemaps/react/release/index.android.bundle.map",
    ),
  ]);
});

test("Android Release builds reject configuration in the runner-owned Gradle home", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plogkit-android-gradle-home-"));
  const androidDirectory = join(directory, "android");
  const gradleHome = join(directory, ".e2e-cache/gradle");
  mkdirSync(androidDirectory, { recursive: true });
  mkdirSync(gradleHome, { recursive: true });
  writeFileSync(join(gradleHome, "gradle.properties"), "org.gradle.java.home=/wrong/jdk\n");
  writeExecutable(join(androidDirectory, "gradlew"), "#!/bin/sh\nexit 0\n");

  await assert.rejects(
    buildAndroid({
      cleanup: { add() {} },
      javaHome: "/controlled/temurin-17",
      root: directory,
      workers: "2",
    }),
    /Runner-owned Gradle home contains build configuration.*gradle\.properties/,
  );
});

test("standalone launch does not pass a development server URL", () => {
  const launchFlow = readFileSync(join(root, "e2e/subflows/launch-app.yaml"), "utf8");
  assert.doesNotMatch(launchFlow, /initialUrl|localhost:8081|10\.0\.2\.2:8081/);
  assert.equal((launchFlow.match(/launchApp:/g) ?? []).length, 1);
  assert.equal((launchFlow.match(/clearState: true/g) ?? []).length, 1);
});

test("iOS export accepts only the add-only Photos permission action", () => {
  const exportFlow = readFileSync(join(root, "e2e/flows/f04-export.yaml"), "utf8");
  assert.match(exportFlow, /visible: \^Allow\$/);
  assert.match(exportFlow, /tapOn: \^Allow\$/);
  assert.doesNotMatch(exportFlow, /visible: Allow\s*$|tapOn: Allow\s*$/m);
});
