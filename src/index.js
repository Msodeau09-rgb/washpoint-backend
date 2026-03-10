import dotenv from "dotenv";
dotenv.config();

console.log("SUPABASE_URL:", process.env.SUPABASE_URL);
console.log("SUPABASE_ANON_KEY:", process.env.SUPABASE_ANON_KEY ? "Loaded" : "Missing");

import express from "express";
import Stripe from "stripe";
import cors from "cors";
import { supabase } from "./supabaseClient.js";
import { createOrderSchema } from "./validation/orderValidation.js";

import { checkSeller, checkCustomer } from "./middleware/roleMiddleware.js";
import { checkOrderOwnership } from "./middleware/ownershipMiddleware.js";

import { authenticateUser } from "./authMiddleware.js";
import { isSellerOnboarded } from "./stripeHelpers.js";

// 🔐 Simple admin check middleware
function checkAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).send("Admin only");
  }
  next();
}

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "WashPoint backend running 🚀" });
});

const PORT = process.env.PORT || 3000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.post("/create-connected-account", async (req, res) => {
  try {

    const account = await stripe.accounts.create({
      type: "express",
      country: "GB",
      email: req.body?.email || "washer@test.com",
      business_type: "individual",
      capabilities: {
        transfers: { requested: true },
        card_payments: { requested: true }
      }
    });

    await supabase
  .from("sellers")
  .insert({
    email: req.body?.email || "washer@test.com",
    stripe_account_id: account.id,
    onboarding_complete: false
  });

const accountLink = await stripe.accountLinks.create({
  account: account.id,
  refresh_url: "https://washpoint-backend-1.onrender.com/reauth",
  return_url: "https://washpoint-backend-1.onrender.com/return",
  type: "account_onboarding"
});

res.json({
  accountId: account.id,
  onboardingUrl: accountLink.url
});

  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * ✅ 1) Webhook FIRST (RAW body)
 */
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log("❌ Webhook signature failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const orderId = session.metadata?.orderId;

      if (!orderId) return res.json({ received: true });

      const { error } = await supabase
        .from("orders")
        .update({
          status: "paid",
          stripe_payment_intent_id: session.payment_intent,
          paid_at: new Date().toISOString(),
        })
        .eq("id", orderId);

      if (error) console.log("❌ Supabase update failed:", error.message);
      else console.log("✅ Marked PAID in DB:", orderId);
    }

    return res.json({ received: true });
  }
);

/**
 * ✅ JSON parser AFTER webhook
 */

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { price } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: {
              name: "Car Wash",
            },
            unit_amount: price * 100,
          },
          quantity: 1,
        },
      ],
      success_url: "https://example.com/success",
      cancel_url: "https://example.com/cancel",
    });

    res.json({ url: session.url });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Payment session failed" });
  }
});

// Health check
app.get("/_ping", (req, res) => res.json({ ok: true }));
app.get("/", (req, res) => res.send("Backend is running 🚀"));

/**
 * DEBUG ROUTES
 */
app.get("/orders", async (req, res) => {
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return res.status(400).json({ ok: false, error: error.message });
  return res.json({ ok: true, data });
});

app.get("/orders/:orderId", async (req, res) => {
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("id", req.params.orderId)
    .single();

  if (error) return res.status(404).json({ ok: false, error: error.message });
  return res.json({ ok: true, order: data });
});

/**
 * CREATE ORDER
 */
app.post("/create-order", authenticateUser, checkCustomer, async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.errors });

  const orderData = parsed.data;

  const { data: order, error } = await supabase
    .from("orders")
    .insert({
      amount_pence: orderData.amount_pence,
      currency: "gbp",
      seller_id: orderData.seller_id || null,
      buyer_name: orderData.buyer_name || null,
      buyer_email: orderData.buyer_email || null,
      status: "available",
    })
    .select()
    .single();

  if (error) throw error;

  return res.json({ ok: true, order });
});

/**
 * CHECKOUT
 */
app.get("/checkout", async (req, res) => {
  const { orderId } = req.query;

  const { data: order, error } = await supabase
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (error || !order) return res.status(404).send("Order not found");

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "gbp",
          product_data: { name: `Car wash ${order.id}` },
          unit_amount: order.amount_pence,
        },
        quantity: 1,
      },
    ],
    metadata: { orderId: order.id },
    success_url: `https://washpoint-backend.onrender.com/success`,
    cancel_url: `https://washpoint-backend.onrender.com/cancel`,
  });

