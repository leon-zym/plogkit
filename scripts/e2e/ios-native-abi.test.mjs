import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertIosExpoModulesCoreAbi } from "./ios-native-abi.mjs";

const compatibleSymbol =
  "_$s15ExpoModulesCore9AnyModuleP09_decorateE06object2iny0aB3JSI16JavaScriptObjectV_AG0jK7RuntimeCtKF";

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function createAppFixture({
  architectures = "arm64",
  exportedSymbols,
  appImports = [],
  supportImports = null,
}) {
  const root = mkdtempSync(join(tmpdir(), "plogkit-ios-abi-"));
  const app = join(root, "PlogKit.app");
  const appBinary = join(app, "PlogKit");
  const frameworks = join(app, "Frameworks");
  const coreBinary = join(frameworks, "ExpoModulesCore.framework", "ExpoModulesCore");
  const mediaBinary = join(frameworks, "ExpoMediaLibrary.framework", "ExpoMediaLibrary");
  const otherBinary = join(frameworks, "ExpoFileSystem.framework", "ExpoFileSystem");
  const supportBinary = join(frameworks, "SupportKit.framework", "SupportKit");
  const bin = join(root, "bin");
  mkdirSync(join(coreBinary, ".."), { recursive: true });
  mkdirSync(join(mediaBinary, ".."), { recursive: true });
  mkdirSync(join(otherBinary, ".."), { recursive: true });
  mkdirSync(bin);
  for (const binary of [appBinary, coreBinary, mediaBinary, otherBinary]) {
    writeFileSync(binary, "binary");
  }
  if (supportImports !== null) {
    mkdirSync(join(supportBinary, ".."), { recursive: true });
    writeFileSync(supportBinary, "binary");
  }
  const supportCases =
    supportImports === null
      ? ""
      : `  "lipo -archs ${supportBinary}")
    printf '%s\\n' '${architectures}'
    ;;
  "nm -arch arm64 -u ${supportBinary}")
    printf '%s\\n' ${supportImports.map((symbol) => `'                 U ${symbol}'`).join(" ")}
    ;;
`;
  writeExecutable(
    join(bin, "xcrun"),
    `#!/bin/sh
case "$*" in
  "lipo -archs ${appBinary}")
    printf '%s\\n' arm64
    ;;
  "lipo -archs ${coreBinary}"|"lipo -archs ${mediaBinary}"|"lipo -archs ${otherBinary}")
    printf '%s\\n' '${architectures}'
    ;;
  "nm -arch arm64 -gU ${coreBinary}")
    printf '%s\\n' ${exportedSymbols.map((symbol) => `'0000000000001000 T ${symbol}'`).join(" ")}
    ;;
  "nm -arch arm64 -u ${mediaBinary}")
    printf '%s\\n' '                 U ${compatibleSymbol}' '                 U _$s10Foundation3URLVMa'
    ;;
  "nm -arch arm64 -u ${otherBinary}")
    printf '%s\\n' '                 U _$s10Foundation4DataVMa'
    ;;
  "nm -arch arm64 -u ${appBinary}")
    printf '%s\\n' ${appImports.map((symbol) => `'                 U ${symbol}'`).join(" ")}
    ;;
${supportCases}
  *) exit 65 ;;
esac
`,
  );
  return { app, bin };
}

test("iOS Release rejects an Expo framework whose ExpoModulesCore symbol is missing", () => {
  const fixture = createAppFixture({ exportedSymbols: [] });
  const previousPath = process.env.PATH;
  process.env.PATH = `${fixture.bin}:${previousPath}`;
  try {
    assert.throws(
      () => assertIosExpoModulesCoreAbi(fixture.app),
      /ExpoMediaLibrary.*missing.*AnyModule.*decorateE0/s,
    );
  } finally {
    process.env.PATH = previousPath;
  }
});

test("iOS Release rejects a PlogKit executable whose ExpoModulesCore symbol is missing", () => {
  const missingSymbol = `${compatibleSymbol}MissingFromApp`;
  const fixture = createAppFixture({
    appImports: [missingSymbol],
    exportedSymbols: [compatibleSymbol],
  });
  const previousPath = process.env.PATH;
  process.env.PATH = `${fixture.bin}:${previousPath}`;
  try {
    assert.throws(
      () => assertIosExpoModulesCoreAbi(fixture.app),
      /PlogKit.*missing.*MissingFromApp/s,
    );
  } finally {
    process.env.PATH = previousPath;
  }
});

test("iOS Release rejects a non-Expo framework whose ExpoModulesCore symbol is missing", () => {
  const missingSymbol = `${compatibleSymbol}MissingFromSupportKit`;
  const fixture = createAppFixture({
    exportedSymbols: [compatibleSymbol],
    supportImports: [missingSymbol],
  });
  const previousPath = process.env.PATH;
  process.env.PATH = `${fixture.bin}:${previousPath}`;
  try {
    assert.throws(
      () => assertIosExpoModulesCoreAbi(fixture.app),
      /SupportKit.*missing.*MissingFromSupportKit/s,
    );
  } finally {
    process.env.PATH = previousPath;
  }
});

test("iOS Release accepts Expo frameworks resolved by the embedded ExpoModulesCore", () => {
  const fixture = createAppFixture({ exportedSymbols: [compatibleSymbol] });
  const previousPath = process.env.PATH;
  process.env.PATH = `${fixture.bin}:${previousPath}`;
  try {
    assert.deepEqual(assertIosExpoModulesCoreAbi(fixture.app), {
      consumers: 1,
      requiredSymbols: 1,
    });
  } finally {
    process.env.PATH = previousPath;
  }
});

test("iOS Release accepts a PlogKit executable resolved by the embedded ExpoModulesCore", () => {
  const fixture = createAppFixture({
    appImports: [compatibleSymbol],
    exportedSymbols: [compatibleSymbol],
  });
  const previousPath = process.env.PATH;
  process.env.PATH = `${fixture.bin}:${previousPath}`;
  try {
    assert.deepEqual(assertIosExpoModulesCoreAbi(fixture.app), {
      consumers: 2,
      requiredSymbols: 2,
    });
  } finally {
    process.env.PATH = previousPath;
  }
});

test("iOS Release rejects a framework outside the arm64-only simulator contract", () => {
  const fixture = createAppFixture({
    architectures: "x86_64 arm64",
    exportedSymbols: [compatibleSymbol],
  });
  const previousPath = process.env.PATH;
  process.env.PATH = `${fixture.bin}:${previousPath}`;
  try {
    assert.throws(
      () => assertIosExpoModulesCoreAbi(fixture.app),
      /ExpoModulesCore.*must contain only arm64/s,
    );
  } finally {
    process.env.PATH = previousPath;
  }
});

test("iOS Release fails closed when an Expo framework executable cannot be inspected", () => {
  const fixture = createAppFixture({ exportedSymbols: [compatibleSymbol] });
  mkdirSync(join(fixture.app, "Frameworks", "ExpoBroken.framework"));
  const previousPath = process.env.PATH;
  process.env.PATH = `${fixture.bin}:${previousPath}`;
  try {
    assert.throws(
      () => assertIosExpoModulesCoreAbi(fixture.app),
      /ExpoBroken\.framework.*executable cannot be inspected/s,
    );
  } finally {
    process.env.PATH = previousPath;
  }
});
