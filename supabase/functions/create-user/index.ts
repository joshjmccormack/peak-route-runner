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
  if (profile?.role !== "admin") return json(403, { error: "Only an admin can add users." });

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json(400, { error: "Invalid request." });
  }
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const role = String(body.role || "officer");
  const displayName = String(body.display_name || "").trim().slice(0, 40);
  const officerCode = String(body.officer_code || "").trim().slice(0, 20);
  if (!displayName) return json(400, { error: "Enter a display name." });
  if (!officerCode) return json(400, { error: "Enter an officer code." });
  if (!email || !email.includes("@")) return json(400, { error: "Enter a valid email." });
  if (password.length < 8) return json(400, { error: "Password must be at least 8 characters." });
  if (!["officer", "roc", "admin"].includes(role)) return json(400, { error: "Pick Officer, ROC, or Admin." });

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError) return json(400, { error: createError.message });
  const userId = created?.user?.id;
  if (userId) {
    await admin.from("profiles").upsert({ id: userId, email, role, display_name: displayName, officer_code: officerCode });
  }
  return json(200, { ok: true, email, role, display_name: displayName, officer_code: officerCode });
});
