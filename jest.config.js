/** @type {import('jest').Config} */
module.exports = {
  preset: "jest-expo",
  clearMocks: true,
  testPathIgnorePatterns: ["/node_modules/", "/render-tests/"],
};
