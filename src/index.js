import dotenv from "dotenv";
dotenv.config();

console.log("🔥 WEBHOOK FIX VERSION 16");
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

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();

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
   console.log("🔥 WEBHOOK RECEIVED:", event.type);
   if (event.type === "checkout.session.completed") {
 const session = event.data.object;
 const orderId = session.metadata?.orderId;
 if (!orderId) {
   console.log("❌ No orderId in metadata");
   return;
 }
 const { error } = await supabase
   .from("orders")
   .update({
     status: "paid",
     stripe_payment_intent_id: session.payment_intent,
     paid_at: new Date().toISOString(),
   })
   .eq("id", orderId);
 if (error) {
   console.log("❌ Order update failed:", error);
 } else {
   console.log("✅ Order marked as PAID:", orderId);
 }
}
   res.json({ received: true });
 }
);

app.use(cors());
app.use(express.json());


app.post("/api/auth/sign-in/email", async (req, res) => {
  try {
    const { email } = req.body;

    return res.status(200).json({
      user: {
        id: "123",
        email
      },
      token: "test-token"
    });

  } catch (err) {
    return res.status(500).json({
      error: "Login failed"
    });
  }
});

app.post("/api/auth/sign-up/email", async (req, res) => {
 try {
   const { email } = req.body;
   return res.status(200).json({
     user: {
       id: "123",
       email
     },
     token: "test-token"
   });
 } catch (err) {
   return res.status(500).json({
     error: "Signup failed"
   });
 }
});

import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

async function sendInvoiceEmail(session) {
  const email = session.customer_details?.email;

  if (!email) return;

  await transporter.sendMail({
    from: "WashPoint <your@email.com>",
    to: email,
    subject: "WashPoint Receipt",
    html: `
      <h2>Payment Successful</h2>
      <p>Thanks for your booking.</p>
      <p><strong>Amount:</strong> £${(session.amount_total / 100).toFixed(2)}</p>
      <p><strong>Order ID:</strong> ${session.metadata?.orderId}</p>
    `,
  });
}

app.post("/api/stripe/create-checkout-session", async (req, res) => {
  try {
    const { amount, orderId } = req.body;

    // ✅ create order first
    let finalOrderId;

const { data: newOrder, error } = await supabase
  .from("orders")
  .insert({
    status: "pending",
    amount_pence: amount || 1500,
    currency: "gbp",
  })
  .select()
  .single();

if (error || !newOrder) {
  console.log("❌ ORDER CREATION FAILED:", error);
  return res.status(500).json({ error: "Order creation failed" });
}

finalOrderId = newOrder.id; // 🔥 THIS WAS MISSING

console.log("🧾 ORDER CREATED:", newOrder);

    // ✅ create stripe session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",

      customer_email: req.body.email || undefined,

      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: {
              name: "WashPoint Car Wash",
            },
            unit_amount: amount || 1500,
          },
          quantity: 1,
        },
      ],

      metadata: {
        orderId: finalOrderId,
      },

      success_url: `washpoint://payment-success?orderId=${orderId}&paymentIntentId={CHECKOUT_SESSION_ID}`,
      cancel_url: `washpoint://payment-cancelled?orderId=${orderId}`,
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).json({ error: err.message });
  }
});

// SESSION (fixes your 404 error)
app.get("/api/auth/get-session", async (req, res) => {
  return res.status(200).json({
    user: null
  });
});

// ✅ ADD THIS RIGHT HERE
app.post("/api/payment-success", (req, res) => {
  res.json({ success: true });
});

app.get("/health", (req, res) => {
  res.json({ status: "WashPoint backend running 🚀" });
});

