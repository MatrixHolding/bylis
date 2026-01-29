#!/bin/bash
export SUPABASE_URL="https://pwlxemgksvhzedtzuwma.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB3bHhlbWdrc3ZoemVkdHp1d21hIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1OTkzNjI0MywiZXhwIjoyMDc1NTEyMjQzfQ.ktesLjpRDBO2lrtcyfhLVMzDyfych5E3WrvqN7KU3xM"
export BAILEYS_AUTH_DIR="./data/baileys"
export PORT=3000

echo "Starting Bylis on http://localhost:3000"
node dist/index.js
