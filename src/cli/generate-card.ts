/**
 * CLI: render the on-disk profile.json into a fully-formed Agent Card JSON
 * document and write it to disk.
 *
 * Writes the canonical A2A v0.3 path `/.well-known/agent-card.json` and a
 * back-compat copy at `/.well-known/agent.json` so v0.2.x clients continue
 * to discover the agent.
 *
 * Usage:
 *   node dist/cli/generate-card.js [--out-dir path] [--url url] [--version v]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadProfile } from "../profile.js";
import { generateAgentCard, type GenerateAgentCardOptions } from "../generator.js";

interface CliArgs {
  outDir: string;
  url: string;
  agentVersion: string;
  profile: string | undefined;
}

/** Parse argv (after `node script.js`) into a typed args object. */
function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const args: CliArgs = {
    // A2A discovery convention: well-known directory under the canonical site.
    outDir: resolve(process.cwd(), "dist/.well-known"),
    url: "https://humancard.dev",
    agentVersion: "0.1.0",
    profile: undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--out-dir":
        if (value === undefined) throw new Error("--out-dir requires a path");
        args.outDir = resolve(process.cwd(), value);
        i++;
        break;
      case "--url":
        if (value === undefined) throw new Error("--url requires a value");
        args.url = value;
        i++;
        break;
      case "--version":
        if (value === undefined) throw new Error("--version requires a value");
        args.agentVersion = value;
        i++;
        break;
      case "--profile":
        if (value === undefined) throw new Error("--profile requires a path");
        args.profile = resolve(process.cwd(), value);
        i++;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${flag ?? "<empty>"}`);
    }
  }

  return args;
}

function printHelp(): void {
  process.stdout.write(
    [
      "humancard generate-card",
      "",
      "Options:",
      "  --out-dir <path>   Output directory (default: dist/.well-known)",
      "  --url <url>        Canonical URL of the agent (default: https://humancard.dev)",
      "  --version <ver>    Agent instance version (default: 0.1.0)",
      "  --profile <path>   Path to profile.json (default: package profile.json)",
      "  -h, --help         Show this help",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const profile = await loadProfile(args.profile);

  const options: GenerateAgentCardOptions = {
    url: args.url,
    agentVersion: args.agentVersion,
    documentationUrl: "https://humancard.dev",
  };
  const card = generateAgentCard(profile, options);

  await mkdir(args.outDir, { recursive: true });

  // Canonical (v0.3, RFC 8615) and legacy (v0.2.x) discovery paths point
  // at the same payload. Keep both in lockstep until v0.2.x is fully phased
  // out by the wider ecosystem.
  const canonical = resolve(args.outDir, "agent-card.json");
  const legacy = resolve(args.outDir, "agent.json");
  const body = `${JSON.stringify(card, null, 2)}\n`;
  await writeFile(canonical, body, "utf8");
  await writeFile(legacy, body, "utf8");

  process.stdout.write(`wrote ${canonical}\nwrote ${legacy}\n`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`generate-card: ${message}\n`);
  process.exit(1);
});
