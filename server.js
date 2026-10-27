const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { BrevoClient } = require("@getbrevo/brevo");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;
const NOWPAYMENTS_API_URL = "https://api.nowpayments.io/v1";

const GOOGLE_APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbylr2JMpdm5hE3gKDT2euN5W5BSXV_aLB-rPMC9ehSa42P45ggPW3Ago2e4iDJqPlWWVQ/exec";

const GOOGLE_SHEETS_SHARED_SECRET = process.env.BREVO_API_KEY;
const AFFILIATE_COMMISSION_RATE = 25;

const POLYGON_CHAIN_ID = 137n;
const POLYGON_RPC =
  process.env.POLYGON_RPC || "https://polygon-rpc.com";

const USDC_ADDRESS =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const MERCHANT_WALLET =
  process.env.MERCHANT_WALLET ||
  "0x9e63CDc3D66714f0FCe5B3347139E117a04A75b3";

const provider = new ethers.JsonRpcProvider(POLYGON_RPC);

const ERC20_ABI = [
  "function transfer(address to, uint256 value) returns (bool)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function symbol() view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

const usdcContract = new ethers.Contract(
  USDC_ADDRESS,
  ERC20_ABI,
  provider
);

function isValidEmail(email) {
  return (
    typeof email === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

function isValidAddress(address) {
  return typeof address === "string" && ethers.isAddress(address);
}

function normalizeAddress(address) {
  return ethers.getAddress(address);
}

function checkEnvironment() {
  const required = [
    "STMP_B3",
    "STMP_PZZC",
    "BREVO_API_KEY",
    "SENDER_EMAIL",
    "SELLER_EMAIL"
  ];

  const missing = required.filter(key => !process.env[key]);

  if (missing.length) {
    throw new Error(
      `Missing Render environment variables: ${missing.join(", ")}`
    );
  }
}

function getDistributionWallet() {
  if (!process.env.STMP_B3) {
    throw new Error("STMP_B3 private key is missing.");
  }

  return new ethers.Wallet(process.env.STMP_B3, provider);
}

function getBrevoClient() {
  if (!process.env.BREVO_API_KEY) {
    throw new Error("BREVO_API_KEY is missing.");
  }

  return new BrevoClient({
    apiKey: process.env.BREVO_API_KEY,
    timeoutInSeconds: 30,
    maxRetries: 3
  });
}

/* =========================================================
   GOOGLE SHEETS VERIFIED-SALE REPORTING
   ========================================================= */

async function recordVerifiedSale({
  orderId,
  paymentMethod,
  affiliateId,
  saleAmount,
  buyerEmail = "",
  buyerWallet = "",
  buyerReceiveWallet = "",
  mainSellerWallet = MERCHANT_WALLET,
  sellerWallet = "",
  txHash = "",
  pzzcTxHash = "",
  pzzcSent = "",
  saleStatus = "approved",
  paymentStatus = "PAID"
}) {
  if (
    !/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(
      GOOGLE_APPS_SCRIPT_URL
    )
  ) {
    console.error("Invalid Google Apps Script Web App URL.");
    return { ok: false };
  }

  if (
    !Number.isFinite(Number(AFFILIATE_COMMISSION_RATE)) ||
    AFFILIATE_COMMISSION_RATE < 0 ||
    AFFILIATE_COMMISSION_RATE > 100
  ) {
    console.error("Invalid affiliate commission rate.");
    return { ok: false };
  }

  const normalizedAffiliateId = isValidAddress(
    String(affiliateId || "").trim()
  )
    ? normalizeAddress(String(affiliateId).trim())
    : "MAIN";

  const normalizedMainSellerWallet = isValidAddress(
    String(mainSellerWallet || "").trim()
  )
    ? normalizeAddress(String(mainSellerWallet).trim())
    : String(mainSellerWallet || "");

  const normalizedSellerWallet = isValidAddress(
    String(sellerWallet || "").trim()
  )
    ? normalizeAddress(String(sellerWallet).trim())
    : normalizedAffiliateId === "MAIN"
      ? normalizedMainSellerWallet
      : normalizedAffiliateId;

  const normalizedBuyerWallet = isValidAddress(
    String(buyerWallet || "").trim()
  )
    ? normalizeAddress(String(buyerWallet).trim())
    : String(buyerWallet || "");

  const normalizedBuyerReceiveWallet = isValidAddress(
    String(buyerReceiveWallet || "").trim()
  )
    ? normalizeAddress(String(buyerReceiveWallet).trim())
    : String(buyerReceiveWallet || "");

  const payload = {
    action: "recordSale",
    timestamp: new Date().toISOString(),
    orderId: String(orderId || ""),
    paymentMethod: String(paymentMethod || ""),
    affiliateId: normalizedAffiliateId,
    saleAmount: Number(saleAmount),
    commissionRate:
      normalizedAffiliateId === "MAIN"
        ? 0
        : AFFILIATE_COMMISSION_RATE,
    saleStatus,
    paymentStatus,
    buyerEmail: String(buyerEmail || ""),
    buyerWallet: normalizedBuyerWallet,
    buyerReceiveWallet: normalizedBuyerReceiveWallet,
    mainSellerWallet: normalizedMainSellerWallet,
    sellerWallet: normalizedSellerWallet,
    txHash: String(txHash || ""),
    pzzcTxHash: String(pzzcTxHash || ""),
    pzzcSent: String(pzzcSent || ""),
    sharedSecret: GOOGLE_SHEETS_SHARED_SECRET || ""
  };

  if (
    !payload.orderId ||
    !Number.isFinite(payload.saleAmount) ||
    payload.saleAmount <= 0
  ) {
    console.error("Invalid sale report data.", {
      orderId: payload.orderId,
      saleAmount: payload.saleAmount
    });
    return { ok: false };
  }

  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(GOOGLE_APPS_SCRIPT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=utf-8"
        },
        body: JSON.stringify(payload),
        redirect: "follow"
      });

      const responseText = await response.text();
      let result;

      try {
        result = JSON.parse(responseText);
      } catch {
        throw new Error(
          `Apps Script returned non-JSON response (HTTP ${response.status}).`
        );
      }

      if (!response.ok || result.ok !== true) {
        throw new Error(
          result.error ||
          `Apps Script request failed (HTTP ${response.status}).`
        );
      }

      console.log("Verified sale reported to Google Sheets:", {
        orderId: payload.orderId,
        paymentMethod: payload.paymentMethod,
        buyerEmail: payload.buyerEmail,
        buyerWallet: payload.buyerWallet,
        buyerReceiveWallet: payload.buyerReceiveWallet,
        sellerWallet: payload.sellerWallet,
        saleAmount: payload.saleAmount,
        duplicate: Boolean(result.duplicate)
      });

      return {
        ok: true,
        duplicate: Boolean(result.duplicate)
      };
    } catch (error) {
      lastError = error;
      console.error(
        `Google Sheets attempt ${attempt}/3 failed:`,
        error.message
      );

      if (attempt < 3) {
        await new Promise(resolve =>
          setTimeout(resolve, attempt * 1000)
        );
      }
    }
  }

  console.error(
    "CRITICAL: verified sale was not recorded in Google Sheets.",
    {
      orderId: payload.orderId,
      error: lastError?.message || "Unknown error"
    }
  );

  return {
    ok: false,
    error: lastError?.message || "Unknown error"
  };
}

