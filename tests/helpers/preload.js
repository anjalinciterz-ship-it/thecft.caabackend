// Imported before anything else by tests/e2e/fixtures.js. Keeping NODE_ENV here
// means the API config is read as 'test' even though dotenv has already run.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
