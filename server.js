const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { BrevoClient } = require("@getbrevo/brevo");

dotenv.config();

/* =========================================================
   EXPRESS
   ========================================================= */

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;


/* =========================================================
   NETWORK
   ========================================================= */

const POLYGON_CHAIN_ID = 137n;

const POLYGON_RPC =
  process.env.POLYGON_RPC ||
  "https://polygon-rpc.com";


/* =========================================================
   CONTRACTS / WALLETS
   ========================================================= */

const USDC_ADDRESS =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const MERCHANT_WALLET =
  process.env.MERCHANT_WALLET ||
  "0x9e63CDc3D66714f0FCe5B3347139E117a04A75b3";


/* =========================================================
   PROVIDER
   ========================================================= */

const provider =
  new ethers.JsonRpcProvider(POLYGON_RPC);


/* =========================================================
   ABIs
   ========================================================= */

const ERC20_ABI = [
  "function transfer(address to, uint256 value) returns (bool)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function symbol() view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];


/* =========================================================
   USDC CONTRACT (For Direct Web3 Route)
   ========================================================= */

const usdcContract =
  new ethers.Contract(
    USDC_ADDRESS,
    ERC20_ABI,
    provider
  );


/* =========================================================
   BASIC VALIDATION
   ========================================================= */

function isValidEmail(email) {
  return (
    typeof email === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

function isValidAddress(address) {
  return (
    typeof address === "string" &&
    ethers.isAddress(address)
  );
}

function normalizeAddress(address) {
  return ethers.getAddress(address);
}


/* =========================================================
   NOWPAYMENTS SIGNATURE VERIFICATION
   ========================================================= */

function verifyNowPaymentsSignature(req) {
  const receivedSig = req.headers["x-nowpayments-sig"];
  const ipnsSecret = process.env.NOWPAYMENTS_IPN_SECRET;

  if (!receivedSig || !ipnsSecret) {
    return false;
  }

  function sortObject(obj) {
    if (obj === null || typeof obj !== "object") {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(sortObject);
    }
    return Object.keys(obj)
      .sort()
      .reduce((sorted, key) => {
        sorted[key] = sortObject(obj[key]);
        return sorted;
      }, {});
  }

  const sortedPayload = sortObject(req.body);
  const hmac = crypto.createHmac("sha512", ipnsSecret);
  hmac.update(JSON.stringify(sortedPayload));
  const calculatedSig = hmac.digest("hex");

  return calculatedSig === receivedSig;
}


/* =========================================================
   REQUIRED ENVIRONMENT VARIABLES (Direct Web3)
   ========================================================= */

function checkEnvironment() {
  const required = [
    "STMP_B3",
    "STMP_PZZC",
    "BREVO_API_KEY",
    "SENDER_EMAIL",
    "SELLER_EMAIL"
  ];

  const missing =
    required.filter(
      key => !process.env[key]
    );

  if (missing.length > 0) {
    throw new Error(
      `Missing Render environment variables: ${missing.join(", ")}`
    );
  }
}


/* =========================================================
   DISTRIBUTION WALLET
   ========================================================= */

function getDistributionWallet() {
  if (!process.env.STMP_B3) {
    throw new Error(
      "STMP_B3 private key is missing."
    );
  }

  return new ethers.Wallet(
    process.env.STMP_B3,
    provider
  );
}


/* =========================================================
   BREVO
   ========================================================= */

function getBrevoClient() {
  if (!process.env.BREVO_API_KEY) {
    throw new Error(
      "BREVO_API_KEY is missing."
    );
  }

  return new BrevoClient({
    apiKey: process.env.BREVO_API_KEY,
    timeoutInSeconds: 30,
    maxRetries: 3
  });
}


/* =========================================================
   IN-MEMORY ORDER LOCK
   ========================================================= */

const processedOrders = new Map();


/* =========================================================
   HEALTH CHECK
   ========================================================= */

app.get(
  "/api/health",
  async (req, res) => {
    try {
      const network = await provider.getNetwork();

      res.status(200).json({
        success: true,
        service: "pizza-backend",
        network: "polygon",
        chainId: network.chainId.toString(),
        routes: [
          "/api/verify-usdc-order",
          "/api/nowpayments-ipn"
        ]
      });
    } catch (error) {
      console.error("Health check error:", error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);


/* =========================================================
   ROOT
   ========================================================= */

app.get(
  "/",
  (req, res) => {
    res.status(200).send(
      "Pizza Coin Backend (Dual Mode) is running successfully!"
    );
  }
);


/* =========================================================
   ROUTE 1: DIRECT WEB3 USDC ORDER (/api/verify-usdc-order)
   ========================================================= */

app.post(
  "/api/verify-usdc-order",
  async (req, res) => {
    let txHash = null;

    try {
      console.log("==================================================");
      console.log("VERIFY USDC ORDER REQUEST (DIRECT WEB3)");
      console.log("==================================================");

      checkEnvironment();

      const {
        email,
        polygonAddress,
        pzzcAmount,
        paymentCrypto,
        txHash: submittedTxHash
      } = req.body;

      txHash = submittedTxHash;

      if (!isValidEmail(email)) {
        return res.status(400).json({ success: false, error: "Invalid buyer email address." });
      }
      if (!isValidAddress(polygonAddress)) {
        return res.status(400).json({ success: false, error: "Invalid Polygon receive address." });
      }

      const requestedPzzc = String(pzzcAmount);
      let numericPzzc = Number(requestedPzzc);

      if (!Number.isFinite(numericPzzc) || numericPzzc <= 0) {
        return res.status(400).json({ success: false, error: "PZZC amount must be greater than zero." });
      }

      if (paymentCrypto && paymentCrypto !== "USDC") {
        return res.status(400).json({ success: false, error: "Only USDC payments are currently supported." });
      }

      if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        return res.status(400).json({ success: false, error: "Invalid Polygon transaction hash." });
      }

      const buyerAddress = normalizeAddress(polygonAddress);
      const merchantAddress = normalizeAddress(MERCHANT_WALLET);

      // Duplicate Check
      const existingOrder = processedOrders.get(txHash);
      if (existingOrder) {
        return res.status(200).json({
          success: existingOrder.success,
          message: "This transaction has already been processed.",
          paymentTxHash: txHash,
          pzzcTxHash: existingOrder.pzzcTxHash || null
        });
      }

      const network = await provider.getNetwork();
      if (network.chainId !== POLYGON_CHAIN_ID) {
        throw new Error(`RPC is not connected to Polygon. Chain ID: ${network.chainId}`);
      }

      const transaction = await provider.getTransaction(txHash);
      if (!transaction || !transaction.to) {
        return res.status(400).json({ success: false, error: "Payment transaction was not found." });
      }

      if (normalizeAddress(transaction.to).toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
        return res.status(400).json({ success: false, error: "Transaction was not sent to USDC contract." });
      }

      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 1) {
        return res.status(400).json({ success: false, error: "Payment transaction failed on Polygon." });
      }

      // Parse USDC logs
      const usdcInterface = new ethers.Interface(ERC20_ABI);
      let verifiedPayment = null;

      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== USDC_ADDRESS.toLowerCase()) continue;
        try {
          const parsed = usdcInterface.parseLog({ topics: log.topics, data: log.data });
          if (!parsed || parsed.name !== "Transfer") continue;

          const from = normalizeAddress(parsed.args[0]);
          const to = normalizeAddress(parsed.args[1]);
          const value = parsed.args[2];

          if (to.toLowerCase() === merchantAddress.toLowerCase()) {
            verifiedPayment = { from, to, value };
            break;
          }
        } catch {
          continue;
        }
      }

      if (!verifiedPayment) {
        return res.status(400).json({ success: false, error: "No USDC transfer to merchant wallet found." });
      }

      const usdcDecimals = await usdcContract.decimals();
      const paidUsdc = ethers.formatUnits(verifiedPayment.value, usdcDecimals);
      const requestedPzzcUnits = ethers.parseUnits(requestedPzzc, usdcDecimals);

      if (verifiedPayment.value < requestedPzzcUnits) {
        return res.status(400).json({ success: false, error: `Insufficient USDC payment.` });
      }

      // Transfer PZZC
      const distributionWallet = getDistributionWallet();
      if (distributionWallet.address.toLowerCase() !== merchantAddress.toLowerCase()) {
        throw new Error(`STMP_B3 wallet does not match MERCHANT_WALLET.`);
      }

      const pzzcContract = new ethers.Contract(process.env.STMP_PZZC, ERC20_ABI, distributionWallet);
      const pzzcDecimals = await pzzcContract.decimals();
      const pzzcSymbol = await pzzcContract.symbol();
      const pzzcUnits = ethers.parseUnits(requestedPzzc, pzzcDecimals);

      const distributorBalance = await pzzcContract.balanceOf(distributionWallet.address);
      if (distributorBalance < pzzcUnits) {
        throw new Error(`Insufficient PZZC balance.`);
      }

      const pzzcTransferTx = await pzzcContract.transfer(buyerAddress, pzzcUnits);
      const pzzcReceipt = await pzzcTransferTx.wait();
      if (!pzzcReceipt || pzzcReceipt.status !== 1) {
        throw new Error("PZZC transfer failed.");
      }

      // Send Emails via Brevo
      const brevo = getBrevoClient();

      await brevo.transactionalEmails.sendTransacEmail({
        subject: "🍕 Your Pizza Coin Order Confirmation",
        htmlContent: `<p>Paid ${paidUsdc} USDC. Sent ${requestedPzzc} ${pzzcSymbol}. Tx: ${pzzcTransferTx.hash}</p>`,
        sender: { name: "Pizza Coin", email: process.env.SENDER_EMAIL },
        to: [{ email }]
      });

      await brevo.transactionalEmails.sendTransacEmail({
        subject: "🍕 New Pizza Coin Order",
        htmlContent: `<p>New order from ${email}. Paid ${paidUsdc} USDC.</p>`,
        sender: { name: "Pizza Coin", email: process.env.SENDER_EMAIL },
        to: [{ email: process.env.SELLER_EMAIL }]
      });

      processedOrders.set(txHash, { success: true, pzzcTxHash: pzzcTransferTx.hash });

      return res.status(200).json({
        success: true,
        message: "Order processed successfully.",
        paymentTxHash: txHash,
        pzzcTxHash: pzzcTransferTx.hash
      });

    } catch (error) {
      console.error("Direct Web3 Order Error:", error);
      return res.status(500).json({ success: false, error: error.message || "Order processing failed." });
    }
  }
);


/* =========================================================
   ROUTE 2: NOWPAYMENTS WEBHOOK IPN (/api/nowpayments-ipn)
   ========================================================= */

app.post(
  "/api/nowpayments-ipn",
  async (req, res) => {
    let paymentId = null;

    try {
      console.log("==================================================");
      console.log("NOWPAYMENTS IPN WEBHOOK RECEIVED");
      console.log("==================================================");

      if (!process.env.NOWPAYMENTS_IPN_SECRET) {
        throw new Error("NOWPAYMENTS_IPN_SECRET is missing from environment.");
      }

      if (!verifyNowPaymentsSignature(req)) {
        console.warn("Invalid NOWPayments IPN signature.");
        return res.status(400).json({ success: false, error: "Invalid signature." });
      }

      const ipnData = req.body;
      paymentId = ipnData.payment_id;
      const paymentStatus = ipnData.payment_status;
      const priceAmount = ipnData.price_amount;
      const orderDescription = ipnData.order_description || "";
      const payCurrency = ipnData.pay_currency || "crypto";

      if (paymentStatus !== "finished" && paymentStatus !== "confirmed") {
        return res.status(200).json({ success: true, message: "IPN received, waiting for finish." });
      }

      let buyerPolygonAddress = null;
      let buyerEmail = null;

      try {
        const walletMatch = orderDescription.match(/Wallet:\s*(0x[a-fA-F0-9]{40})/);
        const emailMatch = orderDescription.match(/Email:\s*([^\s|]+)/);
        if (walletMatch) buyerPolygonAddress = walletMatch[1];
        if (emailMatch) buyerEmail = emailMatch[1];
      } catch (err) {
        console.error("Metadata parse error:", err);
      }

      if (!isValidAddress(buyerPolygonAddress) || !isValidEmail(buyerEmail)) {
        return res.status(400).json({ success: false, error: "Invalid metadata payload." });
      }

      const requestedPzzc = String(priceAmount);

      const existingOrder = processedOrders.get(String(paymentId));
      if (existingOrder) {
        return res.status(200).json({ success: true, message: "Payment already processed." });
      }

      const distributionWallet = getDistributionWallet();
      const buyerAddress = normalizeAddress(buyerPolygonAddress);

      const pzzcContract = new ethers.Contract(process.env.STMP_PZZC, ERC20_ABI, distributionWallet);
      const pzzcDecimals = await pzzcContract.decimals();
      const pzzcSymbol = await pzzcContract.symbol();
      const pzzcUnits = ethers.parseUnits(requestedPzzc, pzzcDecimals);

      const pzzcTransferTx = await pzzcContract.transfer(buyerAddress, pzzcUnits);
      await pzzcTransferTx.wait();

      const brevo = getBrevoClient();
      await brevo.transactionalEmails.sendTransacEmail({
        subject: "🍕 Your Pizza Coin Order Confirmation",
        htmlContent: `<p>Paid $${priceAmount} USD via NOWPayments (${payCurrency}). Sent ${requestedPzzc} ${pzzcSymbol}.</p>`,
        sender: { name: "Pizza Coin", email: process.env.SENDER_EMAIL },
        to: [{ email: buyerEmail }]
      });

      await brevo.transactionalEmails.sendTransacEmail({
        subject: "🍕 New Pizza Coin Order (NOWPayments)",
        htmlContent: `<p>New order from ${buyerEmail}. Paid $${priceAmount} USD.</p>`,
        sender: { name: "Pizza Coin", email: process.env.SENDER_EMAIL },
        to: [{ email: process.env.SELLER_EMAIL }]
      });

      processedOrders.set(String(paymentId), { success: true, pzzcTxHash: pzzcTransferTx.hash });

      return res.status(200).json({ success: true, message: "IPN Order fulfilled." });

    } catch (error) {
      console.error("IPN Error:", error);
      return res.status(500).json({ success: false, error: error.message || "IPN failed." });
    }
  }
);


/* =========================================================
   404 & ERROR HANDLERS
   ========================================================= */

app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.originalUrl}` });
});

app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  if (res.headersSent) return next(error);
  res.status(500).json({ success: false, error: "Internal server error." });
});


/* =========================================================
   START SERVER
   ========================================================= */

app.listen(PORT, () => {
  console.log(`Pizza Coin Dual Backend running on port ${PORT}`);
});
