const http = require("http");
const crypto = require("crypto");
require("dotenv").config();
const { Wallet, getAddress, isAddress } = require("ethers");

const PORT = Number(process.env.IDENTITY_PORT || 3001);
const FRONTEND_ORIGIN = process.env.IDENTITY_FRONTEND_ORIGIN || "http://localhost:5173";
const PROVIDER_URL = process.env.IDENTITY_PROVIDER_URL;
const PROVIDER_API_KEY = process.env.IDENTITY_PROVIDER_API_KEY;
const COMMITMENT_SECRET = process.env.IDENTITY_COMMITMENT_SECRET;
const ISSUER_PRIVATE_KEY = process.env.IDENTITY_ISSUER_PRIVATE_KEY;
const VOTING_CONTRACT_ADDRESS = process.env.IDENTITY_VOTING_CONTRACT_ADDRESS;
const CHAIN_ID = BigInt(process.env.IDENTITY_CHAIN_ID || "11155111");

const IDENTITY_TYPES = {
  IdentityAttestation: [
    { name: "electionId", type: "uint256" },
    { name: "participant", type: "address" },
    { name: "identityHash", type: "bytes32" }
  ]
};

function sendJson(res, statusCode, data, origin) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) {
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

function assertConfigured() {
  if (!PROVIDER_URL || !PROVIDER_API_KEY || !COMMITMENT_SECRET || !ISSUER_PRIVATE_KEY || !VOTING_CONTRACT_ADDRESS) {
    throw new Error("Identity verification is not configured. Set the provider, issuer, contract, and commitment-secret environment variables.");
  }
  if (Buffer.byteLength(COMMITMENT_SECRET, "utf8") < 32) {
    throw new Error("IDENTITY_COMMITMENT_SECRET must contain at least 32 bytes.");
  }
  if (!isAddress(VOTING_CONTRACT_ADDRESS)) {
    throw new Error("IDENTITY_VOTING_CONTRACT_ADDRESS is invalid.");
  }
  const providerUrl = new URL(PROVIDER_URL);
  const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(providerUrl.hostname);
  if (providerUrl.protocol !== "https:" && !(isLoopback && providerUrl.protocol === "http:")) {
    throw new Error("The identity provider URL must use HTTPS (HTTP is allowed only for loopback development).");
  }
}

function createIdentityCommitment(nationalId, electionId) {
  const normalizedId = nationalId.normalize("NFKC").trim().toUpperCase();
  const payload = `ethiopiachain-identity-v1:${electionId}:${normalizedId}`;
  return `0x${crypto.createHmac("sha256", COMMITMENT_SECRET).update(payload, "utf8").digest("hex")}`;
}

async function verifyWithProvider({ nationalId, faceVerificationToken, electionId }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(PROVIDER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PROVIDER_API_KEY}`
      },
      body: JSON.stringify({ nationalId, faceVerificationToken, electionId }),
      signal: controller.signal
    });
    if (!response.ok) return false;
    const result = await response.json();
    return result.nationalIdValid === true && result.faceMatch === true && result.livenessPassed === true;
  } finally {
    clearTimeout(timeout);
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && origin !== FRONTEND_ORIGIN) {
    sendJson(res, 403, { success: false, error: "Origin not allowed." }, "null");
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": origin || FRONTEND_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    });
    res.end();
    return;
  }

  if (req.method !== "POST" || req.url !== "/api/identity/verify") {
    sendJson(res, 404, { success: false, error: "Not found." }, origin || FRONTEND_ORIGIN);
    return;
  }

  try {
    assertConfigured();
    const input = await readJson(req);
    const nationalId = typeof input.nationalId === "string" ? input.nationalId.trim() : "";
    const faceVerificationToken = typeof input.faceVerificationToken === "string" ? input.faceVerificationToken.trim() : "";
    const electionId = typeof input.electionId === "string" ? input.electionId : String(input.electionId ?? "");

    if (!nationalId || nationalId.length > 128 || !faceVerificationToken || faceVerificationToken.length > 10_000 || !/^\d{1,78}$/.test(electionId) || BigInt(electionId) === 0n) {
      sendJson(res, 400, { success: false, error: "Missing or invalid verification information." }, origin || FRONTEND_ORIGIN);
      return;
    }
    if (typeof input.participant !== "string" || !isAddress(input.participant)) {
      sendJson(res, 400, { success: false, error: "A valid connected participant wallet is required." }, origin || FRONTEND_ORIGIN);
      return;
    }

    const identityVerified = await verifyWithProvider({ nationalId, faceVerificationToken, electionId });
    if (!identityVerified) {
      sendJson(res, 403, { success: false, error: "National ID, face match, or liveness verification failed." }, origin || FRONTEND_ORIGIN);
      return;
    }

    const identityCommitment = createIdentityCommitment(nationalId, electionId);
    const issuer = new Wallet(ISSUER_PRIVATE_KEY);
    const domain = {
      name: "EthiopiaChain ZKVoting",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: getAddress(VOTING_CONTRACT_ADDRESS)
    };
    const issuerSignature = await issuer.signTypedData(domain, IDENTITY_TYPES, {
      electionId: BigInt(electionId),
      participant: getAddress(input.participant),
      identityHash: identityCommitment
    });

    sendJson(res, 200, { success: true, identityCommitment, issuerSignature }, origin || FRONTEND_ORIGIN);
  } catch (error) {
    // Never log the request body or sensitive identity data.
    console.error("Identity verification request failed:", error.message);
    const configurationError = /not configured|must contain|is invalid|must use HTTPS/i.test(error.message);
    sendJson(res, configurationError ? 503 : 502, {
      success: false,
      error: configurationError ? error.message : "Identity verification service is unavailable."
    }, origin || FRONTEND_ORIGIN);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Identity verification API listening on http://127.0.0.1:${PORT}`);
});
