import dotenv from "dotenv";
dotenv.config();

console.log("🔥 WEBHOOK FIX VERSION 16");
console.log("SUPABASE_URL:", process.env.SUPABASE_URL);
console.log("SUPABASE_ANON_KEY:", process.env.SUPABASE_ANON_KEY ? "Loaded" : "Missing");

import express from "express";
import Stripe from "stripe";
import cors from "cors";
import { z } from "zod";
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

const bookingPaymentIntentSchema = z.object({
  orderId: z.string().min(1, "orderId is required"),
  buyerId: z.string().min(1, "buyerId is required"),
  buyerName: z.string().optional(),
  buyerPhone: z.string().optional(),
  buyerProfileImage: z.string().optional(),
  sellerId: z.string().optional(),
  carImage: z.string().optional(),
  address: z.string().min(1, "address is required"),
  carType: z.string().min(1, "carType is required"),
  carMake: z.string().optional(),
  washPackage: z.string().min(1, "washPackage is required"),
  price: z.number().positive("price must be positive"),
  amount_pence: z.number().int().positive("amount_pence must be positive"),
  scheduledDate: z.string().optional(),
  scheduledTime: z.string().optional(),
  agePreference: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

const subscriptionPaymentSchema = z.object({
  userId: z.string().min(1, "userId is required"),
  tier: z.enum(["premium", "standard"]),
  userType: z.enum(["buyer", "washer"]),
});

const subscriptionConfirmSchema = z.object({
  userId: z.string().min(1, "userId is required"),
  paymentIntentId: z.string().min(1, "paymentIntentId is required"),
  tier: z.enum(["premium", "standard"]).optional(),
  userType: z.enum(["buyer", "washer"]).optional(),
});

const SUBSCRIPTION_PRICES = {
  "premium-buyer": 1500,
  "premium-washer": 3000,
};

function metadataValue(value) {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return text.length > 500 ? "" : text;
}

function nextSubscriptionRenewalDate() {
  const nextRenewalDate = new Date();
  nextRenewalDate.setDate(nextRenewalDate.getDate() + 30);
  return nextRenewalDate;
}

async function updatePremiumProfile(userId, userType, nextRenewalDate) {
  const now = new Date().toISOString();
  const richPayload = {
    is_premium: true,
    is_premium_buyer: userType === "buyer",
    is_premium_washer: userType === "washer",
    subscription_tier: "premium",
    premium_started_at: now,
    subscription_start_date: now,
    next_renewal_date: nextRenewalDate.toISOString(),
  };

  const { error: richError } = await supabase
    .from("profiles")
    .update(richPayload)
    .eq("id", userId);

  if (!richError) return { ok: true, mode: "rich" };

  console.warn("Rich premium profile update failed, retrying legacy fields:", richError);

  const { error: legacyError } = await supabase
    .from("profiles")
    .update({
      is_premium: true,
      premium_started_at: now,
    })
    .eq("id", userId);

  if (legacyError) {
    return { ok: false, error: legacyError.message };
  }

  return { ok: true, mode: "legacy" };
}

async function saveSubscriptionRecord({ userId, tier, userType, paymentIntent, nextRenewalDate }) {
  const { data: existingSubscription, error: existingError } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("stripe_payment_intent_id", paymentIntent.id)
    .maybeSingle();

  if (!existingError && existingSubscription) {
    return { ok: true, subscription: existingSubscription, idempotent: true };
  }

  if (existingError) {
    console.warn("Subscription idempotency check failed; table may be missing:", existingError);
  }

  const { data: subscription, error: insertError } = await supabase
    .from("subscriptions")
    .insert({
      user_id: userId,
      tier,
      user_type: userType,
      status: "active",
      amount: paymentIntent.amount,
      currency: paymentIntent.currency || "gbp",
      stripe_customer_id: typeof paymentIntent.customer === "string" ? paymentIntent.customer : null,
      stripe_payment_intent_id: paymentIntent.id,
      stripe_payment_method_id: typeof paymentIntent.payment_method === "string" ? paymentIntent.payment_method : null,
      start_date: new Date().toISOString(),
      next_renewal_date: nextRenewalDate.toISOString(),
      last_charged_date: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertError) {
    console.warn("Subscription record insert failed; continuing with premium profile update:", insertError);
    return { ok: false, error: insertError.message };
  }

  return { ok: true, subscription };
}

function buildBookingMetadata(data) {
  return {
    orderId: metadataValue(data.orderId),
    buyerId: metadataValue(data.buyerId),
    buyerName: metadataValue(data.buyerName),
    buyerPhone: metadataValue(data.buyerPhone),
    buyerProfileImage: metadataValue(data.buyerProfileImage),
    sellerId: metadataValue(data.sellerId),
    carImage: metadataValue(data.carImage),
    address: metadataValue(data.address),
    carType: metadataValue(data.carType),
    carMake: metadataValue(data.carMake),
    washPackage: metadataValue(data.washPackage),
    price: metadataValue(data.price),
    scheduledDate: metadataValue(data.scheduledDate),
    scheduledTime: metadataValue(data.scheduledTime),
    agePreference: metadataValue(data.agePreference || "any"),
    latitude: metadataValue(data.latitude),
    longitude: metadataValue(data.longitude),
  };
}

async function createBookingOrderFromPaymentIntent(paymentIntent) {
  const metadata = paymentIntent.metadata || {};
  const price = Number.parseFloat(metadata.price || "");
  const missing = [
    !metadata.orderId ? "orderId" : null,
    !metadata.buyerId ? "buyerId" : null,
    !metadata.address ? "address" : null,
    !metadata.carType ? "carType" : null,
    !metadata.washPackage ? "washPackage" : null,
    !Number.isFinite(price) || price <= 0 ? "price" : null,
  ].filter(Boolean);

  if (missing.length > 0) {
    console.error("PaymentIntent webhook missing booking metadata:", {
      paymentIntentId: paymentIntent.id,
      missing,
    });
    return { ok: false, error: "Missing booking metadata", missing };
  }

  const { data: existingOrder, error: existingError } = await supabase
    .from("orders")
    .select("*")
    .eq("stripe_payment_intent_id", paymentIntent.id)
    .maybeSingle();

  if (existingError) {
    console.error("PaymentIntent webhook idempotency check failed:", existingError);
    return { ok: false, error: existingError.message };
  }

  if (existingOrder) {
    console.log("PaymentIntent webhook idempotent order already exists:", {
      orderId: existingOrder.id,
      paymentIntentId: paymentIntent.id,
    });
    return { ok: true, order: existingOrder, idempotent: true };
  }

  const paidAt = new Date().toISOString();
  const richOrderPayload = {
    buyer_id: metadata.buyerId,
    buyer_name: metadata.buyerName || null,
    buyer_phone: metadata.buyerPhone || null,
    buyer_profile_image: metadata.buyerProfileImage || null,
    seller_id: metadata.sellerId || null,
    address: metadata.address,
    latitude: metadata.latitude ? Number.parseFloat(metadata.latitude) : null,
    longitude: metadata.longitude ? Number.parseFloat(metadata.longitude) : null,
    car_type: metadata.carType,
    car_make: metadata.carMake || null,
    wash_package: metadata.washPackage,
    price,
    amount_pence: paymentIntent.amount,
    currency: paymentIntent.currency || "gbp",
    scheduled_date: metadata.scheduledDate || null,
    scheduled_time: metadata.scheduledTime || null,
    car_image: metadata.carImage || null,
    age_preference: metadata.agePreference || "any",
    status: "pending",
    payment_status: "succeeded",
    stripe_payment_intent_id: paymentIntent.id,
    paid_at: paidAt,
  };

  const { data: newOrder, error: insertError } = await supabase
    .from("orders")
    .insert(richOrderPayload)
    .select()
    .single();

  if (!insertError) {
    console.log("PaymentIntent webhook created booking order:", {
      orderId: newOrder.id,
      paymentIntentId: paymentIntent.id,
    });
    return { ok: true, order: newOrder };
  }

  console.error("PaymentIntent webhook rich order insert failed, retrying legacy columns:", insertError);

  const legacyOrderPayload = {
    status: "paid",
    amount_pence: paymentIntent.amount,
    currency: paymentIntent.currency || "gbp",
    seller_id: metadata.sellerId || null,
    buyer_name: metadata.buyerName || null,
    stripe_payment_intent_id: paymentIntent.id,
    paid_at: paidAt,
  };

  const { data: legacyOrder, error: legacyError } = await supabase
    .from("orders")
    .insert(legacyOrderPayload)
    .select()
    .single();

  if (legacyError) {
    console.error("PaymentIntent webhook legacy order insert failed:", legacyError);
    return { ok: false, error: legacyError.message };
  }

  console.log("PaymentIntent webhook created legacy booking order:", {
    orderId: legacyOrder.id,
    paymentIntentId: paymentIntent.id,
  });
  return { ok: true, order: legacyOrder, legacy: true };
}

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
   if (event.type === "payment_intent.succeeded") {
 const paymentIntent = event.data.object;
 if (paymentIntent.metadata?.type === "subscription") {
   console.log("Subscription PaymentIntent succeeded; confirmation endpoint will activate premium:", paymentIntent.id);
   return res.json({ received: true, subscriptionPayment: true });
 }
 const result = await createBookingOrderFromPaymentIntent(paymentIntent);
 if (!result.ok) {
   return res.status(400).json(result);
 }
 return res.json({ received: true, orderCreated: true });
}
   if (event.type === "checkout.session.completed") {
 const session = event.data.object;
 const orderId = session.metadata?.orderId;
 if (!orderId) {
 console.log("❌ No orderId in metadata");
 return res.json({ received: true });
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

app.post("/api/stripe/create-payment-intent", async (req, res) => {
  const parsed = bookingPaymentIntentSchema.safeParse(req.body);

  if (!parsed.success) {
    console.error("Invalid create-payment-intent payload:", parsed.error.errors);
    return res.status(400).json({
      error: "Invalid payment request",
      details: parsed.error.errors,
    });
  }

  const booking = parsed.data;

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: booking.amount_pence,
      currency: "gbp",
      payment_method_types: ["card"],
      metadata: buildBookingMetadata(booking),
    });

    console.log("Created booking PaymentIntent:", {
      paymentIntentId: paymentIntent.id,
      orderId: booking.orderId,
      buyerId: booking.buyerId,
      amount: paymentIntent.amount,
    });

    return res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: paymentIntent.amount,
    });
  } catch (error) {
    console.error("Create booking PaymentIntent failed:", error);
    return res.status(500).json({
      error: "Failed to create payment intent",
      details: error.message,
    });
  }
});

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

