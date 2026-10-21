Yes, Node.js has tools to analyze code paths and find unused functions. This is typically achieved through Static Application Security Testing (SAST) / Static Analysis tools like ESLint, or via Dead Code Elimination (Tree Shaking) bundles, and Runtime Coverage tools.
Here are the primary use cases and how to implement them:

1. Static Analysis (ESLint) — Best for Development

ESLint analyzes your source code without running it. It can instantly flag unused functions, variables, and imports as you type.
• How to use:
	1. Install ESLint: npm install eslint --save-dev
	2. Ensure the no-unused-vars rule is enabled in your eslint.config.js:
javascript
export default [
  {
    rules: {
      "no-unused-vars": ["error", { "vars": "all", "args": "after-used" }]
    }
  }
];
Use code with caution.
• Usecase: Catching dead code locally inside a single file before committing it to production.

2. Production Bundlers (Rollup / Webpack) — Best for Tree Shaking

If your Node.js application uses ES Modules (import/export), bundlers can trace the entire dependency graph (code path) from your entry point and strip out any functions that are never called.
• How to use: Use Rollup or Webpack (in production mode). They automatically perform "tree shaking."
• Usecase: Reducing the final deployment package size by removing third-party library functions or internal utility functions that your entry point never triggers.

3. Native V8 Coverage — Best for Runtime Dead Code

Sometimes code is imported but never actually executed during runtime. Node.js has a built-in V8 sampler that tracks exactly which functions and code paths are executed.
• How to use: Run your Node.js application or test suite with the coverage environment variable enabled:bash
NODE_V8_COVERAGE=dir/ node index.js
Use code with caution.
You can then use a tool like c8 to output a readable report:bash
npm install -g c8
c8 node index.js
Use code with caution.
• Usecase: Identifying "dark code"—complex business logic or legacy endpoints that are technically valid and exported, but are never actually hit by users or test suites.

Comparison of Methods


Method	Type	Catch Type	Performance Impact
ESLint	Static	Unused local functions/variables	None (Runs during dev/CI)
Rollup/Webpack	Static	Unused exported functions across files	None (Runs during build)
V8 Coverage / c8	Runtime	Code paths never executed in real life	Slight runtime overhead
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
A
B
B
B
B
B
B
B
B
B
B

