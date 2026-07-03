const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    ignores: ["dist/*", "coverage/*", "ios/*", "android/*"],
  },
]);