const refundRequestSchema = z.object({
  buyerName: z.string().min(1, "Buyer name is required"),
  washerName: z.string().min(1, "Washer name is required"),
  damageImage: z.string().optional(),
  description: z.string().min(1, "Description is required"),
  incidentDateTime: z.string().min(1, "Incident date/time is required"),
});

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

app.get("/api/refund-requests/status", (req, res) => {
  res.json({
    enabled: true,
    receiverEmail:
      process.env.REFUND_REQUEST_RECEIVER_EMAIL || "ramseyvincent128@gmail.com",
  });
});

app.post("/api/refund-requests", async (req, res) => {
  console.log("Refund request payload received:", {
    keys: Object.keys(req.body || {}),
    hasDamageImage: Boolean(req.body?.damageImage),
    damageImageType: typeof req.body?.damageImage,
    incidentDateTime: req.body?.incidentDateTime,
  });

  const parsed = refundRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    console.error("Invalid refund request payload:", parsed.error.errors);
    return res.status(400).json({
      error: "Invalid refund request payload",
      details: parsed.error.errors,
    });
  }

  const body = parsed.data;
  const receiverEmail =
    process.env.REFUND_REQUEST_RECEIVER_EMAIL || "ramseyvincent128@gmail.com";

  try {
    const emailAbortController = new AbortController();
    const emailTimeout = setTimeout(() => emailAbortController.abort(), 15000);

    if (!process.env.RESEND_API_KEY) {
      return res.status(500).json({
        error: "Refund request email provider is not configured.",
        details: "Missing RESEND_API_KEY",
      });
    }

    const fromEmail =
      process.env.REFUND_REQUEST_FROM_EMAIL || "onboarding@resend.dev";

    const emailResponse = await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        signal: emailAbortController.signal,
        body: JSON.stringify({
          from: fromEmail,
          to: receiverEmail,
          subject: `Refund Request: ${body.buyerName}`,
          html: `
            <h2>New Refund Request</h2>
            <p><strong>Buyer Name:</strong> ${escapeHtml(body.buyerName)}</p>
            <p><strong>Washer Name:</strong> ${escapeHtml(body.washerName)}</p>
            <p><strong>Incident Date/Time:</strong> ${new Date(body.incidentDateTime).toLocaleString("en-GB")}</p>
            <h3>Description:</h3>
            <p>${escapeHtml(body.description).replace(/\n/g, "<br>")}</p>
            ${body.damageImage ? `<p><strong>Evidence Image:</strong> <a href="${escapeHtml(body.damageImage)}">View Image</a></p>` : ""}
            <hr>
            <p>Submitted at: ${new Date().toISOString()}</p>
          `,
        }),
      }
    );
    clearTimeout(emailTimeout);

    const emailResponseBody = await emailResponse.text().catch(() => "");

    if (!emailResponse.ok) {
      console.error("Failed to send refund request email:", {
        status: emailResponse.status,
        body: emailResponseBody,
      });
      return res.status(502).json({
        error: "Refund request was received, but email delivery failed.",
        smtpStatus: emailResponse.status,
        smtpResponse: emailResponseBody,
      });
    }

    console.log("Refund request email sent:", {
      status: emailResponse.status,
      response: emailResponseBody,
      fromEmail,
      receiverEmail,
    });

    return res.status(201).json({
      success: true,
      message: "Refund request submitted successfully. We will review it shortly.",
      receiverEmail,
    });
  } catch (error) {
    console.error("Refund request error:", error);
    return res.status(502).json({
      error: "Refund request was received, but email delivery failed.",
      details:
        error.name === "AbortError"
          ? "SMTP request timed out"
          : error.message || "Unknown email delivery error",
    });
  }
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