/* =========================================================
   NOWPAYMENTS SIGNATURE VERIFICATION
   ========================================================= */

function verifyNowPaymentsSignature(req) {
  const receivedSig = req.headers["x-nowpayments-sig"];

  if (!receivedSig || !NOWPAYMENTS_IPN_SECRET) {
    return false;
  }

  function sortObject(obj) {
    if (obj === null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(sortObject);

    return Object.keys(obj)
      .sort()
      .reduce((sorted, key) => {
        sorted[key] = sortObject(obj[key]);
        return sorted;
      }, {});
  }

  const sortedPayload = sortObject(req.body);
  const hmac = crypto.createHmac("sha512", NOWPAYMENTS_IPN_SECRET);
  hmac.update(JSON.stringify(sortedPayload));

  const expected = hmac.digest("hex").toLowerCase();
  const received = String(receivedSig).trim().toLowerCase();

  if (
    !/^[0-9a-f]{128}$/.test(received) ||
    received.length !== expected.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(received, "utf8")
  );
}

const processedOrders = new Map();

/* =========================================================
   HEALTH CHECK AND ROOT
   ========================================================= */

app.get("/api/health", async (req, res) => {
  try {
    const network = await provider.getNetwork();

    res.status(200).json({
      success: true,
      service: "pizza-backend",
      network: "polygon",
      chainId: network.chainId.toString(),
      routes: [
        "/api/verify-usdc-order",
        "/api/create-nowpayments-invoice",
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
});

app.get("/", (req, res) => {
  res.status(200).send(
    "Pizza Coin Dual Backend is running successfully!"
  );
});

/* =========================================================
   DIRECT WEB3 USDC ORDER
   ========================================================= */

app.post("/api/verify-usdc-order", async (req, res) => {
  let txHash = null;

  try {
    console.log("VERIFY USDC ORDER REQUEST");
    checkEnvironment();

    const {
      email,
      polygonAddress,
      pzzcAmount,
      paymentCrypto,
      affiliateId,
      txHash: submittedTxHash
    } = req.body;

    txHash = submittedTxHash;

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        error: "Invalid buyer email address."
      });
    }

    if (!isValidAddress(polygonAddress)) {
      return res.status(400).json({
        success: false,
        error: "Invalid Polygon receive address."
      });
    }

    const requestedPzzc = String(pzzcAmount);
    const numericPzzc = Number(requestedPzzc);

    if (!Number.isFinite(numericPzzc) || numericPzzc <= 0) {
      return res.status(400).json({
        success: false,
        error: "PZZC amount must be greater than zero."
      });
    }

    if (paymentCrypto && paymentCrypto !== "USDC") {
      return res.status(400).json({
        success: false,
        error: "Only USDC payments are currently supported."
      });
    }

    if (
      typeof txHash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(txHash)
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid Polygon transaction hash."
      });
    }

    const buyerAddress = normalizeAddress(polygonAddress);
    const merchantAddress = normalizeAddress(MERCHANT_WALLET);

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
      throw new Error(
        `RPC is not connected to Polygon. Chain ID: ${network.chainId}`
      );
    }

    const transaction = await provider.getTransaction(txHash);

    if (!transaction || !transaction.to) {
      return res.status(400).json({
        success: false,
        error: "Payment transaction was not found."
      });
    }

    if (
      normalizeAddress(transaction.to).toLowerCase() !==
      USDC_ADDRESS.toLowerCase()
    ) {
      return res.status(400).json({
        success: false,
        error: "Transaction was not sent to USDC contract."
      });
    }

    const receipt = await provider.getTransactionReceipt(txHash);

    if (!receipt || receipt.status !== 1) {
      return res.status(400).json({
        success: false,
        error: "Payment transaction failed on Polygon."
      });
    }

    const usdcInterface = new ethers.Interface(ERC20_ABI);
    let verifiedPayment = null;

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
        continue;
      }

      try {
        const parsed = usdcInterface.parseLog({
          topics: log.topics,
          data: log.data
        });

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
      return res.status(400).json({
        success: false,
        error: "No USDC transfer to merchant wallet found."
      });
    }

    const usdcDecimals = await usdcContract.decimals();
    const paidUsdc = ethers.formatUnits(
      verifiedPayment.value,
      usdcDecimals
    );

    const requestedPzzcUnits = ethers.parseUnits(
      requestedPzzc,
      usdcDecimals
    );

    if (verifiedPayment.value < requestedPzzcUnits) {
      return res.status(400).json({
        success: false,
        error: "Insufficient USDC payment."
      });
    }

    const distributionWallet = getDistributionWallet();

    if (
      distributionWallet.address.toLowerCase() !==
      merchantAddress.toLowerCase()
    ) {
      throw new Error(
        "STMP_B3 wallet does not match MERCHANT_WALLET."
      );
    }

    const pzzcContract = new ethers.Contract(
      process.env.STMP_PZZC,
      ERC20_ABI,
      distributionWallet
    );

    const pzzcDecimals = await pzzcContract.decimals();
    const pzzcSymbol = await pzzcContract.symbol();
    const pzzcUnits = ethers.parseUnits(
      requestedPzzc,
      pzzcDecimals
    );

    const distributorBalance = await pzzcContract.balanceOf(
      distributionWallet.address
    );

    if (distributorBalance < pzzcUnits) {
      throw new Error("Insufficient PZZC balance.");
    }

    const pzzcTransferTx = await pzzcContract.transfer(
      buyerAddress,
      pzzcUnits
    );

    const pzzcReceipt = await pzzcTransferTx.wait();

    if (!pzzcReceipt || pzzcReceipt.status !== 1) {
      throw new Error("PZZC transfer failed.");
    }

    processedOrders.set(txHash, {
      success: true,
      pzzcTxHash: pzzcTransferTx.hash,
      paymentMethod: "USDC (Polygon)",
      saleAmount: Number(paidUsdc)
    });

    await recordVerifiedSale({
      orderId: txHash,
      paymentMethod: "USDC (Polygon)",
      affiliateId,
      saleAmount: Number(paidUsdc),
      buyerEmail: email,
      buyerWallet: verifiedPayment.from,
      buyerReceiveWallet: buyerAddress,
      mainSellerWallet: merchantAddress,
      sellerWallet: isValidAddress(affiliateId)
        ? normalizeAddress(affiliateId)
        : merchantAddress,
      txHash,
      pzzcTxHash: pzzcTransferTx.hash,
      pzzcSent: requestedPzzc,
      saleStatus: "approved",
      paymentStatus: "PAID"
    });

    const brevo = getBrevoClient();

    await brevo.transactionalEmails.sendTransacEmail({
      subject: "🍕 Your Pizza Coin Order Confirmation",
      htmlContent:
        `<p>Paid ${paidUsdc} USDC. Sent ${requestedPzzc} ${pzzcSymbol}. Tx: ${pzzcTransferTx.hash}</p>`,
      sender: {
        name: "Pizza Coin",
        email: process.env.SENDER_EMAIL
      },
      to: [{ email }]
    });

    await brevo.transactionalEmails.sendTransacEmail({
      subject: "🍕 New Pizza Coin Order",
      htmlContent:
        `<p>New order from ${email}. Paid ${paidUsdc} USDC.</p>`,
      sender: {
        name: "Pizza Coin",
        email: process.env.SENDER_EMAIL
      },
      to: [{ email: process.env.SELLER_EMAIL }]
    });

    return res.status(200).json({
      success: true,
      message: "Order processed successfully.",
      paymentTxHash: txHash,
      pzzcTxHash: pzzcTransferTx.hash
    });
  } catch (error) {
    console.error("Direct Web3 Order Error:", error);

    return res.status(500).json({
      success: false,
      error: error.message || "Order processing failed."
    });
  }
});

