const http = require("http");
const { generateVoteProof } = require("./zk");

const PORT = 8787;

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);

  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });

  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;

      if (body.length > 5_000_000) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON request."));
      }
    });

    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });

    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      service: "EthiopiaChain ZK proof API",
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/proof") {
    try {
      const input = await readJson(req);

      const requiredFields = [
        "credential",
        "electionId",
        "candidateChoice",
        "voteSalt",
        "eligibilityRoot",
        "eligibilityPathElements",
        "eligibilityPathIndices",
        "candidateRoot",
        "candidatePathElements",
        "candidatePathIndices",
        "scopeRoot",
      ];

      for (const field of requiredFields) {
        if (
          input[field] === undefined ||
          input[field] === null
        ) {
          sendJson(res, 400, {
            ok: false,
            error: `Missing field: ${field}`,
          });
          return;
        }
      }

      if (
        !Array.isArray(input.eligibilityPathElements) ||
        input.eligibilityPathElements.length !== 3
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "eligibilityPathElements must contain exactly 3 values.",
        });
        return;
      }

      if (
        !Array.isArray(input.eligibilityPathIndices) ||
        input.eligibilityPathIndices.length !== 3
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "eligibilityPathIndices must contain exactly 3 values.",
        });
        return;
      }

      if (
        !Array.isArray(input.candidatePathElements) ||
        input.candidatePathElements.length !== 3
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "candidatePathElements must contain exactly 3 values.",
        });
        return;
      }

      if (
        !Array.isArray(input.candidatePathIndices) ||
        input.candidatePathIndices.length !== 3
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "candidatePathIndices must contain exactly 3 values.",
        });
        return;
      }

      console.log(
        `Generating ZK proof for election ${input.electionId}...`
      );

      const result = await generateVoteProof(input);

      sendJson(res, 200, {
        ok: true,
        proof: result.proof,
        publicSignals: result.publicSignals,
        solidityCalldata: result.solidityCalldata,
      });

      console.log("ZK proof generated successfully.");
    } catch (error) {
      console.error("PROOF ERROR:", error);

      sendJson(res, 500, {
        ok: false,
        error:
          error?.message ||
          "Failed to generate ZK proof.",
      });
    }

    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: "Not found.",
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `EthiopiaChain ZK proof API running at http://127.0.0.1:${PORT}`
  );
});