app.post('/api/subscriptions/create-payment', async (req, res) => {
 try {
   const parsed = subscriptionPaymentSchema.safeParse(req.body);
   if (!parsed.success) {
     console.error("Invalid subscription payment payload:", parsed.error.errors);
     return res.status(400).json({
       error: "Invalid subscription payment request",
       details: parsed.error.errors,
     });
   }

   const { userId, tier, userType } = parsed.data;
   if (tier === "standard") {
     return res.status(400).json({ error: "Standard tier is free" });
   }

   const amount = SUBSCRIPTION_PRICES[`${tier}-${userType}`];
   if (!amount) {
     return res.status(400).json({ error: "Invalid subscription tier or user type" });
   }

   const paymentIntent = await stripe.paymentIntents.create({
     amount,
     currency: "gbp",
     payment_method_types: ["card"],
     setup_future_usage: "off_session",
     metadata: {
       type: "subscription",
       userId: metadataValue(userId),
       tier: metadataValue(tier),
       userType: metadataValue(userType),
     },
     description: `${tier.toUpperCase()} subscription for ${userType}`,
   });

   console.log("Subscription PaymentIntent created:", {
     paymentIntentId: paymentIntent.id,
     userId,
     tier,
     userType,
     amount,
   });

   return res.json({
     clientSecret: paymentIntent.client_secret,
     paymentIntentId: paymentIntent.id,
     amount,
     tier,
     userType,
   });
 } catch (err) {
   console.error("Subscription PaymentIntent error:", err);
   res.status(500).json({ error: err.message });
 }
});

