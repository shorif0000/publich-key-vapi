
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";

const app = new Hono();

const PORT = Number(process.env.PORT || 4242);
const PAY_TO = process.env.PAY_TO;
const FACILITATOR =
  process.env.FACILITATOR_URL || "https://x402.org/facilitator";

if (!PAY_TO || !/^0x[a-fA-F0-9]{40}$/.test(PAY_TO)) {
  throw new Error("Set a valid PAY_TO wallet address.");
}

const baseUrl =
  process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const paymentOption = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "5000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: PAY_TO,
  maxTimeoutSeconds: 120,
  extra: {
    name: "USD Coin",
    version: "2"
  }
};

const offer = {
  x402Version: 2,
  error: "Payment required",
  resource: {
    url: `${baseUrl}/paid`,
    description: "Text analysis service",
    mimeType: "application/json",
    serviceName: "Text Analyzer API"
  },
  accepts: [paymentOption]
};

app.use(
  "*",
  cors({
    origin: "*",
    exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"]
  })
);

app.get("/", (c) =>
  c.json({
    name: "Text Analyzer API",
    status: "online",
    payment: "x402 v2",
    network: "Base",
    endpoint: "POST /paid"
  })
);

app.get("/health", (c) =>
  c.json({ status: "ok" })
);

app.get("/openapi.json", (c) =>
  c.json({
    openapi: "3.0.3",
    info: {
      title: "Text Analyzer API",
      version: "1.0.0",
      description: "Paid text analysis API using x402."
    },
    paths: {
      "/paid": {
        post: {
          summary: "Analyze text",
          description: "Returns text statistics after payment.",
          "x-payment-info": paymentOption,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["text"],
                  properties: {
                    text: { type: "string" }
                  }
                }
              }
            }
          },
          responses: {
            "200": { description: "Text analysis result" },
            "402": { description: "Payment required" }
          }
        }
      }
    }
  })
);

app.post("/paid", async (c) => {
  const encoded = c.req.header("PAYMENT-SIGNATURE");

  if (!encoded) {
    return c.json(
      offer,
      402,
      {
        "PAYMENT-REQUIRED": btoa(JSON.stringify(offer))
      }
    );
  }

  let payment;

  try {
    payment = JSON.parse(atob(encoded));
  } catch {
    return c.json({ error: "Invalid payment signature" }, 400);
  }

  const paymentBody = {
    x402Version: 2,
    paymentPayload: payment,
    paymentRequirements: paymentOption
  };

  const headers = {
    "content-type": "application/json"
  };

  try {
    // Verify payment before providing the service
    const verifyResponse = await fetch(
      `${FACILITATOR}/verify`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(paymentBody)
      }
    );

    const verification = await verifyResponse.json();

    if (!verifyResponse.ok || !verification.isValid) {
      return c.json(
        { error: "Payment verification failed" },
        402
      );
    }

    // Settle payment
    const settleResponse = await fetch(
      `${FACILITATOR}/settle`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(paymentBody)
      }
    );

    const settlement = await settleResponse.json();

    if (!settleResponse.ok || !settlement.success) {
      return c.json(
        { error: "Payment settlement failed" },
        502
      );
    }

    // Process the paid request
    const input = await c.req.json();
    const text = input?.text;

    if (typeof text !== "string" || text.length === 0) {
      return c.json(
        { error: "Please provide non-empty text." },
        400
      );
    }

    const words = text.trim().split(/\s+/).filter(Boolean);
    const sentences = text
      .split(/[.!?]+/)
      .filter((s) => s.trim().length > 0);

    const result = {
      success: true,
      service: "Text Analyzer API",
      analysis: {
        characters: text.length,
        charactersWithoutSpaces: text.replace(/\s/g, "").length,
        words: words.length,
        sentences: sentences.length
      }
    };

    return c.json(
      result,
      200,
      {
        "PAYMENT-RESPONSE": btoa(
          JSON.stringify(settlement)
        )
      }
    );

  } catch (error) {
    console.error("Payment processing error:", error);

    return c.json(
      { error: "Payment service temporarily unavailable" },
      502
    );
  }
});

serve({
  fetch: app.fetch,
  port: PORT,
  hostname: "0.0.0.0"
});

console.log(`Text Analyzer API running on port ${PORT}`);
