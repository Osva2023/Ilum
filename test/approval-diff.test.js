/**
 * test/approval-diff.test.js
 *
 * Tests for the buildDiffPreview() function in src/approval.js.
 *
 * Strategy: we use jest.unstable_mockModule() to mock child_process so that
 * no real shell commands are executed.  The tests verify that the correct
 * preview lines are generated for each command pattern.
 *
 * Run: npm test   (jest with --experimental-vm-modules)
 */

import { jest } from "@jest/globals";

// ─── mock child_process ───────────────────────────────────────────────────────
// Must be declared before the dynamic import of approval.js.

const mockExecSync = jest.fn();

await jest.unstable_mockModule("child_process", () => ({
  execSync: mockExecSync,
}));

// Now import the module under test (it will receive the mocked child_process).
const { buildDiffPreview } = await import("../src/approval.js");

// ─── helpers ──────────────────────────────────────────────────────────────────

// Strip ANSI escape codes so we can assert on plain text.
// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\x1B\[[0-9;]*m/g, "");

function lines(arr) {
  return arr.map(stripAnsi);
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("buildDiffPreview()", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  // ── rm commands ────────────────────────────────────────────────────────────

  describe("rm commands", () => {
    test("lists files that would be deleted", () => {
      mockExecSync.mockReturnValue("src/foo.js\nsrc/bar.js\n");

      const result = lines(buildDiffPreview("rm -rf src/"));

      expect(result.some((l) => l.includes("Files that would be deleted"))).toBe(true);
      expect(result.some((l) => l.includes("src/foo.js"))).toBe(true);
      expect(result.some((l) => l.includes("src/bar.js"))).toBe(true);
    });

    test("runs find with the extracted path", () => {
      mockExecSync.mockReturnValue("file.txt\n");
      buildDiffPreview("rm -f file.txt");

      const [cmd] = mockExecSync.mock.calls[0];
      expect(cmd).toMatch(/find/);
      expect(cmd).toMatch(/file\.txt/);
    });

    test("returns empty array when find returns nothing", () => {
      mockExecSync.mockReturnValue("");
      const result = buildDiffPreview("rm -rf /nonexistent");
      expect(result).toHaveLength(0);
    });

    test("returns empty array when find throws", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("command not found");
      });
      const result = buildDiffPreview("rm -rf /tmp/foo");
      expect(result).toHaveLength(0);
    });
  });

  // ── redirect to config files ───────────────────────────────────────────────

  describe("redirect to config/env files", () => {
    test("shows current content of target .env file", () => {
      mockExecSync.mockReturnValue("KEY=value\nSECRET=abc\n");

      const result = lines(buildDiffPreview("echo 'KEY=new' > .env"));

      expect(result.some((l) => l.includes("Current content of .env"))).toBe(true);
      expect(result.some((l) => l.includes("KEY=value"))).toBe(true);
      expect(result.some((l) => l.includes("SECRET=abc"))).toBe(true);
    });

    test("shows content of .json config files", () => {
      mockExecSync.mockReturnValue('{"version":"1"}\n');

      const result = lines(buildDiffPreview("cat new.json > package.json"));

      expect(result.some((l) => l.includes("Current content of package.json"))).toBe(true);
    });

    test("shows content of .yaml config files", () => {
      mockExecSync.mockReturnValue("name: app\n");
      const result = lines(buildDiffPreview("cat updated.yml > docker-compose.yml"));
      expect(result.some((l) => l.includes("Current content of docker-compose.yml"))).toBe(true);
    });

    test("returns empty array when target file does not exist (head throws)", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("No such file");
      });
      const result = buildDiffPreview("echo x > .env");
      expect(result).toHaveLength(0);
    });
  });

  // ── git reset --hard ───────────────────────────────────────────────────────

  describe("git reset --hard", () => {
    test("shows git diff --stat HEAD output when there are changes", () => {
      mockExecSync.mockReturnValue(
        "src/foo.js | 10 ++++------\n1 file changed, 4 insertions(+), 6 deletions(-)\n"
      );

      const result = lines(buildDiffPreview("git reset --hard HEAD~1"));

      expect(result.some((l) => l.includes("Changes that would be lost"))).toBe(true);
      expect(result.some((l) => l.includes("src/foo.js"))).toBe(true);
    });

    test("shows 'no uncommitted changes' message when diff is empty", () => {
      mockExecSync.mockReturnValue("");

      const result = lines(buildDiffPreview("git reset --hard"));

      expect(result.some((l) => l.includes("No uncommitted changes"))).toBe(true);
    });

    test("calls git diff --stat HEAD", () => {
      mockExecSync.mockReturnValue("some diff\n");
      buildDiffPreview("git reset --hard HEAD");

      const [cmd] = mockExecSync.mock.calls[0];
      expect(cmd).toMatch(/git diff --stat HEAD/);
    });
  });

  // ── git push --force ───────────────────────────────────────────────────────

  describe("git push --force", () => {
    test("shows recent commits at risk", () => {
      mockExecSync.mockReturnValue(
        "abc1234 add feature\ndef5678 fix bug\n"
      );

      const result = lines(buildDiffPreview("git push origin main --force"));

      expect(result.some((l) => l.includes("Recent commits at risk"))).toBe(true);
      expect(result.some((l) => l.includes("abc1234 add feature"))).toBe(true);
    });

    test("also matches -f shorthand", () => {
      mockExecSync.mockReturnValue("abc1234 initial commit\n");

      const result = lines(buildDiffPreview("git push -f origin main"));

      expect(result.some((l) => l.includes("Recent commits at risk"))).toBe(true);
    });

    test("calls git log --oneline -5", () => {
      mockExecSync.mockReturnValue("abc1234 commit\n");
      buildDiffPreview("git push --force");

      const [cmd] = mockExecSync.mock.calls[0];
      expect(cmd).toMatch(/git log --oneline -5/);
    });
  });

  // ── safe / unrecognised commands ───────────────────────────────────────────

  describe("safe / unrecognised commands", () => {
    test("returns empty array for ls", () => {
      const result = buildDiffPreview("ls -la");
      expect(result).toHaveLength(0);
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    test("returns empty array for npm install", () => {
      const result = buildDiffPreview("npm install lodash");
      expect(result).toHaveLength(0);
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    test("returns empty array for git commit", () => {
      const result = buildDiffPreview("git commit -m 'msg'");
      expect(result).toHaveLength(0);
    });

    test("always returns an array", () => {
      const result = buildDiffPreview("whatever");
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
