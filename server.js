const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
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
   USDC CONTRACT
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
   REQUIRED ENVIRONMENT VARIABLES
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
    apiKey:
      process.env.BREVO_API_KEY,

    timeoutInSeconds: 30,

    maxRetries: 3
  });

}


/* =========================================================
   IN-MEMORY ORDER LOCK
   =========================================================

   Prevents the same txHash from being processed twice
   while this server instance remains alive.

   A production database is recommended for permanent
   idempotency across server restarts.
   ========================================================= */

const processedOrders =
  new Map();


/* =========================================================
   HEALTH CHECK
   ========================================================= */

app.get(
  "/api/health",
  async (req, res) => {

    try {

      const network =
        await provider.getNetwork();

      res.status(200).json({

        success: true,

        service:
          "pizza-backend",

        network:
          "polygon",

        chainId:
          network.chainId.toString(),

        orderRoute:
          "/api/verify-usdc-order"

      });

    } catch (error) {

      console.error(
        "Health check error:",
        error
      );

      res.status(500).json({

        success: false,

        error:
          error.message

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
      "Pizza Coin Backend is running successfully!"
    );

  }
);


/* =========================================================
   ORDER ROUTE
   ========================================================= */

app.post(
  "/api/verify-usdc-order",
  async (req, res) => {

    let txHash = null;

    try {

      console.log(
        "=================================================="
      );

      console.log(
        "VERIFY USDC ORDER REQUEST"
      );

      console.log(
        "=================================================="
      );


      /* ===================================================
         ENVIRONMENT
         =================================================== */

      checkEnvironment();


      /* ===================================================
         REQUEST DATA
         =================================================== */

      const {
        email,
        polygonAddress,
        pzzcAmount,
        paymentCrypto,
        txHash: submittedTxHash
      } = req.body;


      txHash = submittedTxHash;


      console.log(
        "Buyer email:",
        email
      );

      console.log(
        "Buyer receive address:",
        polygonAddress
      );

      console.log(
        "Requested PZZC:",
        pzzcAmount
      );

      console.log(
        "Payment crypto:",
        paymentCrypto
      );

      console.log(
        "Payment TX:",
        txHash
      );


      /* ===================================================
         INPUT VALIDATION
         =================================================== */

      if (!isValidEmail(email)) {

        return res.status(400).json({

          success: false,

          error:
            "Invalid buyer email address."

        });

      }


      if (!isValidAddress(polygonAddress)) {

        return res.status(400).json({

          success: false,

          error:
            "Invalid Polygon receive address."

        });

      }


      if (
        typeof pzzcAmount !== "string" &&
        typeof pzzcAmount !== "number"
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Invalid PZZC amount."

        });

      }


      const requestedPzzc =
        String(pzzcAmount);


      let numericPzzc;

      try {

        numericPzzc =
          Number(requestedPzzc);

      } catch {

        numericPzzc =
          NaN;

      }


      if (
        !Number.isFinite(numericPzzc) ||
        numericPzzc <= 0
      ) {

        return res.status(400).json({

          success: false,

          error:
            "PZZC amount must be greater than zero."

        });

      }


      if (
        paymentCrypto &&
        paymentCrypto !== "USDC"
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Only USDC payments are currently supported."

        });

      }


      if (
        typeof txHash !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(txHash)
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Invalid Polygon transaction hash."

        });

      }


      /* ===================================================
         NORMALIZE ADDRESSES
         =================================================== */

      const buyerAddress =
        normalizeAddress(
          polygonAddress
        );

      const merchantAddress =
        normalizeAddress(
          MERCHANT_WALLET
        );


      /* ===================================================
         DUPLICATE ORDER CHECK
         =================================================== */

      const existingOrder =
        processedOrders.get(txHash);

      if (existingOrder) {

        console.log(
          "Duplicate txHash request:",
          txHash
        );

        return res.status(200).json({

          success:
            existingOrder.success,

          message:
            "This transaction has already been processed.",

          paymentTxHash:
            txHash,

          pzzcTxHash:
            existingOrder.pzzcTxHash || null,

          buyerEmailSent:
            existingOrder.buyerEmailSent || false,

          sellerEmailSent:
            existingOrder.sellerEmailSent || false

        });

      }


      /* ===================================================
         VERIFY POLYGON NETWORK
         =================================================== */

      const network =
        await provider.getNetwork();

      if (
        network.chainId !==
        POLYGON_CHAIN_ID
      ) {

        throw new Error(
          `RPC is not connected to Polygon. Chain ID: ${network.chainId}`
        );

      }


      console.log(
        "Polygon network verified."
      );


      /* ===================================================
         GET TRANSACTION
         =================================================== */

      const transaction =
        await provider.getTransaction(
          txHash
        );


      if (!transaction) {

        return res.status(400).json({

          success: false,

          error:
            "Payment transaction was not found on Polygon."

        });

      }


      console.log(
        "Transaction found."
      );


      /* ===================================================
         VERIFY TRANSACTION TO CONTRACT
         =================================================== */

      if (!transaction.to) {

        return res.status(400).json({

          success: false,

          error:
            "Payment transaction has no destination."

        });

      }


      const transactionTo =
        normalizeAddress(
          transaction.to
        );


      if (
        transactionTo.toLowerCase() !==
        USDC_ADDRESS.toLowerCase()
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Transaction was not sent to the configured Polygon USDC contract."

        });

      }


      /* ===================================================
         VERIFY RECEIPT
         =================================================== */

      const receipt =
        await provider.getTransactionReceipt(
          txHash
        );


      if (!receipt) {

        return res.status(400).json({

          success: false,

          error:
            "Payment transaction has not been mined yet."

        });

      }


      if (
        receipt.status !== 1
      ) {

        return res.status(400).json({

          success: false,

          error:
            "USDC payment transaction failed on Polygon."

        });

      }


      console.log(
        "Payment transaction confirmed."
      );


      /* ===================================================
         PARSE USDC TRANSFER EVENTS
         =================================================== */

      const usdcInterface =
        new ethers.Interface(
          ERC20_ABI
        );


      let verifiedPayment = null;


      for (
        const log of receipt.logs
      ) {

        if (
          log.address.toLowerCase() !==
          USDC_ADDRESS.toLowerCase()
        ) {

          continue;

        }


        try {

          const parsed =
            usdcInterface.parseLog({
              topics:
                log.topics,
              data:
                log.data
            });


          if (
            !parsed ||
            parsed.name !==
            "Transfer"
          ) {

            continue;

          }


          const from =
            normalizeAddress(
              parsed.args[0]
            );

          const to =
            normalizeAddress(
              parsed.args[1]
            );

          const value =
            parsed.args[2];


          if (
            to.toLowerCase() ===
            merchantAddress.toLowerCase()
          ) {

            verifiedPayment = {

              from,

              to,

              value

            };

            break;

          }

        } catch {

          continue;

        }

      }


      /* ===================================================
         PAYMENT EVENT REQUIRED
         =================================================== */

      if (!verifiedPayment) {

        return res.status(400).json({

          success: false,

          error:
            "No USDC transfer to the configured merchant wallet was found in this transaction."

        });

      }


      /* ===================================================
         VERIFY BUYER
         =================================================== */

      if (
        verifiedPayment.from.toLowerCase() !==
        transaction.from.toLowerCase()
      ) {

        return res.status(400).json({

          success: false,

          error:
            "USDC transfer sender does not match transaction sender."

        });

      }


      /* ===================================================
         USDC DECIMALS
         =================================================== */

      const usdcDecimals =
        await usdcContract.decimals();


      const paidUsdc =
        ethers.formatUnits(
          verifiedPayment.value,
          usdcDecimals
        );


      console.log(
        "Verified USDC payment:",
        paidUsdc
      );


      /* ===================================================
         PZZC 1:1 PAYMENT CHECK
         
         PZZC requested must not exceed USDC paid.
         =================================================== */

      const requestedPzzcUnits =
        ethers.parseUnits(
          requestedPzzc,
          usdcDecimals
        );


      if (
        verifiedPayment.value <
        requestedPzzcUnits
      ) {

        return res.status(400).json({

          success: false,

          error:
            `Insufficient USDC payment. Paid ${paidUsdc} USDC but requested ${requestedPzzc} PZZC.`

        });

      }


      console.log(
        "USDC amount is sufficient."
      );


      /* ===================================================
         DISTRIBUTION WALLET
         =================================================== */

      const distributionWallet =
        getDistributionWallet();


      console.log(
        "PZZC distributor:",
        distributionWallet.address
      );


      /* ===================================================
         VERIFY DISTRIBUTOR ADDRESS / MERCHANT
         
         This is intentionally logged rather than silently
         assuming the private key corresponds to the
         merchant wallet.
         =================================================== */

      if (
        distributionWallet.address.toLowerCase() !==
        merchantAddress.toLowerCase()
      ) {

        throw new Error(
          `STMP_B3 wallet ${distributionWallet.address} does not match MERCHANT_WALLET ${merchantAddress}.`
        );

      }


      /* ===================================================
         PZZC CONTRACT
         =================================================== */

      const pzzcContract =
        new ethers.Contract(
          process.env.STMP_PZZC,
          ERC20_ABI,
          distributionWallet
        );


      /* ===================================================
         PZZC DECIMALS
         =================================================== */

      const pzzcDecimals =
        await pzzcContract.decimals();


      const pzzcSymbol =
        await pzzcContract.symbol();


      console.log(
        "PZZC symbol:",
        pzzcSymbol
      );

      console.log(
        "PZZC decimals:",
        pzzcDecimals
      );


      /* ===================================================
         PZZC AMOUNT
         =================================================== */

      const pzzcUnits =
        ethers.parseUnits(
          requestedPzzc,
          pzzcDecimals
        );


      /* ===================================================
         PZZC BALANCE
         =================================================== */

      const distributorBalance =
        await pzzcContract.balanceOf(
          distributionWallet.address
        );


      if (
        distributorBalance <
        pzzcUnits
      ) {

        throw new Error(
          `Insufficient PZZC balance. Required ${requestedPzzc} ${pzzcSymbol}, available ${ethers.formatUnits(distributorBalance, pzzcDecimals)} ${pzzcSymbol}.`
        );

      }


      console.log(
        "PZZC balance sufficient."
      );


      /* ===================================================
         GAS BALANCE
         =================================================== */

      const gasBalance =
        await provider.getBalance(
          distributionWallet.address
        );


      if (
        gasBalance === 0n
      ) {

        throw new Error(
          "PZZC distributor wallet has no MATIC for Polygon gas."
        );

      }


      console.log(
        "Distributor MATIC balance:",
        ethers.formatEther(gasBalance)
      );


      /* ===================================================
         SEND PZZC
         =================================================== */

      console.log(
        `Sending ${requestedPzzc} ${pzzcSymbol} to ${buyerAddress}`
      );


      const pzzcTransferTx =
        await pzzcContract.transfer(
          buyerAddress,
          pzzcUnits
        );


      console.log(
        "PZZC transaction submitted:",
        pzzcTransferTx.hash
      );


      /* ===================================================
         WAIT FOR PZZC CONFIRMATION
         =================================================== */

      const pzzcReceipt =
        await pzzcTransferTx.wait();


      if (
        !pzzcReceipt ||
        pzzcReceipt.status !== 1
      ) {

        throw new Error(
          "PZZC transfer failed or was not confirmed."
        );

      }


      console.log(
        "PZZC transaction confirmed:",
        pzzcTransferTx.hash
      );


      /* ===================================================
         BREVO
         =================================================== */

      const brevo =
        getBrevoClient();


      /* ===================================================
         BUYER EMAIL
         =================================================== */

      const buyerEmailMessage = {

        subject:
          "🍕 Your Pizza Coin Order Confirmation",

        htmlContent: `
<!DOCTYPE html>
<html>
<body>

<h2>🍕 Pizza Coin Order Confirmed</h2>

<p>Thank you for your purchase.</p>

<p>
Your payment has been verified on Polygon.
</p>

<p>
<b>USDC Paid:</b>
${paidUsdc} USDC
</p>

<p>
<b>PZZC Sent:</b>
${requestedPzzc} ${pzzcSymbol}
</p>

<p>
<b>PZZC Recipient:</b><br>
${buyerAddress}
</p>

<p>
<b>Payment Transaction:</b><br>
${txHash}
</p>

<p>
<b>PZZC Transaction:</b><br>
${pzzcTransferTx.hash}
</p>

<hr>

<p>
<b>Electronic Pizza Gift Card:</b><br>
PIZZA-GIFT-8F92-K3L9-PZZC
</p>

<p>
Thank you for choosing Pizza Coin! 🍕
</p>

</body>
</html>
        `,

        sender: {

          name:
            "Pizza Coin",

          email:
            process.env.SENDER_EMAIL

        },

        to: [

          {

            email:
              email

          }

        ]

      };


      const buyerEmailResult =
        await brevo.transactionalEmails.sendTransacEmail(
          buyerEmailMessage
        );


      console.log(
        "Buyer email sent:",
        buyerEmailResult.messageId || "accepted"
      );


      /* ===================================================
         SELLER EMAIL
         =================================================== */

      const sellerEmailMessage = {

        subject:
          "🍕 New Pizza Coin Order",

        htmlContent: `
<!DOCTYPE html>
<html>
<body>

<h2>🍕 New Pizza Coin Order</h2>

<p>
<b>Buyer Email:</b>
${email}
</p>

<p>
<b>USDC Paid:</b>
${paidUsdc} USDC
</p>

<p>
<b>PZZC Sent:</b>
${requestedPzzc} ${pzzcSymbol}
</p>

<p>
<b>Buyer Polygon Address:</b><br>
${buyerAddress}
</p>

<p>
<b>Payment Transaction:</b><br>
${txHash}
</p>

<p>
<b>PZZC Transaction:</b><br>
${pzzcTransferTx.hash}
</p>

</body>
</html>
        `,

        sender: {

          name:
            "Pizza Coin",

          email:
            process.env.SENDER_EMAIL

        },

        to: [

          {

            email:
              process.env.SELLER_EMAIL

          }

        ]

      };


      const sellerEmailResult =
        await brevo.transactionalEmails.sendTransacEmail(
          sellerEmailMessage
        );


      console.log(
        "Seller email sent:",
        sellerEmailResult.messageId || "accepted"
      );


      /* ===================================================
         MARK ORDER COMPLETE
         =================================================== */

      processedOrders.set(
        txHash,
        {

          success: true,

          pzzcTxHash:
            pzzcTransferTx.hash,

          buyerEmailSent:
            true,

          sellerEmailSent:
            true

        }
      );


      /* ===================================================
         SUCCESS RESPONSE
         =================================================== */

      console.log(
        "=================================================="
      );

      console.log(
        "ORDER COMPLETED SUCCESSFULLY"
      );

      console.log(
        "Payment TX:",
        txHash
      );

      console.log(
        "PZZC TX:",
        pzzcTransferTx.hash
      );

      console.log(
        "Buyer email: SENT"
      );

      console.log(
        "Seller email: SENT"
      );

      console.log(
        "=================================================="
      );


      return res.status(200).json({

        success: true,

        message:
          "Order processed successfully.",

        paymentTxHash:
          txHash,

        pzzcTxHash:
          pzzcTransferTx.hash,

        buyerEmailSent:
          true,

        sellerEmailSent:
          true

      });


    } catch (error) {

      console.error(
        "=================================================="
      );

      console.error(
        "ORDER PROCESSING ERROR"
      );

      console.error(
        "Payment TX:",
        txHash
      );

      console.error(
        error
      );

      console.error(
        "=================================================="
      );


      return res.status(500).json({

        success: false,

        error:
          error.message ||
          "Order processing failed.",

        paymentTxHash:
          txHash || null

      });

    }

  }
);


/* =========================================================
   404 HANDLER
   ========================================================= */

app.use(
  (req, res) => {

    res.status(404).json({

      success: false,

      error:
        `Route not found: ${req.method} ${req.originalUrl}`

    });

  }
);


/* =========================================================
   GLOBAL ERROR HANDLER
   ========================================================= */

app.use(
  (error, req, res, next) => {

    console.error(
      "Unhandled Express error:",
      error
    );

    if (res.headersSent) {

      return next(error);

    }

    res.status(500).json({

      success: false,

      error:
        "Internal server error."

    });

  }
);


/* =========================================================
   START SERVER
   ========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      "=================================================="
    );

    console.log(
      "Pizza Coin Backend"
    );

    console.log(
      "Server is running on port:",
      PORT
    );

    console.log(
      "Polygon RPC:",
      POLYGON_RPC
    );

    console.log(
      "Merchant wallet:",
      MERCHANT_WALLET
    );

    console.log(
      "USDC:",
      USDC_ADDRESS
    );

    console.log(
      "Order endpoint:",
      "/api/verify-usdc-order"
    );

    console.log(
      "Health endpoint:",
      "/api/health"
    );

    console.log(
      "=================================================="
    );

  }
);
