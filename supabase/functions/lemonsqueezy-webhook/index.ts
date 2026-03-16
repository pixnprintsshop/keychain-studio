// Lemon Squeezy webhook handler for subscription lifecycle events
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

async function verifySignature(body: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const digest = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return digest === signature;
}

function mapVariantToPlan(variantId: number | string, monthlyId: string, yearlyId: string): "monthly" | "yearly" {
  const v = String(variantId);
  return v === String(yearlyId) ? "yearly" : "monthly";
}

const SUBSCRIPTION_EVENTS = new Set([
  "subscription_created",
  "subscription_updated",
  "subscription_cancelled",
  "subscription_expired",
  "subscription_resumed",
]);

interface SubscriptionAttributes {
  status: string;
  ends_at: string | null;
  renews_at: string | null;
  variant_id: number;
  user_email?: string;
  order_id?: number;
  customer_id?: number;
}

interface WebhookPayload {
  meta?: {
    event_name?: string;
    custom_data?: Record<string, unknown>;
  };
  data?: {
    id: string;
    type?: string;
    attributes?: SubscriptionAttributes;
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await req.text();
  const signature = req.headers.get("X-Signature");
  const eventName = req.headers.get("X-Event-Name");

  const secret = Deno.env.get("LEMONSQUEEZY_WEBHOOK_SECRET");
  if (!secret) {
    console.error("LEMONSQUEEZY_WEBHOOK_SECRET not set");
    return new Response(JSON.stringify({ error: "Webhook not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!(await verifySignature(body, signature, secret))) {
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!eventName || !SUBSCRIPTION_EVENTS.has(eventName)) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const customData = payload.meta?.custom_data as Record<string, string> | undefined;
  const userId = customData?.user_id;
  if (!userId) {
    console.warn("Webhook missing meta.custom_data.user_id, skipping");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const data = payload.data;
  const attrs = data?.attributes;
  if (!data?.id || !attrs) {
    return new Response(JSON.stringify({ error: "Invalid payload" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseServiceKey) {
    return new Response(JSON.stringify({ error: "Supabase not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const monthlyVariantId = Deno.env.get("LEMONSQUEEZY_VARIANT_MONTHLY_ID") ?? "";
  const yearlyVariantId = Deno.env.get("LEMONSQUEEZY_VARIANT_YEARLY_ID") ?? "";
  const plan = mapVariantToPlan(attrs.variant_id ?? 0, monthlyVariantId, yearlyVariantId);

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const row = {
    user_id: userId,
    lemonsqueezy_subscription_id: data.id,
    lemonsqueezy_customer_id: attrs.customer_id != null ? String(attrs.customer_id) : null,
    lemonsqueezy_order_id: attrs.order_id != null ? String(attrs.order_id) : null,
    lemonsqueezy_variant_id: attrs.variant_id != null ? String(attrs.variant_id) : null,
    status: attrs.status ?? "unknown",
    plan,
    ends_at: attrs.ends_at || null,
    renews_at: attrs.renews_at || null,
    updated_at: new Date().toISOString(),
  };

  try {
    const { error } = await supabase.from("subscriptions").upsert(row, {
      onConflict: "user_id",
      ignoreDuplicates: false,
    });

    if (error) {
      console.error("Supabase upsert error:", error);
      return new Response(JSON.stringify({ error: "Database error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    await supabase.from("lemonsqueezy_events").insert({
      event_name: eventName,
      payload: payload as unknown as Record<string, unknown>,
    });
  } catch (err) {
    console.error("Webhook processing error:", err);
    return new Response(JSON.stringify({ error: "Processing failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
