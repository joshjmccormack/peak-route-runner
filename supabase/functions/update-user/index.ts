import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Use POST" });

  const authHeader = req.headers.get("Authorization") || "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) return json(500, { error: "Function is missing service credentials." });

  const admin = createClient(supabaseUrl, serviceKey);
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  const { data: userData, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !userData?.user) return json(401, { error: "Sign in as admin and try again." });
  const { data: profile } = await admin.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
  if (profile?.role !== "admin") return json(403, { error: "Only an admin can edit users." });

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json(400, { error: "Invalid request." });
  }

  const userId = String(body.id || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const role = String(body.role || "");
  const displayName = String(body.display_name || "").trim().slice(0, 40);
  const officerCode = String(body.officer_code || "").trim().slice(0, 20);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return json(400, { error: "That user was not found." });
  }
  if (!displayName) return json(400, { error: "Enter a display name." });
  if (!officerCode) return json(400, { error: "Enter an officer code." });
  if (!email || !email.includes("@")) return json(400, { error: "Enter a valid email." });
  if (password && password.length < 8) return json(400, { error: "Password must be at least 8 characters." });
  if (!["officer", "roc", "admin"].includes(role)) return json(400, { error: "Pick Officer, ROC, or Admin." });

  const { data: existing, error: existingError } = await admin
    .from("profiles")
    .select("id, role")
    .eq("id", userId)
    .maybeSingle();
  if (existingError) return json(500, { error: existingError.message });
  if (!existing) return json(404, { error: "That user was not found." });

  if (existing.role === "admin" && role !== "admin") {
    const { data: admins, error: adminError } = await admin.from("profiles").select("id").eq("role", "admin");
    if (adminError) return json(500, { error: adminError.message });
    if ((admins || []).length <= 1) return json(400, { error: "Keep at least one admin." });
  }

  const authPatch: Record<string, unknown> = {};
  if (password) authPatch.password = password;
  authPatch.email = email;
  authPatch.email_confirm = true;
  const { error: authError } = await admin.auth.admin.updateUserById(userId, authPatch);
  if (authError) return json(400, { error: authError.message });

  const { error: profileError } = await admin
    .from("profiles")
    .update({ email, role, display_name: displayName, officer_code: officerCode })
    .eq("id", userId);
  if (profileError) {
    return json(500, { error: "The login was updated, but the profile could not be saved. Try again." });
  }

  return json(200, { ok: true, id: userId, email, role, display_name: displayName, officer_code: officerCode });
});
