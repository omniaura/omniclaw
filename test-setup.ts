/**
 * Test setup file
 * This runs before all tests to set up the environment
 */

// Force ASSISTANT_NAME to 'Andy' for consistent test behavior
// Tests expect this value regardless of the host environment
process.env.ASSISTANT_NAME = 'Andy';
