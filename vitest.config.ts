import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // Each setupFiles run wipes and recreates the shared disposable SQLite
    // test database, so test files must not run concurrently against it.
    fileParallelism: false,
    // Default excludes don't know about .claude/worktrees/* (git worktrees
    // for in-progress feature branches, created by this project's workflow
    // — see docs/superpowers/). Without this, running the suite from the
    // repo root also picks up whatever worktree happens to be checked out
    // there, and two suites fighting over the same test.db file produces
    // dozens of spurious failures that have nothing to do with the code
    // actually being tested.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
