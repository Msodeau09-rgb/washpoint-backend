import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function isSellerOnboarded(stripeAccountId) {
  try {
    const account = await stripe.accounts.retrieve(stripeAccountId);
    // both must be true to release funds
    return account.charges_enabled && account.payouts_enabled;
  } catch (err) {
    console.error("Stripe onboarding check error:", err);
    return false; // if anything goes wrong, treat as not onboarded
  }
}