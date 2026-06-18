'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/data_transfer_v2/',
    '/archived/'
  ],
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/data_transfer_v2/',
    '/archived/',
    '/tests/'
  ],
  collectCoverageFrom: [
    'services/**/*.js',
    'utils/encryptionService.js'
  ],
  clearMocks: true,
  // Suppress production console output during tests (errors/warnings still surface
  // as test failures via thrown errors; silence just removes the noise).
  silent: true,
  // Prevent Jest from picking up the vendored echarts jest config
  projects: undefined,
  rootDir: '.',
  roots: ['<rootDir>/tests']
};
