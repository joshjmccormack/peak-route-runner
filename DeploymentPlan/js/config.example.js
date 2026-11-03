// Copy this file to js/config.js to override locally.
// js/config.js is gitignored. If it is missing, the app uses this file.
//
// The anon key is the public client key for the Parking Project Supabase
// (same project as the other parking apps). Row level security still applies.
// Do not put a service-role or secret key here.
//
// A publishable key also exists for this project
// (sb_publishable_GcUx6mRolW_p7aL1FQCwpg_JYYQKMsn). This app uses the legacy
// anon JWT so @supabase/supabase-js behaves the same as the sibling apps.

const ROSTER_CONFIG = {
  supabaseUrl: "https://uklqyddpntttrcwaimji.supabase.co",
  supabaseAnonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVrbHF5ZGRwbnR0dHJjd2FpbWppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAwNzE5MzQsImV4cCI6MjEwNTY0NzkzNH0.4KECwYq26C3zp82lnk50n_QozHRe7GSgTW_WCfOtYAs",
};

export default ROSTER_CONFIG;
