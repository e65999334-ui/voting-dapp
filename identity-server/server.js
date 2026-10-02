import crypto from "node:crypto";
import "dotenv/config";
import cors from "cors";
import express from "express";
import multer from "multer";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  getAddress,
  isAddress
} from "ethers";

const app = express();
const PORT = Number(process.env.IDENTITY_PORT || 3001);
const FRONTEND_ORIGIN = process.env.IDENTITY_FRONTEND_ORIGIN || "http://localhost:5173";
const SESSION_TTL_MS = 15 * 60 * 1000;
const RESERVATION_TTL_MS = 5 * 60 * 1000;
const MAX_REQUESTS_PER_IP_PER_MINUTE = 20;

const verificationSessions = new Map();
const pendingCommitments = new Map();
const requestLimits = new Map();

const DOMAIN = {
  name: "EthiopiaChain ZKVoting",
  version: "1"
};
const IDENTITY_TYPES = {
  IdentityAttestation: [
    { name: "electionId", type: "uint256" },
    { name: "participant", type: "address" },
    { name: "identityHash", type: "bytes32" }
  ]
};

app.disable("x-powered-by");
app.use(cors({ origin: FRONTEND_ORIGIN, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type"] }));
app.use(express.json({ limit: "20kb" }));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

function secretValue(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function parseElectionId(value) {
  const electionId = String(value ?? "");
  if (!/^\d{1,78}$/.test(electionId) || BigInt(electionId) === 0n) {
    throw Object.assign(new Error("A valid election ID is required."), { status: 400 });
  }
  return electionId;
}

function checkRateLimit(req) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const current = requestLimits.get(ip);
  if (!current || current.resetAt <= now) {
    requestLimits.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  current.count += 1;
  return current.count <= MAX_REQUESTS_PER_IP_PER_MINUTE;
}

function createIdentityCommitment(providerSubjectId, electionId) {
  const stableSubject = providerSubjectId.normalize("NFKC").trim();
  const payload = `ethiopiachain-identity-v1:${electionId}:${stableSubject}`;
  return `0x${crypto.createHmac("sha256", secretValue("IDENTITY_COMMITMENT_SECRET")).update(payload, "utf8").digest("hex")}`;
}

function providerUrl(name) {
  const url = new URL(secretValue(name));
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS.`);
  }
  return url;
}

async function providerRequest(endpoint, body) {
  const apiKey = secretValue("IDENTITY_PROVIDER_API_KEY");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function isRegisteredOnChain(electionId, identityCommitment) {
  const rpcUrl = secretValue("IDENTITY_RPC_URL");
  const votingAddress = secretValue("IDENTITY_VOTING_CONTRACT_ADDRESS");
  const configuredChainId = BigInt(secretValue("IDENTITY_CHAIN_ID"));
  if (!isAddress(votingAddress)) throw new Error("IDENTITY_VOTING_CONTRACT_ADDRESS is invalid.");

  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== configuredChainId) {
    throw new Error("IDENTITY_RPC_URL chain does not match IDENTITY_CHAIN_ID.");
  }
  const voting = new Contract(
    getAddress(votingAddress),
    ["function identityRegistered(uint256,bytes32) view returns (bool)"],
    provider
  );
  return voting.identityRegistered(BigInt(electionId), identityCommitment);
}

async function createIssuerAttestation({ electionId, participant, identityCommitment }) {
  const chainId = BigInt(secretValue("IDENTITY_CHAIN_ID"));
  const votingAddress = getAddress(secretValue("IDENTITY_VOTING_CONTRACT_ADDRESS"));
  const issuer = new Wallet(secretValue("IDENTITY_ISSUER_PRIVATE_KEY"));
  const configuredIssuer = getAddress(secretValue("IDENTITY_ISSUER_ADDRESS"));
  if (issuer.address !== configuredIssuer) {
    throw new Error("IDENTITY_ISSUER_PRIVATE_KEY does not match IDENTITY_ISSUER_ADDRESS.");
  }

  return issuer.signTypedData(
    { ...DOMAIN, chainId, verifyingContract: votingAddress },
    IDENTITY_TYPES,
    { electionId: BigInt(electionId), participant: getAddress(participant), identityHash: identityCommitment }
  );
}

function sendFailure(res, error) {
  const status = error.status || 503;
  const safeMessage = error.status ? error.message : "Identity verification service is unavailable or not configured.";
  // Do not log request bodies, document data, provider references, or biometric data.
  console.error("Identity service error:", error.message);
  return res.status(status).json({ success: false, error: safeMessage });
}

app.get("/api/health", (_req, res) => {
  const configured = Boolean(
    process.env.IDENTITY_PROVIDER_SESSION_URL &&
    process.env.IDENTITY_PROVIDER_RESULT_URL &&
    process.env.IDENTITY_PROVIDER_API_KEY
  );
  res.json({ ok: true, service: "EthiopiaChain identity verification API", identityProviderConfigured: configured });
});

/*
 * Create a provider-hosted session. The app sends only the selected document
 * type, election, and participant wallet; document images and biometric data
 * are captured and assessed on the authorized provider's hosted experience.
 *
 * Provider session endpoint adapter contract:
 * request: { clientReference, documentType, returnUrl }
 * response: { sessionId, verificationUrl }
 */
app.post("/api/identity/start", upload.single("document"), async (req, res) => {
  try {
    if (!checkRateLimit(req)) {
      return res.status(429).json({ success: false, error: "Too many verification attempts. Try again later." });
    }

    const documentType = req.body?.documentType;
    const electionId = parseElectionId(req.body?.electionId ?? req.body?.pollId);
    const participant = req.body?.participant;
    if (!req.file) {
      return res.status(400).json({ success: false, error: "Please upload your identification document." });
    }
    const allowedMimeTypes = new Set([
      "image/jpeg",
      "image/png",
      "image/heic",
      "image/heif",
      "image/webp",
      "application/pdf"
    ]);
    if (!allowedMimeTypes.has(req.file.mimetype)) {
      return res.status(400).json({ success: false, error: "Unsupported document format." });
    }
    if (!["national_id", "passport", "kebele_id"].includes(documentType)) {
      return res.status(400).json({ success: false, error: "Choose a National ID, passport, or Kebele ID." });
    }
    if (typeof participant !== "string" || !isAddress(participant)) {
      return res.status(400).json({ success: false, error: "A valid participant wallet is required." });
    }

    const providerSessionEndpoint = providerUrl("IDENTITY_PROVIDER_SESSION_URL");
    const clientReference = crypto.randomBytes(32).toString("hex");
    const response = await providerRequest(providerSessionEndpoint, {
      clientReference,
      documentType,
      returnUrl: process.env.IDENTITY_PROVIDER_RETURN_URL || FRONTEND_ORIGIN
    });
    if (!response.ok) {
      throw new Error("Identity provider could not create a verification session.");
    }

    const providerSession = await response.json();
    if (typeof providerSession.sessionId !== "string" || !providerSession.sessionId || typeof providerSession.verificationUrl !== "string") {
      throw new Error("Identity provider returned an invalid verification session.");
    }
    const verificationUrl = new URL(providerSession.verificationUrl);
    if (verificationUrl.protocol !== "https:") {
      throw new Error("Identity provider returned a non-HTTPS verification URL.");
    }

    const sessionId = crypto.randomBytes(32).toString("hex");
    verificationSessions.set(sessionId, {
      providerSessionId: providerSession.sessionId,
      clientReference,
      electionId,
      participant: getAddress(participant),
      documentType,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
      completedResult: null
    });

    return res.json({ success: true, sessionId, verificationUrl: verificationUrl.toString(), expiresInSeconds: SESSION_TTL_MS / 1000 });
  } catch (error) {
    return sendFailure(res, error);
  }
});

/*
 * Complete provider-hosted verification. The browser submits only the
 * provider's opaque verification reference. Verification flags and the
 * stable subject identifier are read server-to-server from the provider;
 * no browser-supplied pass/fail booleans are trusted.
 *
 * Provider result endpoint response contract:
 * { status, documentType, documentDetected, documentReadable,
 *   documentComplete, documentVerified, livenessPassed, faceMatch, subjectId }
 */
app.post("/api/identity/complete", async (req, res) => {
  try {
    const { sessionId, verificationReference } = req.body || {};
    const session = verificationSessions.get(String(sessionId || ""));
    if (!session || session.expiresAt <= Date.now()) {
      if (sessionId) verificationSessions.delete(String(sessionId));
      return res.status(401).json({ success: false, error: "Verification session expired. Start again with the identity provider." });
    }
    if (session.completedResult) {
      return res.json(session.completedResult);
    }
    if (typeof verificationReference !== "string" || verificationReference.length < 8 || verificationReference.length > 2048) {
      return res.status(400).json({ success: false, error: "Enter the verification reference from the identity provider." });
    }

    const providerResultEndpoint = providerUrl("IDENTITY_PROVIDER_RESULT_URL");
    const response = await providerRequest(providerResultEndpoint, {
      verificationReference,
      providerSessionId: session.providerSessionId,
      clientReference: session.clientReference
    });
    if (!response.ok) {
      return res.status(403).json({ success: false, error: "The identity provider has not verified this session." });
    }

    const result = await response.json();
    const verified = result.status === "verified" &&
      result.documentType === session.documentType &&
      result.documentDetected === true &&
      result.documentReadable === true &&
      result.documentComplete === true &&
      result.documentVerified === true &&
      result.livenessPassed === true &&
      result.faceMatch === true &&
      typeof result.subjectId === "string" && result.subjectId.length > 0;
    if (!verified) {
      return res.status(403).json({ success: false, error: "Document, liveness, or face-match verification failed with the identity provider." });
    }

    const identityCommitment = createIdentityCommitment(result.subjectId, session.electionId);
    const registrationKey = `${session.electionId}:${identityCommitment}`;
    const pending = pendingCommitments.get(registrationKey);
    if (pending && pending.expiresAt > Date.now() && pending.sessionId !== sessionId) {
      return res.status(409).json({ success: false, error: "This person is already completing registration for this election." });
    }
    if (await isRegisteredOnChain(session.electionId, identityCommitment)) {
      verificationSessions.delete(String(sessionId));
      return res.status(409).json({ success: false, error: "This person is already registered for this election." });
    }

    const issuerSignature = await createIssuerAttestation({
      electionId: session.electionId,
      participant: session.participant,
      identityCommitment
    });
    const completion = {
      success: true,
      verified: true,
      documentType: session.documentType,
      verificationReference,
      identityCommitment,
      issuerSignature
    };
    session.completedResult = completion;
    pendingCommitments.set(registrationKey, {
      sessionId: String(sessionId),
      expiresAt: Date.now() + RESERVATION_TTL_MS
    });

    return res.json(completion);
  } catch (error) {
    return sendFailure(res, error);
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of verificationSessions) if (session.expiresAt <= now) verificationSessions.delete(id);
  for (const [key, reservation] of pendingCommitments) if (reservation.expiresAt <= now) pendingCommitments.delete(key);
  for (const [ip, rate] of requestLimits) if (rate.resetAt <= now) requestLimits.delete(ip);
}, 60_000).unref();

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Identity verification server running on http://localhost:${PORT}`);
  console.log("Document and biometric verification are delegated to the configured authorized identity provider.");
});
