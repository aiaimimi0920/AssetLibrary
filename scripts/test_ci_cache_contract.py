"""Download/object reuse must preserve every same-commit quality gate."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")


class CacheContractTests(unittest.TestCase):
    def test_cache_is_lock_bound_and_tests_are_unconditional(self):
        self.assertIn("hashFiles('**/pnpm-lock.yaml')", WORKFLOW)
        self.assertIn("pnpm store path --silent", WORKFLOW)
        self.assertIn("Swatinem/rust-cache@", WORKFLOW)
        self.assertIn("github.event_name == 'push' && github.ref == 'refs/heads/main'", WORKFLOW)
        self.assertNotIn("cache-hit", WORKFLOW)
        self.assertNotIn("continue-on-error", WORKFLOW)
        self.assertEqual(WORKFLOW.count("pnpm install --frozen-lockfile"), 3)

    def test_quality_release_and_database_contracts_remain(self):
        for command in ("cargo test --workspace --locked",
                        "cargo test -p assetlibrary-api --locked sitemap_postgres_gate",
                        "cargo test -p assetlibrary-api --locked search_postgres_gate",
                        "-- --ignored --nocapture", "--repeat-each=10 --retries=0",
                        "Test-CiPolicy.ps1", "jobs.quality.outputs.commit",
                        "Record same-commit quality evidence"):
            self.assertIn(command, WORKFLOW)


if __name__ == "__main__":
    unittest.main()
