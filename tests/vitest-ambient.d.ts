// Fork-only. vitest 2's `vitest/globals` types pulled Node's types and the
// ES2022 lib into every file tsconfig includes; vitest 4's do not. The tests
// rely on both (`process`, `node:fs`, `__dirname`, `Array.prototype.at`), so
// they are referenced here instead of editing upstream's tsconfig.json, which
// keeps the fork's auto-rebase off that file.
/// <reference types="node" />
/// <reference lib="es2022" />
