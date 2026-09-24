const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const circuits = path.join(root, "circuits");
const output = path.join(root, "build", "zk");
fs.mkdirSync(output, { recursive: true });

execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules", "circom2", "cli.js"),
    "VoteValidity.circom",
    "--r1cs",
    "--wasm",
    "--sym",
    "-l",
    path.join(root, "node_modules"),
    "--output",
    output
  ],
  { cwd: circuits, stdio: "inherit" }
);