import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(resolve(root, ".github/workflows/e2e.yml"), "utf8");

function jobBlock(name) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `Missing ${name} job`);

  const end = lines.findIndex((line, index) => index > start && /^  [a-z0-9-]+:\s*$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

test("iOS CI gives build and acceptance separate budgets with a permission-safe handoff", () => {
  const build = jobBlock("ios-build");
  const acceptance = jobBlock("ios-maestro");

  assert.match(build, /timeout-minutes: 40/);
  assert.match(
    build,
    /- name: Build iOS development app[\s\S]*?timeout-minutes: 30[\s\S]*?node scripts\/e2e\/run\.mjs ios --phase build/,
  );
  assert.match(
    build,
    /tar -czf .*ios-development-build\.tar\.gz"?\s+-C ios\/build\/Build\/Products\/Debug-iphonesimulator PlogKit\.app/,
  );
  assert.match(build, /uses: actions\/upload-artifact@v4/);
  assert.match(build, /name: ios-development-build/);
  assert.match(
    build,
    /- name: Upload build failure artifacts[\s\S]*?if: failure\(\) \|\| cancelled\(\)[\s\S]*?ios-build-artifacts/,
  );

  assert.match(acceptance, /needs: ios-build/);
  assert.match(acceptance, /timeout-minutes: 60/);
  assert.match(acceptance, /uses: actions\/download-artifact@v4/);
  assert.match(acceptance, /name: ios-development-build/);
  assert.match(
    acceptance,
    /tar -xzf .*ios-development-build\.tar\.gz"? -C ios\/build\/Build\/Products\/Debug-iphonesimulator/,
  );
  assert.match(
    acceptance,
    /- name: Run iOS Maestro flows[\s\S]*?timeout-minutes: 50[\s\S]*?node scripts\/e2e\/run\.mjs ios --phase test/,
  );
  assert.match(
    acceptance,
    /- name: Upload failure artifacts[\s\S]*?if: failure\(\) \|\| cancelled\(\)[\s\S]*?ios-maestro-artifacts/,
  );
  assert.doesNotMatch(acceptance, /node scripts\/e2e\/run\.mjs ios --phase build/);
});

test("Android CI budgets hosted cores and SwiftShader pixels before device readiness", () => {
  const acceptance = jobBlock("android-maestro");

  assert.match(acceptance, /profile: pixel_7\n/);
  assert.doesNotMatch(acceptance, /profile: pixel_7_pro/);
  assert.match(acceptance, /cores: 4/);
  assert.match(acceptance, /emulator-options: .* -gpu swiftshader_indirect /);
  assert.match(
    acceptance,
    /script: node scripts\/e2e\/run\.mjs android --phase test --device "\$ANDROID_SERIAL"/,
  );
});