res.json({
  url: session.url
});
});

app.get("/success", (req, res) => {
  res.json({ status: "success", message: "Payment successful" });
});

app.get("/cancel", (req, res) => {
  res.json({ status: "cancelled", message: "Payment cancelled" });
});

/**
 * RELEASE FUNDS
 */
app.post(
  "/orders/release",
  authenticateUser,
  checkSeller,
  checkOrderOwnership,
  async (req, res) => {
    const order = req.order;

    const { data: sellerData } = await supabase
      .from("sellers")
      .select("stripe_account_id")
      .eq("id", order.seller_id)
      .single();

    const onboarded = await isSellerOnboarded(
      sellerData.stripe_account_id
    );

    if (!onboarded)
      return res.status(403).send("Seller not onboarded");

if (order.status !== "completed")
  return res.status(400).send("Order not completed yet");

    const paidTime = new Date(order.paid_at);
    const hoursPassed = (Date.now() - paidTime) / 36e5;

    if (hoursPassed < 24)
      return res.status(403).send("Funds locked in escrow");

    const sellerAmount = Math.round(order.amount_pence * 0.85);

    const transfer = await stripe.transfers.create({
      amount: sellerAmount,
      currency: "gbp",
      destination: sellerData.stripe_account_id,
      metadata: { orderId: order.id },
    });

    await supabase
      .from("orders")
      .update({ status: "released" })
      .eq("id", order.id);

    return res.json({ ok: true, transferId: transfer.id });
  }
);

/**
 * ACCEPT JOB
 */
app.post("/orders/accept", authenticateUser, checkSeller, async (req, res) => {
  const { orderId } = req.body;

  const { data: order } = await supabase
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (!order) return res.status(404).send("Order not found");

if (order.status !== "available")
  return res.status(400).send("Order is not available");

const completionCode = Math.floor(1000 + Math.random() * 9000);

const { data: updatedOrder, error: updateError } = await supabase
  .from("orders")
  .update({
    status: "accepted",
    seller_id: req.user.id,
    completion_code: completionCode
  })
  .eq("id", orderId)
  .eq("status", "available")
  .select()
  .single();

if (updateError || !updatedOrder) {
  return res.status(400).send("Job already taken");
}

  return res.json({ ok: true, completionCode });
});

/**
 * ⭐ COMPLETE JOB (ADDED)
 */
app.post(
  "/orders/complete",
  authenticateUser,
  checkSeller,
  checkOrderOwnership,
  async (req, res) => {
    const { orderId, code } = req.body;

    const { data: order } = await supabase
      .from("orders")
      .select("*")
      .eq("id", orderId)
      .single();

    if (!order) return res.status(404).send("Order not found");
// Ensure this seller owns the order
if (order.seller_id !== req.user.id) {
  return res.status(403).send("Not your order");
}

    if (order.status !== "accepted")
      return res.status(400).send("Order must be accepted first");

    if (order.completion_code !== Number(code)) {
  return res.status(400).send("Invalid completion code");
}

    await supabase
      .from("orders")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        completion_code: null
      })
      .eq("id", orderId);

    return res.json({ ok: true });
  }
);

/**
 * ⭐ CANCEL ORDER (ADDED)
 */
app.post("/orders/cancel", authenticateUser, async (req, res) => {
  const { orderId } = req.body;

  const { data: order } = await supabase
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (!order) return res.status(404).send("Order not found");

  if (order.status === "released")
    return res.status(400).send("Cannot cancel released order");

  if (order.status === "accepted" || order.status === "completed") {
  return res.status(400).send("Cannot cancel job after washer accepted it");
}

  if (order.stripe_payment_intent_id) {
    await stripe.refunds.create({
      payment_intent: order.stripe_payment_intent_id,
    });
  }

  await supabase
    .from("orders")
    .update({ status: "cancelled" })
    .eq("id", orderId);

  return res.json({ ok: true });
});

/**
 * CONNECT ROUTES
 */
app.get("/connect/create-account", async (req, res) => {
  const account = await stripe.accounts.create({
type: "express",
  country: "GB",
  email: req.body.email,
  business_type: "individual",
  capabilities: {
    transfers: { requested: true },
    card_payments: { requested: true }
    },
  });

  await supabase
    .from("sellers")
    .insert({ stripe_account_id: account.id });

  const link = await stripe.accountLinks.create({
    account: account.id,
    refresh_url: `http://localhost:${PORT}/connect/reauth`,
    return_url: `http://localhost:${PORT}/connect/return`,
    type: "account_onboarding",
  });

  res.redirect(link.url);
});