app.post('/api/subscriptions/confirm-payment', async (req, res) => {
 try {
   const parsed = subscriptionConfirmSchema.safeParse(req.body);
   if (!parsed.success) {
     console.error("Invalid subscription confirmation payload:", parsed.error.errors);
     return res.status(400).json({
       error: "Invalid subscription confirmation request",
       details: parsed.error.errors,
     });
   }

   const { userId, paymentIntentId } = parsed.data;
   const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

   if (paymentIntent.status !== "succeeded") {
     return res.status(400).json({
       error: `Payment not succeeded. Status: ${paymentIntent.status}`,
     });
   }

   const metadata = paymentIntent.metadata || {};
   if (metadata.type !== "subscription") {
     return res.status(400).json({ error: "PaymentIntent is not a subscription payment" });
   }

   if (metadata.userId && metadata.userId !== userId) {
     return res.status(403).json({ error: "PaymentIntent user mismatch" });
   }

   const tier = metadata.tier || parsed.data.tier;
   const userType = metadata.userType || parsed.data.userType;

   if (tier !== "premium" || !["buyer", "washer"].includes(userType)) {
     return res.status(400).json({ error: "Invalid subscription metadata" });
   }

   const nextRenewalDate = nextSubscriptionRenewalDate();
   const subscriptionResult = await saveSubscriptionRecord({
     userId,
     tier,
     userType,
     paymentIntent,
     nextRenewalDate,
   });

   const profileResult = await updatePremiumProfile(userId, userType, nextRenewalDate);
   if (!profileResult.ok) {
     console.error("Failed to update premium profile:", profileResult.error);
     return res.status(500).json({ error: "Failed to activate premium status" });
   }

   console.log("Subscription activated:", {
     userId,
     tier,
     userType,
     paymentIntentId,
     subscriptionRecordSaved: subscriptionResult.ok,
     profileMode: profileResult.mode,
   });

   return res.json({
     success: true,
     subscription: {
       id: subscriptionResult.subscription?.id || paymentIntentId,
       tier,
       userType,
       status: "active",
       nextRenewalDate: nextRenewalDate.toISOString(),
       paymentIntentId,
       recordSaved: subscriptionResult.ok,
     },
   });
 } catch (err) {
   console.error("Subscription confirmation error:", err);
   res.status(500).json({ error: err.message });
 }
});

app.post('/api/buyer-subscription', async (req, res) => {
 try {
   console.log("BUYER SUB HIT");
   const { userId } = req.body;
   // 🔥 Save subscription in Supabase
   const { error } = await supabase
     .from("profiles")
     .update({
       is_premium: true,
       premium_started_at: new Date().toISOString()
     })
     .eq("id", userId);
   if (error) {
     console.log("❌ Supabase error:", error);
     return res.status(500).json({ error: "Database failed" });
   }
   res.json({ success: true });
 } catch (err) {
   console.error("BUYER ERROR:", err);
   res.status(500).json({ error: err.message });
 }
});

// ✅ STRIPE ROUTES

// KEEP THIS LAST
app.listen(PORT, () =>
  console.log(`Backend running at http://localhost:${PORT}`)
);
