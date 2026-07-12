/** @type {import('jest').Config} */
module.exports = {
  clearMocks: true,
  testEnvironment: "node",
  testMatch: ["<rootDir>/render-tests/**/*.test.js"],
  transform: {
    "^.+\\.[jt]sx?$": ["babel-jest", { presets: ["babel-preset-expo"] }],
  },
};