app.get("/connect/return", (req, res) =>
  res.send("Onboarding complete")
);

app.get("/connect/reauth", (req, res) =>
  res.send("Restart onboarding")
);

/**
 * START SERVER
 */
// ⭐ ADMIN — Force release funds
app.post(
  "/admin/release",
  authenticateUser,
  checkAdmin,
  async (req, res) => {
    const { orderId } = req.body;

    const { data: order, error } = await supabase
      .from("orders")
      .select("*")
      .eq("id", orderId)
      .single();

    if (error || !order) {
      return res.status(404).send("Order not found");
    }

    if (order.status === "released") {
      return res.status(400).send("Already released");
    }

    const { data: seller, error: sellerErr } = await supabase
      .from("sellers")
      .select("stripe_account_id")
      .eq("id", order.seller_id)
      .single();

    if (sellerErr || !seller?.stripe_account_id) {
      return res.status(400).send("Seller missing Stripe account");
    }

    const sellerAmount = Math.round(order.amount_pence * 0.85);

    const transfer = await stripe.transfers.create({
      amount: sellerAmount,
      currency: "gbp",
      destination: seller.stripe_account_id,
      metadata: { orderId },
    });

   

    await supabase
      .from("orders")
      .update({
        status: "released",
        released_at: new Date().toISOString(),
      })
      .eq("id", orderId);

    return res.json({
      ok: true,
      forced: true,
      transferId: transfer.id,
    });
  }
);
// ⭐ ADMIN — Cancel ANY order
app.post("/admin/cancel", authenticateUser, checkAdmin, async (req, res) => {

  const { orderId } = req.body;

  const { data: order, error } = await supabase
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (error || !order) {
    return res.status(404).send("Order not found");
  }

  if (order.status === "released") {
    return res.status(400).send("Cannot cancel released order");
  }

  if (order.stripe_payment_intent_id) {
    await stripe.refunds.create({
      payment_intent: order.stripe_payment_intent_id,
    });
  }

  await supabase
    .from("orders")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
    })
    .eq("id", orderId);

  return res.json({
    ok: true,
    adminCancelled: true,
  });

});
// ⭐ AUTO PAYOUT SYSTEM (runs every 5 minutes)

setInterval(async () => {

  console.log("Checking orders for auto release...");

  const { data: orders } = await supabase
    .from("orders")
    .select("*")
    .eq("status", "completed");

  if (!orders) return;

  for (const order of orders) {

    const { data: refund } = await supabase
  .from("refund_requests")
  .select("id")
  .eq("order_id", order.id)
  .eq("status", "pending")
  .single();

if (refund) {
  console.log("Payout paused due to refund request:", order.id);
  continue;
}

    const paidTime = new Date(order.paid_at);
    const hoursPassed = (Date.now() - paidTime) / 36e5;

    if (hoursPassed < 24) continue;

    const { data: seller } = await supabase
      .from("sellers")
      .select("stripe_account_id")
      .eq("id", order.seller_id)
      .single();

    if (!seller?.stripe_account_id) continue;

    const sellerAmount = Math.round(order.amount_pence * 0.85);

    try {

      const transfer = await stripe.transfers.create({
        amount: sellerAmount,
        currency: "gbp",
        destination: seller.stripe_account_id,
        metadata: { orderId: order.id },
      });

      await supabase
        .from("orders")
        .update({
          status: "released",
          released_at: new Date().toISOString()
        })
        .eq("id", order.id);

      console.log("Auto released order:", order.id);

    } catch (err) {
      console.log("Auto release failed:", err.message);
    }

  }

}, 300000);
/**
 * REFUND REQUEST
 */
app.post("/refund-request", authenticateUser, async (req, res) => {

  const {
    order_id,
    buyer_name,
    washer_name,
    description,
    photo_url
  } = req.body;

  const { error } = await supabase
    .from("refund_requests")
    .insert({
      order_id,
      buyer_name,
      washer_name,
      description,
      photo_url,
      status: "pending"
    });

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  return res.json({
    ok: true,
    message: "Refund request submitted"
  });

});

// 🔥 KEEP THIS LAST
app.listen(PORT, () =>
  console.log(`Backend running at http://localhost:${PORT}`)
);