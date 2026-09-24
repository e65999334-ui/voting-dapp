const fs = require("fs");
const path = require("path");
const { generateVoteProof } = require("../backend/zk");

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error("Usage: node scripts/generate-proof.js path\\to\\input.json");
  }

  const absolutePath = path.resolve(process.cwd(), inputPath);
  const input = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  const result = await generateVoteProof(input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, () => {
    // snarkjs can leave a WASM worker handle open after proving. Exit only
    // after stdout is flushed so this CLI behaves predictably on Windows.
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});