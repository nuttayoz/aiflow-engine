/** @type {import('jest').Config} */
module.exports = {
  collectCoverageFrom: [
    'apps/*/src/**/*.ts',
    'packages/*/src/**/*.ts',
    '!**/main.ts',
    '!**/index.ts',
  ],
  coverageDirectory: 'coverage',
  moduleFileExtensions: ['js', 'json', 'ts'],
  roots: ['<rootDir>/apps', '<rootDir>/packages'],
  testEnvironment: 'node',
  testMatch: ['**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.spec.json',
      },
    ],
  },
};
