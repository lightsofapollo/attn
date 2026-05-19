/**
 * Conformance corpus replay — TS/Miniflare side.
 *
 * Loads `cases.json` and runs every scenario against the Worker via
 * `SELF.fetch`. The corpus is the source of truth for both this runner
 * and the Rust replay landing in attn-nnj.6.7; any regression here is
 * a wire-format regression in the relay.
 *
 * See `README.md` for the corpus schema and contribution guide.
 */

import { describe, it } from "vitest";

import corpusJson from "./cases.json" with { type: "json" };
import { runScenario, type Corpus, type Scenario } from "./runner";

const corpus = corpusJson as Corpus;

describe("relay conformance corpus", () => {
  if (corpus.version !== 1) {
    throw new Error(
      `cases.json version=${corpus.version} is not understood by this runner (expected 1)`,
    );
  }

  if (corpus.scenarios.length === 0) {
    throw new Error("cases.json contains zero scenarios; nothing to run");
  }

  for (const scenario of corpus.scenarios as Scenario[]) {
    const label = `${scenario.id} — ${scenario.name}`;
    it(label, async () => {
      await runScenario(scenario);
    });
  }
});
