module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/src/test/**/*.test.ts'],
  // Ignore long-running integration tests during regular unit runs
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/src/test/.*integration.*\\.test\\.ts$'],
  // Map the `vscode` import to the test-local lightweight mock so tests don't import the real vscode API
  moduleNameMapper: {
    '^vscode$': '<rootDir>/src/test/__mocks__/vscode.js'
  },
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.json'
    }
  }
};