/* =========================================================
   NOWPAYMENTS INVOICE CREATION
   ========================================================= */

app.post("/api/create-nowpayments-invoice", async (req, res) => {
  try {
    checkEnvironment();

    const { email, polygonAddress, pzzcAmount, affiliateId } = req.body;

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        error: "Invalid buyer email address."
      });
    }

    if (!isValidAddress(polygonAddress)) {
      return res.status(400).json({
        success: false,
        error: "Invalid Polygon receive address."
      });
    }

    const amount = Number(pzzcAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: "Amount must be greater than zero."
      });
    }

    if (!NOWPAYMENTS_API_KEY) {
      throw new Error(
        "NOWPAYMENTS_API_KEY is missing from Render environment variables."
      );
    }

    const safeAffiliateId = isValidAddress(affiliateId)
      ? normalizeAddress(affiliateId)
      : "";

    const response = await fetch(
      `${NOWPAYMENTS_API_URL}/invoice`,
      {
        method: "POST",
        headers: {
          "x-api-key": NOWPAYMENTS_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          price_amount: amount,
          price_currency: "usd",
          ipn_callback_url:
            "https://pizza-backend-8if7.onrender.com/api/nowpayments-ipn",
          order_id: `PZZC-${crypto.randomUUID()}`,
          order_description:
            `Wallet: ${normalizeAddress(polygonAddress)} | Email: ${email} | Affiliate ID: ${safeAffiliateId}`
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.message || "Failed to create NOWPayments invoice."
      );
    }

    return res.status(200).json({
      success: true,
      invoice_url: data.invoice_url
    });
  } catch (error) {
    console.error("NOWPayments Invoice Creation Error:", error);

    return res.status(500).json({
      success: false,
      error: error.message || "Invoice creation failed."
    });
  }
});