const PORT = process.env.PORT || 3000;

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



    // ✅ CLEAN CHECKOUT SESSION (NO PAYMENT INTENT HERE)
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
console.log("User:", req.user);
  const orderData = parsed.data;

  const { data: order, error } = await supabase
    .from("orders")
    .insert({
      amount_pence: orderData.amount_pence,
      currency: "gbp",
      seller_id: orderData.seller_id || null,
      buyer_name: req.user.email,
      buyer_email: req.user.email,
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

app.get("/success", (req, res) => {
  res.json({ status: "success", message: "Payment successful" });
});

app.get("/cancel", (req, res) => {
  res.json({ status: "cancelled", message: "Payment cancelled" });
});

app.get("/api/user/sellers", async (req, res) => {
  const { data, error } = await supabase
    .from("sellers")
    .select("*");

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ ok: true, sellers: data });
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

    const payoutTransfer = await stripe.transfers.create({
      amount: sellerAmount,
      currency: "gbp",
      destination: sellerData.stripe_account_id,
      metadata: { orderId: order.id },
    });

    await supabase
      .from("orders")
      .update({ status: "released" })
      .eq("id", order.id);

    return res.json({ ok: true, transferId: payoutTransfer.id });
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

// ⬇ ADD THIS BLOCK HERE
const created = new Date(order.created_at);
const hoursPassed = (Date.now() - created) / 36e5;

if (hoursPassed > 24) {
  return res.status(400).send("Order expired and refunded");
}
// ⬆ END BLOCK

if (order.status !== "available")
  return res.status(400).send("Order is not available");

const completionCode = Math.floor(100000 + Math.random() * 900000);

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

// lock order if too many attempts
if (order.attempts >= 3) {
  return res.status(403).send("Order locked due to too many incorrect attempts");
}

// incorrect completion code
if (order.completion_code !== Number(code)) {

  await supabase
    .from("orders")
    .update({ attempts: order.attempts + 1 })
    .eq("id", orderId);

  return res.status(400).send("Invalid completion code");
}

// 🔥 CAPTURE PAYMENT (RELEASE MONEY)
if (!order.stripe_payment_intent_id) {
  return res.status(400).send("No payment intent found");
}

await stripe.paymentIntents.capture(order.stripe_payment_intent_id);

// ✅ THEN mark order complete
await supabase
  .from("orders")
  .update({
    status: "completed",
    completed_at: new Date().toISOString(),
    completion_code: null,
    attempts: 0
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

await stripe.paymentIntents.cancel(order.stripe_payment_intent_id);

await supabase
  .from("orders")
  .update({ status: "cancelled" })
  .eq("id", orderId);

return res.json({ ok: true });
});

/**
 * SUPPORT MESSAGE
 */
app.post("/support/message", authenticateUser, async (req, res) => {
  const { message } = req.body;

  const { error } = await supabase
    .from("support_messages")
    .insert({
      user_id: req.user.id,
      message
    });

  if (error) {
    console.log("Support message error:", error);
    return res.status(500).send("Failed to send message");
  }

  res.json({ ok: true });
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

    if (!order.amount_pence || order.amount_pence < 1500) {
  return res.status(400).send("Invalid order amount");
}

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
});
  
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

  if (refund) continue;

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

  const existingRelease = await supabase
    .from("releases")
    .select("id")
    .eq("order_id", order.id)
    .maybeSingle();

  if (existingRelease.data) continue;

  try {
    const PayoutTransfer = await stripe.transfers.create({
      amount: sellerAmount,
      currency: "gbp",
      destination: seller.stripe_account_id,
      metadata: { orderId: order.id },
    });

    await supabase.from("releases").insert({
      order_id: order.id,
      stripe_transfer_id: PayoutTransfer.id,
      amount_to_seller_pence: sellerAmount,
      platform_fee_pence: order.amount_pence - sellerAmount,
    });

    await supabase
      .from("orders")
      .update({
        status: "released",
        released_at: new Date().toISOString(),
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

app.post("/api/orders", async (req, res) => {
  try {
    const { service, price, location } = req.body;

    // TEMPORARY (just to stop error)
    return res.status(200).json({
      success: true,
      order: {
        id: "order_123",
        service,
        price,
        location
      }
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "Order failed"
    });
  }
});

app.get('/api/orders/my-orders', async (req, res) => {
 try {
   const { data, error } = await supabase
     .from('orders')
     .select('*');
   if (error) {
     console.error(error);
     return res.status(500).json({ error: 'Failed to fetch orders' });
   }
   return res.json(data);
 } catch (err) {
   console.error('SERVER ERROR:', err);
   return res.status(500).json({ error: 'Server crash' });
 }
});

// ✅ STRIPE ROUTES

app.post("/api/stripe/create-payment-intent", async (req, res) => {
 try {
   console.log("🧾 Create checkout session hit");
   const amount = req.body.amount_pence;
   if (!amount) {
     return res.status(400).json({ error: "Missing amount" });
   }
   const session = await stripe.checkout.sessions.create({
 // ...
 mode: 'payment',
 payment_method_types: ['card'],
 // ADD THIS:
 allow_promotion_codes: false,
 // IMPORTANT:
 submit_type: 'pay',
 // This helps UX:
 after_expiration: {
   recovery: {
     enabled: false,
   },
 },
});

   console.log("✅ Checkout URL:", session.url);
   res.json({
     url: session.url,
   });
 } catch (err) {
   console.error("❌ Stripe error:", err);
   res.status(500).json({ error: err.message });
 }
});

// KEEP THIS LAST
app.listen(PORT, () =>
  console.log(`Backend running at http://localhost:${PORT}`)
);