/* =========================================================
   NOWPAYMENTS IPN WEBHOOK
   ========================================================= */

app.post("/api/nowpayments-ipn", async (req, res) => {
  try {
    console.log("NOWPAYMENTS IPN WEBHOOK RECEIVED");

    if (!NOWPAYMENTS_IPN_SECRET) {
      return res.status(500).json({
        success: false,
        error: "IPN secret is not configured."
      });
    }

    if (!verifyNowPaymentsSignature(req)) {
      console.warn("Invalid NOWPayments IPN signature.");

      return res.status(400).json({
        success: false,
        error: "Invalid signature."
      });
    }

    const ipnData = req.body;
    const paymentId =
      ipnData.payment_id ||
      ipnData.invoice_id ||
      ipnData.order_id;

    const paymentStatus =
      ipnData.payment_status || ipnData.status;

    const priceAmount = ipnData.price_amount;
    const orderDescription = ipnData.order_description || "";
    const payCurrency = ipnData.pay_currency || "crypto";

    if (
      paymentStatus !== "finished" &&
      paymentStatus !== "confirmed"
    ) {
      return res.status(200).json({
        success: true,
        message: "IPN received, waiting for finish."
      });
    }

    let buyerPolygonAddress = null;
    let buyerEmail = null;
    let affiliateId = "";

    const walletMatch = orderDescription.match(
      /Wallet:\s*(0x[a-fA-F0-9]{40})/
    );

    const emailMatch = orderDescription.match(
      /Email:\s*([^\s|]+)/
    );

    const affiliateMatch = orderDescription.match(
      /Affiliate ID:\s*(0x[a-fA-F0-9]{40})/i
    );

    if (walletMatch) buyerPolygonAddress = walletMatch[1];
    if (emailMatch) buyerEmail = emailMatch[1];

    if (
      affiliateMatch &&
      isValidAddress(affiliateMatch[1])
    ) {
      affiliateId = normalizeAddress(affiliateMatch[1]);
    }

    if (
      !isValidAddress(buyerPolygonAddress) ||
      !isValidEmail(buyerEmail)
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid metadata payload."
      });
    }

    if (processedOrders.has(String(paymentId))) {
      return res.status(200).json({
        success: true,
        message: "Payment already processed."
      });
    }

    const distributionWallet = getDistributionWallet();
    const buyerAddress = normalizeAddress(buyerPolygonAddress);

    const pzzcContract = new ethers.Contract(
      process.env.STMP_PZZC,
      ERC20_ABI,
      distributionWallet
    );

    const pzzcDecimals = await pzzcContract.decimals();
    const pzzcSymbol = await pzzcContract.symbol();

    const pzzcUnits = ethers.parseUnits(
      String(priceAmount),
      pzzcDecimals
    );

    const pzzcTransferTx = await pzzcContract.transfer(
      buyerAddress,
      pzzcUnits
    );

    const pzzcReceipt = await pzzcTransferTx.wait();

    if (!pzzcReceipt || pzzcReceipt.status !== 1) {
      throw new Error("PZZC transfer failed for NOWPayments order.");
    }

    processedOrders.set(String(paymentId), {
      success: true,
      pzzcTxHash: pzzcTransferTx.hash,
      paymentMethod: `NOWPayments (${payCurrency})`,
      saleAmount: Number(priceAmount)
    });

    await recordVerifiedSale({
      orderId: String(ipnData.order_id || paymentId),
      paymentMethod: `NOWPayments (${payCurrency})`,
      affiliateId,
      saleAmount: Number(priceAmount),
      buyerEmail,
      buyerWallet: "",
      buyerReceiveWallet: buyerAddress,
      mainSellerWallet: MERCHANT_WALLET,
      sellerWallet: isValidAddress(affiliateId)
        ? normalizeAddress(affiliateId)
        : MERCHANT_WALLET,
      txHash: String(paymentId || ""),
      pzzcTxHash: pzzcTransferTx.hash,
      pzzcSent: String(priceAmount),
      saleStatus: "approved",
      paymentStatus: "PAID"
    });

    const brevo = getBrevoClient();

    await brevo.transactionalEmails.sendTransacEmail({
      subject: "🍕 Your Pizza Coin Order Confirmation",
      htmlContent:
        `<p>Paid $${priceAmount} USD via NOWPayments (${payCurrency}). Sent ${priceAmount} ${pzzcSymbol}.</p>`,
      sender: {
        name: "Pizza Coin",
        email: process.env.SENDER_EMAIL
      },
      to: [{ email: buyerEmail }]
    });

    await brevo.transactionalEmails.sendTransacEmail({
      subject: "🍕 New Pizza Coin Order (NOWPayments)",
      htmlContent:
        `<p>New order from ${buyerEmail}. Paid $${priceAmount} USD.</p>`,
      sender: {
        name: "Pizza Coin",
        email: process.env.SENDER_EMAIL
      },
      to: [{ email: process.env.SELLER_EMAIL }]
    });

    return res.status(200).json({
      success: true,
      message: "IPN Order fulfilled."
    });
  } catch (error) {
    console.error("IPN Error:", error);

    return res.status(500).json({
      success: false,
      error: error.message || "IPN failed."
    });
  }
});

/* =========================================================
   ERROR HANDLERS
   ========================================================= */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.originalUrl}`
  });
});

app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);

  if (res.headersSent) return next(error);

  res.status(500).json({
    success: false,
    error: "Internal server error."
  });
});

app.listen(PORT, () => {
  console.log(`Pizza Coin Dual Backend running on port ${PORT}`);
});
